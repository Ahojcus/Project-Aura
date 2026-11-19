#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod appbar;
mod audio;
mod bluetooth;
mod commands;
mod downloads;
mod media;
mod monit;
mod wallpaper_win;
mod clipboard;

use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

fn main() {
    let launched_at_signin = std::env::args().any(|arg| arg == "--autostart");
    let media_state = media::spawn_media_thread();
    let sys_state = monit::spawn_sys_thread();
    let clipboard_state = clipboard::spawn_clipboard_thread();
    let bluetooth_state = bluetooth::spawn_bluetooth_thread();
    let apps_state = apps::spawn_apps_thread();

    // Register shortcuts after the app is running, not during plugin
    // initialization: a combo owned by another app must not abort startup.
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            commands::on_global_shortcut(app, &shortcut.to_string(), event.state());
        })
        .build();

    tauri::Builder::default()
        .manage(media_state)
        .manage(sys_state)
        .manage(clipboard_state)
        .manage(bluetooth_state)
        .manage(apps_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(shortcut_plugin)
        .setup(move |app| {
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
            for combo in commands::SETTINGS_DEFAULT_COMBOS {
                if let Ok(shortcut) = combo.parse::<Shortcut>() {
                    if let Err(err) = app.global_shortcut().register(shortcut) {
                        eprintln!("Aura: settings shortcut {combo} unavailable: {err:?}");
                    }
                }
            }
            monit::spawn_wallpaper_pause_thread(app.handle().clone());
            monit::spawn_display_thread(app.handle().clone());
            monit::spawn_fullscreen_thread(app.handle().clone());
            position_windows(app)?;
            // Seelen UI keeps a full-width toolbar on the top edge. Its window
            // is in the same topmost band and re-raises itself, which slid it
            // over the Smart Notch and made the pill look detached from the
            // screen edge. Guard the z-order while the notch is on screen so
            // both tools can run together, and re-pin the status bar, which the
            // shell's own AppBar placement pass lifts off its edge.
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    commands::enforce_edge_geometry(&handle);
                });
            }
            create_wallpaper_extras(app)?;
            build_tray(app)?;
            spawn_startup_settle(app.handle().clone(), launched_at_signin);
            // On a sign-in launch the settings panel is shown by the settle
            // thread; a normal launch should open immediately as before.
            if !launched_at_signin {
                show_settings(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Hide to tray instead of quitting; Quit lives in the tray menu.
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
            }
            if let WindowEvent::Focused(true) = event {
                // Clicking a bottom-band module panel activates it, and Windows
                // always raises the activated window above the other apps. The
                // panels must stay clickable/selectable but never climb the
                // z-stack, so sink it straight back into its band (it keeps
                // foreground focus — typing still works — it just doesn't stay
                // drawn on top).
                commands::window_focus_restack(window.app_handle(), window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::toggle_settings,
            commands::set_module_visible,
            commands::module_set_hit_region,
            commands::window_apply,
            commands::notch_apply_layout,
            commands::statusbar_apply_layout,
            commands::module_sync_displays,
            commands::open_shortcut,
            commands::wallpaper_import,
            commands::wallpaper_delete_copy,
            commands::wallpaper_set_embedded,
            commands::wallpaper_sync_displays,
            commands::toggle_media_playback,
            commands::media_skip,
            commands::get_media_info,
            commands::get_media_art,
            commands::get_audio_sessions,
            commands::set_audio_session,
            commands::get_downloads,
            commands::cloak_apply,
            commands::edge_light_apply,
            commands::get_system_info,
            commands::wallpaper_set_pause_mode,
            commands::wallpaper_set_battery_pause,
            commands::get_power_status,
            commands::get_active_window,
            commands::get_master_volume,
            commands::get_clipboard_history,
            commands::copy_clipboard_text,
            commands::get_bluetooth_battery,
            commands::notch_chime,
            commands::autostart_set,
            commands::autostart_is_enabled,
            commands::settings_read,
            commands::settings_write,
            commands::startup_is_ready,
            commands::app_shortcut_set,
            commands::get_monitors,
            commands::get_apps,
            commands::rescan_apps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Create the per-display wallpaper webviews once, on the native setup thread.
/// They are hidden until the main wallpaper page asks to show them. Building
/// them lazily from a command was what stalled the event loop.
fn create_wallpaper_extras(app: &tauri::App) -> tauri::Result<()> {
    let Some(primary) = app.primary_monitor().ok().flatten() else {
        return Ok(());
    };
    let primary_pos = primary.position();
    for monitor in app.available_monitors().unwrap_or_default() {
        let pos = monitor.position();
        if pos.x == primary_pos.x && pos.y == primary_pos.y {
            continue;
        }
        let label = format!("wallpaper_{}_{}", pos.x, pos.y);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let builder = tauri::WebviewWindowBuilder::new(
            app.handle(),
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
        if let Ok(window) = builder.build() {
            let size = monitor.size();
            let _ = window.set_size(tauri::PhysicalSize::new(size.width.max(1), size.height.max(1)));
            let _ = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
            crate::wallpaper_win::fit_window(&window);
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.set_focusable(false);
        }
    }
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Aura", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("app icon for tray");
    let _ = TrayIconBuilder::with_id("aura-tray")
        .icon(icon)
        .tooltip("Aura")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-settings" => {
                show_settings(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_settings(tray.app_handle());
            }
        })
        .build(app);
    Ok(())
}

fn show_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// At sign-in, Explorer and the monitor topology can take a few seconds to
/// exist. Hold module reveal and the settings panel until the shell tray is up
/// and monitors are enumerable, then mark startup ready for the webviews.
fn spawn_startup_settle(app: tauri::AppHandle, autostart: bool) {
    std::thread::spawn(move || {
        if autostart {
            let deadline = std::time::Instant::now() + Duration::from_secs(12);
            loop {
                let monitors_ready = app
                    .available_monitors()
                    .map(|monitors| !monitors.is_empty())
                    .unwrap_or(false);
                #[cfg(windows)]
                let shell_ready = {
                    use windows::core::{w, PCWSTR};
                    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
                    unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).is_ok() }
                };
                #[cfg(not(windows))]
                let shell_ready = true;

                if (monitors_ready && shell_ready) || std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            // Give the shell a moment to finish applying the login DPI scale.
            std::thread::sleep(Duration::from_millis(500));
        } else {
            std::thread::sleep(Duration::from_millis(150));
        }

        commands::STARTUP_READY.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = app.emit("aura:startup-settled", ());
        let _ = app.emit("aura:displays-changed", ());
        if autostart {
            show_settings(&app);
        }
    });
}

/// Open a URL or a file/app path through the OS default handler.
pub fn open_external(target: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(target)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .or_else(|_| {
                std::process::Command::new("cmd")
                    .args(["/C", "start", "", target])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map(|_| ())
            })
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(target).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ())
    }
}

/// Position the wallpaper backdrop at startup. Module positions are restored
/// from the persisted settings store by each webview; setting native defaults
/// here races that restore and used to pull clock/todo/notch back to their
/// startup coordinates after a restart.
fn position_windows(app: &tauri::App) -> tauri::Result<()> {
    // Module windows are decoration-free, but Windows can still paint a caption
    // plaque over them; strip the caption style once at startup.
    for (label, window) in app.webview_windows() {
        if label != "settings" {
            commands::strip_caption(&window);
        }
    }
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        if let Some(ww) = app.get_webview_window("wallpaper") {
            let _ = ww.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = ww.set_position(tauri::PhysicalPosition::new(monitor.position().x, monitor.position().y));
            // Tauri sizes the *client* area, so the window frame pushes the
            // backdrop past the display edge; fit the client to the monitor.
            crate::wallpaper_win::fit_window(&ww);
            let _ = ww.set_ignore_cursor_events(true);
        }
    }
    Ok(())
}
