import { useEffect, useState } from "react";
import { hasTauri } from "./bridge";

/**
 * Increments whenever the monitor topology changes (hotplug, resolution,
 * scale). Overlay layouts include it in their effect deps so geometry is
 * re-applied after a DisplayPort monitor enumerates late at boot or reappears.
 */
export function useDisplaysVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!hasTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("aura:displays-changed", () => setVersion((v) => v + 1)))
      .then((un) => {
        const off = un ?? null;
        if (cancelled) off?.();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return version;
}

interface FullscreenState {
  active: boolean;
  monitor: { x: number; y: number } | null;
  primary: boolean;
}

/**
 * True while a fullscreen app owns the monitor passed in. `null` means the
 * primary display, which is where an unconfigured main window lives. This is
 * intentionally monitor-scoped: a game on another screen must not hide the
 * notch/status bar on this one.
 */
export function useFullscreen(monitor: { x: number; y: number } | null = null): boolean {
  const [state, setState] = useState<FullscreenState>({
    active: false,
    monitor: null,
    primary: false,
  });

  useEffect(() => {
    if (!hasTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{
          fullscreen?: boolean;
          monitor?: [number, number] | null;
          primary?: boolean;
        }>("aura:fullscreen-changed", (event) => {
          const payload = event.payload;
          const rawMonitor = payload?.monitor;
          const eventMonitor =
            Array.isArray(rawMonitor) && rawMonitor.length === 2
              ? { x: Number(rawMonitor[0]), y: Number(rawMonitor[1]) }
              : null;
          setState({
            active: Boolean(payload?.fullscreen) || eventMonitor !== null,
            monitor: eventMonitor,
            primary: Boolean(payload?.primary),
          });
        }),
      )
      .then((un) => {
        const off = un ?? null;
        if (cancelled) off?.();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!state.active) return false;
  if (monitor) return state.monitor?.x === monitor.x && state.monitor?.y === monitor.y;
  return state.primary;
}
