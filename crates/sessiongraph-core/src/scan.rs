//! Discover the session logs two harnesses write.
//!
//! **DSH** lays out `<sessionsRoot>/<escaped-cwd>/<session-dir>/session.v<N>.jsonl.zstd` — exactly
//! two directory levels and a filename match, mirroring `packages/sessions/src/scan.ts`. Both `v3`
//! and `v4` logs exist on an upgraded machine and carry the same event shape; within one session
//! directory the highest version wins, so a half-finished v3 → v4 rewrite contributes one session
//! rather than two.
//!
//! **Codex** writes `rollout-*.jsonl.zst` in two places: `archived_sessions/` (flat) and
//! `sessions/<yyyy>/<mm>/<dd>/` (three date levels). A conversation can appear in both after being
//! archived, which is why the run de-duplicates on session id rather than on path.
//!
//! Both walkers answer one shape, because everything downstream — the incremental change key, the
//! parser dispatch, the `source` column — is shared. That is what [`SessionSource`] records.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Which harness wrote a session log, as stored in `session.source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSource {
    /// This harness's own session logs.
    Dsh,
    /// OpenAI Codex rollout logs.
    Codex,
}

impl SessionSource {
    /// The label written to `session.source`, shared with the TypeScript indexer.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dsh => "dsh",
            Self::Codex => "codex",
        }
    }
}

/// Directory name reported for a Codex file, which has no escaped-workspace parent.
const CODEX_WORKSPACE_DIR: &str = "codex";

/// A session log file the indexer can read.
#[derive(Debug, Clone)]
pub struct SessionFile {
    /// Absolute path of the directory holding the log (the harness session directory).
    pub session_dir: PathBuf,
    /// Absolute path of the log file itself.
    pub file_path: PathBuf,
    /// The workspace directory name as the harness escaped it; a fallback when the header has no
    /// `cwd`.
    ///
    /// Codex logs carry no such name, so a Codex file reports [`CODEX_WORKSPACE_DIR`] here and
    /// relies on its `session_meta.cwd` instead.
    pub workspace_dir: String,
    /// Which harness wrote this log.
    pub source: SessionSource,
    /// Modification time in epoch milliseconds, truncated to a whole millisecond.
    pub mtime: i64,
    /// File size in bytes, the other half of the incremental change key.
    pub size: i64,
}

/// `session.v4.jsonl.zstd` → `Some(4)`.
fn log_version(name: &str) -> Option<u32> {
    let rest = name.strip_prefix("session.v")?;
    let digits = rest.strip_suffix(".jsonl.zstd")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// List every session log under `sessions_root`, one entry per session directory.
///
/// A missing root is an empty scan, not an error: a machine that never ran a session has no store
/// yet, so the run should build an empty index rather than fail.
pub fn scan_sessions(sessions_root: &Path) -> Result<Vec<SessionFile>, String> {
    let workspaces = match fs::read_dir(sessions_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}: {error}", sessions_root.display())),
    };

    let mut found = Vec::new();
    for workspace in workspaces.flatten() {
        let is_dir = workspace.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let workspace_path = workspace.path();
        let workspace_dir = workspace.file_name().to_string_lossy().into_owned();
        let sessions = match fs::read_dir(&workspace_path) {
            Ok(entries) => entries,
            // Only a directory that vanished mid-scan is ignorable. Hiding any other read failure
            // would make the run look like "every source disappeared" and delete its rows.
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("read {}: {error}", workspace_path.display())),
        };

        for session in sessions.flatten() {
            let is_dir = session.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            let session_dir = session.path();
            let Some((file_path, _version)) = pick_log_file(&session_dir)? else {
                continue;
            };
            // Vanished between the listing and the stat: the next run drops it anyway.
            let metadata = match fs::metadata(&file_path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("stat {}: {error}", file_path.display())),
            };
            found.push(SessionFile {
                session_dir: session_dir.clone(),
                file_path,
                workspace_dir: workspace_dir.clone(),
                source: SessionSource::Dsh,
                mtime: mtime_millis(&metadata),
                size: metadata.len() as i64,
            });
        }
    }

    // Ordered by workspace then session directory, so a run is reproducible.
    found.sort_by(|left, right| {
        left.workspace_dir
            .cmp(&right.workspace_dir)
            .then_with(|| left.session_dir.cmp(&right.session_dir))
    });
    Ok(found)
}

/// Pick the newest-version log inside one session directory.
fn pick_log_file(session_dir: &Path) -> Result<Option<(PathBuf, u32)>, String> {
    let entries = match fs::read_dir(session_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", session_dir.display())),
    };
    let mut chosen: Option<(PathBuf, u32)> = None;
    for entry in entries.flatten() {
        let is_file = entry.file_type().map(|kind| kind.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(version) = log_version(&name) else {
            continue;
        };
        if chosen.as_ref().is_none_or(|(_, best)| version > *best) {
            chosen = Some((entry.path(), version));
        }
    }
    Ok(chosen)
}

/// Modification time in epoch milliseconds (truncated), or 0 when the platform cannot report one.
fn mtime_millis(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `rollout-2026-03-17T18-23-27-019cfb52-….jsonl.zst` — Codex's one-file-per-conversation shape.
fn is_codex_rollout(name: &str) -> bool {
    name.starts_with("rollout-") && name.ends_with(".jsonl.zst")
}

/// List every Codex rollout log under a Codex home directory.
///
/// A machine that has never run Codex has no `~/.codex`, and that is an empty contribution to the
/// index rather than a failure of the run — the same tolerance [`scan_sessions`] applies to a
/// machine that has never run this harness.
pub fn scan_codex_sessions(codex_root: &Path) -> Result<Vec<SessionFile>, String> {
    let mut found = Vec::new();
    // Archived conversations are flat; live ones are nested under `<yyyy>/<mm>/<dd>`. The depth bound
    // is what stops a stray deep tree from turning the walk into an unbounded recursive read.
    collect_codex_logs(&codex_root.join("archived_sessions"), 0, &mut found)?;
    collect_codex_logs(&codex_root.join("sessions"), 3, &mut found)?;
    // Ordered by path, so a run is reproducible.
    found.sort_by(|left, right| left.file_path.cmp(&right.file_path));
    Ok(found)
}

/// Recursively collect Codex rollout logs below one directory.
fn collect_codex_logs(
    directory: &Path,
    depth: u32,
    out: &mut Vec<SessionFile>,
) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        // Only a directory that does not exist is ignorable. A read that fails for any other reason
        // must abort: a silently short scan looks like "the sources disappeared" and deletes their
        // rows.
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read {}: {error}", directory.display())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry.file_type();
        if file_type.as_ref().map(fs::FileType::is_dir).unwrap_or(false) {
            if depth > 0 {
                collect_codex_logs(&path, depth - 1, out)?;
            }
            continue;
        }
        if !file_type.as_ref().map(fs::FileType::is_file).unwrap_or(false) {
            continue;
        }
        if !is_codex_rollout(&entry.file_name().to_string_lossy()) {
            continue;
        }
        // Vanished between the listing and the stat: the next run drops it anyway.
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("stat {}: {error}", path.display())),
        };
        out.push(SessionFile {
            session_dir: directory.to_path_buf(),
            file_path: path,
            workspace_dir: CODEX_WORKSPACE_DIR.to_owned(),
            source: SessionSource::Codex,
            mtime: mtime_millis(&metadata),
            size: metadata.len() as i64,
        });
    }
    Ok(())
}

/// Read Codex's thread-name index (`<codexRoot>/session_index.jsonl`).
///
/// A rollout log records the conversation but never what Codex shows in its sidebar, so the title
/// has to come from this second file. It is read once per run for every log, and a malformed line
/// costs that one title — Codex appends to the file itself, so a partially written last line is
/// normal.
///
/// An unreadable file yields no titles rather than an error: a title is a label, and failing the
/// whole run over one would trade a searchable index for nothing.
pub fn read_codex_titles(codex_root: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    let Ok(text) = fs::read_to_string(codex_root.join("session_index.jsonl")) else {
        return titles;
    };
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !record.is_object() {
            continue;
        }
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(title) = record.get("thread_name").and_then(Value::as_str) else {
            continue;
        };
        if title.trim().is_empty() {
            continue;
        }
        // Last write wins, which is what the TS `Map.set` does for a repeated id.
        titles.insert(id.to_owned(), title.to_owned());
    }
    titles
}

/// The session id fallback: the session directory's own name.
pub fn fallback_id(file: &SessionFile) -> String {
    file.session_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{log_version, read_codex_titles, scan_codex_sessions, SessionSource};

    #[test]
    fn recognises_only_versioned_session_logs() {
        assert_eq!(log_version("session.v4.jsonl.zstd"), Some(4));
        assert_eq!(log_version("session.v3.jsonl.zstd"), Some(3));
        assert_eq!(log_version("session.v12.jsonl.zstd"), Some(12));
        assert_eq!(log_version("session.lock"), None);
        assert_eq!(log_version("session.v.jsonl.zstd"), None);
        assert_eq!(log_version("session.vX.jsonl.zstd"), None);
        assert_eq!(log_version("other.v4.jsonl.zstd"), None);
    }

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
            "sessiongraph-scan-{}-{sequence}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture directory");
        Fixture { dir }
    }

    /// Create one empty file, with its parent directories.
    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("parent directory")).expect("create parent");
        fs::write(path, b"x").expect("write fixture file");
    }

    #[test]
    fn lists_codex_rollouts_from_both_stores() {
        let fixture = fixture();
        let root = fixture.dir.join("codex");
        touch(&root.join("archived_sessions/rollout-a.jsonl.zst"));
        touch(&root.join("sessions/2026/03/27/rollout-b.jsonl.zst"));
        // Not rollouts: this harness's own log shape, an uncompressed name, and a lock file.
        touch(&root.join("sessions/2026/03/27/session.v4.jsonl.zstd"));
        touch(&root.join("sessions/2026/03/27/rollout-c.jsonl"));
        touch(&root.join("sessions/2026/03/27/session.lock"));
        // Deeper than Codex ever nests: the depth bound must stop the walk here.
        touch(&root.join("sessions/2026/03/27/28/rollout-deep.jsonl.zst"));

        let found = scan_codex_sessions(&root).expect("scan codex");
        let paths: Vec<String> = found
            .iter()
            .map(|file| {
                file.file_path
                    .strip_prefix(&root)
                    .expect("inside root")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            paths,
            vec![
                "archived_sessions/rollout-a.jsonl.zst".to_owned(),
                "sessions/2026/03/27/rollout-b.jsonl.zst".to_owned(),
            ]
        );
        for file in &found {
            assert_eq!(file.source, SessionSource::Codex);
            // A Codex file has no escaped-workspace parent; `session_meta.cwd` supplies the workspace.
            assert_eq!(file.workspace_dir, "codex");
            assert!(file.size > 0);
        }
    }

    #[test]
    fn a_missing_codex_home_is_an_empty_scan() {
        let fixture = fixture();
        let found = scan_codex_sessions(&fixture.dir.join("never-existed")).expect("scan codex");
        assert!(found.is_empty());
    }

    #[test]
    fn reads_thread_names_and_tolerates_a_corrupt_line() {
        let fixture = fixture();
        let index = fixture.dir.join("session_index.jsonl");
        fs::write(
            &index,
            [
                r#"{"id":"aaa","thread_name":"广告 SDK 调试","updated_at":"2026-03-17T10:54:08Z"}"#,
                "{not json",
                r#"{"id":"bbb","thread_name":"   "}"#,
                r#"{"id":"ccc"}"#,
                "[1,2,3]",
                r#"{"id":"ddd","thread_name":"第二个"}"#,
            ]
            .join("\n"),
        )
        .expect("write session index");

        let titles = read_codex_titles(&fixture.dir);
        assert_eq!(titles.len(), 2);
        assert_eq!(titles.get("aaa").map(String::as_str), Some("广告 SDK 调试"));
        assert_eq!(titles.get("ddd").map(String::as_str), Some("第二个"));
    }

    #[test]
    fn a_missing_thread_name_index_yields_no_titles() {
        let fixture = fixture();
        assert!(read_codex_titles(&fixture.dir).is_empty());
    }
}
