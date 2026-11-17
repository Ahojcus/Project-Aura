use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant};
use serde::Serialize;
use sysinfo::{Components, Disks, Networks, System};
use tauri::{AppHandle, Emitter};

/// Wallpaper pause policy, set from Settings (“Pause wallpaper”):
/// 0 = never pause, 1 = pause when a maximized app is in front,
/// 2 = pause only when a fullscreen app (game/video player) is in front.
static WALLPAPER_PAUSE_MODE: AtomicU8 = AtomicU8::new(0);
/// Last pause state that was broadcast — only transitions are emitted.
static WALLPAPER_PAUSED: AtomicBool = AtomicBool::new(false);
/// Lively-style “pause on battery” toggle (laptops/UPS).
static PAUSE_ON_BATTERY: AtomicBool = AtomicBool::new(false);

/// Enable/disable pausing the wallpaper while the machine runs on battery.
pub fn set_battery_pause(enabled: bool) {
    PAUSE_ON_BATTERY.store(enabled, Ordering::Relaxed);
}

pub fn set_wallpaper_pause_mode(mode: u8) {
    // Do not clear WALLPAPER_PAUSED here: the watcher must observe the
    // true -> false transition and emit it. Clearing it early suppressed the
    // resume event, leaving a paused wallpaper frozen after disabling pause.
    WALLPAPER_PAUSE_MODE.store(mode.min(2), Ordering::Relaxed);
}


#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub cpu_percent: f32,
    pub mem_used_gb: f64,
    pub mem_total_gb: f64,
    pub net_down_bps: f64,
    pub net_up_bps: f64,
    pub disk_used_gb: f64,
    pub disk_total_gb: f64,
    pub cpu_temp_c: Option<f32>,
    pub uptime_secs: u64,
}

/// Usage of the Windows system drive, falling back to the first fixed disk.
fn system_disk_usage(disks: &Disks) -> (f64, f64) {
    let system_drive = std::env::var("SystemDrive")
        .ok()
        .map(|drive| drive.to_ascii_lowercase());
    let selected = system_drive
        .as_deref()
        .and_then(|drive| {
            disks.iter().find(|disk| {
                disk.mount_point()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with(drive)
            })
        })
        .or_else(|| disks.iter().find(|disk| disk.total_space() > 0));
    let Some(disk) = selected else {
        return (0.0, 0.0);
    };
    let total = disk.total_space();
    let used = total.saturating_sub(disk.available_space());
    (
        used as f64 / 1_073_741_824.0,
        total as f64 / 1_073_741_824.0,
    )
}

/// Prefer a CPU/package sensor; otherwise use the hottest available sensor.
fn cpu_temperature(components: &Components) -> Option<f32> {
    let mut preferred: Option<f32> = None;
    let mut hottest: Option<f32> = None;
    for component in components.iter() {
        let Some(temperature) = component.temperature() else {
            continue;
        };
        hottest = Some(hottest.map_or(temperature, |current| current.max(temperature)));
        let label = component.label().to_ascii_lowercase();
        if label.contains("cpu") || label.contains("package") || label.contains("core") {
            preferred = Some(preferred.map_or(temperature, |current| current.max(temperature)));
        }
    }
    preferred.or(hottest)
}

pub fn spawn_sys_thread() -> crate::commands::SysState {
    let state = crate::commands::SysState::default();
    let state2 = crate::commands::SysState {
        snapshot: state.snapshot.clone(),
    };
    std::thread::Builder::new()
        .name("mon-sys".into())
        .spawn(move || run_loop(state2))
        .expect("spawn sysmon thread");
    state
}

fn run_loop(state: crate::commands::SysState) {
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    let mut nets = Networks::new_with_refreshed_list();
    nets.refresh(false);
    let mut disks = Disks::new_with_refreshed_list();
    let mut components = Components::new_with_refreshed_list();
    let mut prev: Option<(Instant, u64, u64)> = None;

    loop {
        sys.refresh_memory();
        sys.refresh_cpu_usage();
        nets.refresh(false);
        disks.refresh(true);
        components.refresh(true);

        let mut rx_total: u64 = 0;
        let mut tx_total: u64 = 0;
        for (_name, data) in nets.iter() {
            rx_total = rx_total.saturating_add(data.total_received());
            tx_total = tx_total.saturating_add(data.total_transmitted());
        }
        let now = Instant::now();
        let (down, up) = if let Some((t, rx0, tx0)) = prev {
            let secs = now.duration_since(t).as_secs_f64().max(1e-3);
            (
                (rx_total.saturating_sub(rx0)) as f64 / secs,
                (tx_total.saturating_sub(tx0)) as f64 / secs,
            )
        } else {
            (0.0, 0.0)
        };
        prev = Some((now, rx_total, tx_total));

        let cpu_percent = sys.global_cpu_usage();
        let mem_used = sys.used_memory() as f64 / 1_073_741_824.0;
        let mem_total = sys.total_memory() as f64 / 1_073_741_824.0;
        let (disk_used, disk_total) = system_disk_usage(&disks);
        *state.snapshot.lock().unwrap() = Some(SystemSnapshot {
            cpu_percent,
            mem_used_gb: mem_used,
            mem_total_gb: mem_total,
            net_down_bps: down,
            net_up_bps: up,
            disk_used_gb: disk_used,
            disk_total_gb: disk_total,
            cpu_temp_c: cpu_temperature(&components),
            uptime_secs: System::uptime(),
        });

        std::thread::sleep(Duration::from_millis(1500));
    }
}

// ---------------------------------------------------------------------------
// Lively-style pause watcher: suspend the animated wallpaper while a maximized
// or fullscreen app is in front, so it never steals CPU/GPU from what the user
// is actually doing. The watcher scans the foreground window every 1.5 s
// (same cadence as the system monitor) and broadcasts transitions to the
// wallpaper webviews as an `aura:wallpaper-pause` event.
// ---------------------------------------------------------------------------

pub fn spawn_wallpaper_pause_thread(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("wallpaper-pause".into())
        .spawn(move || pause_loop(app))
        .expect("spawn wallpaper pause thread");
}

fn pause_loop(app: tauri::AppHandle) {
    loop {
        let mode = WALLPAPER_PAUSE_MODE.load(Ordering::Relaxed);
        let battery = PAUSE_ON_BATTERY.load(Ordering::Relaxed) && on_battery();
        let detected = battery || (mode != 0 && foreground_covers_screen(mode));
        let prev = WALLPAPER_PAUSED.swap(detected, Ordering::Relaxed);
        if prev != detected {
            use tauri::Emitter;
            let _ = app.emit("aura:wallpaper-pause", serde_json::json!({ "paused": detected }));
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
}

/// Foreground app window, ignoring Aura overlays, the desktop shell and
/// minimized windows.
#[cfg(windows)]
fn foreground_app_window() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
    };

    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg.is_invalid() {
            return None;
        }
        // Our own overlay windows (e.g. the wallpaper itself, which covers a
        // whole monitor fullscreen) must never trigger the pause.
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == std::process::id() {
            return None;
        }
        // The desktop shell “covers” monitors too — exclude it and the taskbar.
        let mut buf = [0u16; 64];
        let n = GetClassNameW(fg, &mut buf);
        if n > 0 {
            let cls = String::from_utf16_lossy(&buf[..n as usize]);
            if matches!(
                cls.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "ExploreWClass"
            ) {
                return None;
            }
        }
        if IsIconic(fg).as_bool() {
            return None;
        }
        Some(fg)
    }
}

/// Monitor origin and primary flag when `hwnd` paints its entire monitor.
#[cfg(windows)]
fn fullscreen_monitor_of(hwnd: windows::Win32::Foundation::HWND) -> Option<((i32, i32), bool)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        // “Fullscreen” = the foreground window paints its entire monitor.
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO::default();
        info.cbSize = core::mem::size_of::<MONITORINFO>() as u32;
        if !GetMonitorInfoW(mon, &mut info).as_bool() || rect != info.rcMonitor {
            return None;
        }
        // MONITORINFOF_PRIMARY is 1; use the origin returned by the OS so a
        // notch on a secondary screen can be compared with this monitor.
        let primary = (info.dwFlags & 1) != 0;
        Some(((info.rcMonitor.left, info.rcMonitor.top), primary))
    }
}

#[cfg(windows)]
fn foreground_fullscreen_target() -> Option<((i32, i32), bool)> {
    fullscreen_monitor_of(foreground_app_window()?)
}

/// True when the window currently in front qualifies for the pause policy.
#[cfg(windows)]
fn front_app_wants_pause(mode: u8) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsZoomed;

    let Some(fg) = foreground_app_window() else {
        return false;
    };
    if fullscreen_monitor_of(fg).is_some() {
        return true;
    }
    // Maximized foreground app (mode 1): a zoomed window IS the pause trigger
    // regardless of which monitor holds it.
    mode == 1 && unsafe { IsZoomed(fg).as_bool() }
}

/// Foreground-window check that also compiles on non-Windows targets.
fn foreground_covers_screen(mode: u8) -> bool {
    #[cfg(windows)]
    {
        front_app_wants_pause(mode)
    }
    #[cfg(not(windows))]
    {
        let _ = mode;
        false
    }
}

#[cfg(not(windows))]
fn foreground_fullscreen_target() -> Option<((i32, i32), bool)> {
    None
}

// ---------------------------------------------------------------------------
// Battery / foreground window / fullscreen / display hotplug
//
// These are the YASB- and Lively-style signals the shell cannot get from the
// webview: battery state, the foreground app, a fullscreen transition and a
// monitor topology change.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub percent: Option<u8>,
    pub charging: bool,
    pub has_battery: bool,
}

/// Battery charge and AC state (AC-only desktops report `has_battery: false`).
pub fn power_status() -> PowerStatus {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            let flag = status.BatteryFlag;
            let has_battery = flag != 128 && flag != 255;
            let charging = status.ACLineStatus == 1;
            let percent = if status.BatteryLifePercent <= 100 {
                Some(status.BatteryLifePercent)
            } else {
                None
            };
            return PowerStatus {
                percent: if has_battery { percent } else { None },
                charging,
                has_battery,
            };
        }
    }
    PowerStatus::default()
}

/// True while the machine is drawing power from the battery.
fn on_battery() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            return status.ACLineStatus == 0;
        }
    }
    false
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowInfo {
    pub title: String,
    pub class_name: String,
}

/// Title and window class of the foreground window (YASB active-window chip).
pub fn active_window_info() -> ActiveWindowInfo {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetForegroundWindow, GetWindowTextW,
        };
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return ActiveWindowInfo::default();
        }
        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf).max(0) as usize;
        let mut class_buf = [0u16; 128];
        let class_len = GetClassNameW(hwnd, &mut class_buf).max(0) as usize;
        return ActiveWindowInfo {
            title: String::from_utf16_lossy(&title_buf[..title_len]),
            class_name: String::from_utf16_lossy(&class_buf[..class_len]),
        };
    }
    #[cfg(not(windows))]
    ActiveWindowInfo::default()
}

/// Emit `aura:displays-changed` whenever the monitor topology changes.
/// Monitors enumerate late at boot and on DisplayPort hotplug, so geometry
/// restored before the display appears would otherwise stay stale.
pub fn spawn_display_thread(app: AppHandle) {
    std::thread::Builder::new()
        .name("display-watch".into())
        .spawn(move || {
            let signature = |app: &AppHandle| -> String {
                let mut list: Vec<String> = app
                    .available_monitors()
                    .unwrap_or_default()
                    .iter()
                    .map(|m| {
                        let size = m.size();
                        let pos = m.position();
                        format!(
                            "{}x{}+{}+{}@{}",
                            size.width,
                            size.height,
                            pos.x,
                            pos.y,
                            m.scale_factor()
                        )
                    })
                    .collect();
                list.sort();
                list.join("|")
            };
            let mut last = signature(&app);
            loop {
                std::thread::sleep(Duration::from_secs(3));
                let now = signature(&app);
                if now != last {
                    last = now;
                    let _ = app.emit("aura:displays-changed", serde_json::json!({}));
                }
            }
        })
        .expect("spawn display watch thread");
}

/// Emit `aura:fullscreen-changed` when a fullscreen foreground app takes over
/// a monitor. The payload names that monitor so only overlays on the affected
/// display hide; overlays on another monitor stay visible.
pub fn spawn_fullscreen_thread(app: AppHandle) {
    std::thread::Builder::new()
        .name("fullscreen-watch".into())
        .spawn(move || {
            let mut last: Option<Option<((i32, i32), bool)>> = None;
            loop {
                let now = foreground_fullscreen_target();
                if last != Some(now) {
                    last = Some(now);
                    let (fullscreen, monitor, primary) = match now {
                        Some(((x, y), primary)) => (true, Some([x, y]), primary),
                        None => (false, None, false),
                    };
                    let _ = app.emit(
                        "aura:fullscreen-changed",
                        serde_json::json!({
                            "fullscreen": fullscreen,
                            "monitor": monitor,
                            "primary": primary,
                        }),
                    );
                }
                std::thread::sleep(Duration::from_millis(1500));
            }
        })
        .expect("spawn fullscreen watch thread");
}
