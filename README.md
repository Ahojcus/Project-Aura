# Aura Desktop

A lightweight, modular desktop overlay for Windows — dynamic-island-style smart notch,
desktop clock, to-do widget, and a wallpaper engine that renders images and videos behind
your desktop icons — all managed from one sleek settings panel.

Built with **Tauri 2** (native WebView2 shell, minimal memory footprint) + React +
TypeScript + Zustand. See [AGENTS.md](AGENTS.md) for architecture and build details.

## Quick start

```bash
npm install
npm run tauri dev     # requires Rust toolchain (rustup)
```

Global shortcut `Ctrl+Shift+,` opens the settings panel anywhere; the tray icon shows it
on left-click with a Quit menu on right-click.

## Modules

- **Wallpaper Engine** — static images (PNG/JPG/WEBP/GIF) and videos (MP4/WEBM),
  hardware-accelerated, with scaling, positioning, fill modes, playback speed and volume.
  Embeds behind your desktop icons on Windows (WorkerW/Progman).
- **Clock** — digital / analog / minimal-text layouts, 12h/24h, timezone selection, date.
- **Smart Notch** — floating top bar that expands on hover: system media session
  (Spotify and any Windows player: title, artist, album art, progress, play/pause),
  CPU / RAM / network monitors, and quick app/URL shortcuts.
- **To-Do** — categories, priority tags, due dates; persisted as local JSON.
- **Settings** — sidebar navigation (General, Appearance, Wallpaper, Smart Notch,
  Shortcuts, To-Do). Every change applies live across all windows — no restart.

Modules you disable stay hidden so idle memory stays flat.

## Checks

```bash
npm run check   # TypeScript
npm run build   # front-end bundle
cargo check     # Rust shell (run inside src-tauri/)
```
