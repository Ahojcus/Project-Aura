use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(windows)]
use crate::wallpaper_win;

// ---------------------------------------------------------------------------
// State containers shared with background threads (media, sysmon).
// ---------------------------------------------------------------------------

pub type Shared<T> = Arc<Mutex<T>>;

#[derive(Clone, Default)]
pub struct MediaState {
    pub info: Shared<Option<crate::media::MediaInfo>>,
    pub art: Shared<Option<(String, crate::media::MediaArt)>>,
}

#[derive(Clone, Default)]
pub struct SysState {
    pub snapshot: Shared<Option<crate::monit::SystemSnapshot>>,
}

// ---------------------------------------------------------------------------
// Displays — detect monitors, let modules pick one
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub name: Option<String>,
    /// Global (virtual-screen) physical coordinates of the monitor's origin.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

#[tauri::command]
pub fn get_monitors(app: AppHandle) -> Vec<MonitorInfo> {
    enumerate_monitors(&app)
}

/// Snapshot of every connected display; `primary` marks the OS main display.
/// Monitors are identified by their origin coordinates — that value is what
/// the settings store persists as the module's target display.
pub fn enumerate_monitors(app: &AppHandle) -> Vec<MonitorInfo> {
    let prim = app.primary_monitor().ok().flatten();
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let primary = prim
                .as_ref()
                .map(|p| {
                    p.name() == m.name()
                        && p.size() == m.size()
                        && p.position() == m.position()
                        && (p.scale_factor() - m.scale_factor()).abs() < 1e-9
                })
                .unwrap_or(false);
            MonitorInfo {
                name: m.name().cloned(),
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
                scale: m.scale_factor(),
                primary,
            }
        })
        .collect()
}

/// The monitor a module window should sit on: an exact origin match wins,
/// anything else (including `None` and stale coordinates) falls back to the
/// primary display.
fn resolve_monitor(app: &AppHandle, monitor: Option<(i32, i32)>) -> Option<tauri::Monitor> {
    let prim = app.primary_monitor().ok().flatten();
    let Some((want_x, want_y)) = monitor else {
        return prim;
    };
    if prim.as_ref().is_some_and(|p| p.position().x == want_x && p.position().y == want_y) {
        return prim;
    }
    if let Ok(list) = app.available_monitors() {
        if let Some(m) = list.into_iter().find(|m| m.position().x == want_x && m.position().y == want_y) {
            return Some(m);
        }
    }
    prim
}

/// Base module of a window label; per-display duplicates are `module_x_y`.
fn base_label(label: &str) -> &str {
    for base in ["wallpaper", "notch", "clock", "todo", "statusbar"] {
        if label == base {
            return base;
        }
        if let Some(rest) = label.strip_prefix(base).and_then(|r| r.strip_prefix('_')) {
            let parts: Vec<&str> = rest.split('_').collect();
            if parts.len() == 2
                && parts[0].parse::<i32>().is_ok()
                && parts[1].parse::<i32>().is_ok()
            {
                return base;
            }
        }
    }
    label
}

/// Display origin encoded in a duplicate window label (`clock_-1920_0`).
fn label_monitor(label: &str) -> Option<(i32, i32)> {
    for base in ["wallpaper", "notch", "clock", "todo", "statusbar"] {
        if let Some(rest) = label.strip_prefix(base).and_then(|r| r.strip_prefix('_')) {
            let parts: Vec<&str> = rest.split('_').collect();
            if parts.len() == 2 {
                if let (Ok(x), Ok(y)) = (parts[0].parse::<i32>(), parts[1].parse::<i32>()) {
                    return Some((x, y));
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Settings window + module windows
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn toggle_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let visible = matches!(w.is_visible(), Ok(true));
        if visible && matches!(w.is_focused(), Ok(true)) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Reveal a wallpaper webview as an actual desktop backdrop. Keeping it as a
/// normal bottom-most top-level window makes Win+D hide it; reparenting the
/// WebView2 HWND into Explorer's Progman/WorkerW keeps it behind the icons and
/// out of the Show Desktop stack, like Lively.
#[cfg(windows)]
fn show_wallpaper_backdrop(window: &tauri::WebviewWindow) {
    if let Some(hwnd) = hwnd_of(window) {
        let _ = crate::wallpaper_win::set_embedded(hwnd, true);
        crate::wallpaper_win::show_bottom_async(hwnd.0 as isize);
    }
}

#[cfg(not(windows))]
fn show_wallpaper_backdrop(_window: &tauri::WebviewWindow) {}

/// Show/hide one of the module overlay windows. The wallpaper is revealed with
/// non-blocking native window calls; other modules use Tauri positioning.
#[tauri::command]
pub fn set_module_visible(
    app: AppHandle,
    label: String,
    visible: bool,
    x: Option<f64>,
    y: Option<f64>,
    monitor: Option<(i32, i32)>,
) {
    if base_label(&label) == "wallpaper" {
        set_wallpaper_desired(&label, visible);
        #[cfg(windows)]
        if visible {
            if let Some(w) = app.get_webview_window(&label) {
                show_wallpaper_backdrop(&w);
            }
            // WebView2 may not have a usable top-level handle during the first
            // settings-sync pass. Re-query for a short interval instead of
            // keeping a handle that was never ready.
            let app_retry = app.clone();
            let label_retry = label.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    if !wallpaper_should_show(&label_retry) {
                        return;
                    }
                    if let Some(w) = app_retry.get_webview_window(&label_retry) {
                        if hwnd_of(&w).is_some() {
                            show_wallpaper_backdrop(&w);
                            return;
                        }
                    }
                }
            });
        } else if let Some(w) = app.get_webview_window(&label) {
            if let Some(hwnd) = hwnd_of(&w) {
                crate::wallpaper_win::hide_async(hwnd.0 as isize);
            }
        }
        return;
    }

    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    let target = resolve_monitor(&app, monitor);
    if visible {
        match (x, y) {
            (Some(x), Some(y)) => {
                if let Some(mon) = target.as_ref() {
                    // Manual coordinates are logical px within the chosen display.
                    let scale = mon.scale_factor();
                    let _ = window.set_position(tauri::PhysicalPosition::new(
                        mon.position().x + (x * scale).round() as i32,
                        mon.position().y + (y * scale).round() as i32,
                    ));
                }
            }
            _ => {
                if let Some(mon) = target.as_ref() {
                    position_module_window(&app, &label, &window, mon);
                }
            }
        }
        let _ = window.show();
        // Tauri re-applies its window style on show, so the caption strip has
        // to run again here — otherwise DWM can draw a title plaque over the
        // module's own header row.
        #[cfg(windows)]
        strip_caption(&window);
        // Re-reveal must not reshuffle the stack: re-apply the module's
        // remembered level, then restack its whole band so the sidebar
        // priority (not activation recency) decides who is on top.
        #[cfg(windows)]
        if base_label(&label) == "notch" {
            if let Some(hwnd) = hwnd_of(&window) {
                raise_above_top_toolbar(hwnd.0 as isize);
            }
        }
        let lv = levels().lock().unwrap().get(&label).cloned();
        if let Some(l) = lv {
            apply_level(&app, &window, &l);
            if matches!(l.as_str(), "topmost" | "bottommost") {
                band_restack(&app, &l, &order_locked().lock().unwrap().clone());
            }
        }
    } else {
        let _ = window.hide();
    }
    // Per-display duplicates follow the main window's visibility.
    if base_label(&label) == label.as_str() {
        sync_module_visibility(&app, &label, visible);
    }
}

/// Clip a module window to its visible widget rectangle. Transparent pixels in
/// a Tauri window still hit-test as that window on Windows, so the empty shadow
/// margin around a widget was stealing clicks from apps underneath it.
///
/// The region is deliberately rectangular: Windows regions are binary, so a
/// rounded region would cut the CSS `border-radius` with a jagged stair-step.
/// Leaving the region square keeps the visible rounded corners anti-aliased by
/// the WebView, while still dropping the large transparent shadow margin.
#[cfg(windows)]
#[tauri::command]
pub fn module_set_hit_region(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    _radius: f64,
) {
    use windows::Win32::Graphics::Gdi::{CreateRectRgn, SetWindowRgn};

    let Some(window) = app.get_webview_window(&label) else { return };
    let Some(hwnd) = hwnd_of(&window) else { return };
    let size = window.inner_size().ok();
    let win_w = size.map(|s| s.width as i32).unwrap_or(width.max(1));
    let win_h = size.map(|s| s.height as i32).unwrap_or(height.max(1));
    if win_w <= 1 || win_h <= 1 || width <= 0 || height <= 0 {
        return;
    }

    // The frontend reports CSS pixels; window regions use physical pixels.
    let x1 = x.clamp(0, win_w - 1);
    let y1 = y.clamp(0, win_h - 1);
    let x2 = (x.saturating_add(width)).clamp(x1 + 1, win_w);
    let y2 = (y.saturating_add(height)).clamp(y1 + 1, win_h);

    unsafe {
        let region = CreateRectRgn(x1, y1, x2, y2);
        let _ = SetWindowRgn(hwnd, region, windows::Win32::Foundation::BOOL(1));
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn module_set_hit_region(
    _app: AppHandle,
    _label: String,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _radius: f64,
) {
}

/// Reposition the clock/todo windows nicely *within the given display*
/// (idempotent; keeps their logical sizes from tauri.conf.json). Notch and
/// statusbar geometry is owned by their layout commands.
fn position_module_window(
    _app: &AppHandle,
    label: &str,
    window: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
) {
    // The notch and status bar own their geometry through their layout
    // commands (edge placement, length, thickness, insets, hotplug). Showing
    // them must never overwrite that exact layout with a generic guess.
    if !matches!(label, "clock" | "todo" | "start") {
        return;
    }
    let size = monitor.size();
    let scale = monitor.scale_factor() as f64;
    let (w, h) = (size.width as f64, size.height as f64);
    let (mx, my) = (monitor.position().x as f64, monitor.position().y as f64);
    let pos = match label {
        "start" => {
            // Launcher palette: horizontally centered, ~1/3 from the top.
            let ww = window.outer_size().map(|s| s.width as f64).unwrap_or(688.0 * scale);
            let wh = window.outer_size().map(|s| s.height as f64).unwrap_or(588.0 * scale);
            (mx + ((w - ww) / 2.0).max(0.0), my + ((h - wh) * 0.30).max(0.0))
        }
        "clock" => (mx + (w - 458.0 * scale).max(0.0), my + ((46.0 - 64.0) * scale).max(0.0)),
        "todo" => (mx + ((46.0 - 64.0) * scale).max(0.0), my + (h - 630.0 * scale).max(0.0)),
        _ => return,
    };
    let _ = window.set_position(tauri::PhysicalPosition::new(
        pos.0.max(mx) as i32,
        pos.1.max(my) as i32,
    ));
}

/// Default logical window sizes used by the capacity multipliers. Glass
/// widgets keep a 64px transparent inset for the drop shadow, so each entry
/// is the old visible size + 2×64px (clock 340+128×210+128, todo 380+128×
/// 520+128).
const DEFAULT_SIZES: &[(&str, f64, f64)] = &[("clock", 468.0, 338.0), ("todo", 508.0, 648.0)];

/// Apply per-module window configuration passed from the settings store:
/// z-order level, manual coordinates, click-through and a capacity
/// (size-multiplier) for the clock/todo surfaces. Every field is optional so
/// callers can update one property without re-sending the rest.
#[tauri::command]
pub fn window_apply(
    app: AppHandle,
    label: String,
    level: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    click_through: Option<bool>,
    capacity: Option<(f64, f64)>,
    monitor: Option<(i32, i32)>,
    // The Settings sidebar's module stack priorities (TOPMOST-first). When a
    // band change happens, same-level modules are restacked so priority #1
    // truly draws above the others instead of activation recency deciding.
    order: Option<Vec<String>>,
) {
    // Never run native stacking or monitor lookups for wallpaper windows on
    // the startup path. They deadlock the event loop on this Windows setup.
    if label == "wallpaper" || label.starts_with("wallpaper_") {
        return;
    }
    let Some(w) = app.get_webview_window(&label) else { return };

    if let Some(l) = level {
        // The wallpaper (main + per-display extras) is always forced to the
        // very bottom (embedded behind the desktop icons), whatever layer the
        // stored configuration says — apps must never end up behind it.
        let forced = label == "wallpaper" || label.starts_with("wallpaper_");
        apply_level(&app, &w, if forced { "bottommost" } else { &l });
        // Remember each module's level + the shared priority list so a later
        // module reveal (set_module_visible) keeps the same stacking.
        if !forced {
            levels().lock().unwrap().insert(label.clone(), l.clone());
        }
        if let Some(o) = order {
            if o.len() > 1 {
                *order_locked().lock().unwrap() = o;
            }
        }
        if !forced && matches!(l.as_str(), "topmost" | "bottommost") {
            band_restack(&app, &l, &order_locked().lock().unwrap().clone());
        }
    }
    let target_monitor = resolve_monitor(&app, monitor);
    if let (Some(x), Some(y)) = (x, y) {
        if let Some(mon) = target_monitor.as_ref() {
            // Manual coordinates are logical px within the chosen display.
            let scale = mon.scale_factor();
            let px = mon.position().x + (x * scale).round() as i32;
            let py = mon.position().y + (y * scale).round() as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
            #[cfg(windows)]
            if matches!(base_label(&label), "notch" | "statusbar") {
                if let Ok(mut geom) = notch_geometry().lock() {
                    if let Some(slot) = geom.get_mut(&label) {
                        slot.0 = px;
                        slot.1 = py;
                    }
                }
            }
        }
    } else if let Some(mon) = target_monitor.as_ref() {
        // A saved monitor with no manual X/Y still has to be restored. The
        // generic window_apply path used to ignore monitor-only settings, so
        // clock/todo fell back to their primary-display startup position after
        // every restart.
        position_module_window(&app, &label, &w, mon);
    }
    if label == "wallpaper" || label.starts_with("wallpaper_") {
        // The wallpaper is never interactive; WS_EX_TRANSPARENT/NOACTIVATE is
        // applied natively in ensure_backdrop. Avoid the WebView2 focus and
        // cursor APIs here because they can block the window thread while the
        // window is hidden during startup.
    } else if let Some(ct) = click_through {
        let _ = w.set_ignore_cursor_events(ct);
        let _ = w.set_focusable(!ct);
    }
    if let Some((ws, hs)) = capacity {
        let base = base_label(&label);
        if let Some((_, dw, dh)) = DEFAULT_SIZES.iter().find(|(l, _, _)| *l == base) {
            let nw = (dw * ws.clamp(0.4, 2.0)).round();
            let nh = (dh * hs.clamp(0.4, 2.0)).round();
            let _ = w.set_size(tauri::LogicalSize::new(nw, nh));
            // A resized duplicate must stay anchored inside its own display.
            if let Some((mx, my)) = label_monitor(&label) {
                if let Some(mon) = resolve_monitor(&app, Some((mx, my))) {
                    let (px, py) = duplicate_anchor(base, &mon, nw, nh);
                    let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
                }
            }
        }
    }
}

/// True when `window` is the main wallpaper or a per-display wallpaper extra.
fn is_wallpaper_window(app: &AppHandle, window: &tauri::WebviewWindow) -> bool {
    if app.get_webview_window("wallpaper").as_ref() == Some(window) {
        return true;
    }
    app.webview_windows()
        .iter()
        .any(|(l, w)| l.starts_with("wallpaper_") && w == window)
}


fn apply_level(app: &AppHandle, window: &tauri::WebviewWindow, level: &str) {
    match level {
        "topmost" => {
            if is_wallpaper_window(app, window) {
                // A wallpaper can never be topmost — that paints it over the
                // taskbar. Any topmost request collapses to its true bottom:
                // embedded behind the desktop icons (or pinned, if embedding
                // fails on this machine).
                let _ = window.set_always_on_top(false);
                return;
            }
            let _ = window.set_always_on_top(true);
            #[cfg(windows)]
            set_noactivate(window, false);
        }
        "normal" => {
            let is_wallpaper = is_wallpaper_window(app, window);
            let _ = window.set_always_on_top(false);
            #[cfg(windows)]
            if !is_wallpaper {
                set_noactivate(window, false);
                // Tauri's wrapper alone can leave the HWND in the topmost
                // band on Windows; explicitly clear WS_EX_TOPMOST and move it
                // back to the normal band so it stops floating over apps.
                clear_topmost(window);
            }
            // A plain "normal" wallpaper would sit wherever Windows drops it —
            // potentially above open windows. Pin it to the bottom of the
            // normal band instead so it never covers apps. The async helper
            // does that after unembedding, so this never blocks the event loop.
        }
        "bottommost" => {
            // The wallpaper is special-cased: embedding behind the desktop
            // icons is its true bottommost. Other modules pin to the bottom of
            // the window stack.
            if is_wallpaper_window(app, window) {
                let _ = window.set_always_on_top(false);
                return;
            }
            #[cfg(windows)]
            pin_to_bottom(window, false);
            #[cfg(not(windows))]
            let _ = window.set_always_on_top(false);
        }
        _ => {}
    }
    #[cfg(windows)]
    strip_caption(window);
}

/// A click on a bottom-band module panel (to-do, clock, statusbar…) activates
/// the window — and Windows always raises the activated window above every
/// other normal window, so panels visually climbed over apps. The panels must
/// stay click-selectable (and typable), so on every Focus we re-apply the
/// module's band: the window returns to its z-band with SWP_NOACTIVATE while
/// keeping foreground/keyboard focus — clicks still land, inputs still type,
/// it just never stays drawn on top.
pub fn window_focus_restack(app: &AppHandle, label: &str) {
    let Some(level) = levels().lock().unwrap().get(label).cloned() else {
        return;
    };
    if !matches!(level.as_str(), "bottommost") {
        return;
    }
    // A per-display duplicate is not part of the shared band order; sink it
    // directly into the bottom band when it is activated.
    #[cfg(windows)]
    if label_monitor(label).is_some() {
        if let Some(window) = app.get_webview_window(label) {
            pin_to_bottom(&window, false);
        }
        return;
    }
    #[cfg(windows)]
    band_restack(app, "bottommost", &order_locked().lock().unwrap().clone());
    #[cfg(not(windows))]
    let _ = app.get_webview_window(label).map(|w| w.set_always_on_top(false));
}

/// Push the window to the very bottom of the z-stack (just above the desktop
/// background). When `noactivate` is true the window also ignores activation
/// clicks — meant ONLY for wallpapers, which must never take focus. Interactive
/// modules (to-do, clock, statusbar…) must keep activation: without it a click
/// never activates the window and none of its inputs can ever receive typing.
#[cfg(windows)]
fn clear_topmost(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_NOTOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, WS_EX_TOPMOST,
    };

    let Some(hwnd) = hwnd_of(window) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE);
        if ex & (WS_EX_TOPMOST.0 as isize) != 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_TOPMOST.0 as isize));
        }
        let _ = SetWindowPos(
            hwnd,
            HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

/// Place a top-level module in the band directly above the desktop, but below
/// every normal application. `HWND_BOTTOM` is too low: it drops the window
/// behind Progman/WorkerW, so the wallpaper hides it (and the whole bottommost
/// band disappears). Instead insert it after the nearest non-topmost window
/// above Progman; if there is none, put it at the top of the normal band.
#[cfg(windows)]
fn place_in_bottom_band(hwnd: windows::Win32::Foundation::HWND) {
    use windows::core::{PCWSTR, w};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindow, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
        GW_HWNDPREV, HWND_TOP, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOMOVE, SWP_NOSIZE,
        WS_EX_TOPMOST,
    };

    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & (WS_EX_TOPMOST.0 as isize) != 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_TOPMOST.0 as isize));
        }

        let progman = FindWindowW(w!("Progman"), PCWSTR::null()).ok();
        let mut anchor = progman
            .map(|desktop| GetWindow(desktop, GW_HWNDPREV).unwrap_or_default())
            .unwrap_or_default();
        // The taskbar and other topmost windows are above the normal band.
        // Walk past them to the nearest ordinary window above Progman.
        while !anchor.0.is_null() {
            let anchor_ex = GetWindowLongPtrW(anchor, GWL_EXSTYLE);
            if anchor_ex & (WS_EX_TOPMOST.0 as isize) == 0 {
                break;
            }
            anchor = GetWindow(anchor, GW_HWNDPREV).unwrap_or_default();
        }

        let insert = if anchor.0.is_null() { HWND_TOP } else { anchor };
        let _ = SetWindowPos(
            hwnd,
            insert,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

#[cfg(windows)]
fn pin_to_bottom(window: &tauri::WebviewWindow, noactivate: bool) {
    use windows::Win32::Foundation::HWND;
    let _ = window.set_always_on_top(false);
    let Some(hwnd) = hwnd_of(window) else { return };
    set_noactivate(window, noactivate);
    place_in_bottom_band(HWND(hwnd.0));
}

/// Set/unset `WS_EX_NOACTIVATE` on the window's hwnd (no-op off Windows).
/// This is what makes a click on a module activate it (or not) — the to-do
/// input typability bug came from having it stuck on interactive windows.
#[cfg(windows)]
fn set_noactivate(window: &tauri::WebviewWindow, on: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    let Some(hwnd) = hwnd_of(window) else { return };
    unsafe {
        let ex = GetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE);
        let want = if on {
            ex | WS_EX_NOACTIVATE.0 as isize
        } else {
            ex & !(WS_EX_NOACTIVATE.0 as isize)
        };
        if want != ex {
            let _ = SetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE, want);
        }
    }
}

/// The module stack priorities from the Settings sidebar (TOPMOST-first).
static MODULE_ORDER: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Each module's currently applied layer level ("topmost"/"normal"/…).
/// Lazily initialized — a allocating `HashMap::new()` can't run in a static.
static MODULE_LEVELS_CELL: std::sync::OnceLock<Mutex<std::collections::HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn order_locked() -> &'static Mutex<Vec<String>> {
    &MODULE_ORDER
}

fn levels() -> &'static Mutex<std::collections::HashMap<String, String>> {
    MODULE_LEVELS_CELL.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Last requested visibility for each wallpaper window. Delayed show threads
/// must consult this so a fast hide is not undone 350ms later.
static WALLPAPER_VISIBILITY_CELL: std::sync::OnceLock<Mutex<std::collections::HashMap<String, bool>>> =
    std::sync::OnceLock::new();

fn wallpaper_visibility() -> &'static Mutex<std::collections::HashMap<String, bool>> {
    WALLPAPER_VISIBILITY_CELL.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn set_wallpaper_desired(label: &str, visible: bool) {
    if let Ok(mut desired) = wallpaper_visibility().lock() {
        desired.insert(label.to_string(), visible);
    }
}

fn wallpaper_should_show(label: &str) -> bool {
    wallpaper_visibility()
        .lock()
        .ok()
        .and_then(|desired| desired.get(label).copied())
        .unwrap_or(false)
}

/// Deterministic ordering for module windows that share a z-band: when two
/// modules are e.g. both "topmost" or both "bottommost", Windows would
/// otherwise let activation recency decide who is on top — the modules keep
/// stealing the top slot from each other and it visibly bugs out. The
/// Settings sidebar's priority list (TOPMOST-first) is authoritative instead.
#[cfg(windows)]
fn band_restack(app: &AppHandle, level: &str, order: &[String]) {
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
    };

    let bottom_band = level == "bottommost";
    // Only move modules that are actually assigned to this band. Re-applying
    // the band to every module in the sidebar order made one topmost/ bottommost
    // change pull all the normal modules into the same band, so the per-module
    // Layer setting appeared to do nothing.
    let levels_by_label = levels().lock().unwrap().clone();
    let in_band = |label: &String| {
        levels_by_label
            .get(label)
            .is_some_and(|assigned| assigned == level)
    };
    // A HWND_TOPMOST call puts its target on top of the band → process
    // lowest priority first so the highest-priority window is placed last
    // (and therefore stays above the others). The bottom band is placed just
    // above the desktop for each member, so process in priority order.
    let iter: Box<dyn Iterator<Item = &String>> = if level == "topmost" {
        Box::new(order.iter().rev())
    } else {
        Box::new(order.iter())
    };

    for label in iter.filter(|label| in_band(label)) {
        if label == "wallpaper" || label.starts_with("wallpaper_") {
            continue; // embedded behind the desktop icons, managed elsewhere
        }
        let Some(w) = app.get_webview_window(label) else { continue };
        let Some(hwnd) = hwnd_of(&w) else { continue };
        if bottom_band {
            place_in_bottom_band(hwnd);
        } else {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS(
                        (SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_NOOWNERZORDER.0) as u32,
                    ),
                );
            }
        }
    }
}

#[cfg(not(windows))]
fn band_restack(_app: &AppHandle, _level: &str, _order: &[String]) {}

/// Apply the notch's user-configurable layout (free-tier feature parity with
/// the Store "Smart Notch"): notch-or-bar shape, placement along screen
/// edges/corners, and independent length & thickness. `length` means px in
/// "notch" mode and a percentage of screen width in "bar" mode.
/// Put the Smart Notch directly above Seelen UI's top toolbar.
///
/// Both windows live in the same topmost band, and the full-width "Fancy
/// Toolbar" covers the notch's top pixels — which reads as the pill dropping
/// off the screen edge. Raising the notch above that one window keeps both
/// tools enabled while the pill stays attached to the top of the display.
/// Where the notch last put itself (outer rect, physical px) per window label.
///
/// Seelen UI's top toolbar is an AppBar and its placement passes push windows
/// that sit on that edge down by the toolbar height. The notch is drawn over the
/// strip on purpose, so Aura remembers its own geometry and re-asserts it.
#[cfg(windows)]
fn notch_geometry() -> &'static std::sync::Mutex<std::collections::HashMap<String, (i32, i32, i32, i32)>>
{
    static GEOM: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (i32, i32, i32, i32)>>,
    > = std::sync::OnceLock::new();
    GEOM.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// True when `hwnd` sits above `toolbar` in the z-order.
#[cfg(windows)]
fn is_above(hwnd: windows::Win32::Foundation::HWND, toolbar: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDPREV};
    let mut cursor = unsafe { GetWindow(toolbar, GW_HWNDPREV) }.unwrap_or_default();
    for _ in 0..48 {
        if cursor.0.is_null() {
            return false;
        }
        if cursor == hwnd {
            return true;
        }
        cursor = unsafe { GetWindow(cursor, GW_HWNDPREV) }.unwrap_or_default();
    }
    false
}

/// Put every visible edge module back where its layout put it: the Smart Notch
/// on its own screen edge (Seelen UI's toolbar placement drags border windows
/// down by its height) and above that toolbar, so the pill still reads as one
/// piece with the screen top, and the status bar flush on its configured edge.
#[cfg(windows)]
pub fn enforce_edge_geometry(app: &AppHandle) {
    use windows::core::w;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindowRect, IsWindowVisible, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE,
    };
    static DRIFT: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u8>>> =
        std::sync::OnceLock::new();
    let drift = DRIFT.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let wanted = notch_geometry()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let toolbar = (unsafe { FindWindowW(w!("Tauri Window"), w!("Fancy Toolbar")) })
        .ok()
        .filter(|h| !h.0.is_null());

    for (label, window) in app.webview_windows() {
        let base = base_label(&label);
        if base != "notch" && base != "statusbar" {
            continue;
        }
        let Some((x, y, cw, ch)) = wanted.get(&label).copied() else { continue };
        let Some(hwnd) = hwnd_of(&window) else { continue };
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            continue;
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            continue;
        }
        let moved = (rect.left - x).abs() > 2 || (rect.top - y).abs() > 2;
        // The toolbar only overlaps the top edge, so only the notch has to sit
        // above it; the status bar is snapped back into place, not restacked.
        let buried = base == "notch" && toolbar.map(|t| !is_above(hwnd, t)).unwrap_or(false);
        if !moved && !buried {
            if let Ok(mut d) = drift.lock() {
                d.insert(label.clone(), 0);
            }
            continue;
        }
        // Being covered by the toolbar is fixed on the spot: the pill must not
        // sit behind it even for a moment. A moved notch needs two samples,
        // because a single nudge can be a transient of a shell placement pass;
        // the status bar is re-pinned at once so a repeated lift cannot make it
        // flicker between its edge and the shell's spot.
        let count = {
            let Ok(mut d) = drift.lock() else { continue };
            let c = d.entry(label.clone()).or_insert(0);
            *c = c.saturating_add(1);
            *c
        };
        if moved && !buried && count < if base == "statusbar" { 1 } else { 2 } {
            continue;
        }
        let _ = unsafe { SetWindowPos(hwnd, HWND_TOPMOST, x, y, cw, ch, SWP_NOACTIVATE) };
    }
}

#[cfg(windows)]
fn raise_above_top_toolbar(hwnd_isize: isize) {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOPMOST,
    };
    let hwnd = HWND(hwnd_isize as *mut core::ffi::c_void);
    // Only reorder inside the topmost band; a "normal" notch must stay normal.
    let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex & WS_EX_TOPMOST.0 == 0 {
        return;
    }
    let Ok(toolbar) = (unsafe { FindWindowW(w!("Tauri Window"), w!("Fancy Toolbar")) }) else {
        return;
    };
    if toolbar.0.is_null() || toolbar == hwnd {
        return;
    }
    // HWND_TOPMOST puts us at the top of the topmost band, above the toolbar.
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
}

#[tauri::command]
pub fn notch_apply_layout(
    app: AppHandle,
    layout: String,
    placement: String,
    length: f64,
    thickness: f64,
    expanded: bool,
    monitor: Option<(i32, i32)>,
    // Measured height of the expanded panel's content (logical px). The webview
    // reports it so the window grows to fit all enabled widgets instead of a
    // fixed 330px that clipped/overlapped when everything was enabled.
    content_height: Option<f64>,
    // Measured width of the collapsed pill's visible content (logical px).
    // While collapsed the icon row hides, so the window shrinks to the small
    // utility pill in any layout; null keeps the full-bar width.
    collapsed_width: Option<f64>,
    // Rolling-out tween step: outright width override the frontend animates
    // through (the final frame of a tween omits it for exact geometry).
    fit_width: Option<f64>,
    // Duplicate windows pass their own label; the encoded display origin wins
    // over the shared settings monitor.
    label: Option<String>,
) {
    let label = label.unwrap_or_else(|| "notch".to_string());
    let Some(w) = app.get_webview_window(&label) else { return };
    // The Smart Notch is a transparent, fully rounded pill. On Windows the
    // native window shadow is a rectangular DWM glow around the whole HWND,
    // not around the CSS shape; keep it disabled even after the window is
    // resized by the layout command.
    let _ = w.set_shadow(false);
    let monitor = label_monitor(&label).or(monitor);
    let Some(monitor) = resolve_monitor(&app, monitor) else { return };
    let scale = monitor.scale_factor() as f64;
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;

    let _ = (content_height, collapsed_width, fit_width);
    let is_bar = layout == "bar";
    let thickness = thickness.clamp(30.0, 96.0);
    // Fixed footprint: the configured length/thickness own the window size.
    // Content changes (media titles, timer chips) must never resize it.
    let width = if is_bar {
        sw * (length / 100.0).clamp(0.25, 1.0)
    } else {
        // Keep the user's length but give the pill enough room for its status
        // chips plus a readable media title. Below ~320px the title is reduced
        // to a single character even though the other labels are fixed-size.
        let collapsed = length.clamp(320.0, sw * 0.8);
        // Expand the same pill into a usable menu width; the configured length
        // only describes the collapsed state. 560px fits two widget columns.
        if expanded {
            collapsed.max(560.0).min(sw * 0.92)
        } else {
            collapsed
        }
    };
    // Opening the panel uses a fixed height; the panel scrolls if the enabled
    // widgets need more room. This still stays inside 92% of the screen.
    let height = if expanded {
        (thickness + 286.0).min(sh * 0.92)
    } else {
        thickness
    };
    let (width, height) = (width.round(), height.round());

    // Anchor edges/corners keep a small breathing 8px margin from the edge.
    let margin = 8.0;
    // The notch shape hangs from the top edge with no gap, like NotchPixel's
    // notch; bottom placements keep their 8px breathing room.
    let (anchor_x, anchor_y, anchor_side) = match placement.as_str() {
        "top-left" => (margin, 0.0, "left"),
        "top-right" => (sw - margin, 0.0, "right"),
        "top-center" => (sw / 2.0, 0.0, "center"),
        "bottom-left" => (margin, sh - margin, "left"),
        "bottom-right" => (sw - margin, sh - margin, "right"),
        _ => (sw / 2.0, sh - margin, "center"),
    };
    let x = match anchor_side {
        "left" => anchor_x.min((sw - width).max(0.0)),
        "right" => (anchor_x - width).max(0.0),
        _ => (anchor_x - width / 2.0).max(0.0).min(sw - width),
    };
    // Top placements hang the strip from the top of the window; bottom ones
    // pin it to the bottom edge (the webview reverses its column so the pill
    // hugs the screen's bottom).
    let y = match anchor_side {
        "center" if anchor_y > sh / 2.0 => (sh - margin - height).max(0.0),
        _ if anchor_y > sh / 2.0 => (anchor_y - height).max(0.0),
        _ => anchor_y.min((sh - height).max(0.0)),
    };

    let _ = w.set_size(tauri::LogicalSize::new(width, height));
    let px = monitor.position().x + (x * scale).round() as i32;
    let py = monitor.position().y + (y * scale).round() as i32;
    let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
    #[cfg(windows)]
    {
        if let Some(hwnd) = hwnd_of(&w) {
            raise_above_top_toolbar(hwnd.0 as isize);
        }
        // Remember what the layout asked for: the shell's own placement passes
        // like to nudge edge windows down by the height of its toolbar.
        if let Ok(mut geom) = notch_geometry().lock() {
            let slot = geom.entry(label.clone()).or_insert((px, py, 0, 0));
            *slot = (
                px,
                py,
                (width * scale).round() as i32,
                (height * scale).round() as i32,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Status bar (YASB-style module) — a full-width edge strip with system /
// media / clock chips. Geometry is owned by the bar itself: top or bottom
// edge, thickness and side insets.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn statusbar_apply_layout(
    app: AppHandle,
    placement: String,
    thickness: f64,
    inset: f64,
    monitor: Option<(i32, i32)>,
    label: Option<String>,
    reserve_edge: Option<bool>,
) {
    let label = label.unwrap_or_else(|| "statusbar".to_string());
    let Some(w) = app.get_webview_window(&label) else { return };
    let monitor = label_monitor(&label).or(monitor);
    let Some(monitor) = resolve_monitor(&app, monitor) else { return };
    let scale = monitor.scale_factor() as f64;
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;

    let thickness = thickness.clamp(24.0, 96.0);
    // Edge-to-edge by default; the inset sidebar look keeps the bar usable.
    let inset = inset.clamp(0.0, ((sw - 240.0) / 2.0).max(0.0));
    let width = (sw - 2.0 * inset).max(240.0);

    // Reserve the edge as an AppBar so Explorer shrinks the desktop work area
    // instead of letting maximized windows cover the bar. Fullscreen-hidden and
    // disabled bars release it so games and apps get the whole display.
    //
    // The reservation is owned by a hidden carrier window rather than by the
    // bar: Explorer runs its own placement pass over registered AppBars and, for
    // a bottom bar, drops the window one bar-height inside the edge — which is
    // what made the bar hop up and fall back. The carrier is created on the main
    // thread so it lives as long as the app.
    {
        let app = app.clone();
        let placement = placement.clone();
        let want = reserve_edge.unwrap_or(false);
        let (mx, my) = (monitor.position().x, monitor.position().y);
        let (mw, mh) = (
            monitor.size().width as i32,
            monitor.size().height as i32,
        );
        let thick_px = (thickness * scale).round() as i32;
        let key = hwnd_of(&w).map(|h| h.0 as isize).unwrap_or(0);
        let _ = app.run_on_main_thread(move || {
            let carrier = crate::appbar::carrier(key);
            if carrier == 0 {
                return;
            }
            if want {
                let _ = crate::appbar::reserve(carrier, &placement, mx, my, mw, mh, thick_px);
            } else {
                crate::appbar::release(carrier);
            }
        });
    }

    // The bar is always drawn flush on its configured edge. The AppBar reply
    // only describes the reserved work area; using it for the window geometry
    // made the bar hop one bar-height up (and back down) whenever the strip was
    // released and re-reserved — fullscreen, cloak or a display change.
    let height = thickness;
    let y = if placement == "bottom" {
        (sh - height).max(0.0)
    } else {
        0.0
    };

    let px = monitor.position().x + (inset * scale).round() as i32;
    let py = monitor.position().y + (y * scale).round() as i32;
    let _ = w.set_size(tauri::LogicalSize::new(width.round(), height.round()));
    let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
    // Remember the exact strip so the geometry guard can put the bar back on
    // its edge after Explorer's own AppBar placement pass lifts it up.
    #[cfg(windows)]
    if let Ok(mut geom) = notch_geometry().lock() {
        geom.insert(
            label,
            (
                px,
                py,
                (width * scale).round() as i32,
                (height * scale).round() as i32,
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// App launcher scan (smart notch run widget)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_apps(state: State<'_, crate::apps::AppsState>) -> Vec<crate::apps::AppEntry> {
    crate::apps::snapshot(&state)
}

/// Force a fresh Start-Menu walk (after installing a new app).
#[tauri::command]
pub fn rescan_apps(state: State<'_, crate::apps::AppsState>) {
    crate::apps::rescan(&state)
}

// ---------------------------------------------------------------------------
// Clipboard history / Bluetooth battery / focus-timer chime (Smart Notch tier)
// ---------------------------------------------------------------------------

#[tauri::command]
#[cfg(windows)]
pub fn get_clipboard_history(state: State<'_, crate::clipboard::History>) -> Vec<crate::clipboard::ClipboardEntry> {
    state.lock().map(|l| l.clone()).unwrap_or_default()
}

#[tauri::command]
#[cfg(not(windows))]
pub fn get_clipboard_history() -> Vec<crate::clipboard::ClipboardEntry> {
    Vec::new()
}

/// Copy previously captured text back into the clipboard.
#[tauri::command]
#[cfg(windows)]
pub fn copy_clipboard_text(text: String) -> Result<(), String> {
    crate::clipboard::write_clipboard_text(&text)
}

#[tauri::command]
#[cfg(not(windows))]
pub fn copy_clipboard_text(_text: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[cfg(windows)]
pub fn get_bluetooth_battery(state: State<'_, crate::bluetooth::BtList>) -> Vec<crate::bluetooth::BtDevice> {
    state.lock().map(|l| l.clone()).unwrap_or_default()
}

#[tauri::command]
#[cfg(not(windows))]
pub fn get_bluetooth_battery() -> Vec<crate::bluetooth::BtDevice> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// Smart Notch extensions: volume mixer, downloads, cloak and edge light
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_audio_sessions() -> Vec<crate::audio::AudioSessionInfo> {
    crate::audio::list_sessions()
}

#[tauri::command]
pub fn set_audio_session(id: String, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    crate::audio::set_session(&id, volume, muted)
}

#[tauri::command]
pub fn get_downloads() -> Vec<crate::downloads::DownloadInfo> {
    crate::downloads::list_downloads()
}

/// Hide or restore the non-notch overlays. The notch stays visible so the
/// cloak can always be lifted from the same widget that enabled it.
#[tauri::command]
pub fn cloak_apply(app: AppHandle, active: bool, modules: Vec<String>) {
    for label in ["clock", "todo", "statusbar"] {
        let enabled = modules.iter().any(|module| module == label);
        if let Some(window) = app.get_webview_window(label) {
            if active {
                let _ = window.hide();
                #[cfg(windows)]
                if label == "statusbar" {
                    if let Some(hwnd) = hwnd_of(&window) {
                        crate::appbar::release(hwnd.0 as isize);
                    }
                }
            } else if enabled {
                let _ = window.show();
                let level = levels().lock().unwrap().get(label).cloned();
                if let Some(level) = level {
                    apply_level(&app, &window, &level);
                }
            }
        }
        sync_module_visibility(&app, label, !active && enabled);
    }
}

/// Show or hide the click-through edge-glow overlay on the requested display.
#[tauri::command]
pub fn edge_light_apply(app: AppHandle, active: bool, monitor: Option<(i32, i32)>) {
    let Some(window) = app.get_webview_window("edgelight") else {
        return;
    };
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_focusable(false);
    let _ = window.set_shadow(false);
    if !active {
        let _ = window.hide();
        return;
    }
    let Some(target) = resolve_monitor(&app, monitor) else {
        return;
    };
    let size = target.size();
    let _ = window.set_size(tauri::PhysicalSize::new(size.width.max(1), size.height.max(1)));
    let _ = window.set_position(tauri::PhysicalPosition::new(
        target.position().x,
        target.position().y,
    ));
    let _ = window.set_always_on_top(true);
    let _ = window.show();
}

/// Focus timer finished: play the system notification sound twice.
#[tauri::command]
pub fn notch_chime() {
    #[cfg(windows)]
    {
        std::thread::spawn(|| {
            use windows::Win32::System::Diagnostics::Debug::MessageBeep;
            use windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE;
            const MB_ICONASTERISK: u32 = 0x0000_0040; // SystemNotification
            for _ in 0..2 {
                unsafe {
                    let _ = MessageBeep(MESSAGEBOX_STYLE(MB_ICONASTERISK));
                }
                std::thread::sleep(std::time::Duration::from_millis(350));
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Wallpaper embedding helper
// ---------------------------------------------------------------------------

pub fn wallpaper_embed(app: &AppHandle, embed: bool) -> bool {
    wallpaper_embed_label(app, "wallpaper", embed)
}

/// Embed/unembed any wallpaper-suffix window (main + per-display extras).
pub fn wallpaper_embed_label(app: &AppHandle, label: &str, embed: bool) -> bool {
    let Some(w) = app.get_webview_window(label) else {
        return false;
    };
    let Some(hwnd) = hwnd_of(&w) else { return false };
    #[cfg(windows)]
    return wallpaper_win::set_embedded(hwnd, embed);
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        false
    }
}

#[cfg(windows)]
fn hwnd_of(window: &tauri::WebviewWindow) -> Option<windows::Win32::Foundation::HWND> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    let raw = window
        .window_handle()
        .ok()?
        .window_handle()
        .ok()?
        .as_raw();
    match raw {
        RawWindowHandle::Win32(h) => Some(HWND(h.hwnd.get() as *mut core::ffi::c_void)),
        _ => None,
    }
}

#[cfg(not(windows))]
fn hwnd_of(_window: &tauri::WebviewWindow) -> Option<()> {
    None
}

/// Public command so the wallpaper window can request (un)embedding itself too.
/// Strips the caption bits Tauri leaves on a `decorations: false` window and
/// tells DWM to stop drawing non-client chrome. Without this Windows sometimes
/// paints a small light title plaque (app icon + "Tauri App") inside a module
/// window — over the To-Do header, for instance.
#[cfg(windows)]
pub fn strip_caption(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_NCRENDERING_POLICY};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos,
        GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
    };

    let Some(hwnd) = hwnd_of(window) else { return };
    let clear = (WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize;
    let had_caption = unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if style & clear != 0 {
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !clear);
            true
        } else {
            false
        }
    };
    unsafe {
        // DWM keeps the caption frame it already composed until the window's
        // size changes, even after the caption bits are gone (SWP_FRAMECHANGED
        // alone does not invalidate it on a transparent undecorated window).
        // A one-pixel resize that is reverted immediately makes it recompose
        // without the title plaque. A shown window always gets that nudge, so a
        // plaque composed at any earlier moment cannot survive the reveal.
        if had_caption || IsWindowVisible(hwnd).as_bool() {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
                let flags = SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE;
                let _ = SetWindowPos(hwnd, None, 0, 0, w, h + 1, flags);
                let _ = SetWindowPos(hwnd, None, 0, 0, w, h, flags);
            }
        }
        // DWMNCRP_DISABLED: no caption, no frame, only the webview's pixels.
        let policy: i32 = 1;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_NCRENDERING_POLICY,
            &policy as *const _ as *const _,
            4,
        );
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(not(windows))]
pub fn strip_caption(_window: &tauri::WebviewWindow) {}

/// Keep the caption style off the module windows.
///
/// Stripping it once is not enough: Tauri re-applies its window style after a
/// show, and whatever pass wins the race decides whether DWM composes a title
/// plaque. The geometry guard calls this every tick, so a late style is cleared
/// (and forced to recompose) within a fraction of a second.
#[cfg(windows)]
pub fn enforce_module_chrome(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_STYLE, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU,
    };
    let clear = (WS_CAPTION.0 | WS_SYSMENU.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0) as isize;
    for (label, window) in app.webview_windows() {
        // The settings panel is a real decorated window; wallpapers are
        // reparented behind the desktop and never shown as app windows.
        if label == "settings" || label.starts_with("wallpaper") {
            continue;
        }
        let Some(hwnd) = hwnd_of(&window) else { continue };
        let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
        if style & clear != 0 {
            strip_caption(&window);
        }
    }
}

#[tauri::command]
pub fn wallpaper_set_embedded(app: AppHandle, embed: bool) -> bool {
    wallpaper_embed(&app, embed)
}

// ---------------------------------------------------------------------------
// Per-display wallpapers — one extra wallpaper webview per non-main display
// ---------------------------------------------------------------------------

/// Window label of a per-display wallpaper with the given global origin.
fn wallpaper_display_label(x: i32, y: i32) -> String {
    format!("wallpaper_{}_{}", x, y)
}

/// Make sure every connected display except the main wallpaper's display has
/// its own wallpaper window, sized to that display and embedded behind the
/// desktop icons — so each screen can show a different wallpaper.
///
/// Called by the main wallpaper page whenever the module is enabled or the
/// per-display assignment changes. `visible = false` hides every extra.
#[cfg(windows)]
fn schedule_existing_wallpaper_show(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if !wallpaper_should_show(&label) {
                return;
            }
            if let Some(window) = app.get_webview_window(&label) {
                if hwnd_of(&window).is_some() {
                    show_wallpaper_backdrop(&window);
                    return;
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn schedule_existing_wallpaper_show(_app: AppHandle, _label: String) {}

/// Show/hide the per-display wallpaper windows that were created during
/// native setup. This command never builds windows or touches the desktop
/// hierarchy, so it is safe to call from the settings-sync path.
#[tauri::command]
pub fn wallpaper_sync_displays(app: AppHandle, visible: bool, main_monitor: Option<(i32, i32)>) {
    let main_origin = resolve_monitor(&app, main_monitor).map(|m| (m.position().x, m.position().y));
    let extras: Vec<(i32, i32)> = enumerate_monitors(&app)
        .into_iter()
        .filter(|m| Some((m.x, m.y)) != main_origin)
        .map(|m| (m.x, m.y))
        .collect();

    for (x, y) in &extras {
        let label = wallpaper_display_label(*x, *y);
        set_wallpaper_desired(&label, visible);
        if visible {
            if let Some(window) = app.get_webview_window(&label) {
                show_wallpaper_backdrop(&window);
            }
            schedule_existing_wallpaper_show(app.clone(), label);
        } else if let Some(window) = app.get_webview_window(&label) {
            #[cfg(windows)]
            if let Some(hwnd) = hwnd_of(&window) {
                crate::wallpaper_win::hide_async(hwnd.0 as isize);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Multiple displays — duplicate overlay modules onto more monitors
// ---------------------------------------------------------------------------

/// Logical default size used when a module is duplicated onto another display.
/// The notch and statusbar resize themselves through their layout commands.
fn module_default_size(module: &str) -> (f64, f64) {
    match module {
        "clock" => (360.0, 220.0),
        "todo" => (420.0, 560.0),
        "notch" => (240.0, 44.0),
        "statusbar" => (1280.0, 40.0),
        _ => (360.0, 220.0),
    }
}

/// Anchor a duplicated module inside its own display: clock top-right, todo
/// bottom-left, everything else at the origin (their layout command takes over).
fn duplicate_anchor(module: &str, monitor: &tauri::Monitor, w: f64, h: f64) -> (i32, i32) {
    let scale = monitor.scale_factor();
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;
    let margin = 24.0;
    let (x, y) = match module {
        "clock" => ((sw - w - margin).max(0.0), margin),
        "todo" => (margin, (sh - h - margin).max(0.0)),
        _ => (0.0, 0.0),
    };
    (
        monitor.position().x + (x * scale).round() as i32,
        monitor.position().y + (y * scale).round() as i32,
    )
}

/// Every per-display duplicate window of `module` (labels `module_x_y`).
fn duplicate_windows(app: &AppHandle, module: &str) -> Vec<tauri::WebviewWindow> {
    let prefix = format!("{}_", module);
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(&prefix) && label_monitor(label).is_some())
        .map(|(_, window)| window)
        .collect()
}

/// Keep duplicated module windows in step with the main window's visibility.
fn sync_module_visibility(app: &AppHandle, module: &str, visible: bool) {
    for window in duplicate_windows(app, module) {
        if visible {
            let _ = window.show();
            let level = levels().lock().unwrap().get(window.label()).cloned();
            if let Some(level) = level {
                apply_level(app, &window, &level);
            }
        } else {
            let _ = window.hide();
        }
    }
}

/// Ensure one duplicate window per requested display, on that display's
/// monitor, and remove duplicates whose display is gone or deselected.
#[tauri::command]
pub fn module_sync_displays(
    app: AppHandle,
    module: String,
    visible: bool,
    displays: Vec<(i32, i32)>,
    main_monitor: Option<(i32, i32)>,
    level: String,
    click_through: bool,
    capacity: (f64, f64),
) {
    if !matches!(module.as_str(), "clock" | "notch" | "todo" | "statusbar") {
        return;
    }
    // Never duplicate a module over its own (main) display, and ignore saved
    // origins for displays that are currently disconnected.
    let main_origin = resolve_monitor(&app, main_monitor).map(|m| (m.position().x, m.position().y));
    let connected: Vec<(i32, i32)> = enumerate_monitors(&app)
        .into_iter()
        .map(|m| (m.x, m.y))
        .collect();
    let displays: Vec<(i32, i32)> = displays
        .into_iter()
        .filter(|origin| Some(*origin) != main_origin && connected.contains(origin))
        .collect();
    let wanted: Vec<String> = displays
        .iter()
        .map(|(x, y)| format!("{}_{}_{}", module, x, y))
        .collect();

    // Drop duplicates whose display was disconnected or deselected.
    let stale: Vec<tauri::WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(&format!("{}_", module)) && !wanted.contains(label))
        .map(|(_, window)| window)
        .collect();
    for window in stale {
        let _ = window.close();
    }

    if !visible {
        for (label, window) in app.webview_windows() {
            if wanted.contains(&label) {
                let _ = window.hide();
            }
        }
        return;
    }

    let (base_w, base_h) = module_default_size(&module);
    let cap_w = capacity.0.clamp(0.4, 2.0);
    let cap_h = capacity.1.clamp(0.4, 2.0);
    let app2 = app.clone();
    let module2 = module.clone();
    let level2 = level.clone();
    let targets = displays.clone();
    let _ = app.run_on_main_thread(move || {
        for (x, y) in targets.clone() {
            let label = format!("{}_{}_{}", module2, x, y);
            let Some(monitor) = resolve_monitor(&app2, Some((x, y))) else {
                continue;
            };
            let w = (base_w * cap_w).round();
            let h = (base_h * cap_h).round();

            if let Some(window) = app2.get_webview_window(&label) {
                // Refresh an existing duplicate; notch/statusbar keep owning
                // their own geometry through their layout command.
                if matches!(module2.as_str(), "clock" | "todo") {
                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                    let (px, py) = duplicate_anchor(&module2, &monitor, w, h);
                    let _ = window.set_position(tauri::PhysicalPosition::new(px, py));
                }
                strip_caption(&window);
                let _ = window.set_ignore_cursor_events(click_through);
                let _ = window.set_focusable(!click_through);
                let _ = window.show();
                apply_level(&app2, &window, &level2);
                continue;
            }

            let (px, py) = duplicate_anchor(&module2, &monitor, w, h);
            let builder = tauri::WebviewWindowBuilder::new(
                &app2,
                &label,
                tauri::WebviewUrl::App(format!("{}.html", module2).into()),
            )
            .visible(false)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .always_on_top(level2 == "topmost")
            .additional_browser_args(
                "--autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
            );
            if let Ok(window) = builder.build() {
                strip_caption(&window);
                let _ = window.set_size(tauri::LogicalSize::new(w, h));
                let _ = window.set_position(tauri::PhysicalPosition::new(px, py));
                let _ = window.set_ignore_cursor_events(click_through);
                let _ = window.set_focusable(!click_through);
            }
        }

        // Give freshly created webviews a beat to load, then reveal them.
        let handle = app2.clone();
        let module3 = module2.clone();
        let level3 = level2.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            for (x, y) in targets {
                let label = format!("{}_{}_{}", module3, x, y);
                if let Some(window) = handle.get_webview_window(&label) {
                    let _ = window.show();
                    apply_level(&handle, &window, &level3);
                }
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Opening custom quick shortcuts (URLs or file/app paths)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_shortcut(target: String) {
    let _ = crate::open_external(&target);
}

// ---------------------------------------------------------------------------
// Wallpaper library — imported copies live in the app data folder so sources
// may move or be deleted without breaking the wallpaper.
// ---------------------------------------------------------------------------

fn wallpapers_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("wallpapers");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Copy a wallpaper file into the app's own `wallpapers` folder and return the
/// new path. Re-importing the same file name reuses the existing copy instead
/// of piling up duplicates.
#[tauri::command]
pub fn wallpaper_import(app: AppHandle, source: String) -> Result<String, String> {
    let src = std::path::Path::new(&source);
    if !src.is_file() {
        return Err(format!("not a file: {}", source));
    }
    let dir = wallpapers_dir(&app)?;

    let original_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "invalid file name".to_string())?;

    // Dedupe: any previous copy of the same original name ("<stamp>-<name>").
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let suffix = format!("-{}", original_name);
        for entry in entries.flatten() {
            let n = entry.file_name().to_string_lossy().to_string();
            if n.ends_with(&suffix) {
                return Ok(entry.path().to_string_lossy().to_string());
            }
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_name: String = original_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' { c } else { '_' })
        .collect();
    let dest = dir.join(format!("{}-{}", stamp, safe_name));
    std::fs::copy(src, &dest).map_err(|e| format!("copy failed: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Delete a managed copy. Refuses anything outside the app's wallpapers folder.
#[tauri::command]
pub fn wallpaper_delete_copy(app: AppHandle, path: String) -> Result<(), String> {
    let allowed = wallpapers_dir(&app)?;
    let target = std::path::PathBuf::from(&path);
    if target.parent() != Some(allowed.as_path()) {
        return Err("refusing to delete outside the wallpaper library".into());
    }
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Media / system info getters backed by background polling threads
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_media_info(state: State<'_, MediaState>) -> Option<crate::media::MediaInfo> {
    state.info.lock().ok()?.clone()
}

#[tauri::command]
pub fn get_media_art(state: State<'_, MediaState>) -> Option<crate::media::MediaArt> {
    state.art.lock().ok()?.clone().map(|(_, art)| art)
}

/// Toggle play/pause on the active system media session.
#[tauri::command]
pub fn toggle_media_playback() -> bool {
    crate::media::toggle_playback()
}

/// Skip to the next ("next") or previous ("previous") track.
#[tauri::command]
pub fn media_skip(direction: String) -> bool {
    crate::media::skip(&direction)
}

#[tauri::command]
pub fn get_system_info(state: State<'_, SysState>) -> Option<crate::monit::SystemSnapshot> {
    state.snapshot.lock().ok()?.clone()
}

/// Lively-style “Pause wallpaper” policy (0 = off, 1 = maximized, 2 = fullscreen).
/// Sent by the wallpaper webview whenever the setting changes; the pause
/// watcher thread reads it and broadcasts transitions to the wallpaper pages.
#[tauri::command]
pub fn wallpaper_set_pause_mode(mode: u8) {
    crate::monit::set_wallpaper_pause_mode(mode);
}

/// Pause the wallpaper while the machine runs on battery (Lively-style).
#[tauri::command]
pub fn wallpaper_set_battery_pause(enabled: bool) {
    crate::monit::set_battery_pause(enabled);
}

/// Battery charge / AC state for the status bar's battery chip.
#[tauri::command]
pub fn get_power_status() -> crate::monit::PowerStatus {
    crate::monit::power_status()
}

/// Foreground window title/class for the status bar's active-window chip.
#[tauri::command]
pub fn get_active_window() -> crate::monit::ActiveWindowInfo {
    crate::monit::active_window_info()
}

/// Master output volume for the status bar's volume chip.
#[tauri::command]
pub fn get_master_volume() -> Option<crate::audio::MasterVolume> {
    crate::audio::master_volume()
}

// ---------------------------------------------------------------------------
// Global shortcut handler (Ctrl+Shift+, opens the settings panel)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Start with Windows
// ---------------------------------------------------------------------------

/// Prefer the self-contained release build when this is the debug binary.
/// The debug executable points at Vite's `devUrl`, so a Windows sign-in launch
/// would show ERR_CONNECTION_REFUSED when no dev server is running.
#[cfg(windows)]
fn autostart_target_exe() -> std::path::PathBuf {
    let current = std::env::current_exe().unwrap_or_default();
    let is_aura_exe = current
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("aura.exe"));
    let is_debug = current
        .parent()
        .and_then(|dir| dir.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("debug"));
    if is_aura_exe && is_debug {
        if let Some(release) = current.parent().and_then(|dir| dir.parent()).map(|dir| {
            dir.join("release").join("aura.exe")
        }) {
            if release.is_file() {
                return release;
            }
        }
    }
    current
}

const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// Set once the desktop shell and display topology from a sign-in launch have
/// settled. Module pages wait for this before measuring or revealing anything.
pub static STARTUP_READY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn startup_is_ready() -> bool {
    STARTUP_READY.load(Ordering::Relaxed)
}

/// Enable or disable launching Aura at Windows sign-in. On Windows the Run key
/// is written directly so a debug build can register the release executable.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = &app;
        let mut cmd = std::process::Command::new("reg");
        if enabled {
            let target = autostart_target_exe();
            // The marker lets a sign-in launch wait for Explorer and the final
            // display/DPI topology instead of racing them at login.
            let value = format!("\"{}\" --autostart", target.display());
            cmd.args([
                "add",
                AUTOSTART_KEY,
                "/v",
                "Aura",
                "/t",
                "REG_SZ",
                "/d",
                value.as_str(),
                "/f",
            ]);
        } else {
            cmd.args(["delete", AUTOSTART_KEY, "/v", "Aura", "/f"]);
        }
        let status = cmd.status().map_err(|e| format!("autostart: {e}"))?;
        if enabled && !status.success() {
            return Err("Windows rejected the Aura autostart entry".into());
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let m = app.autolaunch();
        let res = if enabled { m.enable() } else { m.disable() };
        res.map_err(|e| e.to_string())
    }
}

/// Reflect the actual OS autostart state (what the Settings toggle shows).
#[tauri::command]
pub fn autostart_is_enabled(app: AppHandle) -> bool {
    #[cfg(windows)]
    {
        let _ = &app;
        return std::process::Command::new("reg")
            .args(["query", AUTOSTART_KEY, "/v", "Aura"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    }
}

/// Hotkeys that open the settings panel, registered statically at boot.
/// `app_shortcut_set` tears these down / re-registers them based on the
/// user's Global-shortcut configuration.
pub const SETTINGS_DEFAULT_COMBOS: [&str; 3] = ["ctrl+shift+,", "ctrl+shift+=", "ctrl+shift+numpadplus"];

/// The user's custom settings hotkey, as currently registered system-wide.
/// `None` = the defaults above are the active settings hotkeys.
static CUSTOM_COMBO: Mutex<Option<String>> = Mutex::new(None);

pub fn on_global_shortcut(app: &AppHandle, _shortcut: &str, state: ShortcutState) {
    if state == ShortcutState::Pressed {
        show_settings(app);
    }
}

/// Apply the user's "open settings" hotkey configuration from Settings:
/// `enabled=false` unregisters every settings hotkey system-wide;
/// `combo` empty keeps the builtin defaults, a non-empty value registers
/// exactly one user-chosen combination instead. Called by the settings
/// webview on boot and whenever the config changes.
#[tauri::command]
pub fn app_shortcut_set(app: AppHandle, enabled: bool, combo: Option<String>) -> Result<(), String> {
    let gs = app.global_shortcut();
    let user = combo
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);

    // Validate the requested custom shortcut BEFORE tearing anything down: a
    // bad value must never leave the app without its settings hotkey.
    let parsed: Option<(String, Shortcut)> = match (&user, enabled) {
        (Some(c), true) => {
            let sc = c.parse::<Shortcut>().map_err(|e| {
                format!("'{c}' is not a valid shortcut ({e:?}). Include at least one modifier, e.g. Ctrl/Alt/Shift.")
            })?;
            Some((c.clone(), sc))
        }
        _ => None,
    };

    // Tear down everything we may have registered before (ignore failures —
    // unregistering something that isn't registered is not an error for us).
    for s in SETTINGS_DEFAULT_COMBOS {
        let _ = gs.unregister(s);
    }
    if let Ok(mut prev) = CUSTOM_COMBO.lock() {
        if let Some(old) = prev.take() {
            if let Ok(sc) = old.parse::<Shortcut>() {
                let _ = gs.unregister(sc);
            }
        }
    }

    if enabled {
        if let Some((c, sc)) = parsed {
            if let Err(e) = gs.register(sc) {
                // Registration failed (combo already taken by another app):
                // restore the builtin defaults so the hotkey keeps working.
                for s in SETTINGS_DEFAULT_COMBOS {
                    let _ = gs.register(s);
                }
                return Err(format!("Could not register {c}: {e:?}"));
            }
            if let Ok(mut slot) = CUSTOM_COMBO.lock() {
                *slot = Some(c);
            }
        } else {
            for s in SETTINGS_DEFAULT_COMBOS {
                gs.register(s)
                    .map_err(|e| format!("Could not register {s}: {e:?}"))?;
            }
        }
    }
    Ok(())
}


// ---------------------------------------------------------------------------
// Shared settings — one JSON file for every launch mode
// ---------------------------------------------------------------------------

/// Path of the settings file shared by the dev server and the packaged app.
fn settings_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Read the shared settings JSON (None on first run or unreadable file).
#[tauri::command]
pub fn settings_read(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(settings_file(&app).ok()?).ok()
}

/// Persist the settings JSON so the next launch — whatever entry point — reads
/// the same theme, layout and module set.
#[tauri::command]
pub fn settings_write(app: AppHandle, json: String) -> Result<(), String> {
    let path = settings_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
