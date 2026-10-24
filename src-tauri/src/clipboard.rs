//! Text clipboard history — a free-tier "Smart Notch" feature.
//!
//! A background thread polls the Windows clipboard every 2s and keeps the last
//! N distinct text snippets. The notch widget shows them and can copy one back
//! to the clipboard. Non-Windows platforms compile but never poll.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize)]
pub struct ClipboardEntry {
    pub text: String,
    pub at_ms: u64,
}

pub type History = Arc<Mutex<Vec<ClipboardEntry>>>;

const MAX_ENTRIES: usize = 30;
const MAX_TEXT_LEN: usize = 4000;
const POLL_MS: u64 = 2000;

pub fn spawn_clipboard_thread() -> History {
    let history: History = Arc::new(Mutex::new(Vec::new()));
    #[cfg(windows)]
    {
        let inner = history.clone();
        std::thread::spawn(move || {
            loop {
                if let Some(text) = read_clipboard_text() {
                    let text = text.chars().take(MAX_TEXT_LEN).collect::<String>();
                    let trimmed = text.trim().to_string();
                    if !trimmed.is_empty() {
                        push_entry(&inner, trimmed);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
            }
        });
    }
    history
}

/// Move `text` to the front of the history (dedupe) and cap the list.
fn push_entry(history: &History, text: String) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(mut list) = history.lock() else { return };
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    list.retain(|e| e.text != text);
    list.insert(0, ClipboardEntry { text, at_ms: at });
    if list.len() > MAX_ENTRIES {
        list.truncate(MAX_ENTRIES);
    }
}

/// Write `text` into the Windows clipboard (the copy-back action).
#[cfg(windows)]
pub fn write_clipboard_text(text: &str) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::Foundation::{HANDLE, HWND};

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * 2;

    unsafe {
        OpenClipboard(HWND(std::ptr::null_mut())).map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|e| e.to_string())?;
            let dst = GlobalLock(hglobal);
            if dst.is_null() {
                return Err("GlobalLock failed".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), dst as *mut u16, wide.len());
            let _ = GlobalUnlock(hglobal);
            SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hglobal.0 as *mut core::ffi::c_void))
                .map_err(|e| e.to_string())?;
            // Ownership of the handle transferred to the clipboard on success.
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

/// Read plain text from the Windows clipboard, if there is any.
#[cfg(windows)]
fn read_clipboard_text() -> Option<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::Foundation::HWND;

    unsafe {
        if OpenClipboard(HWND(std::ptr::null_mut())).is_err() {
            return None;
        }
        let out = (|| -> Option<String> {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let ptr = handle.0 as *const u16;
            if ptr.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *ptr.add(len) != 0 && len < 100_000 {
                len += 1;
            }
            if len == 0 {
                return None;
            }
            let slice = std::slice::from_raw_parts(ptr, len);
            Some(String::from_utf16_lossy(slice))
        })();
        let _ = CloseClipboard();
        out
    }
}
