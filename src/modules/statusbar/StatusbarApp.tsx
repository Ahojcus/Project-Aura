import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useModuleWindow, useSettings } from "../../store/settings";
import {
  formatRate,
  getWindowLabel,
  hasTauri,
  invoke,
  windowMonitor,
  type BtDevice,
  type MediaInfo,
  type SystemSnapshot,
} from "../../lib/bridge";
import { useDisplaysVersion, useFullscreen } from "../../lib/runtime";

interface PowerStatus {
  percent: number | null;
  charging: boolean;
  hasBattery: boolean;
}

interface ActiveWindowInfo {
  title: string;
  className: string;
}

interface MasterVolume {
  volume: number;
  muted: boolean;
}

interface DownloadInfo {
  name: string;
  path: string;
  bytes: number;
  modifiedMs: number;
}

interface WeatherNow {
  city: string;
  tempC: number;
  code: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function truncate(text: string, max = 28): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

async function fetchWeather(location: string, signal: AbortSignal): Promise<WeatherNow> {
  const typed = location.trim();
  let place: { lat: number; lon: number; city: string };
  const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(typed);
  if (coords) {
    place = { lat: Number(coords[1]), lon: Number(coords[2]), city: "Pinned location" };
  } else if (typed) {
    const geo = await fetchJson<{
      results?: { name: string; latitude: number; longitude: number }[];
    }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(typed)}&count=1&language=en&format=json`,
      signal,
    );
    const hit = geo.results?.[0];
    if (!hit) throw new Error(`No weather location named “${typed}”`);
    place = { lat: hit.latitude, lon: hit.longitude, city: hit.name };
  } else {
    const providers: (() => Promise<{ lat: number; lon: number; city: string }>)[] = [
      async () => {
        const ip = await fetchJson<{ city?: string; latitude?: number; longitude?: number }>(
          "https://geolocation-db.com/json/",
          signal,
        );
        if (ip.latitude == null || ip.longitude == null) throw new Error("No coordinates");
        return { lat: ip.latitude, lon: ip.longitude, city: ip.city || "My location" };
      },
      async () => {
        const ip = await fetchJson<{ city?: string; latitude?: number; longitude?: number }>(
          "https://ipapi.co/json/",
          signal,
        );
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
    let detected: { lat: number; lon: number; city: string } | null = null;
    for (const provider of providers) {
      try {
        detected = await provider();
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
      }
    }
    if (!detected) {
      throw new Error(
        `Could not detect a location${lastError instanceof Error ? `: ${lastError.message}` : ""}. Set one in Settings → Status Bar.`,
      );
    }
    place = detected;
  }
  const data = await fetchJson<{
    current: { temperature_2m: number; weather_code: number };
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      "&current=temperature_2m,weather_code&timezone=auto",
    signal,
  );
  return { city: place.city, tempC: data.current.temperature_2m, code: data.current.weather_code };
}

function weatherSymbol(code: number): string {
  if (code === 0) return "☀";
  if (code <= 3) return "⛅";
  if (code === 45 || code === 48) return "☁";
  if (code >= 51 && code <= 67) return "☂";
  if (code >= 71 && code <= 86) return "❄";
  if (code >= 95) return "⛈";
  return "☁";
}

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
  return "Cloudy";
}

export function StatusbarApp() {
  const bar = useSettings((s) => s.settings.statusbar);
  const moduleOn = useSettings((s) => s.settings.modules.statusbar);
  const format12h = useSettings((s) => s.settings.clock.format12h);
  const winConf = bar.win;
  const windowLabel = getWindowLabel();
  const ownMonitor = windowMonitor(windowLabel);
  useModuleWindow("statusbar");

  const [sys, setSys] = useState<SystemSnapshot | null>(null);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [power, setPower] = useState<PowerStatus | null>(null);
  const [volume, setVolume] = useState<MasterVolume | null>(null);
  const [active, setActive] = useState<ActiveWindowInfo | null>(null);
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const [weather, setWeather] = useState<WeatherNow | null>(null);
  const [weatherError, setWeatherError] = useState("");
  const [cloaked, setCloaked] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const fullscreen = useFullscreen(ownMonitor ?? winConf.monitor ?? null);
  const hidden = bar.hideOnFullscreen && fullscreen;
  const displayVersion = useDisplaysVersion();

  const clearBarSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    window.getSelection()?.removeAllRanges();
  };

  // The cloak hides this native window and releases its AppBar edge. When the
  // cloak lifts, re-run the layout so Explorer reserves the strip again.
  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ active: boolean }>("aura:cloak", ({ payload }) => setCloaked(payload.active)),
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
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const needsSystem =
    bar.chips.cpu || bar.chips.ram || bar.chips.disk || bar.chips.temp || bar.chips.net || bar.chips.uptime;

  useEffect(() => {
    if (!needsSystem) return;
    const tick = () => void invoke<SystemSnapshot>("get_system_info").then(setSys);
    tick();
    const id = window.setInterval(tick, 1500);
    return () => window.clearInterval(id);
  }, [needsSystem]);

  useEffect(() => {
    if (!bar.chips.media) return;
    const tick = () => void invoke<MediaInfo>("get_media_info").then(setMedia);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [bar.chips.media]);

  // YASB-style battery chip (AC-only desktops report no battery).
  useEffect(() => {
    if (!bar.chips.battery) {
      setPower(null);
      return;
    }
    const tick = () => void invoke<PowerStatus>("get_power_status").then(setPower);
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [bar.chips.battery]);

  // Master output volume chip.
  useEffect(() => {
    if (!bar.chips.volume) {
      setVolume(null);
      return;
    }
    const tick = () => void invoke<MasterVolume>("get_master_volume").then(setVolume);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [bar.chips.volume]);

  // YASB-style active-window chip.
  useEffect(() => {
    if (!bar.chips.window) {
      setActive(null);
      return;
    }
    const tick = () => void invoke<ActiveWindowInfo>("get_active_window").then(setActive);
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [bar.chips.window]);

  // Connected Bluetooth device batteries.
  useEffect(() => {
    if (!bar.chips.bluetooth) {
      setDevices([]);
      return;
    }
    const tick = () => void invoke<BtDevice[]>("get_bluetooth_battery").then((v) => setDevices(v ?? []));
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, [bar.chips.bluetooth]);

  // Browser partial downloads in the user's Downloads folder.
  useEffect(() => {
    if (!bar.chips.downloads) {
      setDownloads([]);
      return;
    }
    const tick = () => void invoke<DownloadInfo[]>("get_downloads").then((v) => setDownloads(v ?? []));
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [bar.chips.downloads]);

  // Current conditions for the weather chip, refreshed every 15 minutes.
  useEffect(() => {
    if (!bar.chips.weather) {
      setWeather(null);
      setWeatherError("");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchWeather(bar.weatherLocation, controller.signal);
        if (!cancelled) {
          setWeather(next);
          setWeatherError("");
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setWeatherError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void load();
    const id = window.setInterval(load, 15 * 60_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [bar.chips.weather, bar.weatherLocation]);

  // Geometry: edge placement, thickness and side inset. A configured manual
  // position is re-applied after the bar lays itself out. The display version
  // re-runs this after a monitor hotplug.
  const manualPos = winConf.x != null && winConf.y != null && !ownMonitor;
  useEffect(() => {
    let cancelled = false;
    void invoke("statusbar_apply_layout", {
      placement: bar.placement,
      thickness: bar.thickness,
      inset: bar.inset,
      label: windowLabel,
      reserveEdge: moduleOn && !hidden && !cloaked,
      monitor: ownMonitor
        ? [ownMonitor.x, ownMonitor.y]
        : winConf.monitor
          ? [winConf.monitor.x, winConf.monitor.y]
          : null,
    }).then(() => {
      if (cancelled || !manualPos) return;
      void invoke("window_apply", {
        label: windowLabel,
        x: winConf.x,
        y: winConf.y,
        monitor: winConf.monitor ? [winConf.monitor.x, winConf.monitor.y] : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    bar.placement,
    bar.thickness,
    bar.inset,
    winConf.monitor?.x,
    winConf.monitor?.y,
    manualPos,
    winConf.x,
    winConf.y,
    moduleOn,
    hidden,
    cloaked,
    displayVersion,
  ]);

  const h = now.getHours();
  const hh = format12h
    ? String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")
    : String(h).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ampm = format12h ? (h < 12 ? "AM" : "PM") : "";
  const time = `${hh}:${mm}${bar.showSeconds ? ":" + ss : ""}${ampm ? " " + ampm : ""}`;
  const date = `${WEEKDAYS[now.getDay()]} ${MONTHS[now.getMonth()]} ${now.getDate()}`;

  const cpu = sys?.cpuPercent ?? 0;
  const memPct = sys && sys.memTotalGb > 0 ? Math.min(100, (sys.memUsedGb / sys.memTotalGb) * 100) : 0;
  const diskPct =
    sys && sys.diskTotalGb > 0 ? Math.min(100, (sys.diskUsedGb / sys.diskTotalGb) * 100) : 0;
  const uptime = sys?.uptimeSecs ?? 0;
  const playing = media?.status === "playing";
  const progress = media && media.durationMs > 0 ? (media.positionMs / media.durationMs) * 100 : null;
  const bluetooth = devices[0];
  const weatherTemp = weather
    ? Math.round(bar.weatherUnit === "f" ? (weather.tempC * 9) / 5 + 32 : weather.tempC)
    : null;

  // Hiding the webview content is not enough: the native topmost strip still
  // intercepts pointer input over a fullscreen app. Let clicks pass through
  // while hidden, then restore the configured interaction state.
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

  return (
    <div
      className={`sb-root ${bar.placement}${hidden ? " module-hidden" : ""}`}
      style={{ "--sb-thick": `${bar.thickness}px` } as CSSProperties}
    >
      <div className="sb-bar" onPointerDown={clearBarSelection} onPointerUp={clearBarSelection}>
        <span
          className="sb-handle"
          title={winConf.draggable ? "Drag to move" : undefined}
          onPointerDown={
            winConf.draggable
              ? (e) => {
                  if (!hasTauri()) return;
                  e.preventDefault();
                  void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
                    getCurrentWebviewWindow().startDragging(),
                  );
                }
              : undefined
          }
        >
          ⋮⋮
        </span>

        <div className="sb-zone">
          {bar.chips.cpu && (
            <span className="sb-chip" title={`CPU load ${cpu.toFixed(1)}%`}>
              <span className="sb-label">CPU</span> {cpu.toFixed(0)}%
            </span>
          )}
          {bar.chips.ram && (
            <span
              className="sb-chip"
              title={`Memory ${sys?.memUsedGb.toFixed(1) ?? "?"} / ${sys?.memTotalGb.toFixed(1) ?? "?"} GB`}
            >
              <span className="sb-label">RAM</span> {memPct.toFixed(0)}%
            </span>
          )}
          {bar.chips.disk && (sys?.diskTotalGb ?? 0) > 0 && (
            <span
              className="sb-chip"
              title={`System disk ${sys?.diskUsedGb.toFixed(1)} / ${sys?.diskTotalGb.toFixed(1)} GB used`}
            >
              <span className="sb-label">DISK</span> {diskPct.toFixed(0)}%
            </span>
          )}
          {bar.chips.temp && sys?.cpuTempC != null && (
            <span className="sb-chip" title={`CPU temperature ${Math.round(sys.cpuTempC)} °C`}>
              <span className="sb-label">TEMP</span> {Math.round(sys.cpuTempC)}°C
            </span>
          )}
          {bar.chips.net && (
            <span
              className="sb-chip"
              title={`Down ${formatRate(sys?.netDownBps ?? 0)} · Up ${formatRate(sys?.netUpBps ?? 0)}`}
            >
              <span className="sb-label">NET</span> ↓ {formatRate(sys?.netDownBps ?? 0)} ↑{" "}
              {formatRate(sys?.netUpBps ?? 0)}
            </span>
          )}
          {bar.chips.volume && volume && (
            <span
              className="sb-chip"
              title={`Output volume ${Math.round(volume.volume * 100)}%${volume.muted ? " (muted)" : ""}`}
            >
              <span className="sb-label">VOL</span>{" "}
              {volume.muted ? "MUTE" : `${Math.round(volume.volume * 100)}%`}
            </span>
          )}
          {bar.chips.battery && power && (
            <span
              className="sb-chip"
              title={
                power.hasBattery
                  ? `Battery ${power.percent ?? "?"}%${power.charging ? " (charging)" : ""}`
                  : "No battery (AC power)"
              }
            >
              <span className="sb-label">BAT</span>{" "}
              {power.hasBattery ? `${power.percent ?? "?"}%` : "AC"}
              {power.hasBattery && power.charging ? " ⚡" : ""}
            </span>
          )}
          {bar.chips.window && active?.title && (
            <span className="sb-chip sb-window" title={`${active.title} — ${active.className}`}>
              <span className="sb-label">WINDOW</span>{" "}
              <span className="sb-track">{truncate(active.title, 40)}</span>
            </span>
          )}
          {bar.chips.bluetooth && bluetooth && (
            <span
              className="sb-chip"
              title={devices
                .map((d) => `${d.name}: ${d.battery_percent != null ? `${d.battery_percent}%` : "battery unknown"}`)
                .join(" · ")}
            >
              <span className="sb-label">BT</span>{" "}
              {bluetooth.battery_percent != null ? `${bluetooth.battery_percent}%` : devices.length}
            </span>
          )}
          {bar.chips.downloads && downloads.length > 0 && (
            <span
              className="sb-chip"
              title={`${downloads[0].name} — ${formatBytes(downloads[0].bytes)} downloaded${
                downloads.length > 1 ? ` · ${downloads.length} active` : ""
              }`}
            >
              <span className="sb-label">DL</span> {downloads.length}
            </span>
          )}
        </div>

        <div className="sb-zone">
          {bar.chips.media && media?.title && (
            <button
              className="sb-chip"
              title={`${media.title} — ${media.artist} (${playing ? "pause" : "play"})`}
              onClick={() => void invoke("toggle_media_playback")}
            >
              <span className="sb-label">{playing ? "Pause" : "Play"}</span>
              <span className="sb-track">{truncate(media.title)}</span>
              {progress != null && <span className="sb-label">{Math.round(progress)}%</span>}
            </button>
          )}
          {bar.chips.weather && (
            <span
              className="sb-chip"
              title={
                weather
                  ? `${weather.city} · ${weatherLabel(weather.code)}`
                  : weatherError || "Loading weather…"
              }
            >
              <span className="sb-label">WX</span>{" "}
              {weather && weatherTemp != null
                ? `${weatherSymbol(weather.code)} ${weatherTemp}°`
                : weatherError
                  ? "—"
                  : "…"}
            </span>
          )}
          {bar.chips.uptime && sys && (
            <span className="sb-chip" title={`System uptime ${formatUptime(uptime)}`}>
              <span className="sb-label">UPTIME</span> {formatUptime(uptime)}
            </span>
          )}
          {bar.chips.clock && (
            <span className="sb-chip" title={date}>
              {bar.showDate && <span className="sb-label">{date}</span>} {time}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
