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
