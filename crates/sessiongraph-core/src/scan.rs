//! Discover the harness session logs under `sessions_root`.
//!
//! Layout: `<sessionsRoot>/<escaped-cwd>/<session-dir>/session.v<N>.jsonl.zstd` — exactly two
//! directory levels and a filename match, mirroring `packages/sessions/src/scan.ts`. Both `v3` and
//! `v4` logs exist on an upgraded machine and carry the same event shape; within one session
//! directory the highest version wins, so a half-finished v3 → v4 rewrite contributes one session
//! rather than two.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// A session log file the indexer can read.
#[derive(Debug, Clone)]
pub struct SessionFile {
    /// Absolute path of the directory holding the log (the harness session directory).
    pub session_dir: PathBuf,
    /// Absolute path of the log file itself.
    pub file_path: PathBuf,
    /// The workspace directory name as the harness escaped it.
    pub workspace_dir: String,
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

/// The session id fallback: the session directory's own name.
pub fn fallback_id(file: &SessionFile) -> String {
    file.session_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::log_version;

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
}
