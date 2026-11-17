import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getWallpaperLook,
  useModuleWindow,
  useSettings,
  type WallpaperLook,
} from "../../store/settings";
import {
  getWindowLabel,
  hasTauri,
  invoke,
  windowMonitor,
  type MediaInfo,
  type MonitorInfo,
} from "../../lib/bridge";
import { useDisplaysVersion } from "../../lib/runtime";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Build the CSS filter for one wallpaper's saved color adjustments. */
function wallpaperFilter(look: WallpaperLook) {
  const parts: string[] = [];
  const gamma = clamp(look.gamma, 0.4, 2.5);
  const saturation = clamp(look.saturation / 100, 0, 2);
  const hue = clamp(look.hue, -180, 180);

  if (Math.abs(gamma - 1) > 0.001) parts.push("url(#wallpaper-gamma)");
  if (Math.abs(saturation - 1) > 0.001) parts.push(`saturate(${saturation})`);
  if (Math.abs(hue) > 0.001) parts.push(`hue-rotate(${hue}deg)`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function WallpaperGammaFilter({ gamma }: { gamma: number }) {
  const exponent = clamp(gamma, 0.4, 2.5);
  return (
    <svg className="wallpaper-filter-defs" width="0" height="0" aria-hidden="true">
      <defs>
        <filter
          id="wallpaper-gamma"
          colorInterpolationFilters="sRGB"
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
        >
          <feComponentTransfer>
            <feFuncR type="gamma" exponent={exponent} />
            <feFuncG type="gamma" exponent={exponent} />
            <feFuncB type="gamma" exponent={exponent} />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  );
}

export function WallpaperLayer() {
  const wallpaper = useSettings((s) => s.settings.wallpaper);
  const moduleOn = useSettings((s) => s.settings.modules.wallpaper);
  const displayVersion = useDisplaysVersion();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /** Lively-style pause: set by the backend pause watcher. */
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  /** Another player (SMTC) is actually playing → duck the wallpaper audio. */
  const [mediaPlaying, setMediaPlaying] = useState(false);
  /** A hidden WebView2 window must not start a video: doing so can stall the
   *  native window thread before the wallpaper is even shown. */
  const [windowVisible, setWindowVisible] = useState(() => !document.hidden);

  useEffect(() => {
    const update = () => setWindowVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  // The window label is available synchronously. Resolving it from an async
  // import made an extra briefly run the main window's sync/embed effects.
  const encodedMonitor = windowMonitor(getWindowLabel());
  const extraKey = encodedMonitor ? `${encodedMonitor.x},${encodedMonitor.y}` : null;
  const isMain = encodedMonitor == null;
  const [selfKey, setSelfKey] = useState<string | null>(null);

  // Main window resolves its own display key (explicit monitor or primary).
  useEffect(() => {
    if (!hasTauri() || !isMain) return;
    const conf = wallpaper.win.monitor;
    if (conf) {
      setSelfKey(`${conf.x},${conf.y}`);
      return;
    }
    void invoke<MonitorInfo[]>("get_monitors").then((list) => {
      const p = list?.find((m) => m.primary) ?? list?.[0];
      setSelfKey(p ? `${p.x},${p.y}` : null);
    });
  }, [isMain, wallpaper.win.monitor]);

  // Main window keeps one wallpaper window per remaining display in sync.
  const displaysKey = JSON.stringify(wallpaper.displays ?? {});
  useEffect(() => {
    if (!hasTauri() || !isMain) return;
    void invoke("wallpaper_sync_displays", {
      visible: moduleOn,
      mainMonitor: wallpaper.win.monitor
        ? [wallpaper.win.monitor.x, wallpaper.win.monitor.y]
        : null,
    });
  }, [
    isMain,
    moduleOn,
    displaysKey,
    wallpaper.win.monitor?.x,
    wallpaper.win.monitor?.y,
    displayVersion,
  ]);

  // Moving the main wallpaper to another display must resize and re-embed it
  // immediately; the backend only does that inside set_module_visible.
  useEffect(() => {
    if (!hasTauri() || !isMain || !moduleOn) return;
    void invoke("set_module_visible", {
      label: "wallpaper",
      visible: true,
      monitor: wallpaper.win.monitor ? [wallpaper.win.monitor.x, wallpaper.win.monitor.y] : null,
    });
  }, [isMain, moduleOn, wallpaper.win.monitor?.x, wallpaper.win.monitor?.y, displayVersion]);

  // A duplicate display must show itself after its own page has mounted. The
  // main page embeds duplicates through wallpaper_sync_displays, but that can
  // run before this page has painted and leave its WebView black.
  useEffect(() => {
    if (!hasTauri() || isMain || !moduleOn) return;
    void invoke("set_module_visible", {
      label: getWindowLabel(),
      visible: true,
      monitor: encodedMonitor ? [encodedMonitor.x, encodedMonitor.y] : null,
    });
  }, [isMain, moduleOn, encodedMonitor?.x, encodedMonitor?.y, displayVersion]);

  useModuleWindow("wallpaper");

  // Forward the pause policy to the backend watcher.
  useEffect(() => {
    void invoke("wallpaper_set_pause_mode", {
      mode: { off: 0, maximized: 1, fullscreen: 2 }[wallpaper.pauseWhen] ?? 0,
    });
  }, [wallpaper.pauseWhen]);

  // Lively-style battery policy: stop animating while on battery power.
  useEffect(() => {
    void invoke("wallpaper_set_battery_pause", { enabled: wallpaper.pauseOnBattery });
  }, [wallpaper.pauseOnBattery]);

  // Subscribe to pause transitions.
  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ paused: boolean }>("aura:wallpaper-pause", (e) => {
          const p = Boolean(e.payload?.paused);
          pausedRef.current = p;
          setPaused(p);
        }),
      )
      .then((un) => {
        // Avoid leaking a listener if the layer unmounts during startup.
        if (cancelled) {
          un?.();
          return;
        }
        unlisten = un ?? null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Watch whether another media session is playing (audio duck).
  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;
    const tick = () =>
      void invoke<MediaInfo>("get_media_info").then((info) => {
        if (alive) setMediaPlaying((info?.status ?? "").toUpperCase() === "playing");
      });
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const effectiveMuted = wallpaper.muted || (wallpaper.muteWithMedia && mediaPlaying);
  const ownKey = extraKey ?? selfKey;
  const per = ownKey ? wallpaper.displays?.[ownKey] : undefined;
  const path = per ? per.path : wallpaper.path;
  const kind = per ? per.kind : wallpaper.kind;
  const look = getWallpaperLook(wallpaper.looks, path);
  const filter = wallpaperFilter(look);
  const src = useMemo(() => (path ? convertFileSrc(path) : ""), [path]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, wallpaper.volume));
    v.muted = effectiveMuted;
    v.loop = wallpaper.loop;
    v.playbackRate = Math.min(4, Math.max(0.1, wallpaper.playbackRate * look.speed));
  }, [wallpaper.volume, effectiveMuted, wallpaper.loop, wallpaper.playbackRate, look.speed, src]);

  // Kick playback imperatively: autoplay is unreliable in an embedded webview,
  // and an audible start may be refused — retry muted so the wallpaper still
  // animates instead of freezing on its first frame.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    let cancelled = false;
    const kick = () => {
      if (cancelled) return;
      v.play().catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    };
    const onLoaded = () => kick();
    const onStalled = () => {
      if (!pausedRef.current && v.paused) kick();
    };
    const onVisibility = () => {
      if (!document.hidden && !pausedRef.current) kick();
    };

    v.addEventListener("loadeddata", onLoaded);
    v.addEventListener("stalled", onStalled);
    v.addEventListener("pause", onStalled);
    document.addEventListener("visibilitychange", onVisibility);
    void (v.readyState >= 2 ? kick() : v.load());

    return () => {
      cancelled = true;
      v.removeEventListener("loadeddata", onLoaded);
      v.removeEventListener("stalled", onStalled);
      v.removeEventListener("pause", onStalled);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [src]);

  // Pause / resume with the watcher state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused) v.pause();
    else v.play().catch(() => {});
  }, [paused, src]);

  // Resume watchdog: a WebView2 video can pause itself (occlusion, GPU reset,
  // media teardown). Re-kick it unless the pause policy or a non-looping end
  // asked for the stop.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const id = window.setInterval(() => {
      if (!pausedRef.current && v.paused && !v.ended) v.play().catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [src]);

  if (!windowVisible || kind === "none" || !path) return null;

  const transform = `scale(${wallpaper.scale}) translate(${wallpaper.offsetX}%, ${wallpaper.offsetY}%)`;

  if (kind === "web") {
    return (
      <div className="wallpaper-layer">
        <WallpaperGammaFilter gamma={look.gamma} />
        <iframe
          className="wallpaper-media"
          src={path}
          title="Web wallpaper"
          allow="autoplay"
          sandbox="allow-scripts allow-presentation allow-pointer-lock"
          referrerPolicy="no-referrer"
          style={{ filter }}
        />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="wallpaper-layer">
        <WallpaperGammaFilter gamma={look.gamma} />
        <video
          ref={videoRef}
          className="wallpaper-media"
          src={src}
          style={{ transform, objectFit: wallpaper.fit, filter }}
          autoPlay
          loop={wallpaper.loop}
          playsInline
          disablePictureInPicture
        />
      </div>
    );
  }

  return (
    <div className="wallpaper-layer">
      <WallpaperGammaFilter gamma={look.gamma} />
      <img
        key={src}
        className="wallpaper-media"
        src={src}
        alt=""
        style={{ transform, objectFit: wallpaper.fit, filter }}
      />
    </div>
  );
}
