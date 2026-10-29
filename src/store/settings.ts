import { create } from "zustand";
import { useEffect, type CSSProperties } from "react";

export type ModuleKey = "wallpaper" | "clock" | "notch" | "todo" | "start";

/** Per-module window behavior — layer, position, input mode, size, typography. */
export interface WindowConf {
  /** Z-order: always-on-top, plain overlay, or pinned to the very bottom. */
  level: "bottommost" | "normal" | "topmost";
  /** Target display: null = primary, otherwise the monitor's global origin
   *  coordinates (its stable identity from the get_monitors enumeration). */
  monitor: { x: number; y: number } | null;
  /** Manual screen position (logical px, within the chosen display). */
  x: number | null;
  y: number | null;
  /** Mouse clicks pass through the window (can't drag or click while on). */
  clickThrough: boolean;
  /** Show a grab handle / drag region. */
  draggable: boolean;
  /** Capacity: window size multipliers of the default (clock/todo). */
  capacity: { width: number; height: number };
  /** Element scale: zoom of the widget's internal elements (.controls,
   *  chips, rows …) — the window itself and the text-size knob stay aside.
   *  It is a UI zoom only and never touches the native window size. */
  elementScale: number;
  /** Text style: family ("" = inherit), size scale, weight (0 = inherit),
   *  color ("" = inherit). */
  text: { family: string; sizeScale: number; weight: number; color: string };
}

/** Shared defaults; per-module tweaks below. */
function windowConf(level: WindowConf["level"]): WindowConf {
  return {
    level,
    monitor: null,
    x: null,
    y: null,
    clickThrough: false,
    draggable: true,
    capacity: { width: 1, height: 1 },
    elementScale: 1,
    text: { family: "", sizeScale: 1, weight: 0, color: "" },
  };
}

export interface Settings {
  theme: "dark" | "light";
  accent: string;
  /** Launch Aura automatically at sign-in (Windows registry Run entry). */
  launchOnStartup: boolean;
  modules: Record<ModuleKey, boolean>;
  clock: {
    layout: "digital" | "analog" | "minimal";
    format12h: boolean;
    timezone: string | null; // null = system timezone
    showDate: boolean;
    showSeconds: boolean;
    /** Glass surface behind the widget — off = text floats directly on the wallpaper. */
    background: boolean;
    win: WindowConf;
  };
  wallpaper: {
    kind: "none" | "image" | "video";
    path: string;
    /** Imported wallpaper library — copies live in the app data folder. */
    library: { name: string; path: string; kind: "image" | "video" }[];
    /** Per-display wallpaper overrides, keyed by that display's origin
     *  ("<x>,<y>"). A display without an entry follows the main wallpaper
     *  chosen above — that's how single-monitor setups keep working. */
    displays?: Record<string, { path: string; kind: "image" | "video" }>;
    win: WindowConf;
    fit: "cover" | "contain" | "fill";
    scale: number; // 0.5 .. 3
    offsetX: number; // percent -100..100
    offsetY: number;
    playbackRate: number; // 0.25 .. 2
    volume: number; // 0 .. 1
    muted: boolean;
    /** Dark overlay strength over the wallpaper, 0 (off) .. 100. */
    dimmer: number;
  };
  notch: {
    widgets: {
      media: boolean;
      monitors: boolean;
      shortcuts: boolean;
      clipboard: boolean;
      timer: boolean;
      bluetooth: boolean;
      run: boolean;
    };
    shortcuts: { name: string; target: string; icon: string }[];
    /** Layout engine: island/notch shape or a full desktop bar. */
    layout: "notch" | "bar";
    /** Where the strip sits along the screen edges/corners. */
    placement:
      | "top-left"
      | "top-center"
      | "top-right"
      | "bottom-left"
      | "bottom-center"
      | "bottom-right";
    /** Animated background effect (see `NotchFx`, music-reactive subset in
     *  NOTCH_FX_MUSIC — those animate only while something is playing). */
    fx: NotchFx;
    /** Glass surface behind pill + panel — off lets panels float over the
     *  desktop with just a soft shadow. */
    background: boolean;
    /** Independent size controls: px in notch mode, % of screen width in bar mode. */
    length: number;
    thickness: number;
    /** Collapsed (44px) pill content — fully independent from the expanded
     *  panel's widget tabs: these flags ONLY affect the minimized strip, so a
     *  chip can show there while its panel is hidden and vice versa. */
    collapsed: {
      showName: boolean;   // the "Aura" wordmark
      showClock: boolean;  // live time
      showTimer: boolean;  // ⏱ mini timer chip (needs the timer widget to run)
      showMem: boolean;    // RAM usage chip
      showNet: boolean;    // download-rate chip
      showMedia: boolean;  // mini progress bar / EQ for the current track
    };
    /** Visual quality of the glass surface */
    appearance: {
      blur: number;          // backdrop blur, px (0 = off, cheaper)
      glassOpacity: number;  // 0.3 .. 1 — how solid the glass reads
      radius: number;        // corner radius, px
      glow: number;          // 0 .. 1 accent halo intensity
      ambientArt: boolean;   // blurred album art ambience behind the media card
      /** Ambient light color: "" = auto (follow the accent), otherwise a
       *  CSS color that recolors the glow around/behind the notch. */
      ambientColor: string;
    };
    /** Motion & hover behavior */
    animation: {
      speed: number;         // 0.25 .. 2 — multiplier; <1 snappier, >1 dramatic
      stagger: boolean;      // sections cascade on reveal
      hoverDelay: number;    // ms of hover before the notch opens
      closeDelay: number;    // ms of grace after the pointer leaves
    };
    /** Window layer / input behavior / typography (capacity is the layout
     *  engine's length & thickness, so only position may override here). */
    win: WindowConf;
  };
  todo: {
    categories: string[];
    /** "smart" = by priority/due date; "created" = newest first, done last. */
    sort: "smart" | "created";
    /** Glass surface behind the widget — off = the list floats freely. */
    background: boolean;
    win: WindowConf;
  };
  /** Global hotkey that opens the settings panel from anywhere.
   *  `combo: ""` means the builtin default (Ctrl+Shift+,); a non-empty value
   *  replaces it with a user-chosen combination set by the recorder UI.
   *  `enabled: false` unregisters every settings hotkey system-wide. */
  hotkey: { enabled: boolean; combo: string };
  /** Spotlight-style launcher window (toggled by the global Alt+Space). */
  start: {
    /** Glass card behind the launcher — off = borderless, pure text and rows. */
    background: boolean;
    win: WindowConf;
  };
}

/** Animated background styles for the Smart Notch. */
export type NotchFx =
  | "none"
  | "visualizer"
  | "waves"
  | "synthwave"
  | "fireflies"
  | "aurora"
  | "nightsky"
  | "holographic"
  | "topo"
  | "liquid";

export const NOTCH_FX_LABELS: Record<NotchFx, string> = {
  none: "None",
  visualizer: "Visualizer",
  waves: "Waves",
  synthwave: "Synthwave",
  fireflies: "Fireflies",
  aurora: "Aurora",
  nightsky: "Night sky",
  holographic: "Holographic",
  topo: "Topographic",
  liquid: "Midnight liquid",
};

export const NOTCH_FX_DESCRIPTIONS: Record<NotchFx, string> = {
  none: "Clean glass",
  visualizer: "Spectrum bars",
  waves: "Tides",
  synthwave: "Retro sun and neon grid",
  fireflies: "Drifting sparks of light",
  aurora: "Northern lights",
  nightsky: "Stars and meteors",
  holographic: "Iridescent foil sheen",
  topo: "Slow contour lines",
  liquid: "Dark flowing silk",
};

/** Effects that react to the playing state (move only while music plays). */
export const NOTCH_FX_MUSIC: readonly NotchFx[] = ["visualizer", "waves", "synthwave", "liquid"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "#6c7bff",
  launchOnStartup: false,
  hotkey: { enabled: true, combo: "" },
  modules: { wallpaper: false, clock: true, notch: true, todo: true, start: false },
  clock: {
    layout: "digital",
    format12h: false,
    timezone: null,
    showDate: true,
    showSeconds: false,
    background: true,
    win: windowConf("topmost"),
  },
  wallpaper: {
    kind: "none",
    path: "",
    library: [],
    win: windowConf("bottommost"),
    fit: "cover",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    playbackRate: 1,
    volume: 0.6,
    muted: false,
    dimmer: 0,
  },
  notch: {
    widgets: {
      run: true,
      media: true,
      monitors: true,
      shortcuts: true,
      clipboard: false,
      timer: false,
      bluetooth: false,
    },
    shortcuts: [
      { name: "Files", target: "shell:mycomputer", icon: "📁" },
      { name: "GitHub", target: "https://github.com", icon: "🐙" },
    ],
    layout: "notch",
    placement: "top-center",
    fx: "none",
    background: true,
    length: 240, // px in notch mode / % of screen width in bar mode
    thickness: 44,
    collapsed: { showName: true, showClock: false, showTimer: true, showMem: true, showNet: true, showMedia: true },
    appearance: { blur: 30, glassOpacity: 0.86, radius: 26, glow: 0.28, ambientArt: true, ambientColor: "" },
    animation: { speed: 1, stagger: true, hoverDelay: 120, closeDelay: 260 },
    win: { ...windowConf("topmost"), draggable: false }, // drag by the dot only
  },
  todo: {
    categories: ["Personal", "Work", "Shopping"],
    sort: "smart",
    background: true,
    win: windowConf("topmost"),
  },
  start: { background: true, win: windowConf("topmost") },
};

const STORAGE_KEY = "aura.settings.v1";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch as T) ?? base;
  }
  const out: Record<string, unknown> = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const current = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch {
    /* ignore corrupt settings */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

function persist(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

interface SettingsStore {
  settings: Settings;
  /** Local edit: merge patch, persist, and broadcast to all windows. */
  update: (patch: Record<string, unknown>) => void;
  /** Incoming event from another window: apply + persist silently. */
  applyRemote: (settings: Settings) => void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  settings: loadSettings(),
  update: (patch) => {
    const settings = deepMerge(get().settings, patch);
    set({ settings });
    persist(settings);
    if (hasTauri()) {
      void import("@tauri-apps/api/event").then(
        ({ emit }) => void emit("aura:settings", { settings, from: getLabel() }),
      );
    }
    applyCssTokens(settings);
  },
  applyRemote: (settings) => {
    set({ settings });
    persist(settings);
    applyCssTokens(settings);
  },
}));

/**
 * Applies a module's persisted window configuration (layer level, manual
 * coordinates, click-through, capacity size) to its desktop window whenever
 * the configuration changes. Returns CSS custom properties for the text style.
 * No-op in the plain browser preview.
 */
export function useModuleWindow(moduleKey: ModuleKey): CSSProperties {
  const win = useSettings((s) => s.settings[moduleKey].win);

  useEffect(() => {
    if (!hasTauri() || !win) return;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("window_apply", {
        label: moduleKey,
        level: win.level,
        monitor: win.monitor ? [win.monitor.x, win.monitor.y] : null,
        x: win.x,
        y: win.y,
        clickThrough: win.clickThrough,
        capacity: win.capacity.width === 1 && win.capacity.height === 1 ? null : [win.capacity.width, win.capacity.height],
      }),
    );
    // JSON-serialize to avoid effect churn from fresh object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, JSON.stringify(win)]);

  return textStyleVars(win);
}

/** CSS custom properties consumed by module stylesheets (font family/size/weight/color). */
export function textStyleVars(win: WindowConf | undefined): CSSProperties {
  if (!win) return {};
  const style: Record<string, string | number> = {};
  if (win.text.family) style["--tx-family"] = win.text.family;
  if (win.text.sizeScale !== 1) style["--tx-size"] = String(win.text.sizeScale);
  if (win.text.weight > 0) style["--tx-weight"] = String(win.text.weight);
  if (win.text.color) style["--tx-color"] = win.text.color;
  // Element scale → CSS zoom on the widget root (clock/todo/notch pages pin
  // the returned style on their top-level element). Chromium in the WebView2
  // shell scales layout coherently with zoom, so chips, rows and panels all
  // grow/shrink together while the native window keeps its configured size.
  if (win.elementScale !== 1) style.zoom = win.elementScale;
  return style as CSSProperties;
}

/** True when running inside the Tauri shell (vs a plain browser preview). */
export function hasTauri(): boolean {
  return typeof window !== "undefined" && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

export function applyCssTokens(settings: Settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty("--accent", settings.accent);
}

/** Resolve the window label this renderer is serving (from its HTML entry). */
export function getLabel(): string {
  const path = window.location.pathname;
  const base = path.split("/").pop() ?? "index.html";
  if (base.startsWith("notch")) return "notch";
  if (base.startsWith("wallpaper")) return "wallpaper";
  if (base.startsWith("clock")) return "clock";
  if (base.startsWith("todo")) return "todo";
  if (base.startsWith("start")) return "start";
  return "settings";
}
