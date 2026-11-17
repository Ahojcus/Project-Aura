# Aura — functionality-only port

A modular Windows desktop overlay rebuilt from Project-Aura with the visual design
stripped out. Behaviour and system integration are kept; surfaces are plain
structural markup with a minimal reset stylesheet.

**Stack:** Tauri 2 (Rust shell, WebView2) + React 18 + TypeScript + Vite 5 + Zustand.

## Modules

| Window label | Entry | Functionality |
| --- | --- | --- |
| `settings` | `index.html` | Editor for every module; tray icon / `Ctrl+Shift+,` |
| `wallpaper` | `wallpaper.html` | Image, video and webpage wallpapers embedded behind desktop icons; library, per-display overrides, fit/scale/offset, playback rate, volume, audio duck, pause when an app is maximized/fullscreen or on battery, resume watchdog, live monitor hotplug |
| `clock` | `clock.html` | Digital / analog / minimal text, 12h/24h, timezone, date, seconds |
| `notch` | `notch.html` | Smart notch: run launcher, media session, CPU/RAM/network monitors, focus timer, Bluetooth battery, clipboard history, quick shortcuts; layout, placement, size, collapsed chips that deep-link into panels, keep-open while typing, fullscreen auto-hide |
| `todo` | `todo.html` | Tasks with categories, priorities, due dates, inline editing, all/open/done filters, search, sorting, clear-done; persisted locally |
| `statusbar` | `statusbar.html` | Edge status bar: CPU / RAM / network / battery / active-window / media / clock chips, top or bottom, height and inset, fullscreen auto-hide, hotplug-aware geometry |

Intentionally not carried over: the Alt+Space start launcher, animated notch
effects, glass/blur surfaces, shadows, gradients and decorative transitions.

## Run

```bash
npm install
npm run tauri dev     # requires the Rust toolchain
```

## Checks

```bash
npm run check   # TypeScript (tsc --noEmit)
npm run build   # Vite multi-page bundle -> dist/
cargo check     # inside src-tauri/
```

## Layout

- `src/modules/<name>/` — one component tree per module.
- `src/store/settings.ts` — central settings store, persisted in localStorage and
  broadcast to all windows via the `aura:settings` event.
- `src/store/todo.ts` — task store, persisted locally.
- `src/lib/bridge.ts` — typed Tauri command bridge with browser fallbacks.
- `src-tauri/src/` — native work only: SMTC media polling, sysinfo polling,
  clipboard/Bluetooth history, Start-Menu scanning, WorkerW wallpaper embedding
  and window geometry.
