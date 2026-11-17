import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** True when running inside the Tauri shell (vs a plain browser preview). */
export function hasTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined
  );
}

/**
 * Invoke a backend command. In a plain browser preview (or when the backend is
 * not ready yet) the promise resolves to null instead of rejecting, so every
 * module degrades to a static preview without error noise.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasTauri()) return null;
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch {
    return null;
  }
}

/** Raw label of the window this renderer is serving (unique per duplicate). */
export function getWindowLabel(): string {
  if (hasTauri()) {
    const label = (
      window as {
        __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
      }
    ).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
    if (typeof label === "string" && label) return label;
  }
  const entry = (window.location.pathname.split("/").pop() ?? "index.html").split(".")[0];
  return entry || "settings";
}

/** Module key this renderer serves; per-display duplicates map to their base. */
export function getLabel(): string {
  const base = getWindowLabel().split("_")[0];
  if (["wallpaper", "notch", "clock", "todo", "statusbar"].includes(base)) return base;
  return "settings";
}

/** Display origin encoded in a per-display duplicate window label. */
export function windowMonitor(label = getWindowLabel()): { x: number; y: number } | null {
  const match = /^(?:wallpaper|notch|clock|todo|statusbar)_(-?\d+)_(-?\d+)$/.exec(label);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

export interface MonitorInfo {
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

export interface MediaInfo {
  title: string;
  artist: string;
  status: string;
  positionMs: number;
  durationMs: number;
  trackKey: string;
}

export interface SystemSnapshot {
  cpuPercent: number;
  memUsedGb: number;
  memTotalGb: number;
  netDownBps: number;
  netUpBps: number;
  diskUsedGb: number;
  diskTotalGb: number;
  cpuTempC: number | null;
  uptimeSecs: number;
}

export interface ClipboardEntry {
  text: string;
  at_ms: number;
}

export interface BtDevice {
  name: string;
  battery_percent: number | null;
}

export interface AppInfo {
  name: string;
  target: string;
}

export function formatRate(bps: number): string {
  if (bps <= 0) return "0 B/s";
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  if (bps >= 1_024) return `${(bps / 1_024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatAgo(atMs: number): string {
  const s = Math.max(0, (Date.now() - atMs) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
