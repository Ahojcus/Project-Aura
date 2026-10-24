// ---------------------------------------------------------------------------
// App launcher sources: enumerate Start-Menu shortcuts so the notch's run
// widget can search and launch installed apps. A one-shot scan on boot fills
// the shared list; `rescan_apps` (Settings) forces a fresh walk.
// ---------------------------------------------------------------------------

use std::path::Path;

use serde::Serialize;

use crate::commands::Shared;

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    /// Display name (file stem, e.g. "Visual Studio Code").
    pub name: String,
    /// Absolute path of the .lnk/.exe/.url to launch (explorer handles .lnk).
    pub target: String,
}

#[derive(Clone, Default)]
pub struct AppsState {
    list: Shared<Vec<AppEntry>>,
}

pub fn spawn_apps_thread() -> AppsState {
    let state = AppsState::default();
    let state2 = state.clone();
    std::thread::Builder::new()
        .name("mon-apps".into())
        .spawn(move || {
            let list = scan();
            if let Ok(mut guard) = state2.list.lock() {
                *guard = list;
            }
        })
        .expect("spawn apps thread");
    state
}

/// Re-walk the Start Menu now (called from the refresh command).
pub fn rescan(state: &AppsState) {
    let list = scan();
    if let Ok(mut guard) = state.list.lock() {
        *guard = list;
    }
}

fn start_menu_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(pd) = std::env::var_os("ProgramData") {
        dirs.push(std::path::PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(app_a) = std::env::var_os("AppData") {
        dirs.push(std::path::PathBuf::from(app_a).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// Depth-limited walk collecting launchable entries (shortcuts, exes, links).
fn scan() -> Vec<AppEntry> {
    let mut out: Vec<AppEntry> = Vec::new();
    for dir in start_menu_dirs() {
        walk_dir(&dir, 0, &mut out);
    }
    // Stable order for the UI + dedupe identical (name, target) pairs.
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out.dedup();
    out
}

fn walk_dir(dir: &Path, depth: u32, out: &mut Vec<AppEntry>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_dir(&path, depth + 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "lnk" | "exe" | "url") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(AppEntry {
            name: name.to_string(),
            target: path.to_string_lossy().to_string(),
        });
    }
}

/// Convenience for the command: snapshot of the current entry list.
pub fn snapshot(state: &AppsState) -> Vec<AppEntry> {
    state.list.lock().map(|l| l.clone()).unwrap_or_default()
}
