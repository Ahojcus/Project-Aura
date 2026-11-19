//! Windows AppBar reservation for the status bar.
//!
//! A normal topmost window can only draw over applications; it cannot keep
//! maximized windows out of its strip. Registering the status-bar HWND as an
//! AppBar makes Explorer reserve that edge in the monitor work area, exactly
//! like the taskbar does. The window keeps its own visual styling, while apps
//! maximize into the remaining rectangle instead of underneath the bar.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const ABM_NEW: u32 = 0x0000_0000;
const ABM_REMOVE: u32 = 0x0000_0001;
const ABM_QUERYPOS: u32 = 0x0000_0002;
const ABM_SETPOS: u32 = 0x0000_0003;
const ABE_TOP: u32 = 1;
const ABE_BOTTOM: u32 = 3;
/// Private callback message. Tauri ignores unknown window messages; the
/// callback is only required to identify the AppBar to Explorer.
const APPBAR_CALLBACK: u32 = 0x8001;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AppBarRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AppBarData {
    cb_size: u32,
    hwnd: isize,
    callback_message: u32,
    edge: u32,
    rect: AppBarRect,
    l_param: isize,
}

impl AppBarData {
    fn new(hwnd: isize) -> Self {
        Self {
            cb_size: std::mem::size_of::<Self>() as u32,
            hwnd,
            callback_message: APPBAR_CALLBACK,
            edge: ABE_TOP,
            rect: AppBarRect::default(),
            l_param: 0,
        }
    }
}

#[cfg(windows)]
#[link(name = "shell32")]
extern "system" {
    fn SHAppBarMessage(message: u32, data: *mut AppBarData) -> usize;
}

struct Reservation {
    edge: u32,
    desired: AppBarRect,
    actual: AppBarRect,
}

static REGISTERED: OnceLock<Mutex<HashMap<isize, Reservation>>> = OnceLock::new();

fn registered() -> &'static Mutex<HashMap<isize, Reservation>> {
    REGISTERED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hidden window that owns the AppBar reservation.
///
/// The shell runs its own placement pass over registered AppBars and, for a
/// bottom bar, drops the window a bar-height inside the edge. Pointing that at
/// the visible bar made it hop up and fall back, so the reservation lives on an
/// invisible carrier instead: Explorer still shrinks the work area for the
/// strip, but it can only ever move the carrier.
///
/// Must be called on a thread with a message loop (the main thread) so the
/// window outlives the command that asked for it.
#[cfg(windows)]
pub fn carrier(key: isize) -> isize {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, WS_EX_TOOLWINDOW, WS_POPUP};
    // One carrier per bar window, so a duplicated bar on another display keeps
    // its own reservation instead of moving the shared one.
    static CARRIERS: OnceLock<Mutex<HashMap<isize, isize>>> = OnceLock::new();
    let carriers = CARRIERS.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut carriers) = carriers.lock() else {
        return 0;
    };
    if let Some(existing) = carriers.get(&key) {
        if *existing != 0 {
            return *existing;
        }
    }
    let created = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            w!("STATIC"),
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            None,
            None,
        )
    }
    .unwrap_or_else(|_| HWND::default());
    let carrier = created.0 as isize;
    carriers.insert(key, carrier);
    carrier
}

#[cfg(not(windows))]
pub fn carrier(_key: isize) -> isize {
    0
}

/// True when the desktop does not already reserve this edge.
///
/// A monitor whose taskbar sits on the requested edge (the usual case for a
/// bottom bar on a primary display) cannot host an AppBar there: Explorer keeps
/// the taskbar's strip and pushes the AppBar one thickness inside it, which is
/// what made the bar hop up and fall back. The bar is drawn over the edge
/// anyway, so there is nothing to reserve in that case.
#[cfg(windows)]
fn edge_is_free(
    monitor_left: i32,
    monitor_top: i32,
    monitor_width: i32,
    monitor_height: i32,
    edge: u32,
) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let point = POINT {
        x: monitor_left + monitor_width / 2,
        y: monitor_top + monitor_height / 2,
    };
    let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return true;
    }
    if edge == ABE_BOTTOM {
        info.rcWork.bottom >= info.rcMonitor.bottom
    } else {
        info.rcWork.top <= info.rcMonitor.top
    }
}

/// The occupancy check is made once per monitor and edge: our own reservation
/// changes the work area, and re-checking it later would read that as a taskbar.
#[cfg(windows)]
fn edge_free_cache() -> &'static Mutex<std::collections::HashMap<(i32, i32, u32), bool>> {
    static CACHE: OnceLock<Mutex<std::collections::HashMap<(i32, i32, u32), bool>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Reserve a full-width strip at the requested edge of a monitor.
/// Returns the physical rectangle Windows actually reserved, or None when the
/// AppBar API declined the request.
#[cfg(windows)]
pub fn reserve(
    hwnd: isize,
    placement: &str,
    monitor_left: i32,
    monitor_top: i32,
    monitor_width: i32,
    monitor_height: i32,
    thickness: i32,
) -> Option<(i32, i32, i32, i32)> {
    let thickness = thickness.max(1);
    let edge = if placement == "bottom" {
        ABE_BOTTOM
    } else {
        ABE_TOP
    };
    let (top, bottom) = if edge == ABE_BOTTOM {
        (
            monitor_top + monitor_height - thickness,
            monitor_top + monitor_height,
        )
    } else {
        (monitor_top, monitor_top + thickness)
    };

    let desired = AppBarRect {
        left: monitor_left,
        top,
        right: monitor_left + monitor_width,
        bottom,
    };

    let free = {
        let mut cache = edge_free_cache().lock().ok()?;
        *cache
            .entry((monitor_left, monitor_top, edge))
            .or_insert_with(|| {
                edge_is_free(monitor_left, monitor_top, monitor_width, monitor_height, edge)
            })
    };
    if !free {
        return None;
    }

    // Layout effects legitimately repeat when a monitor or bar setting changes.
    // Reuse an identical reservation; querying an AppBar against its own current
    // position makes Explorer place it one bar-height away from the edge.
    let mut registry = registered().lock().ok()?;
    if let Some(existing) = registry.get(&hwnd) {
        if existing.edge == edge
            && existing.desired.left == desired.left
            && existing.desired.top == desired.top
            && existing.desired.right == desired.right
            && existing.desired.bottom == desired.bottom
        {
            return Some((
                existing.actual.left,
                existing.actual.top,
                existing.actual.right,
                existing.actual.bottom,
            ));
        }
    }

    if registry.contains_key(&hwnd) {
        let mut remove = AppBarData::new(hwnd);
        unsafe {
            let _ = SHAppBarMessage(ABM_REMOVE, &mut remove);
        }
        registry.remove(&hwnd);
    }

    let mut data = AppBarData::new(hwnd);
    data.edge = edge;
    data.rect = desired;
    let added = unsafe { SHAppBarMessage(ABM_NEW, &mut data) } != 0;
    if !added {
        return None;
    }

    // Query first so other AppBars (including the Windows taskbar) can adjust
    // the proposed rectangle before it becomes part of the work area.
    unsafe {
        let _ = SHAppBarMessage(ABM_QUERYPOS, &mut data);
        if SHAppBarMessage(ABM_SETPOS, &mut data) == 0 {
            return None;
        }
        // Explorer answers with a rect one thickness inside the edge when it
        // still reports the strip reserved a moment ago — which is exactly the
        // case after a release/re-register pair (fullscreen, cloak, DPI or
        // display change). Left alone that both lifts the bar off its edge and
        // leaves the work area 40px short, so snap the reservation onto the
        // requested edge and let Explorer recompute the work area.
        if data.rect.top != desired.top || data.rect.bottom != desired.bottom {
            data.rect.top = desired.top;
            data.rect.bottom = desired.bottom;
            let _ = SHAppBarMessage(ABM_SETPOS, &mut data);
        }
    }

    registry.insert(
        hwnd,
        Reservation {
            edge,
            desired,
            actual: data.rect,
        },
    );

    Some((
        data.rect.left,
        data.rect.top,
        data.rect.right,
        data.rect.bottom,
    ))
}

/// Release the reserved edge for a status-bar window.
#[cfg(windows)]
pub fn release(hwnd: isize) {
    let mut data = AppBarData::new(hwnd);
    unsafe {
        let _ = SHAppBarMessage(ABM_REMOVE, &mut data);
    }
    if let Ok(mut registry) = registered().lock() {
        registry.remove(&hwnd);
    }
}

#[cfg(not(windows))]
pub fn reserve(
    _hwnd: isize,
    _placement: &str,
    _monitor_left: i32,
    _monitor_top: i32,
    _monitor_width: i32,
    _monitor_height: i32,
    _thickness: i32,
) -> Option<(i32, i32, i32, i32)> {
    None
}

#[cfg(not(windows))]
pub fn release(_hwnd: isize) {}
