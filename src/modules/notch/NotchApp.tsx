import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  NOTCH_MODULE_LABELS,
  moduleBackground,
  useModuleWindow,
  useSettings,
  type NotchWidgetKey,
} from "../../store/settings";
import {
  formatAgo,
  formatRate,
  formatTime,
  getWindowLabel,
  hasTauri,
  invoke,
  windowMonitor,
  type AppInfo,
  type BtDevice,
  type ClipboardEntry,
  type MediaInfo,
  type SystemSnapshot,
} from "../../lib/bridge";
import { dragHandle } from "../../lib/drag";
import { NOTCH_WIDGET_GLYPH, NotchGlyph } from "../../lib/notchGlyphs";
import { useDisplaysVersion, useFullscreen } from "../../lib/runtime";

interface TimerState {
  running: boolean;
  totalMs: number;
  leftMs: number;
  /** Absolute deadline while running (avoids tick drift). */
  endAt: number | null;
  finished: boolean;
}

interface AudioSessionInfo {
  id: string;
  name: string;
  process: string;
  volume: number;
  muted: boolean;
  active: boolean;
}

interface DownloadInfo {
  name: string;
  path: string;
  bytes: number;
  modifiedMs: number;
}

interface ShelfItem {
  id: string;
  name: string;
  target: string;
  kind: "file" | "text";
}

interface WeatherHour {
  time: string;
  tempC: number;
  code: number;
}

interface WeatherDay {
  date: string;
  code: number;
  minC: number;
  maxC: number;
}

interface WeatherSnapshot {
  city: string;
  tempC: number;
  feelsC: number;
  humidity: number;
  windKph: number;
  code: number;
  hourly: WeatherHour[];
  daily: WeatherDay[];
  updatedAt: number;
}

const MUSIC_LIGHT_BARS = Array.from({ length: 26 }, (_, index) => {
  const envelope = Math.sin((index / 25) * Math.PI);
  return {
    peak: (0.34 + envelope * 0.54 + ((index * 37) % 9) / 100).toFixed(2),
    delay: `${-((index * 83) % 920)}ms`,
    duration: `${680 + ((index * 67) % 520)}ms`,
  };
});

const DEFAULT_TIMER_PRESETS = [5, 15, 25, 50];
const INITIAL_TIMER: TimerState = {
  running: false,
  totalMs: 0,
  leftMs: 0,
  endAt: null,
  finished: false,
};

const DEFAULT_TAB_ORDER: NotchWidgetKey[] = [
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

/** Short labels keep the opened notch's tab row calm and single-line. */
function weatherLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Weather";
}

function weatherSymbol(code: number): string {
  if (code === 0) return "☀";
  if (code <= 3) return "⛅";
  if (code === 45 || code === 48) return "☁";
  if (code >= 71 && code <= 86) return "❄";
  if (code >= 95) return "⛈";
  return "☂";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${Math.max(0, bytes)} B`;
}

function shelfName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || path;
}

function isPathLike(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

async function resolveWeatherPlace(location: string, signal: AbortSignal): Promise<{ lat: number; lon: number; city: string }> {
  const typed = location.trim();
  const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(typed);
  if (coords) {
    return { lat: Number(coords[1]), lon: Number(coords[2]), city: "Pinned location" };
  }
  if (typed) {
    const geo = await fetchJson<{
      results?: { name: string; latitude: number; longitude: number; country_code?: string }[];
    }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(typed)}&count=1&language=en&format=json`,
      signal,
    );
    const hit = geo.results?.[0];
    if (!hit) throw new Error(`No weather location named “${typed}”`);
    return { lat: hit.latitude, lon: hit.longitude, city: hit.name };
  }
  // Several public IP-location providers are raced in sequence. Individual
  // providers rate-limit or reject WebView origins, so one failure should not
  // leave the forecast empty when another service still answers.
  const providers: (() => Promise<{ lat: number; lon: number; city: string }>)[] = [
    async () => {
      const ip = await fetchJson<{
        city?: string;
        latitude?: number;
        longitude?: number;
      }>("https://geolocation-db.com/json/", signal);
      if (ip.latitude == null || ip.longitude == null) throw new Error("No coordinates");
      return { lat: ip.latitude, lon: ip.longitude, city: ip.city || "My location" };
    },
    async () => {
      const ip = await fetchJson<{
        city?: string;
        latitude?: number;
        longitude?: number;
      }>("https://ipapi.co/json/", signal);
      if (ip.latitude == null || ip.longitude == null) throw new Error("No coordinates");
      return { lat: ip.latitude, lon: ip.longitude, city: ip.city || "My location" };
    },
    async () => {
      const ip = await fetchJson<{ city?: string; loc?: string }>("https://ipinfo.io/json", signal);
      const [lat, lon] = (ip.loc ?? "").split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("No coordinates");
      return { lat, lon, city: ip.city || "My location" };
    },
  ];
  let lastError: unknown = null;
  for (const provider of providers) {
    try {
      return await provider();
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Could not detect a location${lastError instanceof Error ? `: ${lastError.message}` : ""}. Set one in Settings → Smart Notch.`,
  );
}

/** Saved order leads; modules it does not list are appended. */
function mergeNotchOrder(saved: NotchWidgetKey[] | undefined): NotchWidgetKey[] {
  const list = (saved ?? []).filter((k) => DEFAULT_TAB_ORDER.includes(k));
  return [...list, ...DEFAULT_TAB_ORDER.filter((k) => !list.includes(k))];
}

type PanelKey = NotchWidgetKey | "home";

export function NotchApp() {
  const notch = useSettings((s) => s.settings.notch);
  const modules = useSettings((s) => s.settings.modules);
  const clockFmt12h = useSettings((s) => s.settings.clock.format12h);
  const update = useSettings((s) => s.update);
  useModuleWindow("notch");
  const winConf = notch.win;
  const windowLabel = getWindowLabel();
  const ownMonitor = windowMonitor(windowLabel);
  const displayVersion = useDisplaysVersion();

  const widgetOrder = mergeNotchOrder(notch.moduleOrder);
  const enabledWidgets = widgetOrder.filter((k) => notch.widgets[k]);
  const [activeTab, setActiveTab] = useState<PanelKey | null>(null);
  const [closing, setClosing] = useState(false);
  const expanded = activeTab !== null;
  const [pinned, setPinned] = useState(false);
  const fullscreen = useFullscreen(ownMonitor ?? winConf.monitor ?? null);

  // A panel whose widget was disabled in Settings falls back to Home.
  useEffect(() => {
    if (activeTab && activeTab !== "home" && !notch.widgets[activeTab]) setActiveTab("home");
  }, [activeTab, notch.widgets]);

  // ------------------------------------------------------------------ polling
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [sys, setSys] = useState<SystemSnapshot | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsBump, setAppsBump] = useState(0);
  const [audio, setAudio] = useState<AudioSessionInfo[]>([]);
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherError, setWeatherError] = useState("");
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherBump, setWeatherBump] = useState(0);
  const [shelfDrag, setShelfDrag] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const artKey = useRef("");
  const volumeSends = useRef<Record<string, number>>({});

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!notch.widgets.media) {
      artKey.current = "";
      setMedia(null);
      setArt(null);
      return;
    }
    const tick = async () => {
      const info = await invoke<MediaInfo>("get_media_info");
      setMedia(info);
      if (info && info.trackKey !== artKey.current) {
        artKey.current = info.trackKey;
        const a = await invoke<{ dataUrl?: string; data_url?: string }>("get_media_art");
        setArt(a?.dataUrl ?? a?.data_url ?? null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [notch.widgets.media]);

  useEffect(() => {
    const tick = () => void invoke<SystemSnapshot>("get_system_info").then(setSys);
    tick();
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!notch.widgets.clipboard) {
      setClipboard([]);
      return;
    }
    const tick = () => void invoke<ClipboardEntry[]>("get_clipboard_history").then((v) => setClipboard(v ?? []));
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [notch.widgets.clipboard]);

  useEffect(() => {
    if (!notch.widgets.bluetooth) {
      setDevices([]);
      return;
    }
    const tick = () => void invoke<BtDevice[]>("get_bluetooth_battery").then((v) => setDevices(v ?? []));
    void tick();
    const id = window.setInterval(tick, 15000);
    return () => window.clearInterval(id);
  }, [notch.widgets.bluetooth]);

  useEffect(() => {
    if (!notch.widgets.run) {
      setApps([]);
      return;
    }
    void invoke<AppInfo[]>("get_apps").then((v) => setApps(v ?? []));
  }, [notch.widgets.run, appsBump]);

  useEffect(() => {
    if (!notch.widgets.volume) {
      setAudio([]);
      return;
    }
    const tick = () => void invoke<AudioSessionInfo[]>("get_audio_sessions").then((v) => setAudio(v ?? []));
    void tick();
    const id = window.setInterval(tick, 2500);
    return () => window.clearInterval(id);
  }, [notch.widgets.volume]);

  useEffect(() => {
    if (!notch.widgets.downloads) {
      setDownloads([]);
      return;
    }
    const tick = () => void invoke<DownloadInfo[]>("get_downloads").then((v) => setDownloads(v ?? []));
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [notch.widgets.downloads]);

  // ---------------------------------------------------------------- weather
  const weatherNeeded = notch.widgets.weather || notch.widgets.forecast;
  const weatherLocation = notch.weatherLocation;

  useEffect(() => {
    if (!weatherNeeded) return;
    const controller = new AbortController();
    let cancelled = false;
    const load = async () => {
      setWeatherLoading(true);
      setWeatherError("");
      try {
        const place = await resolveWeatherPlace(weatherLocation, controller.signal);
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
          "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
          "&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min" +
          "&timezone=auto&forecast_days=7";
        const data = await fetchJson<{
          current: {
            temperature_2m: number;
            apparent_temperature: number;
            relative_humidity_2m: number;
            weather_code: number;
            wind_speed_10m: number;
          };
          hourly: { time: string[]; temperature_2m: number[]; weather_code: number[] };
          daily: {
            time: string[];
            weather_code: number[];
            temperature_2m_max: number[];
            temperature_2m_min: number[];
          };
        }>(url, controller.signal);
        if (cancelled) return;
        const hourly = data.hourly.time.map((time, index) => ({
          time,
          tempC: data.hourly.temperature_2m[index],
          code: data.hourly.weather_code[index],
        }));
        setWeather({
          city: place.city,
          tempC: data.current.temperature_2m,
          feelsC: data.current.apparent_temperature,
          humidity: data.current.relative_humidity_2m,
          windKph: data.current.wind_speed_10m,
          code: data.current.weather_code,
          hourly,
          daily: data.daily.time.map((date, index) => ({
            date,
            code: data.daily.weather_code[index],
            minC: data.daily.temperature_2m_min[index],
            maxC: data.daily.temperature_2m_max[index],
          })),
          updatedAt: Date.now(),
        });
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setWeatherError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setWeatherLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [weatherNeeded, weatherLocation, weatherBump]);

  // ---------------------------------------------------------- shelf + overlays
  const addShelfPaths = (paths: string[]) => {
    const current = useSettings.getState().settings.notch.shelf;
    const additions = paths
      .filter((path) => path.trim())
      .filter((path) => !current.some((item) => item.kind === "file" && item.target === path))
      .map((path, index) => ({
        id: `${Date.now()}-${index}-${path}`,
        name: shelfName(path),
        target: path,
        kind: "file" as const,
      }));
    if (additions.length > 0) {
      useSettings.getState().update({ notch: { shelf: [...additions, ...current].slice(0, 40) } });
    }
  };

  const addShelfText = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const current = useSettings.getState().settings.notch.shelf;
    if (current.some((item) => item.kind === "text" && item.target === text)) return;
    useSettings.getState().update({
      notch: {
        shelf: [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: isPathLike(text) ? shelfName(text) : text.slice(0, 80),
            target: text,
            kind: isPathLike(text) ? "file" : "text",
          },
          ...current,
        ].slice(0, 40),
      },
    });
  };

  useEffect(() => {
    if (!notch.widgets.shelf || !hasTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setShelfDrag(true);
            setActiveTab((tab) => (tab == null ? "shelf" : tab));
          } else if (event.payload.type === "drop") {
            setShelfDrag(false);
            addShelfPaths(event.payload.paths);
            setActiveTab("shelf");
          } else {
            setShelfDrag(false);
          }
        }),
      )
      .then((un) => {
        if (cancelled) un?.();
        else unlisten = un ?? undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notch.widgets.shelf]);

  const cloakActive = notch.cloakActive;
  const clockOn = modules.clock;
  const todoOn = modules.todo;
  const statusbarOn = modules.statusbar;
  const cloakInitialized = useRef(false);
  useEffect(() => {
    if (!hasTauri()) return;
    // Do not force-show overlays on the first render: the settings window's
    // startup coordinator still owns the reveal order. Only an active cloak
    // needs to be applied immediately at boot.
    if (!cloakInitialized.current) {
      cloakInitialized.current = true;
      if (!cloakActive) return;
    }
    void invoke("cloak_apply", {
      active: cloakActive,
      modules: [
        ...(clockOn ? ["clock"] : []),
        ...(todoOn ? ["todo"] : []),
        ...(statusbarOn ? ["statusbar"] : []),
      ],
    }).then(() => {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit("aura:cloak", { active: cloakActive }))
        .catch(() => {});
    });
  }, [cloakActive, clockOn, todoOn, statusbarOn]);

  useEffect(() => {
    if (!hasTauri()) return;
    const monitor = ownMonitor ?? winConf.monitor;
    void invoke("edge_light_apply", {
      active: notch.edgeLightActive,
      monitor: monitor ? [monitor.x, monitor.y] : null,
    });
  }, [notch.edgeLightActive, ownMonitor?.x, ownMonitor?.y, winConf.monitor?.x, winConf.monitor?.y]);

  // -------------------------------------------------------------- focus timer
  const [timer, setTimer] = useState<TimerState>(INITIAL_TIMER);

  useEffect(() => {
    if (!timer.running || timer.endAt == null) return;
    const tick = () => {
      const left = (timer.endAt as number) - Date.now();
      if (left <= 0) {
        void invoke("notch_chime");
        setTimer((t) => (t.running ? { ...t, running: false, leftMs: 0, endAt: null, finished: true } : t));
      } else {
        setTimer((t) => (t.running ? { ...t, leftMs: left } : t));
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [timer.running, timer.endAt]);

  // Finished sessions dismiss themselves back to "ready" after 90s.
  useEffect(() => {
    if (!timer.finished) return;
    const id = window.setTimeout(() => setTimer(INITIAL_TIMER), 90_000);
    return () => window.clearTimeout(id);
  }, [timer.finished]);

  const startTimer = (minutes: number) =>
    setTimer({
      running: true,
      totalMs: minutes * 60_000,
      leftMs: minutes * 60_000,
      endAt: Date.now() + minutes * 60_000,
      finished: false,
    });

  const toggleTimer = () =>
    setTimer((t) => {
      if (t.finished || t.totalMs === 0) return t;
      if (t.running && t.endAt != null) {
        return { ...t, running: false, leftMs: Math.max(0, t.endAt - Date.now()), endAt: null };
      }
      return { ...t, running: true, endAt: Date.now() + t.leftMs };
    });

  const extendTimer = (minutes: number) =>
    setTimer((t) => {
      if (t.finished || t.totalMs === 0) return t;
      const add = minutes * 60_000;
      if (t.running && t.endAt != null) {
        return { ...t, totalMs: t.totalMs + add, leftMs: t.leftMs + add, endAt: t.endAt + add };
      }
      return { ...t, totalMs: t.totalMs + add, leftMs: t.leftMs + add };
    });

  // ------------------------------------------------------------ open / close
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const closeAnim = useRef(0);
  const clearTimers = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };

  /** Play the panel out before the native window shrinks back to the pill. */
  const cancelCollapse = () => {
    window.clearTimeout(closeAnim.current);
    setClosing(false);
  };

  const collapse = () => {
    if (activeTab === null) return;
    setClosing(true);
    window.clearTimeout(closeAnim.current);
    closeAnim.current = window.setTimeout(() => {
      setActiveTab(null);
      setClosing(false);
    }, 170);
  };

  const openHome = () => {
    cancelCollapse();
    clearTimers();
    if (!notch.openOnHover || activeTab !== null) return;
    openTimer.current = window.setTimeout(
      () => setActiveTab("home"),
      Math.max(0, notch.animation.hoverDelay),
    );
  };

  const closeSoon = () => {
    clearTimers();
    if (pinned) return;
    // Smart-Notch lesson: never collapse while the user is typing in a panel
    // (adding a task, searching apps). Escape / the dot / Close still work.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".notch-panel")) return;
    closeTimer.current = window.setTimeout(
      () => collapse(),
      Math.max(0, notch.animation.closeDelay),
    );
  };

  const closePanel = () => {
    clearTimers();
    setPinned(false);
    collapse();
  };

  /** Collapsed chips deep-link into their panel (Smart Notch behaviour). */
  const openTab = (key: PanelKey) => {
    cancelCollapse();
    clearTimers();
    setActiveTab(key);
  };

  useEffect(
    () => () => {
      clearTimers();
      window.clearTimeout(closeAnim.current);
    },
    [],
  );

  // ------------------------------------------------------------ geometry
  // Geometry is intentionally fixed to the user's length/thickness. Chips,
  // media titles and panel content must not resize the native window.

  // Push geometry to the native window (manual coordinates win instead).
  // Duplicated windows are anchored by the backend on their own display.
  const manualPos = winConf.x != null && winConf.y != null && !ownMonitor;
  /* The native window is revealed before this page measures itself. Painting
   * first showed the pill at the window's default spot (a few pixels in from
   * the top-left) and then moved it into place, which looked like the notch
   * dropping off the top edge. Keep it blank until the layout has landed. */
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void invoke("notch_apply_layout", {
      layout: notch.layout,
      placement: notch.placement,
      length: notch.length,
      thickness: notch.thickness,
      expanded,
      label: windowLabel,
      monitor: ownMonitor
        ? [ownMonitor.x, ownMonitor.y]
        : winConf.monitor
          ? [winConf.monitor.x, winConf.monitor.y]
          : null,
    }).then(() => {
      if (cancelled) return;
      setPlaced(true);
      // Layout owns size; a configured manual position wins over its placement.
      // While the panel is expanded the manual position would pin its left edge
      // and the wider panel would grow out to the right, so the layout's own
      // edge placement (centred on a centre anchor) owns that frame.
      if (!manualPos || expanded) return;
      void invoke("window_apply", {
        label: windowLabel,
        x: winConf.x,
        y: winConf.y,
        monitor: winConf.monitor ? [winConf.monitor.x, winConf.monitor.y] : null,
      });
    }).catch(() => {
      // Never leave the notch invisible because a placement call failed.
      if (!cancelled) setPlaced(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    notch.layout,
    notch.placement,
    notch.length,
    notch.thickness,
    expanded,
    manualPos,
    winConf.monitor?.x,
    winConf.monitor?.y,
    displayVersion,
  ]);

  // ------------------------------------------------------------------ render
  const timerPresets = notch.timerPresets.length > 0 ? notch.timerPresets : DEFAULT_TIMER_PRESETS;
  const hidden = notch.hideOnFullscreen && fullscreen;

  const clearNotchSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    window.getSelection()?.removeAllRanges();
  };

  // CSS can hide the content in fullscreen, but the native topmost window is
  // still there and would swallow clicks over the game/app. Make the native
  // window click-through too while hidden.
  useEffect(() => {
    if (!hasTauri()) return;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow()
          .setIgnoreCursorEvents(hidden || winConf.clickThrough)
          .catch(() => {}),
      )
      .catch(() => {});
  }, [hidden, winConf.clickThrough]);

  const memPct = sys && sys.memTotalGb > 0 ? Math.min(100, (sys.memUsedGb / sys.memTotalGb) * 100) : 0;
  const mediaPlaying = media?.status === "playing";
  const mediaProgress =
    media && media.durationMs > 0 ? Math.min(100, (media.positionMs / media.durationMs) * 100) : null;
  const h = now.getHours();
  const hh = clockFmt12h
    ? String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")
    : String(h).padStart(2, "0");
  const clockText = `${hh}:${String(now.getMinutes()).padStart(2, "0")}`;
  const ampm = clockFmt12h ? (h < 12 ? "AM" : "PM") : "";

  const tabKeys = enabledWidgets;

  if (!placed) return null;

  return (
    <div
      className={`notch-root${expanded ? " expanded" : ""}${hidden ? " module-hidden" : ""}`}
      data-placement={notch.placement}
      style={
        {
          "--notch-thickness": `${notch.thickness}px`,
          ...moduleBackground(notch.bgTransparency, true),
        } as CSSProperties
      }
      onMouseEnter={openHome}
      onMouseLeave={closeSoon}
      onPointerDown={clearNotchSelection}
      onPointerUp={clearNotchSelection}
      onKeyDown={(e) => {
        if (e.key === "Escape") closePanel();
      }}
      tabIndex={-1}
    >
      <div className="notch-bar">
        {/* Artwork-led pill, the way NotchPixel's island reads at a glance. */}
        <button
          className="notch-lead"
          title={winConf.draggable ? "Drag to move" : undefined}
          aria-label="Notch"
          onPointerDown={winConf.draggable ? dragHandle : undefined}
          onClick={() => (activeTab ? closePanel() : openTab("home"))}
        >
          {notch.collapsed.showMedia && art ? (
            <img className="notch-lead-art" src={art} alt="" />
          ) : (
            <span className="notch-lead-orb" />
          )}
        </button>
        {notch.collapsed.showMedia && media?.title ? (
          <button
            className="notch-now"
            aria-label={`Now playing ${media.title}${media.artist ? ` by ${media.artist}` : ""}`}
            onClick={() => openTab("media")}
          >
            <span className="notch-now-title">{media.title}</span>
            <span className="notch-now-artist">
              {media.artist || (mediaPlaying ? "Playing" : "Paused")}
            </span>
          </button>
        ) : (
          notch.collapsed.showName && (
            <span className="notch-now">
              <span className="notch-now-title">Aura</span>
              <span className="notch-now-artist">Notch</span>
            </span>
          )
        )}
        <span className="notch-metrics">
          {notch.collapsed.showTimer && timer.totalMs > 0 && (
            <button className="notch-chip" title="Focus timer" onClick={() => openTab("timer")}>
              {timer.finished ? "done" : formatTime(timer.leftMs)}
            </button>
          )}
          {notch.collapsed.showMem && (
            <button
              className="notch-chip"
              title={`Memory ${memPct.toFixed(0)}% — open monitors`}
              onClick={() => openTab("monitors")}
            >
              RAM {memPct.toFixed(0)}%
            </button>
          )}
          {notch.collapsed.showNet && (
            <button
              className="notch-chip"
              title="Download rate — open monitors"
              onClick={() => openTab("monitors")}
            >
              ↓ {formatRate(sys?.netDownBps ?? 0)}
            </button>
          )}
          {notch.collapsed.showClock && (
            <span className="notch-clock">
              {clockText}
              {ampm ? ` ${ampm}` : ""}
            </span>
          )}
        </span>
        {notch.collapsed.showMedia && mediaPlaying && (
          <span className="notch-eq" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </div>

      {expanded && (
        <div className={`notch-panel${closing ? " closing" : ""}`}>
          <div className="notch-nav">
            <div className="notch-tabs">
              <button
                className={activeTab === "home" ? "active" : ""}
                title="Home"
                aria-label="Home"
                onClick={() => setActiveTab("home")}
              >
                <NotchGlyph icon="home" />
              </button>
              {tabKeys.map((key) => (
                <button
                  key={key}
                  className={activeTab === key ? "active" : ""}
                  title={NOTCH_MODULE_LABELS[key]}
                  aria-label={NOTCH_MODULE_LABELS[key]}
                  onClick={() => setActiveTab((t) => (t === key ? "home" : key))}
                >
                  <NotchGlyph icon={NOTCH_WIDGET_GLYPH[key]} />
                </button>
              ))}
            </div>
            <div className="notch-actions">
              <button
                className={pinned ? "active" : ""}
                onClick={() => setPinned((p) => !p)}
                title="Keep the notch open"
                aria-label="Keep the notch open"
              >
                <NotchGlyph icon="pin" size={16} />
              </button>
              <button onClick={closePanel} title="Close" aria-label="Close">
                <NotchGlyph icon="close" size={16} />
              </button>
            </div>
          </div>

          {activeTab === "home" ? (
            <div className="notch-home">
              {tabKeys.map((key) => (
                <div
                  key={key}
                  className="notch-cell"
                  style={{ "--notch-scale": notch.moduleScale[key] } as CSSProperties}
                >
                  {renderWidget(key)}
                </div>
              ))}
              {tabKeys.length === 0 && <div className="notch-empty">No widgets enabled.</div>}
            </div>
          ) : activeTab ? (
            <div
              className="notch-detail"
              style={{ "--notch-scale": notch.moduleScale[activeTab] } as CSSProperties}
            >
              {renderWidget(activeTab)}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  function renderWidget(key: NotchWidgetKey) {
    switch (key) {
      case "run":
        return (
          <RunWidget
            apps={apps}
            autoFocus={activeTab === "run"}
            onRescan={() => {
              if (!hasTauri()) return;
              void invoke("rescan_apps").then(() => setAppsBump((n) => n + 1));
            }}
          />
        );
      case "media":
        return (
          <MediaWidget
            media={media}
            art={art}
            playing={mediaPlaying}
            progress={mediaProgress}
          />
        );
      case "musicLights":
        return <MusicLightsWidget media={media} playing={mediaPlaying} />;
      case "monitors":
        return <MonitorsWidget sys={sys} />;
      case "volume":
        return (
          <VolumeMixerWidget
            sessions={audio}
            onVolume={(id, volume) => {
              setAudio((list) => list.map((s) => (s.id === id ? { ...s, volume } : s)));
              window.clearTimeout(volumeSends.current[id]);
              volumeSends.current[id] = window.setTimeout(
                () => void invoke("set_audio_session", { id, volume, muted: null }),
                120,
              );
            }}
            onMute={(id, muted) => {
              setAudio((list) => list.map((s) => (s.id === id ? { ...s, muted } : s)));
              void invoke("set_audio_session", { id, volume: null, muted });
            }}
          />
        );
      case "shelf":
        return (
          <ShelfWidget
            items={notch.shelf}
            dragging={shelfDrag}
            onAddText={addShelfText}
            onAddClipboard={() => {
              void invoke<ClipboardEntry[]>("get_clipboard_history").then((entries) => {
                const latest = entries?.[0]?.text;
                if (latest) addShelfText(latest);
              });
            }}
            onRemove={(id) =>
              update({ notch: { shelf: notch.shelf.filter((item) => item.id !== id) } })
            }
            onOpen={(item) => {
              if (item.kind === "text") void invoke("copy_clipboard_text", { text: item.target });
              else void invoke("open_shortcut", { target: item.target });
            }}
          />
        );
      case "downloads":
        return <DownloadsWidget downloads={downloads} />;
      case "cloak":
        return (
          <CloakWidget
            active={notch.cloakActive}
            onToggle={() => update({ notch: { cloakActive: !notch.cloakActive } })}
          />
        );
      case "weather":
        return (
          <WeatherWidget
            weather={weather}
            unit={notch.weatherUnit}
            loading={weatherLoading}
            error={weatherError}
            onRefresh={() => setWeatherBump((n) => n + 1)}
          />
        );
      case "forecast":
        return (
          <ForecastWidget
            weather={weather}
            unit={notch.weatherUnit}
            loading={weatherLoading}
            error={weatherError}
            onRefresh={() => setWeatherBump((n) => n + 1)}
          />
        );
      case "edgeLight":
        return (
          <EdgeLightWidget
            active={notch.edgeLightActive}
            onToggle={() => update({ notch: { edgeLightActive: !notch.edgeLightActive } })}
          />
        );
      case "timer":
        return (
          <div className="notch-section">
            <span className="notch-title">Focus timer</span>
            <div className="notch-timer-row">
              <span>{timer.finished ? "Done" : timer.totalMs > 0 ? formatTime(timer.leftMs) : "Ready"}</span>
              {timerPresets.map((m) => (
                <button key={m} onClick={() => startTimer(m)}>
                  {m}m
                </button>
              ))}
            </div>
            <div className="notch-timer-row">
              <button onClick={toggleTimer} disabled={timer.totalMs === 0 || timer.finished}>
                {timer.running ? "Pause" : "Resume"}
              </button>
              <button onClick={() => extendTimer(5)} disabled={timer.totalMs === 0 || timer.finished}>
                +5m
              </button>
              <button onClick={() => setTimer(INITIAL_TIMER)} disabled={timer.totalMs === 0}>
                Reset
              </button>
            </div>
          </div>
        );
      case "bluetooth":
        return (
          <div className="notch-section">
            <span className="notch-title">Bluetooth devices</span>
            <div className="notch-list">
              {devices.length === 0 && <span className="notch-muted">No devices reported.</span>}
              {devices.map((d, i) => (
                <div className="notch-list-row" key={`${d.name}-${i}`}>
                  <span>{d.name}</span>
                  <span className="notch-muted">
                    {d.battery_percent != null ? `${d.battery_percent}%` : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      case "clipboard":
        return (
          <div className="notch-section">
            <span className="notch-title">Clipboard history</span>
            <div className="notch-list">
              {clipboard.length === 0 && <span className="notch-muted">Nothing copied yet.</span>}
              {clipboard.map((c, i) => (
                <button
                  key={`${c.at_ms}-${i}`}
                  className="notch-list-row"
                  title="Copy this text back to the clipboard"
                  onClick={() => void invoke("copy_clipboard_text", { text: c.text })}
                >
                  <span className="notch-clip-text">{c.text.slice(0, 120)}</span>
                  <span className="notch-muted">{formatAgo(c.at_ms)}</span>
                </button>
              ))}
            </div>
          </div>
        );
      case "shortcuts":
        return (
          <div className="notch-section">
            <span className="notch-title">Quick shortcuts</span>
            <div className="notch-chips">
              {notch.shortcuts.length === 0 && <span className="notch-muted">No shortcuts configured.</span>}
              {notch.shortcuts.map((s, i) => (
                <button
                  key={`${s.target}-${i}`}
                  title={s.target}
                  onClick={() => void invoke("open_shortcut", { target: s.target })}
                >
                  {s.icon ? `${s.icon} ` : ""}
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        );
      default:
        return null;
    }
  }

}

function RunWidget({
  apps,
  autoFocus,
  onRescan,
}: {
  apps: AppInfo[];
  autoFocus: boolean;
  onRescan: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const q = query.trim().toLowerCase();

  const items = useMemo(() => {
    if (!q) return [];
    const starts: AppInfo[] = [];
    const contains: AppInfo[] = [];
    for (const a of apps) {
      const n = a.name.toLowerCase();
      if (n.startsWith(q)) starts.push(a);
      else if (n.includes(q)) contains.push(a);
    }
    const hits = [...starts, ...contains].slice(0, 6).map((a) => ({ name: a.name, target: a.target }));
    const typed = query.trim();
    if (typed) {
      const looksLikeTarget = typed.includes(".") || typed.includes("://") || /^[a-z]:\\/i.test(typed);
      hits.push({
        name: looksLikeTarget ? `Open ${typed}` : `Search the web for "${typed}"`,
        target: typed,
      });
    }
    return hits;
  }, [apps, q, query]);

  useEffect(() => setSel(0), [q]);

  const run = (target: string) => {
    void invoke("open_shortcut", { target });
    setQuery("");
  };

  return (
    <div className="notch-section">
      <span className="notch-title">Run</span>
      <input
        type="text"
        className="notch-run-input"
        placeholder="Search apps or type a URL / path…"
        value={query}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && items[sel]) {
            e.preventDefault();
            run(items[sel].target);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          }
        }}
      />
      {q && (
        <div className="notch-run-list">
          {items.map((it, i) => (
            <button
              key={`${it.target}-${i}`}
              className={i === sel ? "selected" : ""}
              title={it.target}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it.target)}
            >
              {it.name}
            </button>
          ))}
        </div>
      )}
      <button className="notch-rescan" onClick={onRescan}>
        Re-scan Start Menu
      </button>
    </div>
  );
}

function MediaWidget({
  media,
  art,
  playing,
  progress,
}: {
  media: MediaInfo | null;
  art: string | null;
  playing: boolean;
  progress: number | null;
}) {
  if (!media?.title) {
    return (
      <div className="notch-section">
        <span className="notch-muted">Nothing playing.</span>
      </div>
    );
  }
  const elapsed = formatTime(media.positionMs);
  const remaining = `-${formatTime(Math.max(0, media.durationMs - media.positionMs))}`;
  return (
    <div className="notch-section notch-media">
      <div className="notch-media-top">
        <div className="notch-media-artwrap">
          {art ? <img key={art} className="notch-media-art" src={art} alt="" /> : <span className="notch-media-art" />}
          <span className="notch-media-badge" aria-hidden="true">
            <NotchGlyph icon="media" size={13} />
          </span>
        </div>
        <div className="notch-media-copy">
          <strong className="notch-media-title">{media.title}</strong>
          <span className="notch-media-artist">{media.artist || "Unknown artist"}</span>
        </div>
        <div className="notch-media-transport">
          <button
            onClick={() => void invoke("media_skip", { direction: "previous" })}
            title="Previous"
            aria-label="Previous track"
          >
            <NotchGlyph icon="previous" size={20} />
          </button>
          <button
            className="primary"
            onClick={() => void invoke("toggle_media_playback")}
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
          >
            <NotchGlyph icon={playing ? "pause" : "play"} size={24} />
          </button>
          <button
            onClick={() => void invoke("media_skip", { direction: "next" })}
            title="Next"
            aria-label="Next track"
          >
            <NotchGlyph icon="next" size={20} />
          </button>
        </div>
      </div>
      <div className="notch-media-rail">
        <span className="notch-media-time">{elapsed}</span>
        <span className="notch-media-track">
          <span style={{ width: `${progress ?? 0}%` }} />
        </span>
        <span className="notch-media-time">{remaining}</span>
      </div>
    </div>
  );
}

function MusicLightsWidget({ media, playing }: { media: MediaInfo | null; playing: boolean }) {
  return (
    <div className="notch-section">
      <span className="notch-title">Music lights</span>
      <div className={`music-lights${playing ? " is-playing" : ""}`} aria-hidden="true">
        <div className="music-lights-bars">
          {MUSIC_LIGHT_BARS.map((bar, index) => (
            <span
              key={index}
              style={
                {
                  "--bar-peak": bar.peak,
                  "--bar-delay": bar.delay,
                  "--bar-duration": bar.duration,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>
      <div className="music-lights-now">
        <span className={`music-lights-pulse${playing ? " is-playing" : ""}`} aria-hidden="true" />
        <div className="music-lights-copy">
          <strong>{media?.title || "Nothing playing"}</strong>
          <span>
            {media?.title
              ? `${playing ? "Playing" : "Paused"}${media.artist ? ` · ${media.artist}` : ""}`
              : "Play something to wake the lights."}
          </span>
        </div>
      </div>
    </div>
  );
}

function VolumeMixerWidget({
  sessions,
  onVolume,
  onMute,
}: {
  sessions: AudioSessionInfo[];
  onVolume: (id: string, volume: number) => void;
  onMute: (id: string, muted: boolean) => void;
}) {
  return (
    <div className="notch-section">
      <span className="notch-title">Volume mixer</span>
      {sessions.length === 0 && <span className="notch-muted">No audio sessions are active.</span>}
      <div className="notch-volume-list">
        {sessions.map((session) => (
          <div key={session.id} className="notch-volume-row">
            <div className="notch-volume-head">
              <span className="notch-volume-name" title={session.process || session.name}>
                {session.name || "Application"}
              </span>
              <button
                className={session.muted ? "active" : ""}
                title={session.muted ? "Unmute" : "Mute"}
                onClick={() => onMute(session.id, !session.muted)}
              >
                {session.muted ? "Muted" : "Mute"}
              </button>
              <span className="notch-volume-value">{Math.round(session.volume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={session.volume}
              aria-label={`${session.name} volume`}
              onChange={(e) => onVolume(session.id, Number(e.target.value))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ShelfWidget({
  items,
  dragging,
  onAddText,
  onAddClipboard,
  onRemove,
  onOpen,
}: {
  items: ShelfItem[];
  dragging: boolean;
  onAddText: (value: string) => void;
  onAddClipboard: () => void;
  onRemove: (id: string) => void;
  onOpen: (item: ShelfItem) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className={`notch-section notch-shelf${dragging ? " is-dragging" : ""}`}>
      <span className="notch-title">Drop shelf</span>
      <div
        className="notch-shelf-zone"
        onDragEnter={(e) => {
          e.preventDefault();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <strong>{dragging ? "Release to park it" : "Drop files here"}</strong>
        <span>Files open from here; text snippets copy with one click.</span>
      </div>
      <form
        className="notch-shelf-add"
        onSubmit={(e) => {
          e.preventDefault();
          onAddText(draft);
          setDraft("");
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder="File path or snippet…"
          aria-label="Shelf item"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
        <button type="button" title="Add the newest clipboard text" onClick={onAddClipboard}>
          Paste
        </button>
      </form>
      <div className="notch-shelf-list">
        {items.length === 0 && <span className="notch-muted">The shelf is empty.</span>}
        {items.map((item) => (
          <div className="notch-shelf-row" key={item.id}>
            <button
              className="notch-shelf-item"
              title={item.kind === "text" ? `Copy: ${item.target}` : item.target}
              onClick={() => onOpen(item)}
            >
              <span className="notch-shelf-kind">{item.kind === "text" ? "TXT" : "FILE"}</span>
              <span className="notch-shelf-name">{item.name}</span>
            </button>
            <button
              className="notch-shelf-remove"
              title="Remove from shelf"
              aria-label={`Remove ${item.name}`}
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DownloadsWidget({ downloads }: { downloads: DownloadInfo[] }) {
  return (
    <div className="notch-section">
      <span className="notch-title">Downloads</span>
      {downloads.length === 0 && (
        <span className="notch-muted">No downloads in progress. Watching your Downloads folder.</span>
      )}
      <div className="notch-download-list">
        {downloads.map((item) => (
          <div className="notch-download" key={item.path}>
            <div className="notch-download-head">
              <span title={item.path}>{item.name}</span>
              <span>{formatBytes(item.bytes)}</span>
            </div>
            <span className="notch-download-track" aria-label="Downloading">
              <i />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CloakWidget({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <div className="notch-section">
      <span className="notch-title">Invisibility cloak</span>
      <span className="notch-muted">
        {active
          ? "Clock, to-do and status bar are hidden. Exit the cloak from this notch."
          : "Hide your desktop overlays for a clean screen while presenting or recording."}
      </span>
      <button className={active ? "notch-action active" : "notch-action"} onClick={onToggle}>
        {active ? "Exit cloak" : "Enter cloak"}
      </button>
    </div>
  );
}

function EdgeLightWidget({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <div className="notch-section">
      <span className="notch-title">Edge light</span>
      <span className="notch-muted">
        A soft animated glow around the screen edge — useful as a video-call light and a focus cue.
      </span>
      <button className={active ? "notch-action active" : "notch-action"} onClick={onToggle}>
        {active ? "Turn edge light off" : "Turn edge light on"}
      </button>
    </div>
  );
}

function displayTemp(celsius: number, unit: "c" | "f"): string {
  return `${Math.round(unit === "f" ? (celsius * 9) / 5 + 32 : celsius)}°`;
}

function WeatherWidget({
  weather,
  unit,
  loading,
  error,
  onRefresh,
}: {
  weather: WeatherSnapshot | null;
  unit: "c" | "f";
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const today = weather?.daily[0];
  return (
    <div className="notch-section">
      <span className="notch-title">Weather</span>
      {!weather && loading && <span className="notch-muted">Loading weather…</span>}
      {!weather && !loading && error && (
        <>
          <span className="notch-muted">{error}</span>
          <button onClick={onRefresh}>Retry</button>
        </>
      )}
      {weather && (
        <>
          <div className="notch-weather-now">
            <span className="notch-weather-symbol" aria-hidden="true">
              {weatherSymbol(weather.code)}
            </span>
            <div className="notch-weather-temp">
              <strong>{displayTemp(weather.tempC, unit)}</strong>
              <span>{weatherLabel(weather.code)}</span>
            </div>
            <div className="notch-weather-place">
              <strong>{weather.city}</strong>
              <span>
                Feels {displayTemp(weather.feelsC, unit)}
                {today ? ` · ${displayTemp(today.minC, unit)} / ${displayTemp(today.maxC, unit)}` : ""}
              </span>
            </div>
          </div>
          <div className="notch-weather-meta">
            <span>Humidity {Math.round(weather.humidity)}%</span>
            <span>Wind {Math.round(weather.windKph)} km/h</span>
            <button className="notch-link-button" onClick={onRefresh} disabled={loading}>
              {loading ? "…" : "Refresh"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ForecastWidget({
  weather,
  unit,
  loading,
  error,
  onRefresh,
}: {
  weather: WeatherSnapshot | null;
  unit: "c" | "f";
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const now = Date.now();
  const hours = (weather?.hourly ?? []).filter((hour) => new Date(hour.time).getTime() >= now).slice(0, 8);
  return (
    <div className="notch-section">
      <span className="notch-title">Weather forecast</span>
      {!weather && loading && <span className="notch-muted">Loading forecast…</span>}
      {!weather && !loading && error && (
        <>
          <span className="notch-muted">{error}</span>
          <button onClick={onRefresh}>Retry</button>
        </>
      )}
      {weather && (
        <>
          <span className="notch-muted">{weather.city} · next 8 hours</span>
          <div className="notch-forecast-hours">
            {hours.map((hour) => (
              <div className="notch-forecast-hour" key={hour.time}>
                <span>{new Date(hour.time).toLocaleTimeString([], { hour: "numeric" })}</span>
                <span aria-hidden="true">{weatherSymbol(hour.code)}</span>
                <strong>{displayTemp(hour.tempC, unit)}</strong>
              </div>
            ))}
          </div>
          <div className="notch-forecast-days">
            {weather.daily.map((day, index) => (
              <div className="notch-forecast-day" key={day.date}>
                <span>
                  {index === 0
                    ? "Today"
                    : new Date(`${day.date}T12:00:00`).toLocaleDateString([], { weekday: "short" })}
                </span>
                <span aria-hidden="true">{weatherSymbol(day.code)}</span>
                <strong>
                  {displayTemp(day.maxC, unit)} / {displayTemp(day.minC, unit)}
                </strong>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MonitorsWidget({ sys }: { sys: SystemSnapshot | null }) {
  const memPct = sys && sys.memTotalGb > 0 ? (sys.memUsedGb / sys.memTotalGb) * 100 : 0;
  return (
    <div className="notch-section">
      <span className="notch-title">System monitors</span>
      <div className="notch-metric">
        <span>CPU</span>
        <strong>{sys ? `${sys.cpuPercent.toFixed(0)}%` : "—"}</strong>
      </div>
      <progress className="notch-meter" max={100} value={sys?.cpuPercent ?? 0} />
      <div className="notch-metric">
        <span>RAM</span>
        <strong>
          {sys ? `${sys.memUsedGb.toFixed(1)} / ${sys.memTotalGb.toFixed(1)} GB` : "—"}
        </strong>
      </div>
      <progress className="notch-meter" max={100} value={memPct} />
      <div className="notch-net">
        <span>↓ {formatRate(sys?.netDownBps ?? 0)}</span>
        <span>↑ {formatRate(sys?.netUpBps ?? 0)}</span>
      </div>
    </div>
  );
}
