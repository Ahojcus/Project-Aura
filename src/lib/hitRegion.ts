import { useEffect } from "react";
import { getWindowLabel, hasTauri, invoke } from "./bridge";

/**
 * Clip a module's native window to the union of the given visible elements.
 *
 * Transparent window pixels normally still receive mouse input in Tauri, which
 * makes a widget's invisible shadow margin swallow clicks meant for an app
 * underneath it. A native window region makes those pixels pass clicks through
 * to whatever is behind them.
 */
export function useHitRegion(
  targets: string | string[],
  radiusLogical = 16,
  paddingLogical = 8,
) {
  const selectorKey = Array.isArray(targets) ? targets.join("|") : targets;

  useEffect(() => {
    if (!hasTauri()) return;
    const selectors = selectorKey.split("|");
    let frame = 0;
    let disposed = false;

    const update = () => {
      frame = 0;
      if (disposed) return;

      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (!Number.isFinite(left) || !Number.isFinite(top)) return;

      const dpr = window.devicePixelRatio || 1;
      void invoke("module_set_hit_region", {
        label: getWindowLabel(),
        x: Math.round((left - paddingLogical) * dpr),
        y: Math.round((top - paddingLogical) * dpr),
        width: Math.round((right - left + paddingLogical * 2) * dpr),
        height: Math.round((bottom - top + paddingLogical * 2) * dpr),
        radius: radiusLogical * dpr,
      });
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    const observer = new ResizeObserver(schedule);
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [selectorKey, radiusLogical, paddingLogical]);
}
