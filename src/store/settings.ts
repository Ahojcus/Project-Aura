import { create } from "zustand";
import { useEffect } from "react";
import { getWindowLabel, hasTauri, invoke, windowMonitor } from "../lib/bridge";
import { useDisplaysVersion } from "../lib/runtime";

export type ModuleKey = "wallpaper" | "clock" | "notch" | "todo" | "statusbar";

/** Per-module native window behavior. */
export interface WindowConf {
  level: "bottommost" | "normal" | "topmost";
  /** Target display origin (null = primary). */
  monitor: { x: number; y: number } | null;
  /** Additional displays that duplicate this module's window. */
  extraMonitors: { x: number; y: number }[];
  /** Manual position in logical px within the chosen display. */
  x: number | null;
  y: number | null;
  clickThrough: boolean;
  draggable: boolean;
  /** Window size multiplier of the module's default size. */
  capacity: { width: number; height: number };
}

function windowConf(level: WindowConf["level"]): WindowConf {
  return {
    level,
    monitor: null,
    extraMonitors: [],
    x: null,
    y: null,
    clickThrough: false,
    draggable: true,
    capacity: { width: 1, height: 1 },
  };
}

export type NotchWidgetKey =
  | "run"
  | "media"
  | "musicLights"
  | "monitors"
  | "timer"
  | "bluetooth"
  | "clipboard"
  | "shortcuts"
  | "volume"
  | "shelf"
  | "downloads"
  | "cloak"
  | "weather"
  | "forecast"
  | "edgeLight";

export const NOTCH_MODULE_LABELS: Record<NotchWidgetKey, string> = {
  run: "Run launcher",
  media: "Now playing",
  musicLights: "Music lights",
  monitors: "System stats",
  timer: "Focus timer",
  bluetooth: "Bluetooth devices",
  clipboard: "Clipboard history",
  shortcuts: "Quick shortcuts",
  volume: "Volume mixer",
  shelf: "Drop shelf",
  downloads: "Download progress",
  cloak: "Invisibility cloak",
  weather: "Weather",
  forecast: "Weather forecast",
  edgeLight: "Edge light",
};

export const DEFAULT_NOTCH_MODULE_ORDER: NotchWidgetKey[] = [
  "run",
  "media",
  "musicLights",
  "volume",
  "shelf",
  "downloads",
  "monitors",
  "weather",
  "forecast",
  "timer",
  "bluetooth",
  "clipboard",
  "shortcuts",
  "cloak",
  "edgeLight",
];

export interface WallpaperEntry {
  name: string;
  path: string;
  kind: "image" | "video" | "web";
}

/** Per-wallpaper visual and playback adjustments, keyed by source path. */
export interface WallpaperLook {
  /** Color saturation in percent (100 = unchanged). */
  saturation: number;
  /** Gamma exponent (1 = unchanged, lower brightens, higher darkens). */
  gamma: number;
  /** Hue rotation in degrees (0 = unchanged). */
  hue: number;
  /** Playback-speed multiplier for video wallpapers (1 = unchanged). */
  speed: number;
}

export const DEFAULT_WALLPAPER_LOOK: WallpaperLook = {
  saturation: 100,
  gamma: 1,
  hue: 0,
  speed: 1,
};

export function getWallpaperLook(
  looks: Record<string, WallpaperLook> | undefined,
  path: string,
): WallpaperLook {
  return { ...DEFAULT_WALLPAPER_LOOK, ...(looks?.[path] ?? {}) };
}

export interface Settings {
  theme: "dark" | "light";
  accent: string;
  launchOnStartup: boolean;
  modules: Record<ModuleKey, boolean>;
  moduleOrder: ModuleKey[];
  clock: {
    layout: "digital" | "analog" | "minimal";
    format12h: boolean;
    timezone: string | null;
    showDate: boolean;
    showSeconds: boolean;
    showYear: boolean;
    win: WindowConf;
  };
  wallpaper: {
    kind: "none" | "image" | "video" | "web";
    path: string;
    library: WallpaperEntry[];
    /** Per-wallpaper adjustments keyed by source path. */
    looks: Record<string, WallpaperLook>;
    /** Per-display overrides keyed by that display's origin ("<x>,<y>"). */
    displays: Record<string, { path: string; kind: "image" | "video" | "web" }>;
    win: WindowConf;
    fit: "cover" | "contain" | "fill";
    scale: number;
    offsetX: number;
    offsetY: number;
    playbackRate: number;
    volume: number;
    muted: boolean;
    pauseWhen: "off" | "maximized" | "fullscreen";
    pauseOnBattery: boolean;
    muteWithMedia: boolean;
    /** Loop video wallpapers (off = play once and hold the last frame). */
    loop: boolean;
  };
  notch: {
    widgets: Record<NotchWidgetKey, boolean>;
    moduleOrder: NotchWidgetKey[];
    moduleScale: Record<NotchWidgetKey, number>;
    shortcuts: { name: string; target: string; icon: string }[];
    /** Files and text snippets parked in the drop shelf. */
    shelf: { id: string; name: string; target: string; kind: "file" | "text" }[];
    /** Empty uses approximate network location; otherwise a city or "lat,lon". */
    weatherLocation: string;
    weatherUnit: "c" | "f";
    /** Hide the clock, to-do and status bar until the cloak is lifted. */
    cloakActive: boolean;
    /** Show the full-screen edge glow overlay. */
    edgeLightActive: boolean;
    layout: "notch" | "bar";
    placement:
      | "top-left"
      | "top-center"
      | "top-right"
      | "bottom-left"
      | "bottom-center"
      | "bottom-right";
    length: number;
    thickness: number;
    collapsed: {
      showName: boolean;
      showClock: boolean;
      showTimer: boolean;
      showMem: boolean;
      showNet: boolean;
      showMedia: boolean;
    };
    animation: { hoverDelay: number; closeDelay: number };
    /** Open the panel on hover; off = click the strip instead. */
    openOnHover: boolean;
    /** Hide the strip while a fullscreen app is in front. */
    hideOnFullscreen: boolean;
    /** Focus-timer preset buttons, in minutes. */
    timerPresets: number[];
    win: WindowConf;
  };
  todo: {
    categories: string[];
    sort: "smart" | "created";
    defaultPriority: "low" | "medium" | "high";
    win: WindowConf;
  };
  statusbar: {
    placement: "top" | "bottom";
    thickness: number;
    inset: number;
    chips: {
      cpu: boolean;
      ram: boolean;
      disk: boolean;
      temp: boolean;
      net: boolean;
      volume: boolean;
      uptime: boolean;
      battery: boolean;
      window: boolean;
      media: boolean;
      clock: boolean;
      bluetooth: boolean;
      downloads: boolean;
      weather: boolean;
    };
    showDate: boolean;
    showSeconds: boolean;
    weatherLocation: string;
    weatherUnit: "c" | "f";
    /** Hide the bar while a fullscreen app is in front. */
    hideOnFullscreen: boolean;
    win: WindowConf;
  };
  hotkey: { enabled: boolean; combo: string };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "#6c7bff",
  launchOnStartup: false,
  hotkey: { enabled: true, combo: "" },
  modules: { wallpaper: false, clock: true, notch: true, todo: true, statusbar: false },
  moduleOrder: ["notch", "statusbar", "clock", "todo", "wallpaper"],
  clock: {
    layout: "digital",
    format12h: false,
    timezone: null,
    showDate: true,
    showSeconds: false,
    showYear: false,
    win: windowConf("topmost"),
  },
  wallpaper: {
    kind: "none",
    path: "",
    library: [],
    looks: {},
    displays: {},
    win: windowConf("bottommost"),
    fit: "cover",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    playbackRate: 1,
    volume: 0.6,
    muted: false,
    pauseWhen: "off",
    pauseOnBattery: false,
    muteWithMedia: true,
    loop: true,
  },
  notch: {
    widgets: {
      run: true,
      media: true,
      musicLights: false,
      monitors: true,
      shortcuts: true,
      clipboard: false,
      timer: false,
      bluetooth: false,
      volume: false,
      shelf: false,
      downloads: false,
      cloak: false,
      weather: false,
      forecast: false,
      edgeLight: false,
    },
    moduleOrder: DEFAULT_NOTCH_MODULE_ORDER,
    moduleScale: {
      run: 1,
      media: 1,
      musicLights: 1,
      monitors: 1,
      timer: 1,
      bluetooth: 1,
      clipboard: 1,
      shortcuts: 1,
      volume: 1,
      shelf: 1,
      downloads: 1,
      cloak: 1,
      weather: 1,
      forecast: 1,
      edgeLight: 1,
    },
    shortcuts: [
      { name: "Files", target: "shell:mycomputer", icon: "" },
      { name: "GitHub", target: "https://github.com", icon: "" },
    ],
    shelf: [],
    weatherLocation: "",
    weatherUnit: "c",
    cloakActive: false,
    edgeLightActive: false,
    layout: "notch",
    placement: "top-center",
    length: 240,
    thickness: 44,
    collapsed: {
      showName: true,
      showClock: false,
      showTimer: true,
      showMem: true,
      showNet: true,
      showMedia: true,
    },
    animation: { hoverDelay: 120, closeDelay: 260 },
    openOnHover: true,
    hideOnFullscreen: true,
    timerPresets: [5, 15, 25, 50],
    win: { ...windowConf("topmost"), draggable: false },
  },
  todo: {
    categories: ["Personal", "Work", "Shopping"],
    sort: "smart",
    defaultPriority: "medium",
    win: windowConf("topmost"),
  },
  statusbar: {
    placement: "top",
    thickness: 40,
    inset: 0,
    chips: {
      cpu: true,
      ram: true,
      disk: true,
      temp: true,
      net: true,
      volume: true,
      uptime: true,
      battery: true,
      window: true,
      media: true,
      clock: true,
      bluetooth: false,
      downloads: false,
      weather: false,
    },
    showDate: true,
    showSeconds: false,
    weatherLocation: "",
    weatherUnit: "c",
    hideOnFullscreen: true,
    win: { ...windowConf("topmost"), draggable: false },
  },
};

const STORAGE_KEY = "aura.settings.v2";

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
  update: (patch: Record<string, unknown>) => void;
  /** Replace the whole settings object (reset / map deletions). */
  setSettings: (settings: Settings) => void;
  applyRemote: (settings: Settings) => void;
  /** Delete one display's wallpaper override.
   *  Plain `update` deep-merges objects, so a removal cannot be expressed as
   *  a patch — the deleted key would be merged back from the current value. */
  removeWallpaperDisplay: (key: string) => void;
}

export const useSettings = create<SettingsStore>()((set, get) => {
  const commit = (settings: Settings) => {
    set({ settings });
    persist(settings);
    if (hasTauri()) {
      void import("@tauri-apps/api/event").then(
        ({ emit }) => void emit("aura:settings", { settings, from: getWindowLabel() }),
      );
    }
    applyCssTokens(settings);
  };

  return {
    settings: loadSettings(),
    update: (patch) => commit(deepMerge(get().settings, patch)),
    setSettings: (settings) => commit(settings),
    applyRemote: (settings) => {
      set({ settings });
      persist(settings);
      applyCssTokens(settings);
    },
    removeWallpaperDisplay: (key) => {
      const next = structuredClone(get().settings);
      delete next.wallpaper.displays[key];
      get().setSettings(next);
    },
  };
});

export function applyCssTokens(settings: Settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty("--accent", settings.accent);
}

/**
 * Applies a module's persisted window configuration (layer, position,
 * click-through, capacity) to its native window whenever it changes.
 * No-op in the plain browser preview.
 */
export function useModuleWindow(moduleKey: ModuleKey) {
  const win = useSettings((s) => s.settings[moduleKey].win);
  const order = useSettings((s) => s.settings.moduleOrder);
  const enabled = useSettings((s) => s.settings.modules[moduleKey]);
  const displayVersion = useDisplaysVersion();

  useEffect(() => {
    if (!hasTauri() || !win) return;
    const label = getWindowLabel();
    // Per-display duplicates encode their own monitor in the window label.
    const own = windowMonitor(label);
    void invoke("window_apply", {
      label,
      level: win.level,
      monitor: own
        ? [own.x, own.y]
        : win.monitor
          ? [win.monitor.x, win.monitor.y]
          : null,
      x: own ? null : win.x,
      y: own ? null : win.y,
      clickThrough: win.clickThrough,
      capacity:
        win.capacity.width === 1 && win.capacity.height === 1
          ? null
          : [win.capacity.width, win.capacity.height],
      order,
    });
    // Only the main window owns the set of duplicate windows; a duplicate
    // must never try to recreate the whole family from inside itself.
    if (!own && moduleKey !== "wallpaper") {
      void invoke("module_sync_displays", {
        module: moduleKey,
        visible: enabled,
        displays: (win.extraMonitors ?? []).map((m) => [m.x, m.y]),
        mainMonitor: win.monitor ? [win.monitor.x, win.monitor.y] : null,
        level: win.level,
        clickThrough: win.clickThrough,
        capacity: [win.capacity.width, win.capacity.height],
      });
    }
    // JSON-serialize to avoid effect churn from fresh object identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, JSON.stringify(win), JSON.stringify(order), enabled, displayVersion]);

  // `window_apply` only moves a window when manual X/Y are set, so switching
  // the target display must explicitly re-run the native placement for the
  // already-visible module.
  const monitorKey = win.monitor ? `${win.monitor.x},${win.monitor.y}` : "primary";
  useEffect(() => {
    if (!hasTauri() || !enabled) return;
    // Notch and statusbar rebuild their own geometry from their layout
    // commands on a display change; moving them generically here would race
    // (and overwrite) that exact layout.
    if (moduleKey !== "clock" && moduleKey !== "todo") return;
    if (windowMonitor(getWindowLabel())) return; // duplicates follow their label
    void invoke("set_module_visible", {
      label: moduleKey,
      visible: true,
      x: win.x,
      y: win.y,
      monitor: win.monitor ? [win.monitor.x, win.monitor.y] : null,
    });
    // Only a display change (or re-enabling the module) should re-place it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorKey, enabled, moduleKey]);
}

/** Debug handle: inspect the live settings from any page. */
if (typeof window !== "undefined") {
  (window as unknown as { __auraSettings: unknown }).__auraSettings = useSettings;
}
