import type { PointerEvent as ReactPointerEvent } from "react";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getLabel, getWindowLabel, hasTauri } from "./bridge";
import { useSettings, type ModuleKey } from "../store/settings";

const DRAG_MODULES: ModuleKey[] = ["clock", "todo", "notch"];

/** Cleanup for the active drag tracker; prevents stale listeners stacking up. */
let stopActiveTracking: (() => void) | null = null;

/**
 * Native window drag from any press inside a drag region, including presses on
 * nested children. Presses on interactive controls are ignored so widgets stay
 * usable.
 *
 * Dragging only moves the native window. Tauri does not tell us when the drag
 * ends, so listen for native move events and save the settled position back to
 * the settings store. Without this, every restart reapplies the old/default
 * coordinates.
 */
export function dragHandle(e: ReactPointerEvent) {
  if (!hasTauri() || e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest("button, input, select, textarea, a, [data-no-drag]")) return;
  e.preventDefault();

  const label = getWindowLabel();
  const moduleKey = getLabel() as ModuleKey;
  void (async () => {
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const win = getCurrentWebviewWindow();
      // A duplicate window is positioned by the backend from its display
      // label; only the main module owns the persisted manual coordinates.
      if (label === moduleKey && DRAG_MODULES.includes(moduleKey)) {
        await trackWindowMove(win, moduleKey);
      }
      await win.startDragging();
    } catch {
      /* window drag unavailable */
    }
  })();
}

async function trackWindowMove(win: WebviewWindow, moduleKey: ModuleKey) {
  // A second drag starting before the first settled timer fires should replace
  // the old tracker rather than leave both listeners active.
  stopActiveTracking?.();

  let endTimer = 0;
  let saveTimer = 0;
  let unlisten: (() => void) | null = null;
  let active = true;

  const stop = () => {
    if (!active) return;
    active = false;
    window.clearTimeout(endTimer);
    window.clearTimeout(saveTimer);
    unlisten?.();
    unlisten = null;
    if (stopActiveTracking === stop) stopActiveTracking = null;
  };

  stopActiveTracking = stop;

  // A press without movement should not leave a listener behind forever.
  endTimer = window.setTimeout(stop, 1500);

  const off = await win.onMoved(() => {
    if (!active) return;
    window.clearTimeout(endTimer);
    // Native move events stop when the mouse is released. Wait a little longer
    // than the event gap so the final position is the one that gets saved.
    endTimer = window.setTimeout(stop, 800);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveWindowPosition(win, moduleKey);
    }, 120);
  });

  if (!active) {
    off();
    return;
  }
  unlisten = off;
}

async function saveWindowPosition(win: WebviewWindow, moduleKey: ModuleKey) {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const [position, monitor] = await Promise.all([win.outerPosition(), currentMonitor()]);
  if (!monitor) return;

  const scale = monitor.scaleFactor || 1;
  const x = Math.round((position.x - monitor.position.x) / scale);
  const y = Math.round((position.y - monitor.position.y) / scale);
  const display = { x: monitor.position.x, y: monitor.position.y };
  const current = useSettings.getState().settings[moduleKey].win;

  // Programmatic `window_apply` moves also emit `onMoved`. Avoid feeding those
  // back into the store (which would trigger another apply and a render loop).
  if (
    current.x === x &&
    current.y === y &&
    current.monitor?.x === display.x &&
    current.monitor?.y === display.y
  ) {
    return;
  }

  useSettings.getState().update({
    [moduleKey]: {
      win: {
        x,
        y,
        monitor: display,
      },
    },
  });
}
