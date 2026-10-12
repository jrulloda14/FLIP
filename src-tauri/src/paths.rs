//! Application-owned storage locations and atomic file writes.
//! All files FLIP writes live under one directory: `%APPDATA%\com.flip.dashboard\`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const IDENTIFIER: &str = "com.flip.dashboard";

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub dir: PathBuf,
}

impl AppPaths {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Resolves the data directory without a Tauri handle, so the status-line bridge
    /// (which runs without starting the app) writes to the same place Tauri's `app_config_dir` uses.
    pub fn from_env() -> Option<Self> {
        let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
        Some(Self::new(base.join(IDENTIFIER)))
    }

    pub fn settings(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    pub fn pomodoro(&self) -> PathBuf {
        self.dir.join("pomodoro.json")
    }
    pub fn ai_cache(&self) -> PathBuf {
        self.dir.join("ai-cache.json")
    }
    pub fn claude_statusline(&self) -> PathBuf {
        self.dir.join("claude-statusline.json")
    }
}

/// Writes to a temp file next to the target, then renames over it, so a crash never leaves a
/// half-written file behind.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("nested").join("a.json");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        assert!(!p.with_extension("tmp").exists());
    }
}
