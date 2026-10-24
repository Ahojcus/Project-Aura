# AGENTS.md — Aura Desktop

Build guidelines, system dependencies and modularity rules for the **Aura** desktop overlay
app (wallpaper engine, desktop clock, to-do widget, smart notch, centralized settings).

## What this project is

A lightweight, modular Windows-first desktop companion built with **Tauri 2** (Rust shell +
WebView2) and a **React 18 + TypeScript + Vite 5 + Zustand 4** frontend. Five independent
windows share one frontend codebase via multi-page entries:

| Window label | HTML entry | Role |
|--------------|------------|------|
| `settings`   | `index.html`      | Main settings panel (tray icon / `Ctrl+Shift+,`) |
| `wallpaper`  | `wallpaper.html`  | Fullscreen image/video layer, embedded behind desktop icons |
| `notch`      | `notch.html`      | Dynamic-island style top bar (media, monitors, shortcuts) |
| `clock`      | `clock.html`      | Floating clock widget |
| `todo`       | `todo.html`       | Floating to-do widget |

## System dependencies

- **Node.js ≥ 18** (frontend toolchain; Node 18 is a hard requirement because Vite 5 supports it)
- **Rust stable ≥ 1.77** (Tauri 2) — `cargo` from [rustup](https://rustup.rs)
- **Windows ≥ 10 1809**: WebView2 runtime (installed with Windows 11, or evergreen install);
  Windows version matters for the SMTC media integration and the WorkerW wallpaper embedding.
- Linux/macOS: the Rust shell compiles, but the media (SMTC) and wallpaper-embedding
  features are Windows-only and degrade gracefully (no-ops).

## Build & run

```bash
npm install          # install frontend deps
npm run check        # TypeScript: tsc --noEmit (strict)
npm run build        # Vite multi-page production build -> dist/
npm run dev          # Vite dev server on 5173 (used by `tauri dev`)

cargo check          # in src-tauri/ — validate the Rust side without linking
npm run tauri dev    # full app: dev server + native window shell
npm run tauri build  # release bundle + installer
python tools/gen_icons.py   # regenerate src-tauri/icons (pure stdlib, no deps)
```

Verification bar: `npm run check`, `npm run build` and `cargo check` must all pass before
any change is considered done. Feature-level behavior (overlay windows, embedding behind
desktop icons, media session data) should additionally be verified by launching the app.

## Modularity rules (non-negotiable)

1. **One module, one directory** under `src/modules/<name>/`. A module owns its components,
   its CSS and its store helpers. Never reach from one module into another's internals.
2. **Cross-module communication happens only through**:
   - the central settings store (`src/store/settings.ts`), persisted as JSON in
     localStorage and broadcast via the `aura:settings` Tauri event (see `src/lib/sync.ts`);
   - Tauri commands/events registered in `src-tauri/src/commands.rs`.
3. **Adding a module:**
   1. create `src/modules/<name>/` and an HTML entry + `src/boot/<name>.tsx`;
   2. add a `ModuleKey` to `src/store/settings.ts` (defaults + window label);
   3. add the window to `src-tauri/tauri.conf.json` (`app.windows`, label = module key,
      `visible: false` — the window reveals *itself* on boot if the module is enabled
      via `set_module_visible`);
   4. list the label in `src-tauri/capabilities/default.json`;
   5. add a section/toggle in `src/modules/settings/SettingsApp.tsx`.
4. **Backend boundaries:** system/media/platform work lives in Rust
   (`src-tauri/src/media.rs` SMTC polling, `src-tauri/src/monit.rs` CPU/RAM/net polling,
   `src-tauri/src/wallpaper_win.rs` WorkerW embedding). Frontend only consumes
   JSON-returning commands — never reads files or polls the OS itself.
5. **Performance rules:** background polling threads write into shared state and IPC
   commands just read snapshots (1s media / 1.5s sysmon cadence). Keep idle costs flat:
   module windows are created hidden, shown on demand, and hidden (not destroyed) when
   a module is disabled. Prefer CSS transitions over JS animation loops.

## Configuration notes

- Tauri features: `tray-icon` + `protocol-asset` (required by the enabled asset protocol).
- Asset protocol scope is `**` (any local path) — wallpaper files are served through
  `convertFileSrc()`. Tighten the scope if wider access is not required.
- The settings window hides to tray on close; quitting happens via tray → Quit.
- Every window is created hidden except `settings`; showing is handled by
  `set_module_visible(label, visible=)` (also embeds the wallpaper WorkerW and repositions
  notch/clock/todo from the primary monitor).
