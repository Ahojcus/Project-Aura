import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef } from "react";
import { useSettings, useModuleWindow } from "../../store/settings";

export function WallpaperLayer() {
  const wallpaper = useSettings((s) => s.settings.wallpaper);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Layer level (bottommost = embedded behind desktop icons, normal, topmost)
  // and click-through — no text style applies to the wallpaper.
  useModuleWindow("wallpaper");

  const src = useMemo(
    () => (wallpaper.path ? convertFileSrc(wallpaper.path) : ""),
    [wallpaper.path],
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

  if (wallpaper.kind === "none" || !wallpaper.path || !src) {
    return null;
  }

  const transform = `scale(${wallpaper.scale}) translate(${wallpaper.offsetX}%, ${wallpaper.offsetY}%)`;

  if (wallpaper.kind === "video") {
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
