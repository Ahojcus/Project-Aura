use std::time::Duration;
use serde::Serialize;
use windows::core::Interface;
use windows::{
    Foundation::TimeSpan,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionMediaProperties,
    },
    Storage::Streams::{DataReader, IInputStream},
    Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED},
};

use crate::commands::MediaState;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub status: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub track_key: String,
}

#[derive(Clone, Serialize, Default)]
pub struct MediaArt {
    pub data_url: String,
}

fn span_ms(ts: TimeSpan) -> u64 {
    if ts.Duration <= 0 {
        0
    } else {
        (ts.Duration / 10_000) as u64
    }
}

fn status_of(session: &GlobalSystemMediaTransportControlsSession) -> String {
    if let Ok(info) = session.GetPlaybackInfo() {
        if let Ok(status) = info.PlaybackStatus() {
            use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as S;
            return match status {
                S::Playing => "playing".into(),
                S::Paused => "paused".into(),
                _ => "stopped".into(),
            };
        }
    }
    "stopped".into()
}

pub fn spawn_media_thread() -> MediaState {
    let state = MediaState::default();
    let state2 = state.clone();
    std::thread::Builder::new()
        .name("mon-media".into())
        .spawn(move || run_loop(state2))
        .expect("spawn media thread");
    state
}

fn run_loop(state: MediaState) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut manager: Option<GlobalSystemMediaTransportControlsSessionManager> = None;
    let mut last_art_key = String::new();
    loop {
        let r = tick(&state, &mut manager, &mut last_art_key);
        if r.is_err() {
            std::thread::sleep(Duration::from_millis(1000));
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
}

fn tick(
    state: &MediaState,
    manager: &mut Option<GlobalSystemMediaTransportControlsSessionManager>,
    last_art_key: &mut String,
) -> Result<(), Box<dyn std::error::Error>> {
    let mgr = match manager {
        Some(m) => m.clone(),
        None => {
            let m = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
            *manager = Some(m.clone());
            m
        }
    };

    let sessions = mgr.GetSessions()?;
    let count = sessions.Size()? as usize;
    if count == 0 {
        *state.info.lock().unwrap() = None;
        *state.art.lock().unwrap() = None;
        *last_art_key = String::new();
        return Ok(());
    }

    // Prefer a playing session; fall back to the first one.
    let mut chosen: Option<GlobalSystemMediaTransportControlsSession> = None;
    for i in 0..count {
        let s = sessions.GetAt(i as u32)?;
        if status_of(&s) == "playing" {
            chosen = Some(s);
            break;
        }
        if chosen.is_none() {
            chosen = Some(s);
        }
    }
    let Some(session) = chosen else {
        return Ok(());
    };

    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let status = status_of(&session);
    let timeline = session.GetTimelineProperties()?;
    let mut pos_ms = span_ms(timeline.Position()?);
    let dur_ms = span_ms(timeline.EndTime()?);
    let track_key = format!("{}||{}", title, artist);

    // SMTC position is a snapshot — players often only refresh it every few
    // seconds (or on seek), so the progress bar looked frozen between reports.
    // Extrapolate from LastUpdatedTime × elapsed wall clock so it advances
    // with the music.
    if status == "playing" {
        let elapsed_ms = timeline
            .LastUpdatedTime()
            .ok()
            .map(|lu| (now_universal_ticks() - lu.UniversalTime) / 10_000)
            .unwrap_or(0);
        if (0..30 * 60 * 1000).contains(&elapsed_ms) {
            pos_ms += elapsed_ms as u64;
        }
    }

    let info = MediaInfo {
        title,
        artist,
        status,
        position_ms: pos_ms,
        duration_ms: dur_ms,
        track_key: track_key.clone(),
    };
    *state.info.lock().unwrap() = Some(info);

    if track_key != *last_art_key {
        let art = extract_art(&props).ok();
        *state.art.lock().unwrap() = art.map(|a| (track_key.clone(), a));
        *last_art_key = track_key;
    }
    Ok(())
}

fn extract_art(
    props: &GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Result<MediaArt, Box<dyn std::error::Error>> {
    let reference = props.Thumbnail()?;
    let stream = reference.OpenReadAsync()?.get()?;
    let size = stream.Size()?.min(i32::MAX as u64) as u32;
    let reader = DataReader::CreateDataReader(&stream.cast::<IInputStream>()?)?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    if bytes.is_empty() {
        return Err("empty thumbnail".into());
    }
    let mime = if bytes[..4] == [0x89, 0x50, 0x4E, 0x47] {
        "image/png"
    } else if bytes[..3] == [0xFF, 0xD8, 0xFF] {
        "image/jpeg"
    } else if bytes[..4] == [b'R', b'I', b'F', b'F'] {
        "image/webp"
    } else {
        "image/png"
    };
    Ok(MediaArt {
        data_url: format!("data:{};base64,{}", mime, b64_encode(&bytes)),
    })
}

/// Toggle play/pause on the currently active media session.
pub fn toggle_playback() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let run = || -> Result<bool, Box<dyn std::error::Error>> {
        let mgr = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
        let mut chosen: Option<GlobalSystemMediaTransportControlsSession> = None;
        let sessions = mgr.GetSessions()?;
        for i in 0..sessions.Size()? as usize {
            let s = sessions.GetAt(i as u32)?;
            if status_of(&s) == "playing" {
                chosen = Some(s);
                break;
            }
            if chosen.is_none() {
                chosen = Some(s);
            }
        }
        let Some(session) = chosen else { return Ok(false) };
        let status = status_of(&session);
        if status == "playing" {
            session.TryPauseAsync()?.get()?;
        } else {
            session.TryPlayAsync()?.get()?;
        }
        Ok(true)
    };
    run().unwrap_or(false)
}

/// Current wall clock as 100ns ticks since 1601-01-01 — the same basis as
/// `Windows.Foundation.DateTime.UniversalTime`.
fn now_universal_ticks() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_secs_f64() + 11_644_473_600.0) * 10_000_000.0)
        .map(|s| s as i64)
        .unwrap_or(0)
}

/// Minimal threaded base64 encoder (no external crate).
fn b64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}
