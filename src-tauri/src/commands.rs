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

/// Show/hide one of the module overlay windows. The wallpaper window also gets
/// embedded behind the desktop icons when shown. `x`/`y` (logical px) override
/// the automatic placement when both are provided.
#[tauri::command]
pub fn set_module_visible(
    app: AppHandle,
    label: String,
    visible: bool,
    x: Option<f64>,
    y: Option<f64>,
    monitor: Option<(i32, i32)>,
) {
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    let is_wallpaper = label == "wallpaper";
    let target = resolve_monitor(&app, monitor);
    if visible {
        if is_wallpaper {
            // The wallpaper fills its chosen display.
            if let Some(mon) = target.as_ref() {
                let _ = window.set_size(tauri::PhysicalSize::new(mon.size().width.max(1), mon.size().height.max(1)));
                let _ = window.set_position(tauri::PhysicalPosition::new(mon.position().x, mon.position().y));
            }
        } else {
            match (x, y) {
                (Some(x), Some(y)) => {
                    if let Some(mon) = target.as_ref() {
                        // Manual coordinates are logical px *within the chosen display*.
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
        }
        let _ = window.show();
        if is_wallpaper {
            let handle = app.clone();
            let window = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                let _ = window.show();
                let ok = wallpaper_embed(&handle, true);
                if !ok {
                    // Fallback: keep it as a normal skipped-taskbar window.
                    let _ = window.show();
                }
            });
        }
    } else {
        if is_wallpaper {
            let _ = wallpaper_embed(&app, false);
        }
        let _ = window.hide();
    }
}

/// Reposition the notch/clock/todo windows nicely *within the given display*
/// (idempotent; keeps their logical sizes from tauri.conf.json).
fn position_module_window(
    _app: &AppHandle,
    label: &str,
    window: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
) {
    if !matches!(label, "notch" | "clock" | "todo" | "start") {
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
        "notch" => {
            let notch_w = window.outer_size().map(|s| s.width as f64).unwrap_or(240.0);
            (mx + (w - notch_w) / 2.0, my)
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
) {
    let Some(w) = app.get_webview_window(&label) else { return };

    if let Some(l) = level {
        // The wallpaper (main + per-display extras) is always forced to the
        // very bottom (embedded behind the desktop icons), whatever layer the
        // stored configuration says — apps must never end up behind it.
        let forced = label == "wallpaper" || label.starts_with("wallpaper_");
        apply_level(&app, &w, if forced { "bottommost" } else { &l });
    }
    if let (Some(x), Some(y)) = (x, y) {
        if let Some(mon) = resolve_monitor(&app, monitor) {
            // Manual coordinates are logical px within the chosen display.
            let scale = mon.scale_factor();
            let _ = w.set_position(tauri::PhysicalPosition::new(
                mon.position().x + (x * scale).round() as i32,
                mon.position().y + (y * scale).round() as i32,
            ));
        }
    }
    if label == "wallpaper" || label.starts_with("wallpaper_") {
        // The wallpaper is never interactive — a wallpaper that takes mouse
        // input can be clicked or dragged, and a dragged/moved wallpaper pops
        // out of its z-order slot and covers the windows underneath. Ignore
        // any click-through value that would re-enable input on it.
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.set_focusable(false);
    } else if let Some(ct) = click_through {
        let _ = w.set_ignore_cursor_events(ct);
        let _ = w.set_focusable(!ct);
    }
    if let Some((ws, hs)) = capacity {
        if let Some((_, dw, dh)) = DEFAULT_SIZES.iter().find(|(l, _, _)| *l == label) {
            let _ = w.set_size(tauri::LogicalSize::new(
                (dw * ws.clamp(0.4, 2.0)).round(),
                (dh * hs.clamp(0.4, 2.0)).round(),
            ));
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
                let _ = wallpaper_embed(app, false);
            }
            let _ = window.set_always_on_top(true);
        }
        "normal" => {
            let is_wallpaper = is_wallpaper_window(app, window);
            if is_wallpaper {
                let _ = wallpaper_embed(app, false);
            }
            let _ = window.set_always_on_top(false);
            // A plain "normal" wallpaper would sit wherever Windows drops it —
            // potentially above open windows. Pin it to the bottom of the
            // normal band instead so it never covers apps.
            if is_wallpaper {
                #[cfg(windows)]
                pin_to_bottom(window);
                #[cfg(not(windows))]
                let _ = window;
            }
        }
        "bottommost" => {
            // The wallpaper is special-cased: embedding behind the desktop
            // icons is its true bottommost. Other modules pin to the bottom of
            // the window stack.
            if is_wallpaper_window(app, window) {
                let _ = window.set_always_on_top(false);
                let label = window.label().to_string();
                let _ = wallpaper_embed_label(app, &label, true);
                return;
            }
            #[cfg(windows)]
            pin_to_bottom(window);
            #[cfg(not(windows))]
            let _ = window.set_always_on_top(false);
        }
        _ => {}
    }
}

/// Push the window to the very bottom of the z-stack (just above the desktop
/// background) and prevent it from stealing focus.
#[cfg(windows)]
fn pin_to_bottom(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER,
    };
    use windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW;
    use windows::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE;
    use windows::Win32::UI::WindowsAndMessaging::WS_EX_NOACTIVATE;

    let _ = window.set_always_on_top(false);
    let Some(hwnd) = hwnd_of(window) else { return };
    unsafe {
        // Keep it unresponsive to activation clicks while pinned to the bottom.
        let _ = SetWindowLongPtrW(
            HWND(hwnd.0),
            GWL_EXSTYLE,
            (GetWindowLongPtrW(HWND(hwnd.0), GWL_EXSTYLE) | WS_EX_NOACTIVATE.0 as isize) as _,
        );
        let _ = SetWindowPos(
            HWND(hwnd.0),
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SET_WINDOW_POS_FLAGS(
                (SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_NOZORDER.0) as u32,
            ),
        );
    }
}

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW;

/// Apply the notch's user-configurable layout (free-tier feature parity with
/// the Store "Smart Notch"): notch-or-bar shape, placement along screen
/// edges/corners, and independent length & thickness. `length` means px in
/// "notch" mode and a percentage of screen width in "bar" mode.
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
) {
    let Some(w) = app.get_webview_window("notch") else { return };
    let Some(monitor) = resolve_monitor(&app, monitor) else { return };
    let scale = monitor.scale_factor() as f64;
    let sw = monitor.size().width as f64 / scale;
    let sh = monitor.size().height as f64 / scale;

    let is_bar = layout == "bar";
    let thickness = thickness.clamp(30.0, 96.0);
    // The bar strip is always as wide as the panel it opens (the icon tabs +
    // status chips don't fit a narrower pill), so both states share a width.
    let full_width = if is_bar {
        sw * (length / 100.0).clamp(0.25, 1.0)
    } else {
        660.0f64.max(length.clamp(160.0, sw * 0.8))
    };
    // Collapsed (any layout): shrink to the measured compact pill. Expanded,
    // or no measurement yet: full width.
    let mut width = if !expanded {
        collapsed_width
            .map(|w| w.max(150.0).min(sw * 0.9))
            .unwrap_or(full_width)
    } else {
        full_width
    };
    // Tween frames override the width outright; safe clamps on both ends.
    if let Some(over) = fit_width {
        width = over.max(150.0).min(sw * 0.9);
    }
    let (width, height) = if expanded {
        let content = content_height.unwrap_or(286.0).max(140.0);
        // Bar strip (thickness) + measured panel content, never taller than
        // 92% of the screen so widgets stay reachable.
        (width.round(), (thickness + content).min(sh * 0.92).round())
    } else {
        (width.round(), thickness)
    };

    // Anchor edges/corners keep a small breathing 8px margin from the edge.
    let margin = 8.0;
    let (anchor_x, anchor_y, anchor_side) = match placement.as_str() {
        "top-left" => (margin, margin, "left"),
        "top-right" => (sw - margin, margin, "right"),
        "top-center" => (sw / 2.0, margin, "center"),
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
    let _ = w.set_position(tauri::PhysicalPosition::new(
        monitor.position().x + (x * scale).round() as i32,
        monitor.position().y + (y * scale).round() as i32,
    ));
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
#[tauri::command]
pub fn wallpaper_sync_displays(app: AppHandle, visible: bool, main_monitor: Option<(i32, i32)>) {
    let main_origin = resolve_monitor(&app, main_monitor).map(|m| (m.position().x, m.position().y));
    // One entry per display the main window does NOT already fill.
    let extras: Vec<(i32, i32, u32, u32)> = enumerate_monitors(&app)
        .into_iter()
        .filter(|m| Some((m.x, m.y)) != main_origin)
        .map(|m| (m.x, m.y, m.width, m.height))
        .collect();
    let wanted: Vec<String> = extras
        .iter()
        .map(|(x, y, _, _)| wallpaper_display_label(*x, *y))
        .collect();

    // Tear down extras whose display has moved away or gone missing.
    let stale: Vec<tauri::WebviewWindow> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("wallpaper_") && !wanted.contains(label))
        .map(|(_, w)| w)
        .collect();
    for w in stale {
        let _ = w.close();
    }

    if visible {
        let app2 = app.clone();
        let extras = extras.clone();
        let _ = app.run_on_main_thread(move || {
            for (x, y, w, h) in extras.clone() {
                let label = wallpaper_display_label(x, y);
                if app2.get_webview_window(&label).is_some() {
                    continue;
                }
                let builder = tauri::WebviewWindowBuilder::new(
                    &app2,
                    &label,
                    tauri::WebviewUrl::App("wallpaper.html".into()),
                )
                .visible(false)
                .decorations(false)
                .transparent(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .focused(false)
                .additional_browser_args(
                    "--autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
                );
                if let Ok(win) = builder.build() {
                    let _ = win.set_size(tauri::PhysicalSize::new(w.max(1), h.max(1)));
                    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                    // The wallpaper never takes mouse input or focus.
                    let _ = win.set_ignore_cursor_events(true);
                    let _ = win.set_focusable(false);
                }
            }
            // Give fresh windows a beat to load, then show + embed them all.
            let handle = app2.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                for (x, y, w, h) in extras {
                    let label = wallpaper_display_label(x, y);
                    if let Some(win) = handle.get_webview_window(&label) {
                        let _ = win.set_size(tauri::PhysicalSize::new(w.max(1), h.max(1)));
                        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                        let _ = win.show();
                        if !wallpaper_embed_label(&handle, &label, true) {
                            // Fallback: keep it as a normal skipped-taskbar window.
                            let _ = win.show();
                        }
                    }
                }
            });
        });
    } else {
        for label in wanted {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = wallpaper_embed_label(&app, &label, false);
                let _ = win.hide();
            }
        }
    }
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

#[tauri::command]
pub fn get_system_info(state: State<'_, SysState>) -> Option<crate::monit::SystemSnapshot> {
    state.snapshot.lock().ok()?.clone()
}

// ---------------------------------------------------------------------------
// Global shortcut handler (Ctrl+Shift+, opens the settings panel)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Start with Windows
// ---------------------------------------------------------------------------

/// Enable or disable launching Aura at Windows sign-in (autostart plugin manages
/// the platform entry). Returns a message string on failure for the UI.
#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    let res = if enabled { m.enable() } else { m.disable() };
    res.map_err(|e| e.to_string())
}

/// Reflect the actual OS autostart state (what the Settings toggle shows).
#[tauri::command]
pub fn autostart_is_enabled(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Hotkeys that open the settings panel, registered statically at boot.
/// `app_shortcut_set` tears these down / re-registers them based on the
/// user's Global-shortcut configuration.
const SETTINGS_DEFAULT_COMBOS: [&str; 3] = ["ctrl+shift+,", "ctrl+shift+=", "ctrl+shift+numpadplus"];

/// The user's custom settings hotkey, as currently registered system-wide.
/// `None` = the defaults above are the active settings hotkeys.
static CUSTOM_COMBO: Mutex<Option<String>> = Mutex::new(None);

pub fn on_global_shortcut(app: &AppHandle, shortcut: &str, state: ShortcutState) {
    if state == ShortcutState::Pressed {
        // Route by exact match so a custom, alt-based settings combo
        // (e.g. alt+s) doesn't fall into the launcher branch.
        if shortcut.eq_ignore_ascii_case("alt+space") {
            toggle_start(app.clone());
        } else {
            show_settings(app);
        }
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
        let user = combo
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        if let Some(c) = user {
            let sc: Shortcut = c
                .parse()
                .map_err(|e| format!("'{c}' is not a valid shortcut ({e:?}). Include at least one modifier, e.g. Ctrl/Alt/Shift."))?;
            gs.register(sc)
                .map_err(|e| format!("Could not register {c}: {e:?}"))?;
            if let Ok(mut slot) = CUSTOM_COMBO.lock() {
                *slot = Some(c.to_string());
            }
        } else {
            for s in SETTINGS_DEFAULT_COMBOS {
                gs.register(s).
                    map_err(|e| format!("Could not register {s}: {e:?}"))?;
            }
        }
    }
    Ok(())
}

/// Whether the Start launcher module is enabled (mirrors `modules.start` on the
/// frontend). The global Alt+Space shortcut is muted when the module is off.
/// Starts false: the module ships disabled, and the launcher's webview flips
/// this on boot so Alt+Space never reveals a blank window before then.
static START_ENABLED: AtomicBool = AtomicBool::new(false);

/// Frontend-driven enable flag for the launcher module.
#[tauri::command]
pub fn start_set_enabled(enabled: bool) {
    START_ENABLED.store(enabled, Ordering::Relaxed);
}

/// Toggle the Start launcher from anywhere (global Alt+Space / tray intent).
/// Recentering on the primary display keeps the palette predictable.
#[tauri::command]
pub fn toggle_start(app: AppHandle) {
    if !START_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let Some(w) = app.get_webview_window("start") else {
        return;
    };
    if matches!(w.is_visible(), Ok(true)) {
        let _ = w.hide();
        return;
    }
    if let Ok(Some(mon)) = app.primary_monitor() {
        let msize = mon.size();
        let mpos = mon.position();
        if let Ok(win) = w.outer_size() {
            let x = mpos.x + ((msize.width as f64 - win.width as f64) / 2.0).max(0.0) as i32;
            let y = mpos.y + ((msize.height as f64 - win.height as f64) * 0.32).max(0.0) as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}
