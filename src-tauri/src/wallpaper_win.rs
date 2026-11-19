use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetClientRect, GetWindowLongPtrW,
    GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, SetParent, SetWindowLongPtrW, SetWindowPos,
    ShowWindowAsync, EnumWindows, SendMessageTimeoutW, GWL_EXSTYLE, GWL_STYLE,
    GA_PARENT, HWND_BOTTOM, HWND_TOP, SMTO_NORMAL,
    SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
    SW_SHOWNOACTIVATE, WS_CAPTION,
    WS_CHILD, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_THICKFRAME, SWP_NOZORDER,
};

const WM_SPAWN_WORKER: u32 = 0x052C;

/// Styles captured before the last embed of each window, so un-embedding
/// restores the exact pre-embed window (styles mutate through several code
/// paths — snapshot values beat bit-arithmetic guesses).
static ORIGINAL_STYLES: OnceLock<Mutex<HashMap<isize, (isize, isize)>>> = OnceLock::new();
fn original_styles() -> &'static Mutex<HashMap<isize, (isize, isize)>> {
    ORIGINAL_STYLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Startup can request the same wallpaper show from both the settings sync and
/// the layer's React effect. Reparenting the same HWND from two threads at once
/// deadlocks the window manager, so all native embed/unembed work is serialized.
static EMBED_LOCK: Mutex<()> = Mutex::new(());

std::thread_local! {
    static WORKERW_WINDOWS: std::cell::RefCell<Vec<isize>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// True when the WorkerW owns the icon layer. That WorkerW is above the
/// wallpaper host; use the other one when it exists.
unsafe fn owns_icons(hwnd: windows::Win32::Foundation::HWND) -> bool {
    FindWindowExW(
        hwnd,
        windows::Win32::Foundation::HWND::default(),
        w!("SHELLDLL_DefView"),
        PCWSTR::null(),
    )
    .map(|view| !view.0.is_null())
    .unwrap_or(false)
}

/// Area of a top-level WorkerW. Explorer has a tiny helper WorkerW in
/// addition to the full-screen wallpaper host; choosing the first match made
/// the wallpaper a 136px rectangle.
unsafe fn window_area(hwnd: windows::Win32::Foundation::HWND) -> i64 {
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return 0;
    }
    let w = (rect.right - rect.left).max(0) as i64;
    let h = (rect.bottom - rect.top).max(0) as i64;
    w.saturating_mul(h)
}

unsafe fn class_name(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut buf);
    if n <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize]))
}


/// Keep a wallpaper parented to Progman immediately below the icon layer.
/// Explorer's own WorkerW is a sibling below this point; a plain HWND_BOTTOM
/// puts the wallpaper underneath that sibling and makes it invisible.
unsafe fn place_below_icons(hwnd: windows::Win32::Foundation::HWND) -> bool {
    if GetWindowLongPtrW(hwnd, GWL_STYLE) & (WS_CHILD.0 as isize) == 0 {
        return false;
    }
    let parent = GetAncestor(hwnd, GA_PARENT);
    if class_name(parent).as_deref() != Some("Progman") {
        return false;
    }
    let Ok(defview) = FindWindowExW(
        parent,
        windows::Win32::Foundation::HWND::default(),
        w!("SHELLDLL_DefView"),
        PCWSTR::null(),
    ) else {
        return false;
    };
    if defview.0.is_null() {
        return false;
    }
    SetWindowPos(
        hwnd,
        defview,
        0,
        0,
        0,
        0,
        SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
    )
    .is_ok()
}

unsafe extern "system" fn enum_proc(
    hwnd: windows::Win32::Foundation::HWND,
    _lparam: LPARAM,
) -> windows::Win32::Foundation::BOOL {
    // Keep enumerating after a match: the icon host and the wallpaper host
    // are different top-level windows on current Explorer builds.
    if class_name(hwnd).as_deref() == Some("WorkerW") {
        WORKERW_WINDOWS.with(|windows| windows.borrow_mut().push(hwnd.0 as isize));
    }
    true.into()
}

/// Either embed the wallpaper webview behind the desktop icons (inside the
/// "second" WorkerW created via the Progman 0x052C trick) or restore it, and
/// strip WS_EX_TOPMOST in both directions: a topmost wallpaper child of the
/// desktop would still draw over the taskbar (its z-order shield), and a
/// topmost leftover after a failed embed covers the taskbar outright.
/// Returns true on success.
pub fn set_embedded(hwnd: windows::Win32::Foundation::HWND, embed: bool) -> bool {
    let _guard = EMBED_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        if embed {
            do_embed(hwnd)
        } else {
            do_unembed(hwnd)
        }
    }
}

unsafe fn snapshot_restore(hwnd: HWND) {
    if let Ok(snap) = original_styles().lock() {
        if let Some((style, ex)) = snap.get(&(hwnd.0 as isize)) {
            SetWindowLongPtrW(hwnd, GWL_STYLE, *style);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, *ex);
            let _ = SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

unsafe fn do_embed(hwnd: windows::Win32::Foundation::HWND) -> bool {
    // Re-show path: already parented to the desktop worker. Re-snapshotting
    // child styles here would corrupt the next unembed.
    let existing_style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if existing_style & (WS_CHILD.0 as isize) != 0 {
        let parent = GetAncestor(hwnd, GA_PARENT);
        if matches!(class_name(parent).as_deref(), Some("WorkerW") | Some("Progman")) {
            let ok = ensure_backdrop(hwnd);
            let _ = fit_to_monitor(hwnd);
            if ok {
                let _ = place_below_icons(hwnd);
            }
            return ok;
        }
        // Explorer restarted and the worker is gone: restore the top-level
        // styles and attach to the new desktop instead of staying orphaned.
        snapshot_restore(hwnd);
        let _ = SetParent(hwnd, windows::Win32::Foundation::HWND::default());
    }

    let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) else {
        return false;
    };
    // Ask Progman to spawn the wallpaper WorkerW. Explorer requires the
    // 0xD/0x1 parameters on current builds; 0/0 only finds a tiny helper
    // WorkerW and leaves the wallpaper as a 136px rectangle.
    let _ = SendMessageTimeoutW(
        progman,
        WM_SPAWN_WORKER,
        WPARAM(0xD),
        LPARAM(0x1),
        SMTO_NORMAL,
        1000,
        None,
    );
    let _ = SendMessageTimeoutW(progman, WM_SPAWN_WORKER, WPARAM(0), LPARAM(0), SMTO_NORMAL, 1000, None);

    // The icon layer is normally a child of Progman on Windows 11, but on
    // older shells it lives under a WorkerW. Find both and then prefer the
    // WorkerW that does NOT own SHELLDLL_DefView: that is Explorer's live
    // wallpaper host. Attaching directly to Progman places the webview
    // behind the static desktop painter, which renders as a black wallpaper.
    WORKERW_WINDOWS.with(|windows| windows.borrow_mut().clear());
    let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    let worker_raw = WORKERW_WINDOWS.with(|windows| windows.borrow().clone());
    let workers: Vec<windows::Win32::Foundation::HWND> = worker_raw
        .into_iter()
        .map(|raw| windows::Win32::Foundation::HWND(raw as *mut core::ffi::c_void))
        .collect();
    let defview = FindWindowExW(
        progman,
        windows::Win32::Foundation::HWND::default(),
        w!("SHELLDLL_DefView"),
        PCWSTR::null(),
    )
    .ok()
    .filter(|view| !view.0.is_null());
    let keeper = defview
        .map(|view| GetAncestor(view, GA_PARENT))
        .filter(|parent| !parent.0.is_null())
        .unwrap_or(progman);
    // WorkerW is not unique: WebView2 and other Chromium hosts create their
    // own tiny invisible WorkerW windows. Only an Explorer-owned, visible,
    // full-screen WorkerW is the desktop wallpaper host. If none exists, use
    // Progman itself; Explorer uses Progman directly on current Windows 11.
    let mut progman_pid = 0u32;
    let _ = GetWindowThreadProcessId(progman, Some(&mut progman_pid));
    let candidates: Vec<windows::Win32::Foundation::HWND> = workers
        .iter()
        .copied()
        .filter(|worker| {
            if worker.0 == keeper.0 || owns_icons(*worker) {
                return false;
            }
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(*worker, Some(&mut pid));
            pid == progman_pid && IsWindowVisible(*worker).as_bool() && window_area(*worker) >= 100_000
        })
        .collect();
    // Newer Explorer versions keep the real wallpaper host *nested* under
    // Progman instead of as a top-level WorkerW. It is the full-virtual-screen
    // window behind SHELLDLL_DefView and is the correct Lively-style parent.
    let nested_worker = FindWindowExW(
        progman,
        windows::Win32::Foundation::HWND::default(),
        w!("WorkerW"),
        PCWSTR::null(),
    )
    .ok()
    .filter(|worker| {
        !worker.0.is_null()
            && !owns_icons(*worker)
            && IsWindowVisible(*worker).as_bool()
            && window_area(*worker) >= 100_000
    });
    let target = nested_worker
        .or_else(|| candidates.iter().copied().max_by_key(|worker| window_area(*worker)))
        .or_else(|| {
            if class_name(keeper).as_deref() == Some("WorkerW") {
                Some(keeper)
            } else {
                None
            }
        })
        .unwrap_or(progman);

    // Snapshot the exact pre-embed styles so unembedding restores them.
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if let Ok(mut snap) = original_styles().lock() {
        snap.insert(hwnd.0 as isize, (style, ex));
    }

    // The wallpaper WorkerW is a true child: popup/caption framing must go.
    let clear = (WS_CAPTION.0 | WS_THICKFRAME.0) as isize;
    SetWindowLongPtrW(hwnd, GWL_STYLE, (style & !clear) | (WS_CHILD.0 as isize));
    // OS-level click-through: an embedded wallpaper must never take mouse
    // input (drag/click/steal focus) — it is a backdrop, not an app. Webview
    // ignore-cursor-events also does this, but latch it in the Win32 style so
    // nothing can re-enable interaction by touching the window later. The
    // topmost bit must NOT survive: combined with the child re-parenting
    // window a layering can leak it (or leave it on a *failed* fallback
    // window), and a topmost desktop surface paints over the taskbar. A
    // layered child of WorkerW does not composite its WebView, which leaves
    // per-display wallpaper windows black; drop that bit during embedding.
    let ex_lock = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
    let ex_clear = (WS_EX_TOPMOST.0 | WS_EX_LAYERED.0) as isize;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | ex_lock) & !ex_clear);
    // Snapshot the window's own screen rect BEFORE re-parenting — after
    // SetParent screen coordinates become parent-client coordinates, and
    // callers size/position each wallpaper to its own display. The old
    // behavior (reset to 0,0 at full WorkerW size) stretched every wallpaper
    // across ALL monitors, which could swallow the Windows taskbar beneath it.
    let mut self_rect = RECT::default();
    if GetWindowRect(hwnd, &mut self_rect).is_err() {
        snapshot_restore(hwnd);
        return false;
    }
    let _ = SetParent(hwnd, target);
    // Verify the re-parent actually happened — a silent failure used to leave
    // the wallpaper as a fullscreen *top-level* window over every app.
    if GetAncestor(hwnd, GA_PARENT).0 != target.0 {
        snapshot_restore(hwnd);
        return false;
    }
    let mut rect = RECT::default();
    if GetWindowRect(target, &mut rect).is_err() {
        snapshot_restore(hwnd);
        return false;
    }
    // Place the child at its previous screen position (now WorkerW-relative),
    // clamped inside the worker so nothing can spill past the virtual screen.
    let worker_w = (rect.right - rect.left).max(1);
    let worker_h = (rect.bottom - rect.top).max(1);
    let x = (self_rect.left - rect.left).clamp(0, worker_w - 1);
    let y = (self_rect.top - rect.top).clamp(0, worker_h - 1);
    let cx = (self_rect.right - self_rect.left).clamp(1, worker_w);
    let cy = (self_rect.bottom - self_rect.top).clamp(1, worker_h);
    let _ = SetWindowPos(
        hwnd,
        if class_name(target).as_deref() == Some("WorkerW") { HWND_TOP } else { HWND_BOTTOM },
        x,
        y,
        cx,
        cy,
        SWP_FRAMECHANGED | SWP_NOACTIVATE,
    );
    let _ = place_below_icons(hwnd);
    // A Tauri window keeps a small non-client frame even without decorations,
    // so the client area ends up inset from the display and the wallpaper is
    // cropped at the right/bottom. Fit the client to the monitor now that the
    // window is parented, which is what makes the backdrop fill the screen.
    let _ = fit_to_monitor(hwnd);
    true
}

/// Size and position a wallpaper so its *client* area covers exactly the
/// monitor it sits on. A windowed Tauri webview carries a non-client frame
/// (8px sides, 1px top, 8px bottom here) even with decorations off, and a
/// reparented child positions in parent-client pixels, so neither the frame
/// nor the desktop host can be ignored: `set_size(monitor)` alone leaves the
/// client 8px short on the right/bottom, which reads as a cropped wallpaper.
pub fn fit_to_monitor(hwnd: HWND) -> bool {
    unsafe {
        use windows::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        };
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let target = info.rcMonitor;
        let mut window_rect = RECT::default();
        let mut client_rect = RECT::default();
        if GetWindowRect(hwnd, &mut window_rect).is_err()
            || GetClientRect(hwnd, &mut client_rect).is_err()
        {
            return false;
        }
        let mut client_origin = POINT::default();
        if !ClientToScreen(hwnd, &mut client_origin).as_bool() {
            return false;
        }
        let frame_w =
            (window_rect.right - window_rect.left) - (client_rect.right - client_rect.left);
        let frame_h =
            (window_rect.bottom - window_rect.top) - (client_rect.bottom - client_rect.top);
        let parent = GetAncestor(hwnd, GA_PARENT);
        let mut parent_origin = POINT::default();
        if !ClientToScreen(parent, &mut parent_origin).as_bool() {
            return false;
        }
        // Offset between the window's outer corner and its client corner.
        let nc_x = client_origin.x - window_rect.left;
        let nc_y = client_origin.y - window_rect.top;
        let x = target.left - parent_origin.x - nc_x;
        let y = target.top - parent_origin.y - nc_y;
        let w = (target.right - target.left) + frame_w.max(0);
        let h = (target.bottom - target.top) + frame_h.max(0);
        SetWindowPos(
            hwnd,
            HWND::default(),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .is_ok()
    }
}

/// Fit a Tauri webview window's *client* area to the display it is on.
pub fn fit_window(window: &tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::HWND;
        let hwnd: Option<HWND> = (|| -> Option<HWND> {
            let raw = window.window_handle().ok()?.window_handle().ok()?.as_raw();
            match raw {
                RawWindowHandle::Win32(h) => {
                    Some(HWND(h.hwnd.get() as *mut core::ffi::c_void))
                }
                _ => None,
            }
        })();
        if let Some(hwnd) = hwnd {
            return fit_to_monitor(hwnd);
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

unsafe fn do_unembed(hwnd: windows::Win32::Foundation::HWND) -> bool {
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if style & (WS_CHILD.0 as isize) == 0 {
        // Not currently a child of the desktop worker; still drop any topmost
        // bit left over — an un-embedded wallpaper must never float on top.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & (WS_EX_TOPMOST.0 as isize) != 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_TOPMOST.0 as isize));
            let _ = SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
        return true;
    }
    // Restore the exact snapshot captured at embed time (style + ex + a frame
    // re-check), not a bit-guess — several code paths mutate window styles.
    snapshot_restore(hwnd);
    let _ = SetParent(hwnd, windows::Win32::Foundation::HWND::default());
    let _ = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    if let Ok(mut snap) = original_styles().lock() {
        snap.remove(&(hwnd.0 as isize));
    }
    true
}

/// Force the desktop-backdrop invariants on a wallpaper window: never topmost,
/// never activatable, click-through and at the bottom of its z-band.
pub fn ensure_backdrop(hwnd: windows::Win32::Foundation::HWND) -> bool {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let lock = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
        let clear = (WS_EX_TOPMOST.0 | WS_EX_LAYERED.0) as isize;
        let want = (ex | lock) & !clear;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
        // HWND_BOTTOM only takes effect WITHOUT SWP_NOZORDER — passing both
        // left the wallpaper above an auto-hide taskbar.
        let _ = SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
        );
        // A child of Progman at HWND_BOTTOM sits behind Progman's painted
        // background. Put it back immediately below SHELLDLL_DefView, where
        // it is above the desktop background and below the icons.
        if class_name(GetAncestor(hwnd, GA_PARENT)).as_deref() == Some("Progman") {
            let _ = place_below_icons(hwnd);
        }
        true
    }
}

/// Non-blocking version used on the startup path. `ShowWindow` posts a
/// synchronous message into the window thread and can wait forever if that
/// thread is still settling; `ShowWindowAsync` only queues the request. The
/// z-order move is queued too, so neither call can stall a command worker.
pub fn show_bottom_async(hwnd: isize) {
    let hwnd = windows::Win32::Foundation::HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        // Every show re-fits the client to its display: monitor moves, DPI
        // changes and Explorer restarts all go through this path.
        let _ = fit_to_monitor(hwnd);
        let _ = ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE);
        if class_name(GetAncestor(hwnd, GA_PARENT)).as_deref() == Some("Progman") {
            // Do not queue HWND_BOTTOM here: it would run after (and undo)
            // place_below_icons. Progman's background paint is the bottom of
            // this z-band, so immediately below DefView is already the floor.
            let _ = place_below_icons(hwnd);
        } else {
            let _ = SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
    }
}

/// Non-blocking hide for the wallpaper window.
pub fn hide_async(hwnd: isize) {
    let hwnd = windows::Win32::Foundation::HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        let _ = ShowWindowAsync(hwnd, SW_HIDE);
    }
}

/// Utility: drop the topmost bit on a wallpaper window.
#[allow(dead_code)]
pub fn unpin_topmost(hwnd: windows::Win32::Foundation::HWND) -> bool {
    ensure_backdrop(hwnd)
}
