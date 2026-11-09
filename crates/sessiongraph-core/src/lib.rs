//! Native index kernel for the sessiongraph plugin, exposed to Node through napi-rs.
//!
//! The kernel turns `~/.dsh/sessions` **and `~/.codex`** into the SQLite index the store reads:
//! scan both stores, decompress the multi-frame zstd JSONL logs, extract the readable conversation,
//! and write one transaction. It is a port of `packages/sessions` — the TS indexer remains the
//! behavioural reference, and every rule that has to match (the tokenizer, the parse rules, the
//! schema, the incremental key) is mirrored here deliberately rather than reinvented.
//!
//! Both sources land in one index, discriminated by `session.source`, because a question about a
//! project is answered by both harnesses ("what did I decide about this repo" does not care which
//! agent was driving). The two readers differ only in how they walk a line — [`parse`] for DSH's
//! flat events, [`codex`] for Codex's envelopes — and converge on one `ParsedSession`.
//!
//! ## JS field names
//!
//! `#[napi(object)]` maps a Rust snake_case field to a **camelCase** JS property (`index_path` →
//! `indexPath`, `elapsed_ms` → `elapsedMs`). The loader's `NativeIndexOptions`/`NativeIndexReport`
//! types in `packages/native/src/index.ts` therefore use camelCase, matching
//! `SessiongraphIndexOptions`/`SessiongraphIndexReport` in `packages/service/src/types.ts`. Verified
//! against the built module (the native test asserts `report.indexPath !== undefined`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use napi::{bindgen_prelude::AsyncTask, Env, Task};
use napi_derive::napi;
use rayon::prelude::*;

pub mod codex;
pub mod decode;
pub mod parse;
pub mod query;
pub mod scan;
pub mod tokenize;
pub mod write;

/// Default cap on stored message text, in characters (matches the TS indexer).
pub const DEFAULT_MAX_ENTRY_CHARS: u32 = 4_000;
/// Default cap on stored tool-invocation text, in characters.
pub const DEFAULT_TOOL_CALL_CHARS: u32 = 2_000;
/// Default cap on one compressed log file, in bytes.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Longest failure reason kept in the report.
const MAX_REASON_CHARS: usize = 200;

/// Options for one index run.
///
/// Field names are snake_case here and camelCase in JS (`sessionsRoot`, `indexPath`, …).
#[napi(object)]
#[derive(Clone)]
pub struct IndexOptions {
    /// Directory the harness writes its session logs to (`~/.dsh/sessions`).
    pub sessions_root: String,
    /// Absolute path of the index file to write (`<indexRoot>/index.db`).
    pub index_path: String,
    /// Rebuild every session from scratch into `index.db.tmp` and rename it into place.
    pub force: Option<bool>,
    /// Index only sessions whose `cwd` matches this workspace (exact, or a prefix without `/`).
    pub workspace_filter: Option<String>,
    /// Index only one session, by full id or unambiguous prefix.
    pub session_filter: Option<String>,
    /// Also index OpenAI Codex's rollout logs (default true).
    ///
    /// One index spans both harnesses because a question about a project is answered by both; set
    /// this false on a machine where Codex's history is not wanted, and the next run drops its rows.
    pub codex: Option<bool>,
    /// Codex home directory the rollout logs are read from (default `~/.codex`).
    pub codex_root: Option<String>,
    /// Longest message text stored whole (default 4000).
    pub max_entry_chars: Option<u32>,
    /// Longest tool invocation text stored whole (default 2000).
    pub tool_call_chars: Option<u32>,
    /// Logs larger than this are skipped and reported in `failed` (default 67108864).
    ///
    /// `f64`, not `u64`: napi-rs converts `u64`/`i64` to a JS **BigInt**
    /// (`napi_create_bigint_uint64`), which would turn this documented `number` into a BigInt and
    /// make `JSON.stringify(report)` throw on any field carrying one. A byte count is exact well
    /// past 2^53, so `f64` is the faithful JS-number type here.
    pub max_file_bytes: Option<f64>,
}

/// One session log that could not be parsed.
#[napi(object)]
pub struct FailedSession {
    /// Absolute path of the log.
    pub path: String,
    /// Bounded reason, at most 200 characters.
    pub reason: String,
}

/// What one index run did. JS property names are camelCase.
#[napi(object)]
pub struct IndexReport {
    /// Absolute path of the index the run wrote.
    pub index_path: String,
    /// Sessions added since the previous run.
    pub added: u32,
    /// Sessions whose source changed and were re-written.
    pub updated: u32,
    /// Sessions skipped because their source was unchanged.
    pub skipped: u32,
    /// Sessions dropped because their source file disappeared.
    pub removed: u32,
    /// Live (still-running) sessions rebuilt from the host's in-memory view this run.
    ///
    /// Always 0 from this kernel: live sessions come from the host's `sessionQuery`, which the
    /// caller's live pass owns. The field exists so the shape matches `SessiongraphIndexReport`,
    /// and so a consumer merging this report with the caller's live pass gets a number, not
    /// `undefined`.
    pub live_sessions: u32,
    /// Live sessions left out by the caller's cap. Always 0 here, for the same reason.
    pub live_skipped: u32,
    /// Sessions discovered in total across all source roots.
    pub discovered: u32,
    /// Sessions that failed to parse, with a bounded reason.
    pub failed: Vec<FailedSession>,
    /// Searchable entries in the index after the run.
    pub entries: u32,
    /// Sessions in the index after the run.
    pub sessions: u32,
    /// Distinct workspaces in the index after the run.
    pub workspaces: u32,
    /// Bytes the index occupies after the run.
    ///
    /// `f64` because napi-rs maps `u64` to BigInt; see `IndexOptions::max_file_bytes`.
    pub bytes: f64,
    /// Wall-clock duration of the run, milliseconds.
    pub elapsed_ms: f64,
}

/// One pending index run, executed on libuv's thread pool.
///
/// The body used to be synchronous on purpose — "the caller already runs it on its own timeout
/// budget" — which answered the wrong question. A `Sync` napi call holds the JavaScript thread for
/// its whole duration, so a run scheduled through the host's job registry *still* froze the UI:
/// measured at 1294 ms of dead event loop on one 17 MB session log, from a corpus of 856 sessions /
/// 642 MB. `AsyncTask` is what makes "in the background" mean what it says.
pub struct IndexTask {
    options: IndexOptions,
}

impl Task for IndexTask {
    type Output = IndexReport;
    type JsValue = IndexReport;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        run_index(self.options.clone()).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Build or refresh one index, off the JavaScript thread.
#[napi]
pub fn index_sessions(options: IndexOptions) -> AsyncTask<IndexTask> {
    AsyncTask::new(IndexTask { options })
}

/// Answer one query, off the JavaScript thread.
///
/// The answer carries a complete result JSON string rather than a per-field napi object: a raw event
/// can be tens of kilobytes, and one `JSON.parse` on the JS side is cheaper than converting every
/// field across the boundary. Errors are carried in the response (`ok: false` + code + message)
/// rather than thrown, so the JS wrapper can fall back to the TypeScript store on any failure.
#[napi]
pub fn query(request: query::QueryRequest) -> AsyncTask<query::QueryTask> {
    AsyncTask::new(query::QueryTask::new(request))
}

/// Options after defaults and path resolution.
struct ResolvedOptions {
    sessions_root: PathBuf,
    index_path: PathBuf,
    force: bool,
    workspace_filter: Option<String>,
    session_filter: Option<String>,
    /// Codex home to scan, or `None` when the source is off **or** this machine does not say where
    /// home is — guessing a path there would scan a tree that is not the user's Codex history.
    codex_root: Option<PathBuf>,
    limits: parse::ParseLimits,
    max_file_bytes: u64,
}

impl ResolvedOptions {
    fn resolve(options: IndexOptions) -> Result<Self, String> {
        if options.sessions_root.is_empty() {
            return Err("sessionsRoot is required".to_owned());
        }
        if options.index_path.is_empty() {
            return Err("indexPath is required".to_owned());
        }
        let max_entry_chars = match options.max_entry_chars {
            None => DEFAULT_MAX_ENTRY_CHARS,
            Some(0) => return Err("maxEntryChars must be a positive integer".to_owned()),
            Some(value) => value,
        };
        let tool_call_chars = match options.tool_call_chars {
            None => DEFAULT_TOOL_CALL_CHARS,
            Some(0) => return Err("toolCallChars must be a positive integer".to_owned()),
            Some(value) => value,
        };
        let max_file_bytes = match options.max_file_bytes {
            None => DEFAULT_MAX_FILE_BYTES,
            Some(value) if !(value.is_finite() && value >= 1.0) => {
                return Err("maxFileBytes must be a positive integer".to_owned())
            }
            Some(value) => value.floor() as u64,
        };
        let codex_root = match options.codex_root {
            Some(root) if !root.is_empty() => Some(PathBuf::from(root)),
            _ => default_codex_root(),
        };
        Ok(Self {
            sessions_root: PathBuf::from(options.sessions_root),
            index_path: PathBuf::from(options.index_path),
            force: options.force.unwrap_or(false),
            workspace_filter: options.workspace_filter,
            session_filter: options.session_filter,
            codex_root: if options.codex.unwrap_or(true) {
                codex_root
            } else {
                None
            },
            limits: parse::ParseLimits {
                max_entry_chars: max_entry_chars as usize,
                tool_call_chars: tool_call_chars as usize,
            },
            max_file_bytes,
        })
    }

    fn in_scope(&self, workspace: &str, id: &str) -> bool {
        matches_workspace(self.workspace_filter.as_deref(), workspace)
            && matches_session(self.session_filter.as_deref(), id)
    }
}

/// Default Codex home, resolved from the environment.
///
/// No path crate is a dependency of this build, and `HOME`/`USERPROFILE` is what the TypeScript
/// indexer's `os.homedir()` ultimately reads too. `None` means this machine does not say where home
/// is, which disables the Codex source rather than scanning a relative `.codex` in the process's
/// working directory.
fn default_codex_root() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".codex"))
}

/// Build or refresh one index.
fn run_index(options: IndexOptions) -> Result<IndexReport, String> {
    let started = Instant::now();
    let resolved = ResolvedOptions::resolve(options)?;
    let harness_files = scan::scan_sessions(&resolved.sessions_root)?;
    // A machine that never ran Codex contributes nothing, not a failed run — the same tolerance the
    // harness scan applies to a store that does not exist yet.
    let codex_files = match &resolved.codex_root {
        Some(root) => scan::scan_codex_sessions(root)?,
        None => Vec::new(),
    };
    // Titles come from a second Codex file and are read once per run, so the parsers stay pure
    // functions of the bytes they are handed. Nothing to read when no rollout was found.
    let titles = match &resolved.codex_root {
        Some(root) if !codex_files.is_empty() => scan::read_codex_titles(root),
        _ => HashMap::new(),
    };
    let mut files = harness_files;
    files.extend(codex_files);
    let discovered = files.len();
    let previous = write::read_index_state(&resolved.index_path);
    // A missing or unusable previous index is rebuilt through the temporary file too, so a corrupt
    // or schema-mismatched file is replaced atomically instead of being written into.
    let force = resolved.force || previous.is_none();
    let scoped = resolved.workspace_filter.is_some() || resolved.session_filter.is_some();

    let mut seen: HashSet<String> = HashSet::with_capacity(files.len());
    let mut failed: Vec<FailedSession> = Vec::new();
    let mut pending: Vec<&scan::SessionFile> = Vec::new();
    let mut skipped = 0u32;

    for file in &files {
        let source_path = file.file_path.to_string_lossy().into_owned();
        seen.insert(source_path.clone());
        let existing = previous.as_ref().and_then(|rows| rows.get(&source_path));
        let unchanged = existing.is_some_and(|row| row.mtime == file.mtime && row.size == file.size);
        if unchanged && !force {
            if let Some(row) = existing {
                if scoped && !resolved.in_scope(&row.workspace, &row.id) {
                    continue;
                }
            }
            skipped += 1;
            continue;
        }
        if file.size as u64 > resolved.max_file_bytes {
            failed.push(FailedSession {
                path: source_path,
                reason: truncate_reason(&format!(
                    "session log is {} bytes, over maxFileBytes ({})",
                    file.size, resolved.max_file_bytes
                )),
            });
            continue;
        }
        pending.push(file);
    }

    // Reading, decompressing and parsing are the expensive half and are per-file independent, so
    // they run on the rayon pool; `collect` keeps scan order, which makes the report reproducible.
    // The parser is chosen by source: the two harnesses record a conversation in different shapes,
    // and only the shape decides how a line is read.
    let outcomes: Vec<Result<parse::ParsedSession, String>> = pending
        .par_iter()
        .map(|file| {
            let buffer = std::fs::read(&file.file_path)
                .map_err(|error| format!("read: {error}"))?;
            match file.source {
                scan::SessionSource::Dsh => {
                    parse::parse_session_log(&buffer, &scan::fallback_id(file), &resolved.limits)
                }
                scan::SessionSource::Codex => codex::parse_codex_log(
                    &buffer,
                    &codex::codex_fallback_id(&file.file_path),
                    &resolved.limits,
                    &titles,
                ),
            }
        })
        .collect();

    let mut candidates: Vec<write::IndexedSession> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for (file, outcome) in pending.iter().zip(outcomes) {
        let session = match outcome {
            Ok(session) => session,
            Err(reason) => {
                failed.push(FailedSession {
                    path: file.file_path.to_string_lossy().into_owned(),
                    reason: truncate_reason(&reason),
                });
                continue;
            }
        };
        if scoped && !resolved.in_scope(&session.cwd, &session.id) {
            continue;
        }
        match by_id.get(&session.id).copied() {
            // One session id reachable through two files must contribute one session row. Since the
            // Codex reader arrived there are two ways that happens: a v3 → v4 migration or workspace
            // move in this harness, and a rollout Codex copied into `archived_sessions/` while the
            // original is still under `sessions/`. The copy that reaches further wins — `last_at`,
            // not mtime — because "the session committed is the most complete one" is what a query
            // about it should answer, and that is the rule the TypeScript indexer applies.
            Some(index) => {
                if session.last_at >= candidates[index].session.last_at {
                    candidates[index] = write::IndexedSession {
                        session,
                        source: file.source.as_str(),
                        source_path: file.file_path.to_string_lossy().into_owned(),
                        mtime: file.mtime,
                        size: file.size,
                    };
                }
                skipped += 1;
            }
            None => {
                by_id.insert(session.id.clone(), candidates.len());
                candidates.push(write::IndexedSession {
                    session,
                    source: file.source.as_str(),
                    source_path: file.file_path.to_string_lossy().into_owned(),
                    mtime: file.mtime,
                    size: file.size,
                });
            }
        }
    }

    let mut added = 0u32;
    let mut updated = 0u32;
    for candidate in &candidates {
        if previous.as_ref().is_some_and(|rows| rows.contains_key(&candidate.source_path)) {
            updated += 1;
        } else {
            added += 1;
        }
    }

    // A scoped run only removes what it can see: rows outside the requested workspace or session
    // are kept, because "not in this scan" says nothing about a source the caller excluded.
    let mut removed: Vec<String> = Vec::new();
    if let Some(rows) = previous.as_ref() {
        for (source_path, row) in rows {
            // Live rows carry a synthetic source path and are rebuilt by the caller's live pass
            // every run; a file scan saying nothing about them must not delete them.
            if write::is_live_source(source_path) {
                continue;
            }
            if seen.contains(source_path) {
                continue;
            }
            if scoped && !resolved.in_scope(&row.workspace, &row.id) {
                continue;
            }
            removed.push(row.id.clone());
        }
    }

    let indexed_at = now_millis();
    let summary = write::write_index(&write::WritePlan {
        index_path: &resolved.index_path,
        force,
        preserve_existing: scoped && previous.is_some(),
        sessions: &candidates,
        removed: &removed,
        discovered,
        failed: failed.len(),
        indexed_at,
    })?;

    Ok(IndexReport {
        index_path: resolved.index_path.to_string_lossy().into_owned(),
        added,
        updated,
        skipped,
        removed: u32::try_from(removed.len()).unwrap_or(u32::MAX),
        live_sessions: 0,
        live_skipped: 0,
        discovered: u32::try_from(discovered).unwrap_or(u32::MAX),
        failed,
        entries: u32::try_from(summary.entries).unwrap_or(u32::MAX),
        sessions: u32::try_from(summary.sessions).unwrap_or(u32::MAX),
        workspaces: u32::try_from(summary.workspaces).unwrap_or(u32::MAX),
        bytes: summary.bytes as f64,
        elapsed_ms: started.elapsed().as_millis() as f64,
    })
}

/// Whether a session's workspace matches an optional workspace filter.
///
/// An exact match always counts. A value without a trailing separator is also a path prefix, which
/// is how one indexed root serves a whole `~/www` subtree; a value with the trailing separator
/// addresses the exact directory only. Same rule as `matchesWorkspace` in the TS indexer.
pub fn matches_workspace(filter: Option<&str>, workspace: &str) -> bool {
    match filter {
        None => true,
        Some(value) => match value.strip_suffix('/') {
            Some(exact) => workspace == exact,
            None => workspace == value || workspace.starts_with(value),
        },
    }
}

/// Whether a session id matches an optional id filter (full id or any prefix).
pub fn matches_session(filter: Option<&str>, id: &str) -> bool {
    match filter {
        None => true,
        Some(value) => id == value || id.starts_with(value),
    }
}

/// Bound a failure reason to the contract's 200 characters, ellipsis included.
fn truncate_reason(reason: &str) -> String {
    if reason.chars().count() <= MAX_REASON_CHARS {
        return reason.to_owned();
    }
    let truncated: String = reason.chars().take(MAX_REASON_CHARS - 1).collect();
    format!("{truncated}…")
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{matches_session, matches_workspace, truncate_reason, IndexOptions, ResolvedOptions};

    /// One option set, with every switch but the Codex pair left at its default.
    fn options(codex: Option<bool>, codex_root: Option<&str>) -> IndexOptions {
        IndexOptions {
            sessions_root: "/sessions".to_owned(),
            index_path: "/index/index.db".to_owned(),
            force: None,
            workspace_filter: None,
            session_filter: None,
            codex,
            codex_root: codex_root.map(str::to_owned),
            max_entry_chars: None,
            tool_call_chars: None,
            max_file_bytes: None,
        }
    }

    #[test]
    fn codex_is_on_by_default_and_rooted_at_home() {
        // Default on: a machine that has Codex history should get it without a config change, and
        // the root has to come from the environment rather than the process's working directory.
        let resolved = ResolvedOptions::resolve(options(None, None)).expect("resolve");
        assert_eq!(
            resolved.codex_root,
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex"))
        );

        // Off means the scan is skipped entirely, not merely rooted somewhere else.
        let off = ResolvedOptions::resolve(options(Some(false), Some("/tmp/codex"))).expect("resolve");
        assert_eq!(off.codex_root, None);

        // An explicit root wins over the default.
        let custom = ResolvedOptions::resolve(options(Some(true), Some("/tmp/codex"))).expect("resolve");
        assert_eq!(custom.codex_root, Some(PathBuf::from("/tmp/codex")));
    }

    #[test]
    fn workspace_filter_is_exact_or_prefix() {
        assert!(matches_workspace(None, "/a/b"));
        assert!(matches_workspace(Some("/a/b"), "/a/b"));
        assert!(matches_workspace(Some("/a"), "/a/b"));
        assert!(!matches_workspace(Some("/a/b/"), "/a/bc"));
        assert!(matches_workspace(Some("/a/b/"), "/a/b"));
        assert!(!matches_workspace(Some("/a/b"), "/a/c"));
    }

    #[test]
    fn session_filter_is_full_id_or_prefix() {
        assert!(matches_session(None, "abc"));
        assert!(matches_session(Some("abc"), "abc"));
        assert!(matches_session(Some("ab"), "abc"));
        assert!(!matches_session(Some("bc"), "abc"));
    }

    #[test]
    fn reason_is_bounded_to_200_characters() {
        let long = "错".repeat(300);
        let bounded = truncate_reason(&long);
        assert_eq!(bounded.chars().count(), 200);
        assert!(bounded.ends_with('…'));
    }
}
