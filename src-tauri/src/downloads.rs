//! Detect in-progress browser downloads in the user's Downloads folder.
//!
//! Browsers expose no public progress API, but every major one keeps a partial
//! file on disk while a download is running. Watching those suffixes gives the
//! notch a reliable, permission-free progress indicator.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

const PARTIAL_SUFFIXES: &[&str] = &[
    ".crdownload", // Chrome / Edge / Chromium
    ".part",       // Firefox
    ".download",   // Safari
    ".opdownload", // Opera
    ".partial",    // generic
];

fn downloads_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let dir = home.join("Downloads");
    dir.is_dir().then_some(dir)
}

fn display_name(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    for suffix in PARTIAL_SUFFIXES {
        if lower.ends_with(suffix) {
            return file_name[..file_name.len() - suffix.len()].to_string();
        }
    }
    file_name.to_string()
}

/// Active partial downloads, newest first.
pub fn list_downloads() -> Vec<DownloadInfo> {
    let Some(dir) = downloads_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<DownloadInfo> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if !PARTIAL_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix)) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            Some(DownloadInfo {
                name: display_name(&name),
                path: entry.path().to_string_lossy().to_string(),
                bytes: metadata.len(),
                modified_ms,
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}
