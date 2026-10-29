import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings, useModuleWindow, hasTauri } from "../../store/settings";

/** Display info mirrored from the Rust `get_monitors` command. */
interface Mon {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export function WallpaperLayer() {
  const wallpaper = useSettings((s) => s.settings.wallpaper);
  const wallpaperModuleOn = useSettings((s) => s.settings.modules.wallpaper);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /** This webview's display key ("<x>,<y>") when it is a per-display extra. */
  const [extraKey, setExtraKey] = useState<string | null>(null);
  /** Main window when true — it owns the sync of per-display extras. */
  const [isMain, setIsMain] = useState(true);
  /** This window's display key — for extras from the label, for the main
   *  window from its configured display (primary when unset). */
  const [selfKey, setSelfKey] = useState<string | null>(null);

  // Identify which display THIS window covers (alias: dynamic import keeps the
  // plain-browser preview working).
  useEffect(() => {
    if (!hasTauri()) return;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) => {
        const label = getCurrentWebviewWindow().label;
        if (label.startsWith("wallpaper_")) {
          // "wallpaper_<x>_<y>" — global origin of the display this extra fills.
          const parts = label.slice("wallpaper_".length).split("_");
          const x = Number(parts[0]);
          const y = Number(parts[1]);
          if (Number.isFinite(x) && Number.isFinite(y) && parts.length === 2) {
            setExtraKey(`${x},${y}`);
            setIsMain(false);
            setSelfKey(`${x},${y}`);
            return;
          }
        }
        setIsMain(true);
      })
      .catch(() => {});
  }, []);

  // Main window: resolve its own display key (explicit monitor or primary).
  useEffect(() => {
    if (!hasTauri() || !isMain) return;
    const conf = wallpaper.win.monitor as { x: number; y: number } | null;
    if (conf) {
      setSelfKey(`${conf.x},${conf.y}`);
      return;
    }
    void invoke<Mon[]>("get_monitors")
      .then((list) => {
        const p = list.find((m) => m.primary) ?? list[0];
        setSelfKey(p ? `${p.x},${p.y}` : null);
      })
      .catch(() => {});
  }, [isMain, wallpaper.win.monitor]);

  // Main window: keep the per-display wallpaper windows in sync — create or
  // show them for every display, hide torn-down extras (the module switch is
  // the master visibility gate, same as the main wallpaper window).
  const displaysKey = JSON.stringify(wallpaper.displays ?? {});
  useEffect(() => {
    if (!hasTauri() || !isMain) return;
    void invoke("wallpaper_sync_displays", {
      visible: wallpaperModuleOn,
      mainMonitor: wallpaper.win.monitor ?? null,
    }).catch(() => {});
  }, [isMain, wallpaperModuleOn, displaysKey, wallpaper.win.monitor]);

  // Layer level (bottommost = embedded behind desktop icons, normal, topmost)
  // and click-through. Extras run this too, but the command is addressed by the
  // fixed "wallpaper" label, so only the main window is actually updated —
  // per-display extras are configured by Rust at creation.
  useModuleWindow("wallpaper");

  /** The wallpaper assigned to THIS display: a per-display override if there
   *  is one, otherwise the main wallpaper. */
  const ownKey = extraKey ?? selfKey;
  const per = ownKey ? wallpaper.displays?.[ownKey] : undefined;
  const path = per ? per.path : wallpaper.path;
  const kind = per ? per.kind : wallpaper.kind;
  const src = useMemo(
    () => (path ? convertFileSrc(path) : ""),
    [path],
  );

  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = Math.min(1, Math.max(0, wallpaper.volume));
      v.muted = wallpaper.muted;
      v.playbackRate = Math.min(4, Math.max(0.1, wallpaper.playbackRate));
    }
  }, [wallpaper.volume, wallpaper.muted, wallpaper.playbackRate, src]);

  // Kick the video whenever its source or relevant settings change. An
  // `autoPlay` attribute alone is unreliable: the embedded window can free its
  // play() promise (WebView2 blocked autoplay while audible, or Chromium
  // paused/never started it), which left the wallpaper frozen on the first
  // frame. Play imperatively; if an audible start is refused, retry muted so
  // the wallpaper still animates.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    let cancelled = false;
    const kick = () => {
      if (cancelled) return;
      v.play().catch(() => {
        // Autoplay with sound refused → animate silently instead of freezing.
        v.muted = true;
        v.play().catch(() => { /* give up until the next kick */ });
      });
    };

    const onLoaded = () => kick();
    const onStalled = () => { if (v.paused) kick(); };
    const onVisibility = () => { if (!document.hidden) kick(); };

    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("stalled", onStalled);
    v.addEventListener("pause", onStalled);
    document.addEventListener("visibilitychange", onVisibility);
    // The element may already be ready when this effect runs (hot reload etc.).
    void (v.readyState >= 2 ? kick() : v.load());

    return () => {
      cancelled = true;
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("stalled", onStalled);
      v.removeEventListener("pause", onStalled);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [src]);

  if (kind === "none" || !path || !src) {
    return null;
  }

  const transform = `scale(${wallpaper.scale}) translate(${wallpaper.offsetX}%, ${wallpaper.offsetY}%)`;

  if (kind === "video") {
    return (
      <div className="wallpaper-layer">
        <video
          ref={videoRef}
          className="wallpaper-media"
          src={src}
          style={{ transform, objectFit: wallpaper.fit === "fill" ? "fill" : wallpaper.fit }}
          autoPlay
          loop
          playsInline
          disablePictureInPicture
        />
        {wallpaper.dimmer > 0 && <div className="wallpaper-dim" style={{ opacity: wallpaper.dimmer / 100 }} />}
      </div>
    );
  }

  return (
    <div className="wallpaper-layer">
      <img
        key={src}
        className="wallpaper-media"
        src={src}
        alt=""
        style={{ transform, objectFit: wallpaper.fit === "fill" ? "fill" : wallpaper.fit }}
      />
      {wallpaper.dimmer > 0 && <div className="wallpaper-dim" style={{ opacity: wallpaper.dimmer / 100 }} />}
    </div>
  );
}
