//! Per-application volume sessions for the Smart Notch volume mixer.
//!
//! Windows exposes each app's audio stream through the Core Audio session
//! manager. The manager itself is cheap to activate, so the notch polls it on
//! demand and only holds COM objects for the duration of one command.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2,
    IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionInfo {
    pub id: String,
    pub name: String,
    pub process: String,
    pub volume: f32,
    pub muted: bool,
    pub active: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterVolume {
    pub volume: f32,
    pub muted: bool,
}

fn init_com() {
    // Tauri commands already run on threads with COM initialized in some
    // builds. RPC_E_CHANGED_MODE is safe to ignore: COM is still available.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn process_label(pid: u32) -> (String, String) {
    if pid == 0 {
        return ("System sounds".into(), String::new());
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return (format!("Process {pid}"), String::new());
        };
        let mut buffer = vec![0u16; 2048];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return (format!("Process {pid}"), String::new());
        }
        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        let name = Path::new(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|stem| {
                let mut chars = stem.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => "Application".into(),
                }
            })
            .unwrap_or_else(|| format!("Process {pid}"));
        (name, path)
    }
}

fn with_sessions<T>(run: impl FnOnce(&IAudioSessionManager2) -> Result<T, String>) -> Result<T, String> {
    init_com();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;
        run(&manager)
    }
}

/// Master output volume and mute state for the default playback device.
pub fn master_volume() -> Option<MasterVolume> {
    init_com();
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        let volume = endpoint.GetMasterVolumeLevelScalar().ok()?;
        let muted = endpoint.GetMute().map(|value| value.as_bool()).unwrap_or(false);
        Some(MasterVolume {
            volume: volume.clamp(0.0, 1.0),
            muted,
        })
    }
}

/// Snapshot every unexpired audio session on the default playback device.
pub fn list_sessions() -> Vec<AudioSessionInfo> {
    let result = with_sessions(|manager| unsafe {
        let sessions = manager.GetSessionEnumerator().map_err(|e| e.to_string())?;
        let count = sessions.GetCount().map_err(|e| e.to_string())?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for index in 0..count {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let state = control2.GetState().unwrap_or(AudioSessionStateExpired);
            if state == AudioSessionStateExpired {
                continue;
            }
            let identifier = control2
                .GetSessionIdentifier()
                .ok()
                .and_then(|value| value.to_string().ok())
                .unwrap_or_default();
            let pid = control2.GetProcessId().unwrap_or(0);
            let id = if identifier.is_empty() {
                format!("pid:{pid}")
            } else {
                identifier
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            let (name, process) = process_label(pid);
            let display = control2
                .GetDisplayName()
                .ok()
                .and_then(|value| value.to_string().ok())
                .unwrap_or_default();
            let simple: ISimpleAudioVolume = match control.cast() {
                Ok(simple) => simple,
                Err(_) => continue,
            };
            let volume = simple.GetMasterVolume().unwrap_or(0.0);
            let muted = simple.GetMute().map(|value| value.as_bool()).unwrap_or(false);
            let friendly = if name.eq_ignore_ascii_case("audiosrv")
                || display.to_lowercase().contains("audiosrv.dll")
            {
                "System sounds".to_string()
            } else {
                name
            };
            // Some system sessions expose a resource string ("@%SystemRoot%…")
            // as their display name; prefer the process name in that case.
            let display = if display.starts_with('@') || display.trim().is_empty() {
                friendly
            } else {
                display
            };
            out.push(AudioSessionInfo {
                id,
                name: display,
                process,
                volume: volume.clamp(0.0, 1.0),
                muted,
                active: state == AudioSessionStateActive,
            });
        }
        Ok(out)
    });
    let mut list = result.unwrap_or_default();
    list.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    list
}

/// Change one session's volume and/or mute state. A null value leaves that
/// property untouched, so a mute click never snaps the slider back.
pub fn set_session(id: &str, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    with_sessions(|manager| unsafe {
        let sessions = manager.GetSessionEnumerator().map_err(|e| e.to_string())?;
        let count = sessions.GetCount().map_err(|e| e.to_string())?;
        for index in 0..count {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let identifier = control2
                .GetSessionIdentifier()
                .ok()
                .and_then(|value| value.to_string().ok())
                .unwrap_or_default();
            let pid = control2.GetProcessId().unwrap_or(0);
            let candidate = if identifier.is_empty() {
                format!("pid:{pid}")
            } else {
                identifier
            };
            if candidate != id {
                continue;
            }
            let simple: ISimpleAudioVolume = control.cast().map_err(|e| e.to_string())?;
            if let Some(value) = volume {
                simple
                    .SetMasterVolume(value.clamp(0.0, 1.0), std::ptr::null())
                    .map_err(|e| e.to_string())?;
            }
            if let Some(value) = muted {
                simple
                    .SetMute(BOOL(if value { 1 } else { 0 }), std::ptr::null())
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        Err("That audio session is no longer available.".into())
    })
}
