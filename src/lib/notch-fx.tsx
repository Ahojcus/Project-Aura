/**
 * NotchFxBackdrop — the animated background "scene" of the Smart Notch, also
 * reused by Settings → Smart Notch → Background effect tile previews.
 *
 * Pure markup + CSS animations (see src/styles/notch-fx.css): every layer is
 * driven by CSS keyframes on transform/opacity, so there are no JS animation
 * loops and idle cost stays flat. Music-reactive effects (`NOTCH_FX_MUSIC`)
 * get an `idle` class when nothing is playing, which pauses their animation.
 */
import type { CSSProperties } from "react";
import { NOTCH_FX_MUSIC, type NotchFx } from "../store/settings";

/** Deterministic pseudo-random in [0, 1) — keeps layouts stable across renders. */
function rnd(i: number, salt = 7): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function NotchFxBackdrop({ fx, playing }: { fx: NotchFx; playing: boolean }) {
  if (fx === "none") return null;
  const cls = `nfx nfx-${fx}${NOTCH_FX_MUSIC.includes(fx) && !playing ? " idle" : ""}`;

  return (
    <div className={cls} aria-hidden>
      {fx === "visualizer" && (
        <div className="nfx-bars">
          {Array.from({ length: 28 }, (_, i) => (
            <i
              key={i}
              style={{
                height: `${26 + rnd(i + 1) * 64}%`,
                animationDuration: `${(0.5 + rnd(i, 3) * 0.9).toFixed(2)}s`,
                animationDelay: `${(-rnd(i, 5) * 1.3).toFixed(2)}s`,
                filter: `hue-rotate(${Math.round(rnd(i, 9) * 76 - 38)}deg)`,
              }}
            />
          ))}
        </div>
      )}

      {fx === "waves" && (
        <>
          {["a", "b", "c"].map((layer, i) => (
            <i
              key={layer}
              className={`nw-w${i + 1}`}
              style={{ "--t": `${(12 + i * 8).toFixed(0)}s`, animationDelay: `${(-i * 4).toFixed(1)}s` } as CSSProperties}
            />
          ))}
        </>
      )}

      {fx === "synthwave" && (
        <>
          <i className="nw-sun" />
          <i className="nw-grid" />
        </>
      )}

      {fx === "fireflies" && (
        <>
          {Array.from({ length: 16 }, (_, i) => (
            <i
              key={i}
              style={
                {
                  left: `${rnd(i) * 96}%`,
                  top: `${12 + rnd(i, 2) * 68}%`,
                  "--s": `${4 + rnd(i, 3) * 5}px`,
                  "--dx": `${((rnd(i, 4) - 0.5) * 130).toFixed(0)}px`,
                  "--dy": `${((rnd(i, 5) - 0.5) * 90).toFixed(0)}px`,
                  "--t": `${(5 + rnd(i, 6) * 8).toFixed(1)}s`,
                  "--dl": `${(-rnd(i, 7) * 6).toFixed(1)}s`,
                } as CSSProperties
              }
            />
          ))}
        </>
      )}

      {fx === "aurora" && (
        <>
          {["a", "b", "c"].map((layer, i) => (
            <i
              key={layer}
              className={`nw-${layer}`}
              style={
                {
                  "--t": `${(9 + i * 6).toFixed(0)}s`,
                  "--dx": `${(18 + i * 14).toFixed(0)}px`,
                  "--sk": `${(8 + i * 9).toFixed(0)}deg`,
                } as CSSProperties
              }
            />
          ))}
        </>
      )}

      {fx === "nightsky" && <i className="nw-meteor" />}

      {fx === "topo" && (
        <>
          <i className="nw-a" />
          <i className="nw-b" />
        </>
      )}

      {fx === "liquid" && (
        <>
          {["a", "b", "c", "d"].map((layer, i) => (
            <i
              key={layer}
              className={`nw-${layer}`}
              style={{ "--t": `${(10 + i * 5).toFixed(0)}s`, "--x": rnd(i, 3).toFixed(2) } as CSSProperties}
            />
          ))}
        </>
      )}
      {/* holographic is a single sheen gradient animated on `.nfx` itself */}
    </div>
  );
}
