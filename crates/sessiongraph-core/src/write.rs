//! Write the session index with bundled SQLite (`rusqlite`).
//!
//! Two modes, deliberately different on disk — the same contract as
//! `packages/sessions/src/write.ts`:
//!
//! - **Rebuild** (`force`) writes a complete index to `index.db.tmp` and renames it over `index.db`
//!   only after the transaction commits, so a reader never observes a half-built index and a run
//!   that dies leaves the previous one untouched. When the run is also scoped (a workspace or a
//!   single session was requested), the previous index is attached and copied in first, because a
//!   scoped rebuild must not delete the sessions it was not asked about.
//! - **Incremental** opens the live index and rewrites only the sessions whose source changed,
//!   inside one transaction.
//!
//! `entry_fts.rowid` is aligned with `entry.id`: every written entry row is followed by exactly one
//! FTS row carrying the tokenizer's output. Deletion therefore goes FTS-first — the entry rows are
//! what names the rowids, so dropping them first would strand the FTS rows.
//!
//! The table statements are a verbatim translation of `SCHEMA_STATEMENTS` in
//! `packages/service/src/schema.ts`; that file is the single source of truth and must be edited
//! first if the shape ever changes.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::json;

use crate::parse::ParsedSession;
use crate::tokenize;

/// Current on-disk schema version, matching `SCHEMA_VERSION` in the seam package.
pub const SCHEMA_VERSION: i64 = 3;

/// Relative path of the index file inside an index root.
pub const INDEX_RELATIVE_PATH: &str = "index.db";

/// Prefix of the synthetic source path a live (still-running) session is recorded under.
///
/// A live row belongs to no file: the caller's live pass rebuilds it from the host's in-memory log
/// on every run, with `source_mtime = 0` and `source_size = 0`. A file scan saying nothing about it
/// is not evidence that its session disappeared, so the removal pass must skip these rows.
pub const LIVE_SOURCE_PREFIX: &str = "live://";

/// Whether a recorded source path is the synthetic marker of a live session.
pub fn is_live_source(source_path: &str) -> bool {
    source_path.starts_with(LIVE_SOURCE_PREFIX)
}

/// Sidecar summary the prompt-assembly path reads without opening SQLite.
pub const STATUS_RELATIVE_PATH: &str = "status.json";

/// `meta` keys the store and the indexer exchange through the file.
pub(crate) const META_SCHEMA_VERSION: &str = "schema_version";
pub(crate) const META_INDEXED_AT: &str = "indexed_at";
const META_DISCOVERED: &str = "discovered";
const META_FAILED: &str = "failed";

/// Every statement needed to create an index from nothing, in dependency order.
///
/// Copied statement for statement from `packages/service/src/schema.ts`; `${SESSION_TABLE}` and
/// friends are inlined with the same names. `entry_fts` is an FTS5 table storing only the bigram
/// token stream and keyed by `entry.id`.
pub const SCHEMA_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )",
    "CREATE TABLE IF NOT EXISTS session (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     workspace TEXT NOT NULL,
     title TEXT,
     created_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     parent_session TEXT,
     origin TEXT,
     agent_preset TEXT,
     turns INTEGER NOT NULL DEFAULT 0,
     entries INTEGER NOT NULL DEFAULT 0,
     source_path TEXT NOT NULL,
     source_mtime INTEGER NOT NULL,
     source_size INTEGER NOT NULL
   )",
    "CREATE TABLE IF NOT EXISTS entry (
     id INTEGER PRIMARY KEY,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     time INTEGER NOT NULL,
     turn INTEGER,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     clipped INTEGER NOT NULL DEFAULT 0
   )",
    "CREATE INDEX IF NOT EXISTS idx_entry_session ON entry (session_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_session_last ON session (last_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_session_workspace ON session (workspace, last_at DESC)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
     tokens,
     content = '',
     contentless_delete = 1,
     tokenize = 'unicode61 remove_diacritics 0'
   )",
];

/// What a previous index already holds for one source file.
#[derive(Debug, Clone)]
pub struct ExistingSession {
    /// Session id the row was written under.
    pub id: String,
    /// Working directory recorded for the id.
    pub workspace: String,
    /// Absolute path of the session log the row was built from.
    pub source_path: String,
    /// Recorded source mtime, the incremental key.
    pub mtime: i64,
    /// Recorded source size, the other half of the incremental key.
    pub size: i64,
}

/// Previous index rows keyed by source path.
pub type ExistingIndex = HashMap<String, ExistingSession>;

/// One parsed session paired with the source it came from.
pub struct IndexedSession {
    pub session: ParsedSession,
    /// Which harness wrote the log (`"dsh"` or `"codex"`), stored as `session.source`.
    ///
    /// The column exists so one index can answer "which agent was driving" without opening the
    /// source file, and because two harnesses' rows are otherwise indistinguishable by id shape.
    pub source: &'static str,
    /// Absolute log path, or the synthetic `live://<id>` marker of a live session.
    pub source_path: String,
    /// Source mtime in epoch milliseconds, or 0 for a live session (there is no version to compare).
    pub mtime: i64,
    /// Source size in bytes, or 0 for a live session.
    pub size: i64,
}

/// One index write, already scoped by the caller.
pub struct WritePlan<'a> {
    /// Absolute path of `index.db`.
    pub index_path: &'a Path,
    /// Rebuild from scratch in `index.db.tmp` and rename it into place.
    pub force: bool,
    /// With `force`: seed the rebuild from the previous index so out-of-scope rows survive.
    pub preserve_existing: bool,
    /// Sessions to (re)write.
    pub sessions: &'a [IndexedSession],
    /// Session ids whose source file disappeared.
    pub removed: &'a [String],
    /// Sessions the scan found, for `meta.discovered`.
    pub discovered: usize,
    /// Sessions that failed to parse, for `meta.failed`.
    pub failed: usize,
    /// Epoch milliseconds recorded as the run's completion time in `meta` and the sidecar.
    pub indexed_at: i64,
}

/// What one index write produced.
#[derive(Debug, Clone, Copy)]
pub struct WriteSummary {
    /// Total searchable entries in the index after the write.
    pub entries: i64,
    /// Total sessions in the index after the write.
    pub sessions: i64,
    /// Distinct workspaces in the index after the write.
    pub workspaces: i64,
    /// Bytes the index file occupies after the write.
    pub bytes: i64,
}

/// Read the state a previous index recorded, when it is usable.
///
/// A missing file, an unreadable one, or one written under another schema version yields `None`,
/// which makes the run a full rebuild through the temporary file — the store would refuse such a
/// file anyway, so writing into it would only produce a half-migrated index.
pub fn read_index_state(index_path: &Path) -> Option<ExistingIndex> {
    let connection = Connection::open_with_flags(index_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let version: Option<String> = connection
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![META_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .optional()
        .ok()?;
    if version.and_then(|value| value.parse::<i64>().ok()) != Some(SCHEMA_VERSION) {
        return None;
    }

    let mut statement = connection
        .prepare("SELECT id, workspace, source_path, source_mtime, source_size FROM session")
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok(ExistingSession {
                id: row.get(0)?,
                workspace: row.get(1)?,
                source_path: row.get(2)?,
                mtime: row.get(3)?,
                size: row.get(4)?,
            })
        })
        .ok()?;
    let mut existing = ExistingIndex::new();
    for row in rows {
        let row = row.ok()?;
        existing.insert(row.source_path.clone(), row);
    }
    Some(existing)
}

/// Write one index update.
pub fn write_index(plan: &WritePlan<'_>) -> Result<WriteSummary, String> {
    if let Some(parent) = plan.index_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
    }

    let target = if plan.force {
        temporary_path(plan.index_path)
    } else {
        plan.index_path.to_path_buf()
    };
    if plan.force {
        remove_database_files(&target);
    }
    let preserve = plan.force && plan.preserve_existing && plan.index_path.exists();

    let connection = open_writer(&target)?;
    let written = create_schema(&connection).and_then(|()| write_all(&connection, plan, preserve));
    if let Err(error) = written {
        drop(connection);
        if plan.force {
            remove_database_files(&target);
        }
        return Err(error);
    }
    // Checkpoint before measuring and closing: the WAL holds committed pages, so without this the
    // reported `bytes` would understate the index and the temporary file would be renamed without
    // the data that only lives in its `-wal` sibling.
    checkpoint(&connection)?;
    let summary = summarize(&connection, &target)?;
    drop(connection);

    if plan.force {
        // A clean close removes the WAL and shm siblings; remove any leftovers so the rename cannot
        // carry a stale journal into the live index.
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(with_suffix(&target, suffix));
        }
        fs::rename(&target, plan.index_path).map_err(|error| {
            format!(
                "rename {} -> {}: {error}",
                target.display(),
                plan.index_path.display()
            )
        })?;
    }

    write_status_file(plan.index_path, plan.indexed_at, &summary)?;
    Ok(summary)
}

/// Open an index database for writing with the pragmas the contract fixes.
fn open_writer(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    connection
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|error| format!("pragma on {}: {error}", path.display()))?;
    Ok(connection)
}

/// Create every table and index the shared schema declares.
fn create_schema(connection: &Connection) -> Result<(), String> {
    for statement in SCHEMA_STATEMENTS {
        connection
            .execute_batch(statement)
            .map_err(|error| format!("schema: {error}"))?;
    }
    Ok(())
}

/// Flush the WAL back into the main database file so the file is self-contained.
fn checkpoint(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| format!("checkpoint: {error}"))
}

/// Apply the plan inside one transaction.
fn write_all(connection: &Connection, plan: &WritePlan<'_>, preserve: bool) -> Result<(), String> {
    if preserve {
        let existing = plan.index_path.to_string_lossy().into_owned();
        connection
            .execute("ATTACH DATABASE ?1 AS existing", params![existing])
            .map_err(|error| format!("attach previous index: {error}"))?;
    }

    let outcome = apply_plan(connection, plan, preserve);
    if outcome.is_err() {
        let _ = connection.execute_batch("ROLLBACK;");
    }
    if preserve {
        let _ = connection.execute_batch("DETACH DATABASE existing;");
    }
    outcome
}

/// The transactional half of [`write_all`].
fn apply_plan(connection: &Connection, plan: &WritePlan<'_>, preserve: bool) -> Result<(), String> {
    connection
        .execute_batch("BEGIN IMMEDIATE;")
        .map_err(|error| format!("begin: {error}"))?;

    if preserve {
        copy_existing(connection)?;
    }

    let mut remove_fts = connection
        .prepare("DELETE FROM entry_fts WHERE rowid IN (SELECT id FROM entry WHERE session_id = ?1)")
        .map_err(database_error)?;
    let mut remove_entries = connection
        .prepare("DELETE FROM entry WHERE session_id = ?1")
        .map_err(database_error)?;
    let mut remove_session = connection
        .prepare("DELETE FROM session WHERE id = ?1")
        .map_err(database_error)?;
    for id in plan.removed {
        remove_fts.execute(params![id]).map_err(database_error)?;
        remove_entries.execute(params![id]).map_err(database_error)?;
        remove_session.execute(params![id]).map_err(database_error)?;
    }

    let mut remove_fts_for_source = connection
        .prepare(
            "DELETE FROM entry_fts WHERE rowid IN (SELECT id FROM entry
              WHERE session_id IN (SELECT id FROM session WHERE id = ?1 OR source_path = ?2))",
        )
        .map_err(database_error)?;
    let mut remove_entries_for_source = connection
        .prepare(
            "DELETE FROM entry
              WHERE session_id IN (SELECT id FROM session WHERE id = ?1 OR source_path = ?2)",
        )
        .map_err(database_error)?;
    let mut remove_session_for_source = connection
        .prepare("DELETE FROM session WHERE id = ?1 OR source_path = ?2")
        .map_err(database_error)?;
    let mut insert_session = connection
        .prepare(
            "INSERT INTO session
              (id, source, workspace, title, created_at, last_at, parent_session, origin, agent_preset,
               turns, entries, source_path, source_mtime, source_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )
        .map_err(database_error)?;
    let mut insert_entry = connection
        .prepare(
            "INSERT INTO entry (session_id, seq, time, turn, kind, text, clipped)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(database_error)?;
    let mut insert_fts = connection
        .prepare("INSERT INTO entry_fts (rowid, tokens) VALUES (?1, ?2)")
        .map_err(database_error)?;

    for item in plan.sessions {
        let source_path = item.source_path.clone();
        // Keyed by id AND source path: a session whose id changed between runs must not leave its
        // old row behind, and the source path is the stable half of the pair.
        remove_fts_for_source
            .execute(params![item.session.id, source_path])
            .map_err(database_error)?;
        remove_entries_for_source
            .execute(params![item.session.id, source_path])
            .map_err(database_error)?;
        remove_session_for_source
            .execute(params![item.session.id, source_path])
            .map_err(database_error)?;

        insert_session
            .execute(params![
                item.session.id,
                item.source,
                item.session.cwd,
                item.session.title,
                item.session.created_at,
                item.session.last_at,
                item.session.parent_session,
                item.session.origin,
                item.session.agent_preset,
                item.session.turns,
                item.session.entries.len() as i64,
                source_path,
                item.mtime,
                item.size,
            ])
            .map_err(database_error)?;

        for entry in &item.session.entries {
            insert_entry
                .execute(params![
                    item.session.id,
                    entry.seq,
                    entry.time,
                    entry.turn,
                    entry.kind,
                    entry.text,
                    if entry.clipped { 1 } else { 0 },
                ])
                .map_err(database_error)?;
            insert_fts
                .execute(params![
                    connection.last_insert_rowid(),
                    tokenize::joined(&entry.text),
                ])
                .map_err(database_error)?;
        }
    }

    let mut upsert_meta = connection
        .prepare(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .map_err(database_error)?;
    for (key, value) in [
        (META_SCHEMA_VERSION, SCHEMA_VERSION.to_string()),
        (META_INDEXED_AT, plan.indexed_at.to_string()),
        (META_DISCOVERED, plan.discovered.to_string()),
        (META_FAILED, plan.failed.to_string()),
    ] {
        upsert_meta
            .execute(params![key, value])
            .map_err(database_error)?;
    }

    connection
        .execute_batch("COMMIT;")
        .map_err(|error| format!("commit: {error}"))
}

/// Copy the previous index's rows into a scoped rebuild.
fn copy_existing(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "INSERT INTO session SELECT * FROM existing.session;
             INSERT INTO entry SELECT * FROM existing.entry;
             INSERT INTO entry_fts (rowid, tokens) SELECT rowid, tokens FROM existing.entry_fts;",
        )
        .map_err(|error| format!("copy previous index: {error}"))
}

/// Count what the index now holds and measure it.
fn summarize(connection: &Connection, path: &Path) -> Result<WriteSummary, String> {
    let sessions = count(connection, "SELECT COUNT(*) FROM session")?;
    let entries = count(connection, "SELECT COUNT(*) FROM entry")?;
    let workspaces = count(connection, "SELECT COUNT(DISTINCT workspace) FROM session")?;
    let bytes = fs::metadata(path)
        .map_err(|error| format!("stat {}: {error}", path.display()))?
        .len() as i64;
    Ok(WriteSummary {
        entries,
        sessions,
        workspaces,
        bytes,
    })
}

fn count(connection: &Connection, sql: &str) -> Result<i64, String> {
    connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(database_error)
}

/// Write the sidecar summary the prompt-assembly path reads.
///
/// Written only after the index transaction committed and the file is in place, through a
/// temporary file and a rename: a reader polling the sidecar sees either the previous run's
/// complete JSON or this run's, never a half-written one.
fn write_status_file(index_path: &Path, indexed_at: i64, summary: &WriteSummary) -> Result<(), String> {
    let status_path = index_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(STATUS_RELATIVE_PATH);
    let temporary_path = with_suffix(&status_path, ".tmp");
    let document = json!({
        "schemaVersion": SCHEMA_VERSION,
        "indexedAt": indexed_at,
        "sessions": summary.sessions,
        "entries": summary.entries,
        "workspaces": summary.workspaces,
        "bytes": summary.bytes,
    });
    let mut body = serde_json::to_string(&document).map_err(|error| format!("status json: {error}"))?;
    body.push('\n');
    fs::write(&temporary_path, body)
        .map_err(|error| format!("write {}: {error}", temporary_path.display()))?;
    fs::rename(&temporary_path, &status_path)
        .map_err(|error| format!("rename {}: {error}", status_path.display()))
}

/// `<indexPath>.tmp` — the rebuild target that replaces the live index atomically.
fn temporary_path(index_path: &Path) -> PathBuf {
    with_suffix(index_path, ".tmp")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut owned = path.as_os_str().to_os_string();
    owned.push(suffix);
    PathBuf::from(owned)
}

/// Delete a database file and any journal/WAL siblings a previous run left behind.
fn remove_database_files(path: &Path) {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let _ = fs::remove_file(with_suffix(path, suffix));
    }
}

fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}
