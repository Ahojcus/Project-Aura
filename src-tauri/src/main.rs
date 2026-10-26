#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod bluetooth;
mod commands;
mod media;
mod monit;
mod wallpaper_win;
mod clipboard;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

fn main() {
    let media_state = media::spawn_media_thread();
    let sys_state = monit::spawn_sys_thread();
    let clipboard_state = clipboard::spawn_clipboard_thread();
    let bluetooth_state = bluetooth::spawn_bluetooth_thread();
    let apps_state = apps::spawn_apps_thread();

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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+shift+,", "ctrl+shift+=", "ctrl+shift+numpadplus", "alt+space"])
                .expect("failed to register global shortcut")
                .with_handler(|app, shortcut, event| {
                    commands::on_global_shortcut(app, &shortcut.to_string(), event.state());
                })
                .build(),
        )
        .setup(|app| {
            position_windows(app)?;
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Hide to tray instead of quitting; Quit lives in the tray menu.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::toggle_settings,
            commands::set_module_visible,
            commands::window_apply,
            commands::notch_apply_layout,
            commands::open_shortcut,
            commands::wallpaper_import,
            commands::wallpaper_delete_copy,
            commands::wallpaper_set_embedded,
            commands::toggle_media_playback,
            commands::get_media_info,
            commands::get_media_art,
            commands::get_system_info,
            commands::get_clipboard_history,
            commands::copy_clipboard_text,
            commands::get_bluetooth_battery,
            commands::notch_chime,
            commands::autostart_set,
            commands::autostart_is_enabled,
            commands::get_monitors,
            commands::get_apps,
            commands::rescan_apps,
            commands::start_set_enabled,
            commands::toggle_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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

/// Position the overlay windows on the primary display at startup.
fn position_windows(app: &tauri::App) -> tauri::Result<()> {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let (w, h) = (size.width as f64, size.height as f64);
        let scale = monitor.scale_factor() as f64;

        if let Some(wn) = app.get_webview_window("notch") {
            let notch_w = (240.0 * scale) as i32;
            let _ = wn.set_position(tauri::PhysicalPosition::new(((w - notch_w as f64) / 2.0) as i32, 0));
        }
        if let Some(ww) = app.get_webview_window("wallpaper") {
            let _ = ww.set_size(tauri::PhysicalSize::new(size.width, size.height));
            let _ = ww.set_position(tauri::PhysicalPosition::new(monitor.position().x, monitor.position().y));
            let _ = ww.set_ignore_cursor_events(true);
        }
        if let Some(wc) = app.get_webview_window("clock") {
            let x = (w - 340.0 * scale - 48.0 * scale).max(0.0) as i32;
            let _ = wc.set_position(tauri::PhysicalPosition::new(x, (40.0 * scale) as i32));
        }
        if let Some(wt) = app.get_webview_window("todo") {
            let y = (h - 520.0 * scale - 40.0 * scale).max(0.0) as i32;
            let _ = wt.set_position(tauri::PhysicalPosition::new((40.0 * scale) as i32, y));
        }
    }
    Ok(())
}
