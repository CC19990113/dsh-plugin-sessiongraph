//! Read half of the native kernel: answer the seam's query operations from `index.db`.
//!
//! The write half (`scan`/`decode`/`parse`/`write`) and this module are one kernel on purpose: the
//! query side must tokenize a search query with the same bigram rules the write side used, or the
//! index silently cannot answer its own queries. `tokenize::tokenize` is called directly, never
//! reimplemented.
//!
//! Six operations answer from the index alone; `event` and `trace`'s event shape additionally read
//! the session's source log, because the index stores clipped semantic text while those answers must
//! be the original log line (including events the index never stores). The log reader mirrors
//! `packages/sessions/src/raw.ts` — tolerant per line, replacement chains folded from `surfaceOp`.
//!
//! ## Ranking
//!
//! FTS5's `bm25()` is negative and *more negative means a better match*, so the weighted sort key is
//! `bm25 / weight`: the larger a kind's weight, the closer to zero (the lower) it ranks. The table is
//! fixed — `user` 1.0, `title` 1.1, `assistant` 1.2, `tool` 1.5 — and is shared vocabulary with the
//! TypeScript store so the two engines order one query the same way.
//!
//! ## Why the page is built in Rust instead of one window query
//!
//! The TypeScript store answers a search with a `count(DISTINCT session_id)` plus a
//! `ROW_NUMBER() OVER (PARTITION BY session_id …)` statement. Both scan every match, so one search
//! paid for the FTS match twice. Here one lightweight scan collects `(id, session_id, kind, time,
//! seq, bm25)` for every match — notably **without `text`**, which is the large column — and the
//! dedupe/ordering/pagination happen in memory; only the page's ids are read back for their text.
//! The ordering is identical: the same `bm25` values and the same tie-break columns, with the
//! session's strongest entry chosen by raw score exactly as the window function chose it.
//!
//! ## Field names
//!
//! A plain `#[napi(object)]` field is exposed to JS in camelCase (`index_path` → `indexPath`), which
//! is why the index types read that way. The query boundary is the seam's own shape and keeps
//! snake_case, so every multi-word field here carries an explicit `#[napi(js_name = "…")]`
//! (`index_root`, `session_id`, `payload_json`). The result itself crosses as a JSON string in
//! `payload_json`: a raw event can be tens of kilobytes, and one `JSON.parse` costs less than
//! per-field napi conversion.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use napi::{Env, Task};
use napi_derive::napi;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::decode::decompress_session_log;
use crate::tokenize;
use crate::write;

/// Ceiling on one rendered snippet, in UTF-16 code units.
///
/// Mirrors `DEFAULT_MAX_SNIPPET_CHARS` in `packages/sqlite/src/index.ts`. The store's `maxSnippetChars`
/// configuration can lower or raise it; a caller that cares sends it as `max_snippet_chars`, and
/// without that field the kernel uses this default.
pub const DEFAULT_MAX_SNIPPET_CHARS: usize = 240;

/// Ceiling on one session-lineage walk, in levels. The log is not trusted to be acyclic.
const MAX_LINEAGE_DEPTH: usize = 64;

/// The `session` projections every result shape reads, qualified for the lineage CTEs.
const SESSION_COLUMNS_S: &str = "s.id, s.workspace, s.title, s.created_at, s.last_at, \
     s.parent_session, s.origin, s.agent_preset, s.turns, s.entries";

/// The same projection, unqualified, for a single-table read.
const SESSION_COLUMNS: &str = "id, workspace, title, created_at, last_at, parent_session, origin, \
     agent_preset, turns, entries";

/// One `.dsh/sessiongraph` index file, relative to the request's `indexRoot`.
const INDEX_FILE: &str = "index.db";

/// Pseudo source path a live (still-running) session's row is recorded under.
const LIVE_SOURCE_PREFIX: &str = "live://";

/// Largest number of bound ids per `IN (…)` statement (SQLite's default variable cap is 32766).
const ID_CHUNK: usize = 500;

/// One query failure, carrying the seam's error code.
#[derive(Debug, Clone)]
pub struct QueryError {
    /// `SESSIONGRAPH_*` code, as the seam defines it.
    pub code: &'static str,
    /// Human-readable diagnosis.
    pub message: String,
}

impl QueryError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

type QResult<T> = Result<T, QueryError>;

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::new("SESSIONGRAPH_INVALID_REQUEST", message)
}

fn not_found(message: impl Into<String>) -> QueryError {
    QueryError::new("SESSIONGRAPH_NOT_FOUND", message)
}

fn corrupt(message: impl Into<String>) -> QueryError {
    QueryError::new("SESSIONGRAPH_CORRUPT", message)
}

fn io_error(message: impl Into<String>) -> QueryError {
    QueryError::new("SESSIONGRAPH_IO", message)
}

/// One query request. Snake_case here, camelCase in JS (`indexRoot`, `sessionId`, `windowBefore`, …).
///
/// `max_snippet_chars` is additive over the seam request: the store's snippet cap is configuration,
/// not part of a query, so it rides along here and defaults to [`DEFAULT_MAX_SNIPPET_CHARS`] when the
/// caller does not send it.
#[napi(object)]
#[derive(Clone, Default)]
pub struct QueryRequest {
    /// Directory holding the index (`<index_root>/index.db`).
    #[napi(js_name = "index_root")]
    pub index_root: String,
    /// One of `search`, `session`, `event`, `trace`, `timeline`, `workspaces`, `status`.
    pub operation: String,
    /// Search text (search only).
    pub query: Option<String>,
    /// Full session id, or a prefix long enough to identify exactly one session.
    #[napi(js_name = "session_id")]
    pub session_id: Option<String>,
    /// Event sequence number (event; trace's event shape).
    pub seq: Option<f64>,
    /// Page size. `0` asks for the total only; absent means `0`, like the seam's numeric contract.
    pub limit: Option<f64>,
    /// Rows to skip, for paging.
    pub offset: Option<f64>,
    /// Raw events to include immediately before the target (event).
    #[napi(js_name = "window_before")]
    pub window_before: Option<f64>,
    /// Raw events to include immediately after the target (event).
    #[napi(js_name = "window_after")]
    pub window_after: Option<f64>,
    /// Maximum descendant depth (trace's session shape). Absent means the whole tree.
    pub depth: Option<f64>,
    /// Workspace filter (exact, or a prefix when it ends with `/`).
    pub workspace: Option<String>,
    /// Only entries/sessions at or after this epoch-millisecond bound.
    pub since: Option<f64>,
    /// Only entries/sessions at or before this epoch-millisecond bound.
    pub until: Option<f64>,
    /// Restrict to these entry kinds (search). An explicitly empty list matches nothing.
    pub kinds: Option<Vec<String>>,
    /// One hit per session (default true). `false` pages every matching entry.
    #[napi(js_name = "dedupe_by_session")]
    pub dedupe_by_session: Option<bool>,
    /// Largest snippet, in UTF-16 code units (default 240; the store's `maxSnippetChars`).
    #[napi(js_name = "max_snippet_chars")]
    pub max_snippet_chars: Option<f64>,
}

/// One query answer. `ok: false` carries the seam's error code and message instead of a payload.
#[napi(object)]
pub struct QueryResponse {
    /// Whether the operation ran.
    pub ok: bool,
    /// Complete result JSON (the seam result's own shape), or an empty string on failure.
    #[napi(js_name = "payload_json")]
    pub payload_json: String,
    /// `SESSIONGRAPH_*` code when `ok` is false.
    #[napi(js_name = "error_code")]
    pub error_code: Option<String>,
    /// Human-readable failure reason when `ok` is false.
    #[napi(js_name = "error_message")]
    pub error_message: Option<String>,
}

/// One pending query, executed on libuv's thread pool so it never blocks the JavaScript thread.
pub struct QueryTask {
    request: QueryRequest,
}

impl QueryTask {
    /// Wrap one request for the native worker.
    pub fn new(request: QueryRequest) -> Self {
        Self { request }
    }
}

impl Task for QueryTask {
    type Output = QueryResponse;
    type JsValue = QueryResponse;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(answer(&self.request))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Answer one request without ever throwing across the boundary: a failure becomes `ok: false`.
pub fn answer(request: &QueryRequest) -> QueryResponse {
    match run(request) {
        Ok(payload) => QueryResponse {
            ok: true,
            payload_json: serde_json::to_string(&payload)
                .unwrap_or_else(|_| String::from(r#"{"operation":"error"}"#)),
            error_code: None,
            error_message: None,
        },
        Err(error) => QueryResponse {
            ok: false,
            payload_json: String::new(),
            error_code: Some(error.code.to_owned()),
            error_message: Some(error.message),
        },
    }
}

/// Dispatch one request to its operation.
pub fn run(request: &QueryRequest) -> QResult<Value> {
    if request.index_root.trim().is_empty() {
        return Err(invalid("indexRoot is required"));
    }
    match request.operation.as_str() {
        "search" => {
            let connection = open_index(&request.index_root)?;
            search(&connection, request)
        }
        "session" => {
            let connection = open_index(&request.index_root)?;
            session(&connection, request)
        }
        "event" => {
            let connection = open_index(&request.index_root)?;
            event(&connection, request)
        }
        "trace" => {
            let connection = open_index(&request.index_root)?;
            trace(&connection, request)
        }
        "timeline" => {
            let connection = open_index(&request.index_root)?;
            timeline(&connection, request)
        }
        "workspaces" => {
            let connection = open_index(&request.index_root)?;
            workspaces(&connection, request)
        }
        // `status` is the one operation that answers when no index exists.
        "status" => status(&request.index_root),
        other => Err(invalid(format!(
            "unknown sessiongraph operation \"{other}\""
        ))),
    }
}

// ---------------------------------------------------------------------------------------------
// Opening and validating the index
// ---------------------------------------------------------------------------------------------

fn database_path(index_root: &str) -> PathBuf {
    Path::new(index_root).join(INDEX_FILE)
}

/// Open one index read-only and verify it was written at the schema version this kernel reads.
///
/// Mirrors `openIndex` in `packages/sqlite/src/database.ts`: a file that is not SQLite, records no
/// schema version, or records another one is `SESSIONGRAPH_CORRUPT`, never a silent empty database.
fn open_index(index_root: &str) -> QResult<Connection> {
    let path = database_path(index_root);
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        corrupt(format!(
            "cannot open the session-graph index at \"{}\" ({error})",
            path.display()
        ))
    })?;
    // A rebuild replaces the file by rename, so a reader can hold an old inode; polling is not this
    // kernel's job (the store re-opens per query), but a reader must not block a writer either.
    let version: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![write::META_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| corrupt(format!("read the schema version: {error}")))?;
    let version = match version {
        Some(value) => value.parse::<i64>().ok(),
        None => None,
    };
    let version = match version {
        Some(version) => version,
        None => {
            return Err(corrupt(
                "the session-graph index records no readable schema version",
            ))
        }
    };
    if version != write::SCHEMA_VERSION {
        return Err(corrupt(format!(
            "the session-graph index at \"{}\" is schema version {version}; this kernel reads version {}",
            path.display(),
            write::SCHEMA_VERSION
        )));
    }
    // The ranking scan touches FTS docsize pages across the whole index; a memory map turns those
    // into page-cache hits instead of copies into SQLite's small default cache. Read-only, no WAL.
    let _ = connection.execute_batch("PRAGMA mmap_size=268435456; PRAGMA cache_size=-16000;");
    Ok(connection)
}

// ---------------------------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------------------------

/// One matched entry, as the lightweight ranking scan needs it: no `text`, no session metadata.
struct MatchRow {
    id: i64,
    session_id: String,
    kind: String,
    time: i64,
    seq: i64,
    /// Raw FTS5 `bm25`: negative, more negative is better.
    score: f64,
}

impl MatchRow {
    /// Weighted score: FTS5's `bm25` is negative, so dividing by a larger weight ranks that kind lower.
    fn weighted(&self) -> f64 {
        self.score / kind_weight(&self.kind)
    }
}

/// Rank weight per entry kind, shared with the TypeScript store.
fn kind_weight(kind: &str) -> f64 {
    match kind {
        "user" => 1.0,
        "title" => 1.1,
        "assistant" => 1.2,
        "tool" => 1.5,
        _ => 1.0,
    }
}

/// Whether `candidate` sorts before `current` under the per-session strength order
/// `bm25 ASC, time DESC, entry_id ASC`.
fn beats(candidate: &MatchRow, current: &MatchRow) -> bool {
    match candidate.score.partial_cmp(&current.score) {
        Some(Ordering::Less) => true,
        Some(Ordering::Greater) => false,
        _ => {
            if candidate.time != current.time {
                candidate.time > current.time
            } else {
                candidate.id < current.id
            }
        }
    }
}

/// Compare two f64 scores exactly (both come from SQLite; NaN never occurs).
fn cmp_score(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

/// Deduped cross-session order: weighted score, newest, smallest seq, smallest entry id.
fn cmp_ranked(left: &MatchRow, right: &MatchRow) -> Ordering {
    cmp_score(left.weighted(), right.weighted())
        .then_with(|| right.time.cmp(&left.time))
        .then_with(|| left.seq.cmp(&right.seq))
        .then_with(|| left.id.cmp(&right.id))
}

/// Un-deduped order: weighted score, newest, smallest entry id.
fn cmp_plain(left: &MatchRow, right: &MatchRow) -> Ordering {
    cmp_score(left.weighted(), right.weighted())
        .then_with(|| right.time.cmp(&left.time))
        .then_with(|| left.id.cmp(&right.id))
}

/// One page row read back with the columns a hit reports.
struct HitDetail {
    session_id: String,
    title: Option<String>,
    workspace: String,
    time: i64,
    kind: String,
    seq: i64,
    turn: Option<i64>,
    text: String,
}

/// Full-text search across indexed history.
fn search(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let query = request.query.as_deref().unwrap_or("");
    let Some(match_expression) = match_expression(query) else {
        // A query with no searchable token cannot match anything, and `entry_fts MATCH ''` is a
        // syntax error rather than "zero rows"; the empty answer is the honest one.
        return Ok(search_result(Vec::new(), 0, false));
    };
    if let Some(kinds) = &request.kinds {
        // An explicitly empty `kinds` list means "none of them", not "no filter".
        if kinds.is_empty() {
            return Ok(search_result(Vec::new(), 0, false));
        }
    }

    // One read transaction so the ranking scan and the page read-back see the same snapshot.
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| corrupt(format!("begin search: {error}")))?;
    let matches = scan_matches(&transaction, request, &match_expression)?;

    let dedupe = request.dedupe_by_session != Some(false);
    let ranked = if dedupe {
        rank_deduped(matches)
    } else {
        let mut rows = matches;
        rows.sort_by(cmp_plain);
        rows
    };
    let total = ranked.len();
    let limit = bound(request.limit);
    let offset = bound(request.offset);
    let page: Vec<&MatchRow> = if limit == 0 {
        Vec::new()
    } else {
        ranked.iter().skip(offset).take(limit).collect()
    };

    let ids: Vec<i64> = page.iter().map(|row| row.id).collect();
    let details = read_hit_details(&transaction, &ids)?;
    transaction
        .commit()
        .map_err(|error| corrupt(format!("end search: {error}")))?;

    let terms = highlight_terms(query);
    let cap = max_snippet_chars(request);
    let mut clipped = false;
    let mut hits = Vec::with_capacity(page.len());
    for row in &page {
        let Some(detail) = details.get(&row.id) else {
            return Err(corrupt(
                "the index changed while it was being read; a matched entry disappeared",
            ));
        };
        validate_kind(&detail.kind)?;
        let units: Vec<u16> = detail.text.encode_utf16().collect();
        let rendered = render_snippet(&units, &terms, cap);
        if rendered.clipped {
            clipped = true;
        }
        let mut hit = Map::new();
        hit.insert("sessionId".to_owned(), json!(detail.session_id));
        if let Some(title) = optional_text(&detail.title) {
            hit.insert("title".to_owned(), json!(title));
        }
        hit.insert("workspace".to_owned(), json!(detail.workspace));
        hit.insert("time".to_owned(), json!(detail.time));
        hit.insert("kind".to_owned(), json!(detail.kind));
        hit.insert("seq".to_owned(), json!(detail.seq));
        if let Some(turn) = detail.turn {
            hit.insert("turn".to_owned(), json!(turn));
        }
        hit.insert("snippet".to_owned(), json!(rendered.snippet));
        hit.insert("length".to_owned(), json!(units.len()));
        hits.push(Value::Object(hit));
    }
    let truncated = total as i64 > (offset as i64 + hits.len() as i64) || clipped;
    Ok(search_result(hits, total as i64, truncated))
}

/// Build the FTS5 MATCH expression for a query: deduplicated tokens, quoted, joined with `AND`.
fn match_expression(query: &str) -> Option<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut tokens: Vec<String> = Vec::new();
    for token in tokenize::tokenize(query) {
        if seen.insert(token.clone()) {
            tokens.push(token);
        }
    }
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// Tokenized query terms, longest first, for snippet highlighting (the TS `highlightTerms`).
fn highlight_terms(query: &str) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    for token in tokenize::tokenize(query) {
        if seen.insert(token.clone()) {
            terms.push(token);
        }
    }
    // Stable sort, exactly like `Array.prototype.sort` on equal lengths.
    terms.sort_by(|left, right| {
        right
            .encode_utf16()
            .count()
            .cmp(&left.encode_utf16().count())
    });
    terms
}

/// Scan every match with the ranking columns only.
fn scan_matches(
    connection: &Connection,
    request: &QueryRequest,
    match_expression: &str,
) -> QResult<Vec<MatchRow>> {
    let mut filters: Vec<String> = vec!["entry_fts MATCH ?".to_owned()];
    let mut values: Vec<SqlValue> = vec![SqlValue::Text(match_expression.to_owned())];

    if let Some(session_id) = &request.session_id {
        filters.push("e.session_id = ?".to_owned());
        values.push(SqlValue::Text(resolve_session_id(
            connection,
            session_id,
            SessionReference::SearchFilter,
        )?));
    }
    if let Some(kinds) = &request.kinds {
        let placeholders = vec!["?"; kinds.len()].join(", ");
        filters.push(format!("e.kind IN ({placeholders})"));
        for kind in kinds {
            values.push(SqlValue::Text(kind.clone()));
        }
    }
    if let Some((clause, value)) = workspace_clause("w.workspace", request.workspace.as_deref()) {
        filters.push(format!(
            "EXISTS (SELECT 1 FROM session w WHERE w.id = e.session_id AND {clause})"
        ));
        values.push(SqlValue::Text(value));
    }
    if let Some(since) = request_int(request.since) {
        filters.push("e.time >= ?".to_owned());
        values.push(SqlValue::Integer(since));
    }
    if let Some(until) = request_int(request.until) {
        filters.push("e.time <= ?".to_owned());
        values.push(SqlValue::Integer(until));
    }

    let sql = format!(
        "SELECT e.id, e.session_id, e.kind, e.time, e.seq, bm25(entry_fts) AS score
           FROM entry_fts JOIN entry e ON e.id = entry_fts.rowid
          WHERE {}",
        filters.join(" AND ")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| corrupt(format!("search: {error}")))?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| {
            Ok(MatchRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                kind: row.get(2)?,
                time: row.get(3)?,
                seq: row.get(4)?,
                score: row.get(5)?,
            })
        })
        .map_err(|error| corrupt(format!("search: {error}")))?;
    let mut matches = Vec::new();
    for row in rows {
        matches.push(row.map_err(|error| corrupt(format!("search: {error}")))?);
    }
    Ok(matches)
}

/// One strongest entry per session, ordered across sessions.
fn rank_deduped(matches: Vec<MatchRow>) -> Vec<MatchRow> {
    let mut best: HashMap<String, MatchRow> = HashMap::new();
    for row in matches {
        match best.get(&row.session_id) {
            Some(current) if !beats(&row, current) => {}
            _ => {
                best.insert(row.session_id.clone(), row);
            }
        }
    }
    let mut ranked: Vec<MatchRow> = best.into_values().collect();
    ranked.sort_by(cmp_ranked);
    ranked
}

/// Read the page's entry texts and session metadata by id, in chunks that fit SQLite's bound-parameter cap.
fn read_hit_details(connection: &Connection, ids: &[i64]) -> QResult<HashMap<i64, HitDetail>> {
    let mut details: HashMap<i64, HitDetail> = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(ID_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT e.id, e.session_id, s.title, s.workspace, e.time, e.kind, e.seq, e.turn, e.text
               FROM entry e JOIN session s ON s.id = e.session_id
              WHERE e.id IN ({placeholders})"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| corrupt(format!("read search page: {error}")))?;
        let values: Vec<SqlValue> = chunk.iter().map(|id| SqlValue::Integer(*id)).collect();
        let rows = statement
            .query_map(params_from_iter(values.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    HitDetail {
                        session_id: row.get(1)?,
                        title: row.get(2)?,
                        workspace: row.get(3)?,
                        time: row.get(4)?,
                        kind: row.get(5)?,
                        seq: row.get(6)?,
                        turn: row.get(7)?,
                        text: row.get(8)?,
                    },
                ))
            })
            .map_err(|error| corrupt(format!("read search page: {error}")))?;
        // Keyed by the row's own `e.id`: SQLite returns these rows in rowid order, not in the order
        // the ids were bound, so pairing by position would hand each rank another entry's text.
        for row in rows {
            let (id, detail) =
                row.map_err(|error| corrupt(format!("read search page: {error}")))?;
            details.insert(id, detail);
        }
    }
    Ok(details)
}

/// The empty/filled search result envelope.
fn search_result(hits: Vec<Value>, total: i64, truncated: bool) -> Value {
    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("search"));
    map.insert("hits".to_owned(), Value::Array(hits));
    map.insert("total".to_owned(), json!(total));
    map.insert("truncated".to_owned(), json!(truncated));
    Value::Object(map)
}

// ---------------------------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------------------------

/// Read one session's metadata, a page of its entries in chronological order, and its children.
fn session(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let id = resolve_session_id(
        connection,
        request.session_id.as_deref().unwrap_or(""),
        SessionReference::Read,
    )?;
    let summary = read_session_row(connection, &id)?;
    let limit = bound(request.limit);
    let offset = bound(request.offset);
    let total = count(
        connection,
        "SELECT count(*) FROM entry WHERE session_id = ?1",
        params![id],
    )?;

    let mut entries: Vec<Value> = Vec::new();
    if limit > 0 {
        let mut statement = connection
            .prepare(
                "SELECT seq, time, kind, turn, text, clipped FROM entry
                  WHERE session_id = ?1 ORDER BY seq ASC LIMIT ?2 OFFSET ?3",
            )
            .map_err(|error| corrupt(format!("session entries: {error}")))?;
        let rows = statement
            .query_map(params![id, as_sql_int(limit), as_sql_int(offset)], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)? != 0,
                ))
            })
            .map_err(|error| corrupt(format!("session entries: {error}")))?;
        for row in rows {
            let (seq, time, kind, turn, text, clipped) =
                row.map_err(|error| corrupt(format!("session entries: {error}")))?;
            validate_kind(&kind)?;
            entries.push(entry_json(seq, time, &kind, turn, &text, clipped));
        }
    }

    let children = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM session WHERE parent_session = ?1
                  ORDER BY created_at ASC, id ASC",
            )
            .map_err(|error| corrupt(format!("session children: {error}")))?;
        let rows = statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| corrupt(format!("session children: {error}")))?;
        let mut children = Vec::new();
        for row in rows {
            children.push(Value::String(
                row.map_err(|error| corrupt(format!("session children: {error}")))?,
            ));
        }
        children
    };

    let truncated = total > offset as i64 + entries.len() as i64;
    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("session"));
    map.insert("session".to_owned(), session_summary_json(&summary));
    map.insert("entries".to_owned(), Value::Array(entries));
    map.insert("children".to_owned(), Value::Array(children));
    map.insert("truncated".to_owned(), json!(truncated));
    Ok(Value::Object(map))
}

/// One entry, as the session operation reports it.
fn entry_json(
    seq: i64,
    time: i64,
    kind: &str,
    turn: Option<i64>,
    text: &str,
    clipped: bool,
) -> Value {
    let mut map = Map::new();
    map.insert("seq".to_owned(), json!(seq));
    map.insert("time".to_owned(), json!(time));
    map.insert("kind".to_owned(), json!(kind));
    if let Some(turn) = turn {
        map.insert("turn".to_owned(), json!(turn));
    }
    map.insert("text".to_owned(), json!(text));
    map.insert("clipped".to_owned(), json!(clipped));
    Value::Object(map)
}

// ---------------------------------------------------------------------------------------------
// event
// ---------------------------------------------------------------------------------------------

/// Read one unabridged event, plus a window of its neighbours, from the session's source log.
fn event(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let id = resolve_session_id(
        connection,
        request.session_id.as_deref().unwrap_or(""),
        SessionReference::Read,
    )?;
    let summary = read_session_row(connection, &id)?;
    let seq = request
        .seq
        .ok_or_else(|| invalid("seq is required for the event operation"))?;
    let seq = request_int(Some(seq)).unwrap_or(0);
    let log = read_raw_log(connection, &id)?;
    let Some(index) = log.events.iter().position(|candidate| candidate.seq == seq) else {
        return Err(not_found(format!(
            "session \"{id}\" has no event at seq {seq}"
        )));
    };
    let before_count = bound(request.window_before);
    let after_count = bound(request.window_after);
    let before_start = index.saturating_sub(before_count);
    let after_end = index
        .saturating_add(1)
        .saturating_add(after_count)
        .min(log.events.len());
    let before: Vec<Value> = log.events[before_start..index]
        .iter()
        .map(raw_event_summary_json)
        .collect();
    let after: Vec<Value> = log.events[index + 1..after_end]
        .iter()
        .map(raw_event_summary_json)
        .collect();

    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("event"));
    map.insert("session".to_owned(), session_summary_json(&summary));
    map.insert("event".to_owned(), raw_event_json(&log.events[index]));
    map.insert("before".to_owned(), Value::Array(before));
    map.insert("after".to_owned(), Value::Array(after));
    Ok(Value::Object(map))
}

// ---------------------------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------------------------

/// Follow a session's lineage, or one event's replacement and citation relationships.
fn trace(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let id = resolve_session_id(
        connection,
        request.session_id.as_deref().unwrap_or(""),
        SessionReference::Read,
    )?;
    match request.seq {
        Some(seq) => trace_event(connection, &id, request_int(Some(seq)).unwrap_or(0)),
        None => trace_session_chain(connection, &id, request.depth),
    }
}

/// Trace one event: its replacements, what it shadowed, and the sources it cites.
fn trace_event(connection: &Connection, id: &str, seq: i64) -> QResult<Value> {
    let summary = read_session_row(connection, id)?;
    let log = read_raw_log(connection, id)?;
    let Some(event) = log.events.iter().find(|candidate| candidate.seq == seq) else {
        return Err(not_found(format!(
            "session \"{id}\" has no event at seq {seq}"
        )));
    };
    let fold = fold_raw_surface(&log.events);
    let mut replaced_by: Vec<Value> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::from([seq]);
    let mut next = fold.replaced_by.get(&seq).copied();
    while let Some(value) = next {
        if seen.contains(&value) || replaced_by.len() >= log.events.len() {
            break;
        }
        replaced_by.push(json!(value));
        seen.insert(value);
        next = fold.replaced_by.get(&value).copied();
    }
    let shadowed: Vec<Value> = fold
        .shadowed
        .get(&seq)
        .map(|seqs| seqs.iter().map(|value| json!(value)).collect())
        .unwrap_or_default();
    let sources: Vec<Value> = event.source_seqs.iter().map(|value| json!(value)).collect();

    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("trace"));
    map.insert("kind".to_owned(), json!("event"));
    map.insert("session".to_owned(), session_summary_json(&summary));
    map.insert("event".to_owned(), raw_event_summary_json(event));
    map.insert("replacedBy".to_owned(), Value::Array(replaced_by));
    map.insert("shadowedSeqs".to_owned(), Value::Array(shadowed));
    map.insert("sourceEventSeqs".to_owned(), Value::Array(sources));
    Ok(Value::Object(map))
}

/// Trace one session: its ancestor chain and descendant tree.
fn trace_session_chain(
    connection: &Connection,
    id: &str,
    requested_depth: Option<f64>,
) -> QResult<Value> {
    let target = read_session_row(connection, id)?;
    let depth = match requested_depth {
        None => MAX_LINEAGE_DEPTH,
        Some(value) => bound(Some(value)).min(MAX_LINEAGE_DEPTH),
    };

    let ancestor_rows = lineage_rows(
        connection,
        &format!(
            "WITH RECURSIVE ancestry(id, parent_session, depth) AS (
               SELECT id, parent_session, 0 FROM session WHERE id = ?1
               UNION ALL
               SELECT s.id, s.parent_session, a.depth + 1
                 FROM session s JOIN ancestry a ON s.id = a.parent_session
                WHERE a.depth < ?2
             )
             SELECT {SESSION_COLUMNS_S}, a.depth AS depth
               FROM session s JOIN ancestry a ON a.id = s.id
              WHERE a.depth > 0
              ORDER BY a.depth ASC"
        ),
        params![id, as_sql_int(MAX_LINEAGE_DEPTH)],
    )?;
    let mut ancestors: Vec<SessionRow> = Vec::new();
    let mut seen_ancestors: HashSet<String> = HashSet::new();
    let mut ancestors_complete = true;
    for (row, _) in ancestor_rows {
        if !seen_ancestors.insert(row.id.clone()) {
            // A cycle in the log's lineage links: stop where it closes instead of listing twice.
            ancestors_complete = false;
            break;
        }
        ancestors.push(row);
    }
    if optional_text(&target.parent_session).is_some() {
        // A held `parent_session` that is not in the index means the parent exists somewhere this
        // index cannot see, so "no ancestors" must not read as "this is a root".
        ancestors_complete = match ancestors.last() {
            Some(nearest) => optional_text(&nearest.parent_session).is_none(),
            None => false,
        };
    }

    let descendant_rows = lineage_rows(
        connection,
        &format!(
            "WITH RECURSIVE lineage(id, depth) AS (
               SELECT id, 0 FROM session WHERE id = ?1
               UNION ALL
               SELECT s.id, l.depth + 1
                 FROM session s JOIN lineage l ON s.parent_session = l.id
                WHERE l.depth < ?2
             )
             SELECT {SESSION_COLUMNS_S}, l.depth AS depth
               FROM session s JOIN lineage l ON l.id = s.id
              WHERE l.depth > 0
              ORDER BY l.depth ASC, s.created_at ASC, s.id ASC"
        ),
        params![id, as_sql_int(depth)],
    )?;

    // Flat arena: rows are ordered by depth, then creation order, so a parent always precedes its
    // children and can be looked up by id.
    let mut nodes: Vec<SessionRow> = Vec::new();
    let mut child_indices: Vec<Vec<usize>> = Vec::new();
    let mut node_index: HashMap<String, usize> = HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut seen_descendants: HashSet<String> = HashSet::from([id.to_owned()]);
    let mut deepest = 0usize;
    let mut descendants_complete = true;
    for (row, row_depth) in descendant_rows {
        if !seen_descendants.insert(row.id.clone()) {
            descendants_complete = false;
            continue;
        }
        let index = nodes.len();
        node_index.insert(row.id.clone(), index);
        let parent = row
            .parent_session
            .as_deref()
            .and_then(|parent_id| node_index.get(parent_id).copied());
        match parent {
            Some(parent_index) => child_indices[parent_index].push(index),
            None => roots.push(index),
        }
        nodes.push(row);
        child_indices.push(Vec::new());
        deepest = deepest.max(row_depth.max(0) as usize);
    }

    // A walk that reached its bound may have stopped short: ask whether anything hangs below the
    // deepest level returned. `depth: 0` has no returned level, so its frontier is the target.
    let frontier: Vec<String> = if depth == 0 {
        vec![id.to_owned()]
    } else if deepest >= depth {
        node_index.keys().cloned().collect()
    } else {
        Vec::new()
    };
    if !frontier.is_empty() {
        let placeholders = vec!["?"; frontier.len()].join(", ");
        let values: Vec<SqlValue> = frontier
            .iter()
            .map(|value| SqlValue::Text(value.clone()))
            .collect();
        let below = count(
            connection,
            &format!("SELECT count(*) FROM session WHERE parent_session IN ({placeholders})"),
            params_from_iter(values.iter()),
        )?;
        if below > 0 {
            descendants_complete = false;
        }
    }

    let descendants: Vec<Value> = roots
        .iter()
        .map(|&index| trace_node_json(&nodes, &child_indices, index))
        .collect();

    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("trace"));
    map.insert("kind".to_owned(), json!("session"));
    map.insert("target".to_owned(), session_summary_json(&target));
    map.insert(
        "ancestors".to_owned(),
        Value::Array(ancestors.iter().map(session_summary_json).collect()),
    );
    map.insert("descendants".to_owned(), Value::Array(descendants));
    map.insert(
        "complete".to_owned(),
        json!(ancestors_complete && descendants_complete),
    );
    Ok(Value::Object(map))
}

/// One recursive-lineage result row: the session columns plus the walk depth.
fn lineage_rows<P>(
    connection: &Connection,
    sql: &str,
    parameters: P,
) -> QResult<Vec<(SessionRow, i64)>>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| corrupt(format!("trace: {error}")))?;
    let rows = statement
        .query_map(parameters, |row| {
            Ok((session_row_at(row, 0)?, row.get::<_, i64>(10)?))
        })
        .map_err(|error| corrupt(format!("trace: {error}")))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|error| corrupt(format!("trace: {error}")))?);
    }
    Ok(out)
}

/// One descendant node and everything below it.
fn trace_node_json(nodes: &[SessionRow], children: &[Vec<usize>], index: usize) -> Value {
    let mut map = Map::new();
    map.insert("session".to_owned(), session_summary_json(&nodes[index]));
    let descendants: Vec<Value> = children[index]
        .iter()
        .map(|&child| trace_node_json(nodes, children, child))
        .collect();
    map.insert("descendants".to_owned(), Value::Array(descendants));
    Value::Object(map)
}

// ---------------------------------------------------------------------------------------------
// timeline / workspaces / status
// ---------------------------------------------------------------------------------------------

/// List sessions newest-first by last activity.
fn timeline(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let limit = bound(request.limit);
    if limit == 0 {
        return Ok(envelope(vec![
            ("operation", json!("timeline")),
            ("sessions", json!([])),
            ("truncated", json!(false)),
        ]));
    }
    let mut filters: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some((clause, value)) = workspace_clause("s.workspace", request.workspace.as_deref()) {
        filters.push(clause);
        values.push(SqlValue::Text(value));
    }
    // `since`/`until` describe the session's span, not an entry's time.
    if let Some(since) = request_int(request.since) {
        filters.push("s.last_at >= ?".to_owned());
        values.push(SqlValue::Integer(since));
    }
    if let Some(until) = request_int(request.until) {
        filters.push("s.created_at <= ?".to_owned());
        values.push(SqlValue::Integer(until));
    }
    let where_clause = if filters.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filters.join(" AND "))
    };
    // One extra row distinguishes "exactly `limit` sessions" from "there are more".
    values.push(SqlValue::Integer(as_sql_int(limit.saturating_add(1))));
    let sql = format!(
        "SELECT {SESSION_COLUMNS_S} FROM session s {where_clause}
          ORDER BY s.last_at DESC, s.id ASC LIMIT ?"
    );
    let rows = session_rows(connection, &sql, params_from_iter(values.iter()))?;
    let truncated = rows.len() > limit;
    let sessions: Vec<Value> = rows
        .into_iter()
        .take(limit)
        .map(|row| session_summary_json(&row))
        .collect();
    Ok(envelope(vec![
        ("operation", json!("timeline")),
        ("sessions", Value::Array(sessions)),
        ("truncated", json!(truncated)),
    ]))
}

/// Enumerate indexed workspaces, most recently active first.
fn workspaces(connection: &Connection, request: &QueryRequest) -> QResult<Value> {
    let total = count(
        connection,
        "SELECT count(DISTINCT workspace) FROM session",
        [],
    )?;
    let limit = bound(request.limit);
    let mut stats: Vec<Value> = Vec::new();
    if limit > 0 {
        let mut statement = connection
            .prepare(
                "SELECT workspace, count(*) AS sessions, COALESCE(sum(entries), 0) AS entries,
                        min(created_at) AS first_at, max(last_at) AS last_at
                   FROM session
                  GROUP BY workspace
                  ORDER BY max(last_at) DESC, workspace ASC
                  LIMIT ?1",
            )
            .map_err(|error| corrupt(format!("workspaces: {error}")))?;
        let rows = statement
            .query_map(params![as_sql_int(limit)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| corrupt(format!("workspaces: {error}")))?;
        for row in rows {
            let (workspace, sessions, entries, first_at, last_at) =
                row.map_err(|error| corrupt(format!("workspaces: {error}")))?;
            stats.push(envelope(vec![
                ("workspace", json!(workspace)),
                ("sessions", json!(sessions)),
                ("entries", json!(entries)),
                ("firstAt", json!(first_at)),
                ("lastAt", json!(last_at)),
            ]));
        }
    }
    Ok(envelope(vec![
        ("operation", json!("workspaces")),
        ("workspaces", Value::Array(stats)),
        ("total", json!(total)),
    ]))
}

/// Report the index's own state. Unlike every other operation, this answers when no index exists.
fn status(index_root: &str) -> QResult<Value> {
    let path = database_path(index_root);
    let bytes = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(_) => {
            return Ok(envelope(vec![
                ("operation", json!("status")),
                ("indexed", json!(false)),
                ("indexPath", json!(path.to_string_lossy())),
                ("sessions", json!(0)),
                ("liveSessions", json!(0)),
                ("entries", json!(0)),
                ("workspaces", json!(0)),
                ("bytes", json!(0)),
            ]))
        }
    };
    let connection = open_index(index_root)?;
    let sessions = count(&connection, "SELECT count(*) FROM session", [])?;
    let live_sessions = count(
        &connection,
        "SELECT count(*) FROM session WHERE source_path LIKE ?1",
        params![format!("{LIVE_SOURCE_PREFIX}%")],
    )?;
    let entries = count(&connection, "SELECT count(*) FROM entry", [])?;
    let workspaces = count(
        &connection,
        "SELECT count(DISTINCT workspace) FROM session",
        [],
    )?;
    let indexed_at: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![write::META_INDEXED_AT],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| corrupt(format!("status: {error}")))?;
    let indexed_at = indexed_at
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite());

    let mut map = Map::new();
    map.insert("operation".to_owned(), json!("status"));
    map.insert("indexed".to_owned(), json!(true));
    map.insert("indexPath".to_owned(), json!(path.to_string_lossy()));
    map.insert("sessions".to_owned(), json!(sessions));
    map.insert("liveSessions".to_owned(), json!(live_sessions));
    map.insert("entries".to_owned(), json!(entries));
    map.insert("workspaces".to_owned(), json!(workspaces));
    if let Some(indexed_at) = indexed_at {
        map.insert(
            "indexedAt".to_owned(),
            if indexed_at.fract() == 0.0 {
                json!(indexed_at as i64)
            } else {
                json!(indexed_at)
            },
        );
    }
    map.insert("bytes".to_owned(), json!(bytes));
    Ok(Value::Object(map))
}

// ---------------------------------------------------------------------------------------------
// Session resolution and row mapping
// ---------------------------------------------------------------------------------------------

/// Which of the two resolution policies a session reference is read under.
#[derive(Clone, Copy)]
enum SessionReference {
    /// `session`/`event`/`trace`: an ambiguous prefix is a miss (`SESSIONGRAPH_NOT_FOUND`).
    Read,
    /// A search's session filter: an ambiguous prefix is a bad request.
    SearchFilter,
}

/// Resolve a full session id or an unambiguous prefix.
///
/// An exact id always wins, even when it is also a prefix of another id. A prefix naming several
/// sessions is refused rather than guessed.
fn resolve_session_id(
    connection: &Connection,
    wanted: &str,
    policy: SessionReference,
) -> QResult<String> {
    let reference = wanted.trim();
    if reference.is_empty() {
        return Err(match policy {
            SessionReference::Read => not_found("a session id must be a non-empty string"),
            SessionReference::SearchFilter => {
                invalid("a session id filter must be a non-empty string")
            }
        });
    }
    let exact: Option<String> = connection
        .query_row(
            "SELECT id FROM session WHERE id = ?1",
            params![reference],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| corrupt(format!("resolve session: {error}")))?;
    if let Some(id) = exact {
        return Ok(id);
    }
    let pattern = format!("{}%", escape_like(reference));
    let mut statement = connection
        .prepare(
            "SELECT id FROM session WHERE id LIKE ?1 ESCAPE '\\'
              ORDER BY last_at DESC, id ASC LIMIT 8",
        )
        .map_err(|error| corrupt(format!("resolve session: {error}")))?;
    let rows = statement
        .query_map(params![pattern], |row| row.get::<_, String>(0))
        .map_err(|error| corrupt(format!("resolve session: {error}")))?;
    let mut candidates: Vec<String> = Vec::new();
    for row in rows {
        candidates.push(row.map_err(|error| corrupt(format!("resolve session: {error}")))?);
    }
    match candidates.len() {
        0 => Err(not_found(format!(
            "no indexed session matches \"{reference}\""
        ))),
        1 => Ok(candidates.remove(0)),
        _ => {
            let listing = candidates.join(", ");
            Err(match policy {
                SessionReference::Read => not_found(format!(
                    "session prefix \"{reference}\" is ambiguous; it matches several sessions: {listing}"
                )),
                SessionReference::SearchFilter => invalid(format!(
                    "session id filter \"{reference}\" is ambiguous; it matches several sessions: {listing}"
                )),
            })
        }
    }
}

/// Escape the wildcard characters in a string that becomes a `LIKE` pattern.
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Build the workspace predicate for one side of a query.
///
/// A path ending with `/` is a prefix filter; any other value is an exact `cwd` match.
fn workspace_clause(column: &str, workspace: Option<&str>) -> Option<(String, String)> {
    let workspace = workspace?;
    if workspace.is_empty() {
        return None;
    }
    if workspace.ends_with('/') {
        Some((
            format!("{column} LIKE ? ESCAPE '\\'"),
            format!("{}%", escape_like(workspace)),
        ))
    } else {
        Some((format!("{column} = ?"), workspace.to_owned()))
    }
}

/// One `session` row, as every result shape reports it.
struct SessionRow {
    id: String,
    workspace: String,
    title: Option<String>,
    created_at: i64,
    last_at: i64,
    parent_session: Option<String>,
    origin: Option<String>,
    agent_preset: Option<String>,
    turns: i64,
    entries: i64,
}

/// Read the ten session columns starting at `base` from a row.
fn session_row_at(row: &rusqlite::Row<'_>, base: usize) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(base)?,
        workspace: row.get(base + 1)?,
        title: row.get(base + 2)?,
        created_at: row.get(base + 3)?,
        last_at: row.get(base + 4)?,
        parent_session: row.get(base + 5)?,
        origin: row.get(base + 6)?,
        agent_preset: row.get(base + 7)?,
        turns: row.get(base + 8)?,
        entries: row.get(base + 9)?,
    })
}

/// Read one session's summary row.
fn read_session_row(connection: &Connection, id: &str) -> QResult<SessionRow> {
    connection
        .query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM session WHERE id = ?1"),
            params![id],
            |row| session_row_at(row, 0),
        )
        .optional()
        .map_err(|error| corrupt(format!("read session: {error}")))?
        .ok_or_else(|| not_found(format!("no indexed session matches \"{id}\"")))
}

/// Run a session-column query and map every row.
fn session_rows<P>(connection: &Connection, sql: &str, parameters: P) -> QResult<Vec<SessionRow>>
where
    P: rusqlite::Params,
{
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| corrupt(format!("session query: {error}")))?;
    let rows = statement
        .query_map(parameters, |row| session_row_at(row, 0))
        .map_err(|error| corrupt(format!("session query: {error}")))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|error| corrupt(format!("session query: {error}")))?);
    }
    Ok(out)
}

/// Build one session summary, omitting absent optional fields (the seam says `undefined`, and a
/// dropped key survives JSON while an explicit `null` would leak as the text "null").
fn session_summary_json(row: &SessionRow) -> Value {
    let mut map = Map::new();
    map.insert("sessionId".to_owned(), json!(row.id));
    if let Some(title) = optional_text(&row.title) {
        map.insert("title".to_owned(), json!(title));
    }
    map.insert("workspace".to_owned(), json!(row.workspace));
    map.insert("createdAt".to_owned(), json!(row.created_at));
    map.insert("lastAt".to_owned(), json!(row.last_at));
    map.insert("turns".to_owned(), json!(row.turns));
    map.insert("entries".to_owned(), json!(row.entries));
    if let Some(parent) = optional_text(&row.parent_session) {
        map.insert("parentSession".to_owned(), json!(parent));
    }
    if let Some(origin) = optional_text(&row.origin) {
        map.insert("origin".to_owned(), json!(origin));
    }
    if let Some(preset) = optional_text(&row.agent_preset) {
        map.insert("agentPreset".to_owned(), json!(preset));
    }
    Value::Object(map)
}

/// Absent when `None` or the empty string, like `optionalText` in the TS store.
fn optional_text(value: &Option<String>) -> Option<&str> {
    match value.as_deref() {
        Some(text) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// Refuse an entry kind this schema version does not define.
fn validate_kind(kind: &str) -> QResult<()> {
    match kind {
        "user" | "assistant" | "tool" | "title" => Ok(()),
        _ => Err(corrupt(format!(
            "an indexed entry has an unknown kind \"{kind}\""
        ))),
    }
}

// ---------------------------------------------------------------------------------------------
// Raw session logs (event / trace)
// ---------------------------------------------------------------------------------------------

/// One raw event, with the log's own fields preserved.
struct RawEvent {
    seq: i64,
    time: i64,
    event_type: String,
    /// The whole parsed line, so an absent `data` stays absent and a `null` data stays `null`.
    record: Value,
    /// Sequence numbers this event cites as sources, when the log records them.
    source_seqs: Vec<i64>,
    /// How the event enters the model surface (`'append'` or a `replace` marker).
    surface_op: Option<Value>,
}

/// One parsed session log, in ascending log order.
struct RawLog {
    events: Vec<RawEvent>,
}

/// The folded event surface and the replacement relationships the fold discovered.
struct SurfaceFold {
    replaced_by: HashMap<i64, i64>,
    shadowed: HashMap<i64, Vec<i64>>,
}

/// Read the source log an indexed session came from.
///
/// A live session (`live://` source) has no log yet; that is a real state, reported as
/// `SESSIONGRAPH_IO` rather than as a missing session.
fn read_raw_log(connection: &Connection, id: &str) -> QResult<RawLog> {
    let source: Option<String> = connection
        .query_row(
            "SELECT source_path FROM session WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| corrupt(format!("read session source: {error}")))?;
    let Some(source) = source else {
        return Err(not_found(format!("no indexed session matches \"{id}\"")));
    };
    if source.starts_with(LIVE_SOURCE_PREFIX) {
        return Err(io_error(format!(
            "session \"{id}\" is still running: its log is not on disk yet, so its raw events cannot be read"
        )));
    }
    let buffer = fs::read(&source).map_err(|error| {
        io_error(format!(
            "cannot read the source log of session \"{id}\" ({error})"
        ))
    })?;
    let raw = decompress_session_log(&buffer).map_err(|error| {
        io_error(format!(
            "cannot read the source log of session \"{id}\" ({error})"
        ))
    })?;
    Ok(parse_raw_events(&String::from_utf8_lossy(&raw)))
}

/// Parse decompressed JSONL into raw events, tolerating a corrupt line.
fn parse_raw_events(text: &str) -> RawLog {
    let lines: Vec<&str> = text.split('\n').collect();
    let first = lines.iter().position(|line| !line.trim().is_empty());
    let mut start = 0usize;
    if let Some(first) = first {
        let record = parse_record(lines[first].trim());
        if record
            .as_ref()
            .and_then(|record| record.get("type"))
            .and_then(Value::as_str)
            == Some("session")
        {
            start = first + 1;
        } else {
            start = first;
        }
    }
    let mut events: Vec<RawEvent> = Vec::new();
    for line in lines.iter().skip(start) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(record) = parse_record(line) else {
            continue;
        };
        let Some(seq) = number_i64(record.get("seq")) else {
            continue;
        };
        let Some(event_type) = record.get("type").and_then(Value::as_str) else {
            continue;
        };
        let time = number_i64(record.get("time")).unwrap_or(0);
        let source_seqs = match record.get("sourceEventSeqs") {
            Some(Value::Array(values)) => values.iter().filter_map(number_i64_value).collect(),
            _ => Vec::new(),
        };
        events.push(RawEvent {
            seq,
            time,
            event_type: event_type.to_owned(),
            surface_op: record.get("surfaceOp").cloned(),
            record,
            source_seqs,
        });
    }
    RawLog { events }
}

/// Parse one JSONL line into a JSON object, tolerating a corrupt line.
fn parse_record(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;
    value.is_object().then_some(value)
}

/// Read a finite numeric field, truncated to an integer (the log's sequence numbers and times).
fn number_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let float = value.as_f64()?;
    float.is_finite().then_some(float as i64)
}

fn number_i64_value(value: &Value) -> Option<i64> {
    number_i64(Some(value))
}

/// One event, unabridged.
fn raw_event_json(event: &RawEvent) -> Value {
    let mut map = Map::new();
    map.insert("seq".to_owned(), json!(event.seq));
    map.insert("time".to_owned(), json!(event.time));
    map.insert("type".to_owned(), json!(event.event_type));
    if let Some(data) = event.record.get("data") {
        map.insert("data".to_owned(), data.clone());
    }
    Value::Object(map)
}

/// One event reduced to its identity, for the window around a target.
fn raw_event_summary_json(event: &RawEvent) -> Value {
    let mut map = Map::new();
    map.insert("seq".to_owned(), json!(event.seq));
    map.insert("time".to_owned(), json!(event.time));
    map.insert("type".to_owned(), json!(event.event_type));
    Value::Object(map)
}

/// Fold a log's event surface, keeping every replacement relationship the fold discovers.
fn fold_raw_surface(events: &[RawEvent]) -> SurfaceFold {
    let mut nodes: Vec<i64> = Vec::new();
    let mut replaced_by: HashMap<i64, i64> = HashMap::new();
    let mut shadowed: HashMap<i64, Vec<i64>> = HashMap::new();
    for event in events {
        match &event.surface_op {
            Some(Value::String(op)) if op == "append" => {
                nodes.push(event.seq);
            }
            Some(Value::Object(marker)) => {
                if marker.get("op").and_then(Value::as_str) != Some("replace") {
                    continue;
                }
                let (Some(start_seq), Some(end_seq)) = (
                    number_i64(marker.get("startSeq")),
                    number_i64(marker.get("endSeq")),
                ) else {
                    continue;
                };
                // A replacement naming an event this reader did not put on the surface is skipped
                // rather than guessed at: an empty trace beats a wrong one.
                let (Some(start_index), Some(end_index)) = (
                    nodes.iter().position(|value| *value == start_seq),
                    nodes.iter().position(|value| *value == end_seq),
                ) else {
                    continue;
                };
                if start_index > end_index {
                    continue;
                }
                let removed: Vec<i64> = nodes[start_index..=end_index].to_vec();
                shadowed.insert(event.seq, removed.clone());
                for seq in &removed {
                    replaced_by.insert(*seq, event.seq);
                }
                nodes.splice(start_index..=end_index, std::iter::once(event.seq));
            }
            _ => {}
        }
    }
    SurfaceFold {
        replaced_by,
        shadowed,
    }
}

// ---------------------------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------------------------

/// One character span in UTF-16 code units, the unit JS string indices use.
#[derive(Debug, Clone, Copy)]
struct Span {
    start: usize,
    end: usize,
}

/// A rendered snippet and whether it is a window onto a longer entry.
struct RenderedSnippet {
    snippet: String,
    clipped: bool,
}

/// Whether two UTF-16 units match case-insensitively under the terms this tokenizer can produce.
///
/// Tokens are ASCII letters/digits or CJK ideographs. The TS regex is `/term/gi`, whose case folding
/// only matters across ASCII letters (CJK has no case), so comparing ASCII letters ignoring case and
/// everything else by identity is the faithful rule for these tokens.
fn unit_matches(left: u16, right: u16) -> bool {
    if left == right {
        return true;
    }
    let (left, right) = (left as u32, right as u32);
    if left < 128 && right < 128 {
        (left as u8).eq_ignore_ascii_case(&(right as u8))
    } else {
        false
    }
}

/// Every non-overlapping case-insensitive occurrence of `term` in `haystack`, in document order.
fn find_spans(haystack: &[u16], term: &[u16], spans: &mut Vec<Span>) {
    if term.is_empty() || term.len() > haystack.len() {
        return;
    }
    let mut at = 0usize;
    while at + term.len() <= haystack.len() {
        let matched = haystack[at..at + term.len()]
            .iter()
            .zip(term)
            .all(|(left, right)| unit_matches(*left, *right));
        if matched {
            spans.push(Span {
                start: at,
                end: at + term.len(),
            });
            at += term.len();
        } else {
            at += 1;
        }
    }
}

/// Sort spans and merge the ones that touch, so adjacent matched terms render as one bracketed run.
fn merge_spans(spans: &mut Vec<Span>) -> Vec<Span> {
    spans.sort_by(|left, right| left.start.cmp(&right.start).then(left.end.cmp(&right.end)));
    let mut merged: Vec<Span> = Vec::new();
    for span in spans.drain(..) {
        match merged.last_mut() {
            Some(last) if span.start <= last.end => {
                if span.end > last.end {
                    last.end = span.end;
                }
            }
            _ => merged.push(span),
        }
    }
    merged
}

/// The span the snippet window centres on: the longest query term that occurs, at its first match.
fn anchor_span(haystack: &[u16], terms: &[Vec<u16>]) -> Option<Span> {
    for term in terms {
        let mut spans = Vec::new();
        find_spans(haystack, term, &mut spans);
        if let Some(first) = spans.first() {
            return Some(*first);
        }
    }
    None
}

/// Cut a bounded excerpt around the first match and bracket every matched term inside it.
///
/// `max_chars` counts UTF-16 units, exactly like the TS `String.length`/`slice` arithmetic, so both
/// engines render the same window. Brackets are added afterwards and are not counted against the cap.
///
/// One cell of the TS behaviour is not representable here: `String.slice` can cut a surrogate pair
/// in half and leave a lone code unit, while a Rust `String` cannot hold one. That unit becomes
/// U+FFFD at the boundary. Only an emoji straddling the exact window edge hits this; the window and
/// its length are otherwise identical.
fn render_snippet(text: &[u16], terms: &[String], max_chars: usize) -> RenderedSnippet {
    let cap = max_chars.max(1);
    let needles: Vec<Vec<u16>> = terms
        .iter()
        .map(|term| term.encode_utf16().collect())
        .collect();
    let anchor = anchor_span(text, &needles);
    let anchor_length = anchor.map(|span| span.end - span.start).unwrap_or(0);
    let mut start = match anchor {
        Some(span) => {
            let shift = (cap.saturating_sub(anchor_length.min(cap))) / 2;
            span.start.saturating_sub(shift)
        }
        None => 0,
    };
    let furthest = text.len().saturating_sub(cap);
    start = start.min(furthest);
    let mut end = (start + cap).min(text.len());
    if let Some(span) = anchor {
        // A match longer than the cap cannot fit whole: show its start rather than a tail slice.
        if span.end > end {
            start = span.start;
            end = (span.start + cap).min(text.len());
        }
    }
    let excerpt = &text[start..end];
    let mut spans: Vec<Span> = Vec::new();
    for needle in &needles {
        find_spans(excerpt, needle, &mut spans);
    }
    let merged = merge_spans(&mut spans);
    let mut snippet = String::new();
    let mut cursor = 0usize;
    for span in merged {
        snippet.push_str(&String::from_utf16_lossy(&excerpt[cursor..span.start]));
        snippet.push('[');
        snippet.push_str(&String::from_utf16_lossy(&excerpt[span.start..span.end]));
        snippet.push(']');
        cursor = span.end;
    }
    snippet.push_str(&String::from_utf16_lossy(&excerpt[cursor..]));
    RenderedSnippet {
        snippet,
        clipped: start > 0 || end < text.len(),
    }
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

/// Coerce a request bound into a non-negative integer; absent or non-finite means `0`.
fn bound(value: Option<f64>) -> usize {
    match value {
        Some(value) if value.is_finite() => {
            let floored = value.floor();
            if floored <= 0.0 {
                0
            } else if floored >= usize::MAX as f64 {
                usize::MAX
            } else {
                floored as usize
            }
        }
        _ => 0,
    }
}

/// The snippet cap this kernel should use.
fn max_snippet_chars(request: &QueryRequest) -> usize {
    match request.max_snippet_chars {
        Some(value) if value.is_finite() => bound(Some(value)).max(1),
        _ => DEFAULT_MAX_SNIPPET_CHARS,
    }
}

/// Coerce a request number into a SQLite integer bound.
fn request_int(value: Option<f64>) -> Option<i64> {
    value.filter(|value| value.is_finite()).map(|value| {
        if value >= i64::MAX as f64 {
            i64::MAX
        } else if value <= i64::MIN as f64 {
            i64::MIN
        } else {
            value as i64
        }
    })
}

/// A `usize` as a SQLite integer bound.
fn as_sql_int(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Run one `count(*)`/`count(DISTINCT …)` statement.
fn count<P: rusqlite::Params>(connection: &Connection, sql: &str, parameters: P) -> QResult<i64> {
    connection
        .query_row(sql, parameters, |row| row.get(0))
        .map_err(|error| corrupt(format!("count: {error}")))
}

/// Build a JSON object, preserving insertion order (field order matches the seam's TS objects).
fn envelope(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::parse::{ParsedEntry, ParsedSession};
    use crate::write::{IndexedSession, WritePlan};

    /// A temporary directory removed on drop.
    struct Fixture {
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture() -> Fixture {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let sequence = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "sessiongraph-query-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create fixture directory");
        Fixture { dir }
    }

    fn entry(kind: &'static str, text: &str, seq: i64, time: i64) -> ParsedEntry {
        ParsedEntry {
            seq,
            time,
            turn: None,
            kind,
            text: text.to_owned(),
            clipped: false,
        }
    }

    fn parsed(id: &str, workspace: &str, entries: Vec<ParsedEntry>) -> ParsedSession {
        ParsedSession {
            id: id.to_owned(),
            cwd: workspace.to_owned(),
            created_at: entries.iter().map(|entry| entry.time).min().unwrap_or(0),
            last_at: entries.iter().map(|entry| entry.time).max().unwrap_or(0),
            title: None,
            parent_session: None,
            origin: None,
            agent_preset: None,
            turns: 0,
            entries,
        }
    }

    fn write_log(path: &Path, records: &[Value]) {
        let mut bytes = Vec::new();
        for record in records {
            let line = format!("{record}\n");
            bytes.extend_from_slice(&zstd::encode_all(line.as_bytes(), 3).expect("compress"));
        }
        fs::write(path, bytes).expect("write session log");
    }

    fn header(id: &str) -> Value {
        json!({"type": "session", "version": 4, "id": id, "createdAt": 1, "cwd": "/w"})
    }

    /// The shared fixture: text-bearing sessions, ambiguous prefixes, a lineage, and two raw logs.
    fn seed(fixture: &Fixture) -> PathBuf {
        let root = fixture.dir.join("index");
        let main_log = fixture.dir.join("main.jsonl.zstd");
        let replace_log = fixture.dir.join("replace.jsonl.zstd");
        write_log(
            &main_log,
            &[
                header("aaaa-1"),
                json!({"type": "user/message", "seq": 0, "time": 10,
                       "data": {"source": {"kind": "user"}, "content": [{"type": "text", "text": "hello"}]}}),
                json!({"type": "turn/start", "seq": 1, "time": 11, "data": {"turn": 1}}),
                json!({"type": "tool/call", "seq": 2, "time": 12,
                       "data": {"name": "read", "arguments": {"path": "/tmp/x"}}}),
                json!({"type": "assistant/message", "seq": 3, "time": 13,
                       "data": {"message": {"content": [{"type": "text", "text": "reply"}]}}}),
            ],
        );
        write_log(
            &replace_log,
            &[
                header("rep-0"),
                json!({"type": "user/message", "seq": 1, "time": 20, "surfaceOp": "append",
                       "sourceEventSeqs": [7, 8], "data": {"text": "one"}}),
                json!({"type": "user/message", "seq": 2, "time": 21, "surfaceOp": "append",
                       "data": {"text": "two"}}),
                json!({"type": "assistant/message", "seq": 3, "time": 22,
                       "surfaceOp": {"op": "replace", "startSeq": 1, "endSeq": 2},
                       "data": {"text": "three"}}),
                json!({"type": "assistant/message", "seq": 4, "time": 23,
                       "surfaceOp": {"op": "replace", "startSeq": 3, "endSeq": 3},
                       "data": {"text": "four"}}),
            ],
        );

        let mut sessions = vec![
            IndexedSession {
                session: parsed(
                    "aaaa-1",
                    "/w1",
                    vec![
                        entry("user", "广告 一号", 0, 10),
                        entry("assistant", "广告 二号", 1, 20),
                        entry("tool", "广告 三号", 2, 30),
                    ],
                ),
                source_path: main_log.to_string_lossy().into_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: parsed("bbbb-2", "/w2", vec![entry("user", "广告 四号", 0, 40)]),
                source_path: fixture
                    .dir
                    .join("bbbb.jsonl.zstd")
                    .to_string_lossy()
                    .into_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: parsed("dup-a1", "/w1", Vec::new()),
                source_path: "dup-a1".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: parsed("dup-a2", "/w1", Vec::new()),
                source_path: "dup-a2".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: parsed("solo-9", "/w2", Vec::new()),
                source_path: "solo-9".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: {
                    let mut row = parsed("parent-0", "/w1", Vec::new());
                    row.created_at = 1;
                    row.last_at = 10;
                    row
                },
                source_path: "parent-0".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: {
                    let mut row = parsed("child-1", "/w1", Vec::new());
                    row.parent_session = Some("parent-0".to_owned());
                    row.created_at = 2;
                    row.last_at = 11;
                    row
                },
                source_path: "child-1".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: {
                    let mut row = parsed("child-2", "/w1", Vec::new());
                    row.parent_session = Some("parent-0".to_owned());
                    row.created_at = 3;
                    row.last_at = 12;
                    row
                },
                source_path: "child-2".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: {
                    let mut row = parsed("grand-3", "/w1", Vec::new());
                    row.parent_session = Some("child-1".to_owned());
                    row.created_at = 4;
                    row.last_at = 13;
                    row
                },
                source_path: "grand-3".to_owned(),
                mtime: 1,
                size: 1,
            },
            IndexedSession {
                session: parsed("rep-0", "/w1", Vec::new()),
                source_path: replace_log.to_string_lossy().into_owned(),
                mtime: 1,
                size: 1,
            },
        ];
        sessions.sort_by(|left, right| left.session.id.cmp(&right.session.id));
        let index_path = root.join("index.db");
        write::write_index(&WritePlan {
            index_path: &index_path,
            force: true,
            preserve_existing: false,
            sessions: &sessions,
            removed: &[],
            discovered: sessions.len(),
            failed: 0,
            indexed_at: 1_700_000_000_000,
        })
        .expect("write fixture index");
        root
    }

    fn request(root: &Path, operation: &str) -> QueryRequest {
        QueryRequest {
            index_root: root.to_string_lossy().into_owned(),
            operation: operation.to_owned(),
            ..QueryRequest::default()
        }
    }

    fn payload(_root: &Path, request: QueryRequest) -> Value {
        let response = answer(&request);
        assert!(
            response.ok,
            "expected success, got {:?}: {:?}",
            response.error_code, response.error_message
        );
        serde_json::from_str(&response.payload_json).expect("payload is JSON")
    }

    fn failure(request: QueryRequest) -> (String, String) {
        let response = answer(&request);
        assert!(
            !response.ok,
            "expected a failure, got {}",
            response.payload_json
        );
        (
            response.error_code.unwrap_or_default(),
            response.error_message.unwrap_or_default(),
        )
    }

    #[test]
    fn dispatches_every_operation() {
        let fixture = fixture();
        let root = seed(&fixture);
        for operation in [
            "search",
            "session",
            "event",
            "trace",
            "timeline",
            "workspaces",
        ] {
            let mut query = request(&root, operation);
            match operation {
                "search" => {
                    query.query = Some("广告".to_owned());
                    query.limit = Some(5.0);
                }
                "session" => {
                    query.session_id = Some("aaaa-1".to_owned());
                    query.limit = Some(5.0);
                }
                "event" => {
                    query.session_id = Some("aaaa-1".to_owned());
                    query.seq = Some(2.0);
                }
                "trace" => query.session_id = Some("parent-0".to_owned()),
                "timeline" => query.limit = Some(5.0),
                "workspaces" => query.limit = Some(5.0),
                _ => unreachable!(),
            }
            let answer = payload(&root, query);
            assert_eq!(
                answer["operation"], operation,
                "{operation} payload: {answer}"
            );
        }
        let status = payload(&root, request(&root, "status"));
        assert_eq!(status["operation"], "status");
        assert_eq!(status["indexed"], true);
        assert_eq!(status["sessions"], 10);
    }

    #[test]
    fn status_without_an_index_answers_false() {
        let fixture = fixture();
        let root = fixture.dir.join("empty");
        let status = payload(&root, request(&root, "status"));
        assert_eq!(status["indexed"], false);
        assert_eq!(status["sessions"], 0);
        assert!(status["indexPath"].as_str().unwrap().ends_with("index.db"));
    }

    #[test]
    fn search_dedupes_one_hit_per_session() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.limit = Some(10.0);
        let deduped = payload(&root, query.clone());
        assert_eq!(deduped["total"], 2, "two sessions match: {deduped}");
        assert_eq!(deduped["hits"].as_array().unwrap().len(), 2);
        assert_eq!(deduped["truncated"], false);

        query.dedupe_by_session = Some(false);
        let plain = payload(&root, query.clone());
        assert_eq!(plain["total"], 4, "four entries match: {plain}");
        assert_eq!(plain["hits"].as_array().unwrap().len(), 4);

        query.limit = Some(1.0);
        let page = payload(&root, query);
        assert_eq!(page["hits"].as_array().unwrap().len(), 1);
        assert_eq!(page["truncated"], true);
    }

    #[test]
    fn search_orders_by_the_kind_weight_division() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.dedupe_by_session = Some(false);
        query.limit = Some(10.0);
        let answer = payload(&root, query);
        let hits = answer["hits"].as_array().unwrap();
        // Same text means the same bm25; `bm25 / weight` puts user (1.0) before tool (1.5).
        let kinds: Vec<&str> = hits
            .iter()
            .map(|hit| hit["kind"].as_str().unwrap())
            .collect();
        let user = kinds.iter().position(|kind| *kind == "user");
        let tool = kinds.iter().position(|kind| *kind == "tool");
        assert!(user.is_some() && tool.is_some(), "kinds: {kinds:?}");
        assert!(user < tool, "user must outrank tool: {kinds:?}");
        assert!(hits[0]["snippet"].as_str().unwrap().contains('['));
    }

    #[test]
    fn search_filters_by_workspace_and_kind() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.workspace = Some("/w1".to_owned());
        query.limit = Some(10.0);
        let answer = payload(&root, query);
        assert_eq!(answer["total"], 1, "only aaaa-1 is under /w1: {answer}");
        assert_eq!(answer["hits"][0]["sessionId"], "aaaa-1");

        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.kinds = Some(vec!["tool".to_owned()]);
        query.limit = Some(10.0);
        let answer = payload(&root, query);
        assert_eq!(answer["total"], 1);
        assert_eq!(answer["hits"][0]["kind"], "tool");

        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.kinds = Some(Vec::new());
        query.limit = Some(10.0);
        let answer = payload(&root, query);
        assert_eq!(answer["total"], 0);
    }

    #[test]
    fn event_window_clamps_at_both_ends() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "event");
        query.session_id = Some("aaaa-1".to_owned());
        query.seq = Some(0.0);
        query.window_before = Some(5.0);
        query.window_after = Some(2.0);
        let answer = payload(&root, query);
        assert_eq!(answer["event"]["seq"], 0);
        assert_eq!(answer["before"].as_array().unwrap().len(), 0);
        let after: Vec<i64> = answer["after"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["seq"].as_i64().unwrap())
            .collect();
        assert_eq!(after, vec![1, 2]);

        let mut query = request(&root, "event");
        query.session_id = Some("aaaa-1".to_owned());
        query.seq = Some(3.0);
        query.window_before = Some(1.0);
        query.window_after = Some(99.0);
        let answer = payload(&root, query);
        assert_eq!(answer["before"].as_array().unwrap().len(), 1);
        assert_eq!(answer["before"][0]["seq"], 2);
        assert_eq!(answer["after"].as_array().unwrap().len(), 0);

        // The target event's payload is passed through verbatim, not clipped.
        let mut query = request(&root, "event");
        query.session_id = Some("aaaa-1".to_owned());
        query.seq = Some(2.0);
        let answer = payload(&root, query);
        assert_eq!(answer["event"]["data"]["name"], "read");
        assert_eq!(answer["event"]["data"]["arguments"]["path"], "/tmp/x");
        assert_eq!(answer["event"]["type"], "tool/call");
    }

    #[test]
    fn event_beyond_the_tail_is_not_found() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "event");
        query.session_id = Some("aaaa-1".to_owned());
        query.seq = Some(99.0);
        let (code, message) = failure(query);
        assert_eq!(code, "SESSIONGRAPH_NOT_FOUND");
        assert!(message.contains("no event at seq 99"), "{message}");
    }

    #[test]
    fn a_session_prefix_must_be_unambiguous() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "session");
        query.session_id = Some("dup-a".to_owned());
        query.limit = Some(5.0);
        let (code, message) = failure(query);
        assert_eq!(code, "SESSIONGRAPH_NOT_FOUND");
        assert!(message.contains("ambiguous"), "{message}");

        // A search's session filter calls the same situation a bad request.
        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.session_id = Some("dup-a".to_owned());
        query.limit = Some(5.0);
        let (code, _) = failure(query);
        assert_eq!(code, "SESSIONGRAPH_INVALID_REQUEST");

        // An unambiguous prefix resolves; an exact id always wins.
        let mut query = request(&root, "session");
        query.session_id = Some("sol".to_owned());
        query.limit = Some(5.0);
        assert_eq!(payload(&root, query)["session"]["sessionId"], "solo-9");
        let mut query = request(&root, "session");
        query.session_id = Some("dup-a1".to_owned());
        query.limit = Some(5.0);
        assert_eq!(payload(&root, query)["session"]["sessionId"], "dup-a1");
    }

    #[test]
    fn trace_session_reports_lineage_and_completeness() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "trace");
        query.session_id = Some("parent-0".to_owned());
        let answer = payload(&root, query);
        assert_eq!(answer["kind"], "session");
        assert_eq!(answer["ancestors"].as_array().unwrap().len(), 0);
        let children = answer["descendants"].as_array().unwrap();
        assert_eq!(children.len(), 2);
        let child_one = children
            .iter()
            .find(|node| node["session"]["sessionId"] == "child-1")
            .unwrap();
        assert_eq!(child_one["descendants"].as_array().unwrap().len(), 1);
        assert_eq!(answer["complete"], true);

        // A depth-limited walk that stops short must not claim completeness.
        let mut query = request(&root, "trace");
        query.session_id = Some("parent-0".to_owned());
        query.depth = Some(0.0);
        let answer = payload(&root, query);
        assert_eq!(answer["descendants"].as_array().unwrap().len(), 0);
        assert_eq!(answer["complete"], false);

        let mut query = request(&root, "trace");
        query.session_id = Some("grand-3".to_owned());
        let answer = payload(&root, query);
        let ancestors: Vec<&str> = answer["ancestors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["sessionId"].as_str().unwrap())
            .collect();
        assert_eq!(ancestors, vec!["child-1", "parent-0"]);
        assert_eq!(answer["complete"], true);
    }

    #[test]
    fn trace_event_follows_the_replacement_chain() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "trace");
        query.session_id = Some("rep-0".to_owned());
        query.seq = Some(1.0);
        let answer = payload(&root, query);
        assert_eq!(answer["kind"], "event");
        assert_eq!(answer["event"]["seq"], 1);
        let replaced: Vec<i64> = answer["replacedBy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect();
        assert_eq!(replaced, vec![3, 4]);
        assert_eq!(answer["shadowedSeqs"].as_array().unwrap().len(), 0);
        let sources: Vec<i64> = answer["sourceEventSeqs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect();
        assert_eq!(sources, vec![7, 8]);

        let mut query = request(&root, "trace");
        query.session_id = Some("rep-0".to_owned());
        query.seq = Some(3.0);
        let answer = payload(&root, query);
        let shadowed: Vec<i64> = answer["shadowedSeqs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap())
            .collect();
        assert_eq!(shadowed, vec![1, 2]);
    }

    #[test]
    fn timeline_and_workspaces_report_their_shapes() {
        let fixture = fixture();
        let root = seed(&fixture);
        let mut query = request(&root, "timeline");
        query.limit = Some(3.0);
        let answer = payload(&root, query);
        assert_eq!(answer["operation"], "timeline");
        assert_eq!(answer["sessions"].as_array().unwrap().len(), 3);
        assert_eq!(answer["truncated"], true);

        let mut query = request(&root, "workspaces");
        query.limit = Some(10.0);
        let answer = payload(&root, query);
        assert_eq!(answer["total"], 2);
        let first = &answer["workspaces"][0];
        assert!(first["workspace"].is_string());
        assert!(first["sessions"].is_number());
        assert!(first["entries"].is_number());
        assert!(first["firstAt"].is_number());
        assert!(first["lastAt"].is_number());
    }

    #[test]
    fn rejects_an_unknown_operation() {
        let fixture = fixture();
        let root = seed(&fixture);
        let (code, message) = failure(request(&root, "index"));
        assert_eq!(code, "SESSIONGRAPH_INVALID_REQUEST");
        assert!(
            message.contains("unknown sessiongraph operation"),
            "{message}"
        );
    }

    /// Not part of the hermetic suite: reads the developer's real index for the parity/timing
    /// report. Run with `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads ~/.dsh/sessiongraph/index.db; run explicitly with --ignored"]
    fn real_index_search_report() {
        let root = match std::env::var_os("SESSIONGRAPH_REAL_INDEX") {
            Some(path) => PathBuf::from(path),
            None => {
                let Some(home) = std::env::var_os("HOME") else {
                    return;
                };
                PathBuf::from(home).join(".dsh").join("sessiongraph")
            }
        };
        if !root.join(INDEX_FILE).exists() {
            eprintln!("no real index at {}; nothing to report", root.display());
            return;
        }
        let mut query = request(&root, "search");
        query.query = Some("广告".to_owned());
        query.limit = Some(10.0);
        let _ = answer(&query);
        let mut times: Vec<f64> = Vec::new();
        let mut internal: Vec<f64> = Vec::new();
        for _ in 0..15 {
            let started = std::time::Instant::now();
            let response = answer(&query);
            times.push(started.elapsed().as_secs_f64() * 1000.0);
            assert!(response.ok, "{:?}", response.error_message);
            let started = std::time::Instant::now();
            let _ = run(&query).expect("internal run");
            internal.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|left, right| left.partial_cmp(right).unwrap());
        internal.sort_by(|left, right| left.partial_cmp(right).unwrap());
        // Breakdown of one search: open, FTS scan, page read-back, and a full extra search + JSON.
        let mut open_times: Vec<f64> = Vec::new();
        let mut scan_times: Vec<f64> = Vec::new();
        let mut detail_times: Vec<f64> = Vec::new();
        let mut serialize_times: Vec<f64> = Vec::new();
        let expression = match_expression("广告").expect("match expression");
        for _ in 0..15 {
            let started = std::time::Instant::now();
            let connection = open_index(&query.index_root).expect("open index");
            open_times.push(started.elapsed().as_secs_f64() * 1000.0);
            let started = std::time::Instant::now();
            let matches = scan_matches(&connection, &query, &expression).expect("scan matches");
            scan_times.push(started.elapsed().as_secs_f64() * 1000.0);
            let mut ranked: Vec<MatchRow> = rank_deduped(matches);
            let page_ids: Vec<i64> = ranked.drain(..).take(10).map(|row| row.id).collect();
            let started = std::time::Instant::now();
            let _ = read_hit_details(&connection, &page_ids).expect("page details");
            detail_times.push(started.elapsed().as_secs_f64() * 1000.0);
            let started = std::time::Instant::now();
            let _ = serde_json::to_string(&payload_of(&connection, &query)).expect("serialize");
            serialize_times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        for times in [
            &mut open_times,
            &mut scan_times,
            &mut detail_times,
            &mut serialize_times,
        ] {
            times.sort_by(|left, right| left.partial_cmp(right).unwrap());
        }
        let payload: Value = serde_json::from_str(&answer(&query).payload_json).unwrap();
        let mut plain = query.clone();
        plain.dedupe_by_session = Some(false);
        let plain_payload: Value = serde_json::from_str(&answer(&plain).payload_json).unwrap();
        println!(
            "real index: dedupe total={} plain total={} hits={} total_ms min={:.2} p50={:.2} | run_ms min={:.2} p50={:.2}",
            payload["total"],
            plain_payload["total"],
            payload["hits"].as_array().map(|hits| hits.len()).unwrap_or(0),
            times[0],
            times[times.len() / 2],
            internal[0],
            internal[internal.len() / 2],
        );
        println!(
            "breakdown ms min: open={:.2} scan={:.2} details={:.2} full_search={:.2}",
            open_times[0], scan_times[0], detail_times[0], serialize_times[0]
        );
        assert!(payload["total"].as_i64().unwrap_or(0) > 0);
    }

    /// One full search payload, for the report test's per-stage timing.
    fn payload_of(connection: &Connection, request: &QueryRequest) -> Value {
        search(connection, request).expect("search")
    }
}
