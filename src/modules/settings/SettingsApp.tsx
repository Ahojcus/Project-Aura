import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_NOTCH_MODULE_ORDER,
  DEFAULT_SETTINGS,
  getWallpaperLook,
  useSettings,
  type ModuleKey,
  type NotchWidgetKey,
  type Settings,
  type WallpaperEntry,
  type WallpaperLook,
  type WindowConf,
} from "../../store/settings";
import { hasTauri, invoke, type MonitorInfo } from "../../lib/bridge";

type SectionKey = "general" | "wallpaper" | "clock" | "notch" | "todo" | "statusbar";

const SECTIONS: SectionKey[] = ["general", "wallpaper", "clock", "notch", "todo", "statusbar"];

const SECTION_META: Record<SectionKey, { label: string; description: string; keywords: string }> = {
  general: {
    label: "General",
    description: "Enable modules, control their stacking order, startup and the settings shortcut.",
    keywords: "modules enable order startup boot autostart hotkey shortcut theme accent reset",
  },
  wallpaper: {
    label: "Wallpaper",
    description: "Source, library, per-display assignment, playback and pause behaviour.",
    keywords:
      "wallpaper image video web library display monitor fit scale offset volume mute loop pause duck saturation gamma hue speed",
  },
  clock: {
    label: "Clock",
    description: "Clock layout, timezone and date/time formatting.",
    keywords: "clock time digital analog minimal 12 24 hour timezone date seconds year",
  },
  notch: {
    label: "Smart Notch",
    description: "Widgets, layout, collapsed pill, focus timer and quick shortcuts.",
    keywords:
      "notch widget media music lights volume shelf downloads cloak weather forecast monitors timer bluetooth clipboard shortcuts edge light layout placement length thickness hover",
  },
  todo: {
    label: "To-Do",
    description: "Task categories, defaults and sorting for the to-do widget.",
    keywords: "todo task category priority sort default",
  },
  statusbar: {
    label: "Status Bar",
    description: "Edge placement, chip selection and sizing for the status bar.",
    keywords:
      "statusbar status bar edge top bottom chips cpu ram disk temperature temp volume uptime net media clock date seconds bluetooth downloads weather location",
  },
};

const MODULE_LABELS: Record<ModuleKey, string> = {
  wallpaper: "Wallpaper engine",
  clock: "Clock",
  notch: "Smart notch",
  todo: "To-do",
  statusbar: "Status bar",
};

const LAYERS: WindowConf["level"][] = ["topmost", "normal", "bottommost"];

type NotchModuleIcon =
  | "media"
  | "lights"
  | "volume"
  | "shelf"
  | "clipboard"
  | "download"
  | "cloak"
  | "stats"
  | "weather"
  | "timer"
  | "shortcuts"
  | "light"
  | "run"
  | "bluetooth";

interface NotchModuleOption {
  key: NotchWidgetKey;
  title: string;
  description: string;
  icon: NotchModuleIcon;
}

const NOTCH_MODULE_INFO: Record<NotchWidgetKey, { title: string; description: string; icon: NotchModuleIcon }> = {
  run: {
    title: "App launcher",
    description: "Search and launch apps from the notch.",
    icon: "run",
  },
  media: {
    title: "Now playing",
    description: "Artwork, progress and playback controls.",
    icon: "media",
  },
  musicLights: {
    title: "Music lights",
    description: "Animated bars while something is playing.",
    icon: "lights",
  },
  monitors: {
    title: "System stats",
    description: "CPU, memory and network in one view.",
    icon: "stats",
  },
  timer: {
    title: "Focus timer",
    description: "Work and break sessions with presets.",
    icon: "timer",
  },
  bluetooth: {
    title: "Bluetooth devices",
    description: "Battery levels for connected devices.",
    icon: "bluetooth",
  },
  clipboard: {
    title: "Clipboard History",
    description: "Saved text clips with one-click re-copy.",
    icon: "clipboard",
  },
  shortcuts: {
    title: "Shortcuts",
    description: "Launch apps, files, URLs or shell targets.",
    icon: "shortcuts",
  },
  volume: {
    title: "Volume mixer",
    description: "Per-app volume sliders and quick mute controls.",
    icon: "volume",
  },
  shelf: {
    title: "Drop shelf",
    description: "Drag-and-drop workspace for parking files and snippets.",
    icon: "shelf",
  },
  downloads: {
    title: "Download progress",
    description: "Animated indicator while files are downloading.",
    icon: "download",
  },
  cloak: {
    title: "Invisibility cloak",
    description: "Hide overlays for a distraction-free screen.",
    icon: "cloak",
  },
  weather: {
    title: "Weather",
    description: "Temperature and conditions in the notch.",
    icon: "weather",
  },
  forecast: {
    title: "Weather forecast",
    description: "A weather tab with hourly and seven-day forecasts.",
    icon: "weather",
  },
  edgeLight: {
    title: "Edge light",
    description: "A screen-edge glow for video calls.",
    icon: "light",
  },
};

const NOTCH_MODULE_CATALOG: NotchModuleOption[] = [
  { key: "media", ...NOTCH_MODULE_INFO.media },
  { key: "musicLights", ...NOTCH_MODULE_INFO.musicLights },
  { key: "volume", ...NOTCH_MODULE_INFO.volume },
  { key: "shelf", ...NOTCH_MODULE_INFO.shelf },
  { key: "clipboard", ...NOTCH_MODULE_INFO.clipboard },
  { key: "downloads", ...NOTCH_MODULE_INFO.downloads },
  { key: "cloak", ...NOTCH_MODULE_INFO.cloak },
  { key: "monitors", ...NOTCH_MODULE_INFO.monitors },
  { key: "weather", ...NOTCH_MODULE_INFO.weather },
  { key: "forecast", ...NOTCH_MODULE_INFO.forecast },
  { key: "timer", ...NOTCH_MODULE_INFO.timer },
  { key: "shortcuts", ...NOTCH_MODULE_INFO.shortcuts },
  { key: "edgeLight", ...NOTCH_MODULE_INFO.edgeLight },
  { key: "run", ...NOTCH_MODULE_INFO.run },
  { key: "bluetooth", ...NOTCH_MODULE_INFO.bluetooth },
];

function ModuleGlyph({ name }: { name: NotchModuleIcon }) {
  let icon: React.ReactNode = null;
  switch (name) {
    case "media":
      icon = (
        <>
          <path d="M9 18V6l9-2v12" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="15" cy="16" r="3" />
        </>
      );
      break;
    case "lights":
      icon = <path d="M4 18v-5M8 18V8M12 18V5M16 18v-7M20 18V9" />;
      break;
    case "volume":
      icon = (
        <>
          <path d="M4 7h9M18 7h2M4 17h3M11 17h9" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="8" cy="17" r="2" />
        </>
      );
      break;
    case "shelf":
      icon = (
        <>
          <path d="M4 5h16v13H4z" />
          <path d="M4 12h4l2 2h4l2-2h4" />
        </>
      );
      break;
    case "clipboard":
      icon = (
        <>
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <path d="M9 4V3h6v1M9 9h6M9 13h6M9 17h4" />
        </>
      );
      break;
    case "download":
      icon = <path d="M12 4v10M8 11l4 4 4-4M5 19h14" />;
      break;
    case "cloak":
      icon = <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6ZM4 4l16 16" />;
      break;
    case "stats":
      icon = <path d="M4 17l4-5 3 3 4-7 5 4M4 20h16" />;
      break;
    case "weather":
      icon = (
        <>
          <path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.5A3.5 3.5 0 0 0 7 18Z" />
          <path d="M8 5V3M5 7 3.5 5.5M12 4V2" />
        </>
      );
      break;
    case "timer":
      icon = (
        <>
          <circle cx="12" cy="13" r="7" />
          <path d="M12 13V9M9 3h6" />
        </>
      );
      break;
    case "shortcuts":
      icon = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M7 9h2M13 9h2M7 14h8" />
        </>
      );
      break;
    case "light":
      icon = (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
        </>
      );
      break;
    case "run":
      icon = (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="M16 16l4 4" />
        </>
      );
      break;
    case "bluetooth":
      icon = <path d="M8 7l8 10-4 3V4l4 3L8 17" />;
      break;
  }
  return (
    <span className="notch-module-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon}
      </svg>
    </span>
  );
}

function NotchModuleRow({
  option,
  checked,
  onChange,
}: {
  option: NotchModuleOption;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="notch-module-row">
      <ModuleGlyph name={option.icon} />
      <div className="notch-module-copy">
        <div className="notch-module-heading">
          <strong>{option.title}</strong>
        </div>
        <p>{option.description}</p>
      </div>
      <Toggle label={option.title} checked={checked} onChange={onChange} hideLabel />
    </div>
  );
}

function matchesSection(key: SectionKey, query: string): boolean {
  const meta = SECTION_META[key];
  return (
    meta.label.toLowerCase().includes(query) ||
    meta.description.toLowerCase().includes(query) ||
    meta.keywords.includes(query)
  );
}

function winOf(settings: Settings, key: ModuleKey): WindowConf {
  return settings[key].win;
}

export function SettingsApp() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const setSettings = useSettings((s) => s.setSettings);
  const removeWallpaperDisplay = useSettings((s) => s.removeWallpaperDisplay);

  const [section, setSection] = useState<SectionKey>("general");
  const [query, setQuery] = useState("");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [hotkeyError, setHotkeyError] = useState("");
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void invoke<MonitorInfo[]>("get_monitors").then((list) => setMonitors(list ?? []));
  }, []);

  // A monitor plugged in after the window opened must appear in every display
  // picker without restarting the app.
  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("aura:displays-changed", () => {
          void invoke<MonitorInfo[]>("get_monitors").then((list) => setMonitors(list ?? []));
        }),
      )
      .then((un) => {
        // The window may close before the async import resolves.
        if (cancelled) {
          un?.();
          return;
        }
        unlisten = un ?? null;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Reflect the real OS autostart entry on boot (it may have been changed
  // outside the app since the setting was last written).
  useEffect(() => {
    void invoke<boolean>("autostart_is_enabled").then((actual) => {
      const store = useSettings.getState();
      if (actual != null && actual !== store.settings.launchOnStartup) {
        store.update({ launchOnStartup: actual });
      }
    });
  }, []);

  // Apply the settings hotkey (debounced while typing) and surface backend
  // errors instead of silently leaving the user without a shortcut.
  useEffect(() => {
    if (!hasTauri()) return;
    let alive = true;
    const id = window.setTimeout(() => {
      void import("@tauri-apps/api/core").then(({ invoke: raw }) =>
        raw("app_shortcut_set", {
          enabled: settings.hotkey.enabled,
          combo: settings.hotkey.combo.trim() || null,
        })
          .then(() => {
            if (alive) setHotkeyError("");
          })
          .catch((err: unknown) => {
            if (alive) setHotkeyError(String(err));
          }),
      );
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [settings.hotkey.enabled, settings.hotkey.combo]);

  // Jump to a matching section when searching from somewhere that does not match.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const matches = SECTIONS.filter((key) => matchesSection(key, q));
    if (matches.length > 0 && !matches.includes(section)) setSection(matches[0]);
  }, [query, section]);

  // Filter the option groups inside the active section by their rendered text,
  // so a search reaches individual options, not just section names.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    const groups = Array.from(root.querySelectorAll<HTMLElement>("[data-settings-group]"));
    let shown = 0;
    for (const group of groups) {
      const hit = !q || (group.textContent ?? "").toLowerCase().includes(q);
      group.hidden = !hit;
      if (hit) shown += 1;
    }
    setMatchCount(q ? shown : null);
  }, [query, section, settings]);

  const resetSection = () => {
    const next = structuredClone(settings);
    if (section === "general") {
      next.theme = DEFAULT_SETTINGS.theme;
      next.accent = DEFAULT_SETTINGS.accent;
      next.launchOnStartup = DEFAULT_SETTINGS.launchOnStartup;
      next.modules = structuredClone(DEFAULT_SETTINGS.modules);
      next.moduleOrder = [...DEFAULT_SETTINGS.moduleOrder];
      next.hotkey = { ...DEFAULT_SETTINGS.hotkey };
    } else {
      (next as unknown as Record<string, unknown>)[section] = structuredClone(DEFAULT_SETTINGS[section]);
    }
    setSettings(next);
  };

  const navItems = SECTIONS.filter(
    (key) => !query.trim() || matchesSection(key, query.trim().toLowerCase()),
  );

  return (
    <div className="settings-app">
      <aside className="settings-sidebar">
        <div className="settings-brand">Aura</div>
        <div className="settings-search">
          <input
            type="search"
            value={query}
            placeholder="Search settings…"
            aria-label="Search settings"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav className="settings-nav">
          {navItems.map((key) => (
            <button
              key={key}
              className={section === key ? "active" : ""}
              onClick={() => setSection(key)}
            >
              {SECTION_META[key].label}
            </button>
          ))}
          {navItems.length === 0 && <p className="settings-sidebar-note">No sections match.</p>}
        </nav>
        <div className="settings-sidebar-footer">
          {confirmReset ? (
            <>
              <button
                onClick={() => {
                  setSettings(structuredClone(DEFAULT_SETTINGS));
                  setConfirmReset(false);
                }}
              >
                Confirm reset
              </button>
              <button onClick={() => setConfirmReset(false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmReset(true)}>Reset all settings</button>
          )}
          <span className="settings-sidebar-note">Changes apply immediately.</span>
        </div>
      </aside>

      <main className="settings-main" ref={contentRef}>
        <header className="settings-header">
          <div>
            <h1>{SECTION_META[section].label}</h1>
            <p>{SECTION_META[section].description}</p>
          </div>
          <div className="settings-actions">
            <button onClick={resetSection}>Reset section</button>
          </div>
        </header>

        {matchCount === 0 && (
          <p className="settings-empty">No options in this section match “{query}”.</p>
        )}

        <div className="settings-section" key={section}>
          {section === "general" && (
            <GeneralSettings settings={settings} update={update} hotkeyError={hotkeyError} />
          )}
          {section === "wallpaper" && (
          <WallpaperSettings
            settings={settings}
            update={update}
            setWin={(key, patch) => setWin(update, settings, key, patch)}
            monitors={monitors}
            removeDisplay={removeWallpaperDisplay}
          />
        )}
        {section === "clock" && (
          <ClockSettings
            settings={settings}
            update={update}
            setWin={(key, patch) => setWin(update, settings, key, patch)}
            monitors={monitors}
          />
        )}
        {section === "notch" && (
          <NotchSettings
            settings={settings}
            update={update}
            setWin={(key, patch) => setWin(update, settings, key, patch)}
            monitors={monitors}
          />
        )}
        {section === "todo" && (
          <TodoSettings
            settings={settings}
            update={update}
            setWin={(key, patch) => setWin(update, settings, key, patch)}
            monitors={monitors}
          />
        )}
          {section === "statusbar" && (
            <StatusbarSettings
              settings={settings}
              update={update}
              setWin={(key, patch) => setWin(update, settings, key, patch)}
              monitors={monitors}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function setWin(
  update: Update,
  settings: Settings,
  key: ModuleKey,
  patch: Partial<WindowConf>,
) {
  update({ [key]: { win: { ...winOf(settings, key), ...patch } } });
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

type Update = (patch: Record<string, unknown>) => void;
type SetWin = (key: ModuleKey, patch: Partial<WindowConf>) => void;

function SettingsGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group" data-settings-group>
      <header className="settings-group-head">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
  hideLabel = false,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hideLabel?: boolean;
}) {
  return (
    <label className={`setting-toggle${disabled ? " is-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      {!hideLabel && <span>{label}</span>}
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <SettingRow label={`${label} (${display ? display(value) : value})`} hint={hint}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </SettingRow>
  );
}

/** Per-module background transparency control. */
function BackgroundGroup({
  module,
  value,
  update,
}: {
  module: "clock" | "notch" | "todo" | "statusbar";
  value: number;
  update: Update;
}) {
  return (
    <SettingsGroup
      title="Background"
      hint="How much of the desktop shows through this module's glass."
    >
      <Slider
        label="Transparency"
        value={value}
        min={0}
        max={100}
        display={(v) => `${Math.round(v)}%`}
        onChange={(v) => update({ [module]: { bgTransparency: v } })}
      />
    </SettingsGroup>
  );
}

function PresetEditor({
  values,
  onChange,
}: {
  values: number[];
  onChange: (values: number[]) => void;
}) {
  const [draft, setDraft] = useState(values.join(", "));

  useEffect(() => {
    setDraft(values.join(", "));
  }, [values.join(",")]);

  const commit = () => {
    const parsed = Array.from(
      new Set(
        draft
          .split(/[\s,]+/)
          .map((v) => Math.round(Number(v)))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= 600),
      ),
    ).sort((a, b) => a - b);
    onChange(parsed);
    setDraft(parsed.join(", "));
  };

  return (
    <input
      type="text"
      value={draft}
      placeholder="5, 15, 25, 50"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function WindowGroup({
  moduleKey,
  win,
  setWin,
  monitors,
  showCapacity = false,
}: {
  moduleKey: ModuleKey;
  win: WindowConf;
  setWin: SetWin;
  monitors: MonitorInfo[];
  showCapacity?: boolean;
}) {
  const monitorValue = win.monitor ? `${win.monitor.x},${win.monitor.y}` : "primary";
  const extras = win.extraMonitors ?? [];
  const enabled = useSettings((s) => s.settings.modules[moduleKey]);

  /** Move an already-visible module onto its newly chosen display right away.
   *  The notch and statusbar own their geometry and follow the monitor through
   *  their own layout commands instead. */
  const placeOnMonitor = (monitor: { x: number; y: number } | null) => {
    if (!hasTauri() || !enabled) return;
    if (moduleKey !== "clock" && moduleKey !== "todo") return;
    void invoke("set_module_visible", {
      label: moduleKey,
      visible: true,
      x: win.x,
      y: win.y,
      monitor: monitor ? [monitor.x, monitor.y] : null,
    });
  };

  /** Create/remove the duplicate windows directly, without waiting for the
   *  module's own renderer to observe the settings event. */
  const applyExtras = (next: { x: number; y: number }[]) => {
    setWin(moduleKey, { extraMonitors: next });
    if (!hasTauri()) return;
    void invoke("module_sync_displays", {
      module: moduleKey,
      visible: enabled,
      displays: next.map((m) => [m.x, m.y]),
      mainMonitor: win.monitor ? [win.monitor.x, win.monitor.y] : null,
      level: win.level,
      clickThrough: win.clickThrough,
      capacity: [win.capacity.width, win.capacity.height],
    });
  };
  const primary = monitors.find((m) => m.primary);
  const mainKey = win.monitor
    ? `${win.monitor.x},${win.monitor.y}`
    : primary
      ? `${primary.x},${primary.y}`
      : "";
  const otherMonitors = monitors.filter((m) => `${m.x},${m.y}` !== mainKey);
  return (
    <SettingsGroup
      title="Window & placement"
      hint="Native window behaviour for this module."
    >
      <SettingRow label="Layer">
        <select
          value={win.level}
          onChange={(e) => setWin(moduleKey, { level: e.target.value as WindowConf["level"] })}
        >
          {LAYERS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="Display">
        <select
          value={monitorValue}
          onChange={(e) => {
            const key =
              e.target.value === "primary"
                ? primary
                  ? `${primary.x},${primary.y}`
                  : ""
                : e.target.value;
            const chosen = e.target.value === "primary" ? null : e.target.value;
            const nextMonitor = chosen
              ? { x: Number(chosen.split(",")[0]), y: Number(chosen.split(",")[1]) }
              : null;
            setWin(moduleKey, {
              monitor: nextMonitor,
              // A display cannot be both the main target and a duplicate.
              extraMonitors: extras.filter((m) => `${m.x},${m.y}` !== key),
            });
            placeOnMonitor(nextMonitor);
          }}
        >
          <option value="primary">Primary</option>
          {monitors.map((m) => (
            <option key={`${m.x},${m.y}`} value={`${m.x},${m.y}`}>
              {m.name ?? `${m.width}×${m.height}`} at {m.x},{m.y}
              {m.primary ? " (primary)" : ""}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label="More displays"
        hint="Duplicate this module's window on additional monitors."
      >
        {otherMonitors.length === 0 ? (
          <span className="setting-empty">No other displays connected.</span>
        ) : (
          <div className="setting-toggle-grid">
            {otherMonitors.map((m) => {
              const key = `${m.x},${m.y}`;
              return (
                <Toggle
                  key={key}
                  label={m.name ?? `${m.width}×${m.height} at ${m.x},${m.y}`}
                  checked={extras.some((e) => `${e.x},${e.y}` === key)}
                  onChange={(on) =>
                    applyExtras(
                      on
                        ? [...extras, { x: m.x, y: m.y }]
                        : extras.filter((e) => `${e.x},${e.y}` !== key),
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </SettingRow>
      <SettingRow label="Manual position" hint="Needs both X and Y; empty means automatic.">
        <input
          type="number"
          aria-label="Position X"
          placeholder="auto"
          value={win.x ?? ""}
          onChange={(e) => setWin(moduleKey, { x: e.target.value === "" ? null : Number(e.target.value) })}
        />
        <input
          type="number"
          aria-label="Position Y"
          placeholder="auto"
          value={win.y ?? ""}
          onChange={(e) => setWin(moduleKey, { y: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </SettingRow>
      {showCapacity && (
        <SettingRow label="Window size" hint="Multiplier of this module's default size.">
          <input
            type="number"
            aria-label="Width multiplier"
            step="0.1"
            min="0.4"
            max="2"
            value={win.capacity.width}
            onChange={(e) =>
              setWin(moduleKey, {
                capacity: { ...win.capacity, width: Number(e.target.value) || 1 },
              })
            }
          />
          <input
            type="number"
            aria-label="Height multiplier"
            step="0.1"
            min="0.4"
            max="2"
            value={win.capacity.height}
            onChange={(e) =>
              setWin(moduleKey, {
                capacity: { ...win.capacity, height: Number(e.target.value) || 1 },
              })
            }
          />
        </SettingRow>
      )}
      <div className="setting-toggle-grid">
        <Toggle
          label="Click-through"
          checked={win.clickThrough}
          onChange={(v) => setWin(moduleKey, { clickThrough: v })}
        />
        <Toggle
          label="Draggable"
          checked={win.draggable}
          onChange={(v) => setWin(moduleKey, { draggable: v })}
        />
      </div>
    </SettingsGroup>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralSettings({
  settings,
  update,
  hotkeyError,
}: {
  settings: Settings;
  update: Update;
  hotkeyError: string;
}) {
  const allModules = Object.keys(settings.modules) as ModuleKey[];
  const ordered = [
    ...settings.moduleOrder.filter((k) => allModules.includes(k)),
    ...allModules.filter((k) => !settings.moduleOrder.includes(k)),
  ];

  const moveModule = (key: ModuleKey, delta: number) => {
    const order = [...ordered];
    const i = order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    update({ moduleOrder: order });
  };

  return (
    <>
      <SettingsGroup
        title="Modules"
        hint="Order is the stacking priority within a layer (first = top). The wallpaper always sits behind the desktop icons."
      >
        <div className="setting-list">
          {ordered.map((key) => (
            <div className="setting-list-row" key={key}>
              <Toggle
                label={MODULE_LABELS[key]}
                checked={settings.modules[key]}
                onChange={(v) => update({ modules: { [key]: v } })}
              />
              <button onClick={() => moveModule(key, -1)} title="Move up" aria-label={`Move ${MODULE_LABELS[key]} up`}>
                ↑
              </button>
              <button onClick={() => moveModule(key, 1)} title="Move down" aria-label={`Move ${MODULE_LABELS[key]} down`}>
                ↓
              </button>
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Startup & shortcut" hint="The shortcut opens this settings window from anywhere.">
        <div className="setting-toggle-grid">
          <Toggle
            label="Launch at sign-in"
            checked={settings.launchOnStartup}
            onChange={(v) => {
              update({ launchOnStartup: v });
              void invoke("autostart_set", { enabled: v });
            }}
          />
          <Toggle
            label="Settings hotkey enabled"
            checked={settings.hotkey.enabled}
            onChange={(v) => update({ hotkey: { enabled: v } })}
          />
        </div>
        <SettingRow label="Hotkey" hint="Empty uses the built-in Ctrl+Shift+,">
          <input
            type="text"
            value={settings.hotkey.combo}
            placeholder="ctrl+shift+,"
            onChange={(e) => update({ hotkey: { combo: e.target.value } })}
          />
        </SettingRow>
        {hotkeyError && <p className="setting-empty">Shortcut not applied: {hotkeyError}</p>}
      </SettingsGroup>

      <SettingsGroup title="Appearance" hint="Base theme tokens. Visual customization is intentionally out of scope for now.">
        <SettingRow label="Theme">
          <select
            value={settings.theme}
            onChange={(e) => update({ theme: e.target.value as Settings["theme"] })}
          >
            <option value="dark">dark</option>
            <option value="light">light</option>
          </select>
        </SettingRow>
        <SettingRow label="Accent color">
          <input type="color" value={settings.accent} onChange={(e) => update({ accent: e.target.value })} />
        </SettingRow>
      </SettingsGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------------

function kindOf(path: string): "image" | "video" {
  return /\.(mp4|webm|ogv|mov|mkv)$/i.test(path) ? "video" : "image";
}

function WallpaperThumb({ entry }: { entry: WallpaperEntry }) {
  if (entry.kind === "web") {
    return (
      <div className="wallpaper-thumb wallpaper-thumb-web" aria-hidden="true">
        WEB
      </div>
    );
  }
  if (entry.kind === "image") {
    return (
      <img
        className="wallpaper-thumb"
        src={convertFileSrc(entry.path)}
        alt=""
        loading="lazy"
      />
    );
  }
  return (
    <video
      className="wallpaper-thumb"
      src={convertFileSrc(entry.path)}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = Math.min(1, video.duration * 0.1);
        }
      }}
    />
  );
}

function WallpaperSettings({
  settings,
  update,
  setWin,
  monitors,
  removeDisplay,
}: {
  settings: Settings;
  update: Update;
  setWin: SetWin;
  monitors: MonitorInfo[];
  removeDisplay: (key: string) => void;
}) {
  const wp = settings.wallpaper;
  const look = getWallpaperLook(wp.looks, wp.path);
  const [url, setUrl] = useState("");

  const setLook = (patch: Partial<WallpaperLook>) => {
    if (!wp.path) return;
    update({ wallpaper: { looks: { [wp.path]: { ...look, ...patch } } } });
  };

  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Wallpapers", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm"] },
      ],
    });
    if (typeof picked !== "string") return;
    // Imported copies live in the app data folder so the source file may move.
    const imported = await invoke<string>("wallpaper_import", { source: picked });
    const path = imported ?? picked;
    const kind = kindOf(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    const library = [...wp.library.filter((e) => e.path !== path), { name, path, kind }];
    update({ wallpaper: { kind, path, library } });
  };

  const applyEntry = (path: string) => {
    const entry = wp.library.find((e) => e.path === path);
    if (!entry) return;
    update({ wallpaper: { kind: entry.kind, path: entry.path } });
  };

  const removeEntry = async (path: string) => {
    await invoke("wallpaper_delete_copy", { path });
    const library = wp.library.filter((e) => e.path !== path);
    const patch: Record<string, unknown> = { library };
    if (wp.path === path) {
      patch.kind = "none";
      patch.path = "";
    }
    update({ wallpaper: patch });
    for (const [key, value] of Object.entries(wp.displays)) {
      if (value.path === path) removeDisplay(key);
    }
  };

  const setDisplay = (key: string, path: string) => {
    if (!path) {
      removeDisplay(key);
      return;
    }
    const entry = wp.library.find((e) => e.path === path);
    if (!entry) return;
    update({
      wallpaper: { displays: { ...wp.displays, [key]: { path: entry.path, kind: entry.kind } } },
    });
  };

  const mainDisplay = wp.win.monitor ? `${wp.win.monitor.x},${wp.win.monitor.y}` : "primary";

  return (
    <>
      <SettingsGroup title="Source" hint="Images, videos and web pages. Import copies files into the app data folder.">
        <SettingRow label="Type">
          <select value={wp.kind} onChange={(e) => update({ wallpaper: { kind: e.target.value } })}>
            <option value="none">none</option>
            <option value="image">image</option>
            <option value="video">video</option>
            <option value="web">web page</option>
          </select>
        </SettingRow>
        <SettingRow label="File or URL">
          <input
            type="text"
            value={wp.path}
            placeholder="C:\… or https://…"
            onChange={(e) => update({ wallpaper: { path: e.target.value } })}
          />
          <button onClick={() => void browse()}>Import file…</button>
        </SettingRow>
        <SettingRow label="Web page URL" hint="Loads a live page as the wallpaper.">
          <input
            type="text"
            value={url}
            placeholder="https://example.com"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button disabled={!url.trim()} onClick={() => update({ wallpaper: { kind: "web", path: url.trim() } })}>
            Use page
          </button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Library">
        <div className="setting-list">
          {wp.library.length === 0 && <p className="setting-empty">Imported wallpapers appear here.</p>}
          {wp.library.map((entry) => (
            <div className="setting-list-row" key={entry.path}>
              <WallpaperThumb entry={entry} />
              <span title={entry.path}>
                {entry.name} ({entry.kind})
              </span>
              <button onClick={() => applyEntry(entry.path)}>Apply</button>
              <button onClick={() => void removeEntry(entry.path)}>Delete</button>
            </div>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Displays" hint="The main wallpaper fills its display; other displays can show a different file.">
        <SettingRow label="Main display">
          <select
            value={mainDisplay}
            onChange={(e) => {
              if (e.target.value === "primary") setWin("wallpaper", { monitor: null });
              else {
                const [x, y] = e.target.value.split(",").map(Number);
                setWin("wallpaper", { monitor: { x, y } });
              }
            }}
          >
            <option value="primary">Primary</option>
            {monitors.map((m) => (
              <option key={`${m.x},${m.y}`} value={`${m.x},${m.y}`}>
                {m.name ?? `${m.width}×${m.height}`} at {m.x},{m.y}
              </option>
            ))}
          </select>
        </SettingRow>
        {monitors.map((m) => {
          const key = `${m.x},${m.y}`;
          return (
            <SettingRow key={key} label={m.name ?? `${m.width}×${m.height}`}>
              <select value={wp.displays[key]?.path ?? ""} onChange={(e) => setDisplay(key, e.target.value)}>
                <option value="">Main wallpaper</option>
                {wp.library.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </SettingRow>
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Playback">
        <div className="setting-toggle-grid">
          <Toggle label="Loop video" checked={wp.loop} onChange={(v) => update({ wallpaper: { loop: v } })} />
          <Toggle label="Muted" checked={wp.muted} onChange={(v) => update({ wallpaper: { muted: v } })} />
          <Toggle
            label="Mute while other media plays"
            checked={wp.muteWithMedia}
            onChange={(v) => update({ wallpaper: { muteWithMedia: v } })}
          />
        </div>
        <SettingRow label="Fit">
          <select value={wp.fit} onChange={(e) => update({ wallpaper: { fit: e.target.value } })}>
            <option value="cover">cover</option>
            <option value="contain">contain</option>
            <option value="fill">fill</option>
          </select>
        </SettingRow>
        <Slider
          label="Scale"
          value={wp.scale}
          min={0.5}
          max={3}
          step={0.05}
          display={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ wallpaper: { scale: v } })}
        />
        <Slider
          label="Offset X"
          value={wp.offsetX}
          min={-100}
          max={100}
          display={(v) => `${v}%`}
          onChange={(v) => update({ wallpaper: { offsetX: v } })}
        />
        <Slider
          label="Offset Y"
          value={wp.offsetY}
          min={-100}
          max={100}
          display={(v) => `${v}%`}
          onChange={(v) => update({ wallpaper: { offsetY: v } })}
        />
        <Slider
          label="Playback rate"
          value={wp.playbackRate}
          min={0.25}
          max={2}
          step={0.05}
          display={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update({ wallpaper: { playbackRate: v } })}
        />
        <Slider
          label="Volume"
          value={wp.volume}
          min={0}
          max={1}
          step={0.05}
          display={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update({ wallpaper: { volume: v } })}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Adjustments"
        hint="Saved for each wallpaper and applied whenever it is active. Speed affects video wallpapers."
      >
        {wp.path ? (
          <>
            <Slider
              label="Saturation"
              value={look.saturation}
              min={0}
              max={200}
              display={(v) => `${v}%`}
              onChange={(v) => setLook({ saturation: v })}
            />
            <Slider
              label="Gamma"
              value={look.gamma}
              min={0.5}
              max={2}
              step={0.05}
              display={(v) => v.toFixed(2)}
              onChange={(v) => setLook({ gamma: v })}
            />
            <Slider
              label="Hue"
              value={look.hue}
              min={-180}
              max={180}
              display={(v) => `${v}°`}
              onChange={(v) => setLook({ hue: v })}
            />
            <Slider
              label="Speed"
              value={look.speed}
              min={0.25}
              max={2}
              step={0.05}
              display={(v) => `${v.toFixed(2)}×`}
              hint="Video wallpapers only; multiplies the playback rate."
              onChange={(v) => setLook({ speed: v })}
            />
          </>
        ) : (
          <p className="settings-empty">Choose or apply a wallpaper to adjust it.</p>
        )}
      </SettingsGroup>

      <SettingsGroup title="Behaviour" hint="Pausing saves CPU and GPU while you work or game.">
        <SettingRow label="Pause when">
          <select value={wp.pauseWhen} onChange={(e) => update({ wallpaper: { pauseWhen: e.target.value } })}>
            <option value="off">never</option>
            <option value="maximized">app maximized</option>
            <option value="fullscreen">app fullscreen</option>
          </select>
        </SettingRow>
        <div className="setting-toggle-grid">
          <Toggle
            label="Pause on battery"
            checked={wp.pauseOnBattery}
            onChange={(v) => update({ wallpaper: { pauseOnBattery: v } })}
          />
        </div>
      </SettingsGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function ClockSettings({
  settings,
  update,
  setWin,
  monitors,
}: {
  settings: Settings;
  update: Update;
  setWin: SetWin;
  monitors: MonitorInfo[];
}) {
  const clock = settings.clock;
  const zones = useMemo(() => {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.("timeZone") ?? [];
  }, []);
  const tz = clock.timezone ?? "";
  const tzOptions = tz && !zones.includes(tz) ? [tz, ...zones] : zones;

  return (
    <>
      <SettingsGroup title="Format">
        <SettingRow label="Layout">
          <select value={clock.layout} onChange={(e) => update({ clock: { layout: e.target.value } })}>
            <option value="digital">digital</option>
            <option value="analog">analog</option>
            <option value="minimal">minimal text</option>
          </select>
        </SettingRow>
        <SettingRow label="Timezone">
          <select value={tz} onChange={(e) => update({ clock: { timezone: e.target.value || null } })}>
            <option value="">System timezone</option>
            {tzOptions.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </SettingRow>
        <div className="setting-toggle-grid">
          <Toggle
            label="12-hour format"
            checked={clock.format12h}
            onChange={(v) => update({ clock: { format12h: v } })}
          />
          <Toggle
            label="Show seconds"
            checked={clock.showSeconds}
            onChange={(v) => update({ clock: { showSeconds: v } })}
          />
          <Toggle label="Show date" checked={clock.showDate} onChange={(v) => update({ clock: { showDate: v } })} />
          <Toggle label="Show year" checked={clock.showYear} onChange={(v) => update({ clock: { showYear: v } })} />
        </div>
      </SettingsGroup>
      <BackgroundGroup module="clock" value={clock.bgTransparency} update={update} />
      <WindowGroup moduleKey="clock" win={clock.win} setWin={setWin} monitors={monitors} showCapacity />
    </>
  );
}

// ---------------------------------------------------------------------------
// Smart Notch
// ---------------------------------------------------------------------------

function NotchSettings({
  settings,
  update,
  setWin,
  monitors,
}: {
  settings: Settings;
  update: Update;
  setWin: SetWin;
  monitors: MonitorInfo[];
}) {
  const notch = settings.notch;
  const widgetKeys = [
    ...notch.moduleOrder.filter((k) => DEFAULT_NOTCH_MODULE_ORDER.includes(k)),
    ...DEFAULT_NOTCH_MODULE_ORDER.filter((k) => !notch.moduleOrder.includes(k)),
  ];

  const moveWidget = (key: NotchWidgetKey, delta: number) => {
    // Reorder the normalized list, not the raw saved list: widgets added to
    // the defaults after a profile was saved still need to be movable.
    const order = [...widgetKeys];
    const i = order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    update({ notch: { moduleOrder: order } });
  };

  const setShortcut = (index: number, patch: Partial<{ name: string; target: string; icon: string }>) => {
    const shortcuts = notch.shortcuts.map((s, i) => (i === index ? { ...s, ...patch } : s));
    update({ notch: { shortcuts } });
  };

  return (
    <>
      <SettingsGroup
        title="Widgets"
        hint="Choose what appears as tabs in the expanded notch. Every widget is available now."
      >
        <div className="notch-module-list">
          {NOTCH_MODULE_CATALOG.map((option) => (
            <NotchModuleRow
              key={option.key}
              option={option}
              checked={notch.widgets[option.key]}
              onChange={(v) => update({ notch: { widgets: { [option.key]: v } } })}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Order & zoom" hint="Order is the tab order. Zoom scales the entire widget card.">
        <div className="setting-list">
          {widgetKeys.map((key) => (
            <div className="setting-list-row" key={key}>
              <span>{NOTCH_MODULE_INFO[key].title}</span>
              <label className="setting-toggle">
                zoom
                <input
                  type="number"
                  min="0.7"
                  max="1.5"
                  step="0.05"
                  value={notch.moduleScale[key]}
                  onChange={(e) => update({ notch: { moduleScale: { [key]: Number(e.target.value) || 1 } } })}
                />
              </label>
              <button
                onClick={() => moveWidget(key, -1)}
                title="Move up"
                aria-label={`Move ${NOTCH_MODULE_INFO[key].title} up`}
              >
                ↑
              </button>
              <button
                onClick={() => moveWidget(key, 1)}
                title="Move down"
                aria-label={`Move ${NOTCH_MODULE_INFO[key].title} down`}
              >
                ↓
              </button>
            </div>
          ))}
        </div>
        <div>
          <button onClick={() => update({ notch: { moduleOrder: [...DEFAULT_NOTCH_MODULE_ORDER] } })}>
            Reset widget order
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Layout & motion">
        <SettingRow label="Shape">
          <select value={notch.layout} onChange={(e) => update({ notch: { layout: e.target.value } })}>
            <option value="notch">notch (island)</option>
            <option value="bar">bar (full width)</option>
          </select>
        </SettingRow>
        <SettingRow label="Placement">
          <select value={notch.placement} onChange={(e) => update({ notch: { placement: e.target.value } })}>
            {["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </SettingRow>
        <Slider
          label="Length"
          value={notch.length}
          min={notch.layout === "bar" ? 25 : 160}
          max={notch.layout === "bar" ? 100 : 1200}
          display={(v) => `${v}${notch.layout === "bar" ? "%" : "px"}`}
          onChange={(v) => update({ notch: { length: v } })}
        />
        <Slider
          label="Thickness"
          value={notch.thickness}
          min={30}
          max={96}
          display={(v) => `${v}px`}
          onChange={(v) => update({ notch: { thickness: v } })}
        />
        <div className="setting-toggle-grid">
          <Toggle
            label="Open on hover"
            checked={notch.openOnHover}
            onChange={(v) => update({ notch: { openOnHover: v } })}
          />
          <Toggle
            label="Hide in fullscreen"
            checked={notch.hideOnFullscreen}
            onChange={(v) => update({ notch: { hideOnFullscreen: v } })}
          />
        </div>
        <Slider
          label="Hover delay"
          value={notch.animation.hoverDelay}
          min={0}
          max={800}
          step={20}
          display={(v) => `${v}ms`}
          onChange={(v) => update({ notch: { animation: { hoverDelay: v } } })}
        />
        <Slider
          label="Close delay"
          value={notch.animation.closeDelay}
          min={0}
          max={1200}
          step={20}
          display={(v) => `${v}ms`}
          onChange={(v) => update({ notch: { animation: { closeDelay: v } } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Collapsed pill" hint="Choose which chips the minimized strip shows.">
        <div className="setting-toggle-grid">
          {(
            [
              ["showName", "Name"],
              ["showClock", "Time"],
              ["showTimer", "Timer"],
              ["showMem", "Memory"],
              ["showNet", "Network"],
              ["showMedia", "Media"],
            ] as [keyof Settings["notch"]["collapsed"], string][]
          ).map(([key, label]) => (
            <Toggle
              key={key}
              label={label}
              checked={notch.collapsed[key]}
              onChange={(v) => update({ notch: { collapsed: { [key]: v } } })}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Weather"
        hint="Powered by Open-Meteo. An empty location uses approximate network location; a city name or latitude,longitude also works."
      >
        <SettingRow label="Location" hint="Leave empty to detect automatically.">
          <input
            type="text"
            value={notch.weatherLocation}
            placeholder="Prague or 50.09,14.42"
            onChange={(e) => update({ notch: { weatherLocation: e.target.value } })}
          />
        </SettingRow>
        <SettingRow label="Units">
          <select
            value={notch.weatherUnit}
            onChange={(e) => update({ notch: { weatherUnit: e.target.value as "c" | "f" } })}
          >
            <option value="c">Celsius</option>
            <option value="f">Fahrenheit</option>
          </select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Focus timer" hint="Preset buttons, in minutes. Separate with commas.">
        <SettingRow label="Presets">
          <PresetEditor
            values={notch.timerPresets}
            onChange={(values) => update({ notch: { timerPresets: values } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Quick shortcuts" hint="Open URLs, file paths or shell: targets from the notch.">
        <div className="setting-list">
          {notch.shortcuts.length === 0 && <p className="setting-empty">No shortcuts configured.</p>}
          {notch.shortcuts.map((s, i) => (
            <div className="setting-list-row" key={i}>
              <input
                type="text"
                style={{ width: 40, flex: "0 0 40px" }}
                value={s.icon}
                placeholder="icon"
                aria-label="Shortcut icon"
                onChange={(e) => setShortcut(i, { icon: e.target.value })}
              />
              <input
                type="text"
                value={s.name}
                placeholder="Name"
                aria-label="Shortcut name"
                onChange={(e) => setShortcut(i, { name: e.target.value })}
              />
              <input
                type="text"
                value={s.target}
                placeholder="URL, path or shell: command"
                aria-label="Shortcut target"
                onChange={(e) => setShortcut(i, { target: e.target.value })}
              />
              <button
                onClick={() =>
                  update({ notch: { shortcuts: notch.shortcuts.filter((_, index) => index !== i) } })
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div>
          <button
            onClick={() =>
              update({
                notch: { shortcuts: [...notch.shortcuts, { name: "New", target: "https://", icon: "" }] },
              })
            }
          >
            Add shortcut
          </button>
        </div>
      </SettingsGroup>

      <BackgroundGroup module="notch" value={notch.bgTransparency} update={update} />
      <WindowGroup moduleKey="notch" win={notch.win} setWin={setWin} monitors={monitors} />
    </>
  );
}

// ---------------------------------------------------------------------------
// To-do
// ---------------------------------------------------------------------------

function TodoSettings({
  settings,
  update,
  setWin,
  monitors,
}: {
  settings: Settings;
  update: Update;
  setWin: SetWin;
  monitors: MonitorInfo[];
}) {
  const todo = settings.todo;
  const [draft, setDraft] = useState("");

  return (
    <>
      <SettingsGroup title="Categories" hint="The to-do widget can filter by these categories.">
        <div className="setting-list">
          {todo.categories.length === 0 && (
            <p className="setting-empty">No categories: new tasks are filed as “Uncategorised”.</p>
          )}
          {todo.categories.map((c, i) => (
            <div className="setting-list-row" key={`${c}-${i}`}>
              <span>{c}</span>
              <button
                onClick={() =>
                  update({ todo: { categories: todo.categories.filter((_, index) => index !== i) } })
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="setting-list-row">
          <input type="text" value={draft} placeholder="New category" onChange={(e) => setDraft(e.target.value)} />
          <button
            disabled={!draft.trim() || todo.categories.includes(draft.trim())}
            onClick={() => {
              const name = draft.trim();
              if (!name) return;
              update({ todo: { categories: [...todo.categories, name] } });
              setDraft("");
            }}
          >
            Add
          </button>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Defaults & sorting">
        <SettingRow label="Sort order">
          <select value={todo.sort} onChange={(e) => update({ todo: { sort: e.target.value } })}>
            <option value="smart">priority and due date</option>
            <option value="created">newest first</option>
          </select>
        </SettingRow>
        <SettingRow label="Default priority" hint="Applied to each new task after it is added.">
          <select
            value={todo.defaultPriority}
            onChange={(e) => update({ todo: { defaultPriority: e.target.value } })}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </SettingRow>
      </SettingsGroup>

      <BackgroundGroup module="todo" value={todo.bgTransparency} update={update} />
      <WindowGroup moduleKey="todo" win={todo.win} setWin={setWin} monitors={monitors} showCapacity />
    </>
  );
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function StatusbarSettings({
  settings,
  update,
  setWin,
  monitors,
}: {
  settings: Settings;
  update: Update;
  setWin: SetWin;
  monitors: MonitorInfo[];
}) {
  const bar = settings.statusbar;
  return (
    <>
      <SettingsGroup title="Placement">
        <SettingRow label="Edge">
          <select value={bar.placement} onChange={(e) => update({ statusbar: { placement: e.target.value } })}>
            <option value="top">top</option>
            <option value="bottom">bottom</option>
          </select>
        </SettingRow>
        <Slider
          label="Height"
          value={bar.thickness}
          min={24}
          max={96}
          display={(v) => `${v}px`}
          onChange={(v) => update({ statusbar: { thickness: v } })}
        />
        <Slider
          label="Side inset"
          value={bar.inset}
          min={0}
          max={400}
          display={(v) => `${v}px`}
          onChange={(v) => update({ statusbar: { inset: v } })}
        />
        <div className="setting-toggle-grid">
          <Toggle
            label="Hide in fullscreen"
            checked={bar.hideOnFullscreen}
            onChange={(v) => update({ statusbar: { hideOnFullscreen: v } })}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Chips" hint="The clock follows the global 12/24-hour clock setting.">
        <div className="setting-toggle-grid">
          {(
            [
              ["cpu", "CPU"],
              ["ram", "RAM"],
              ["disk", "DISK"],
              ["temp", "CPU TEMPERATURE"],
              ["net", "NET"],
              ["volume", "VOLUME"],
              ["uptime", "UPTIME"],
              ["battery", "BATTERY"],
              ["window", "ACTIVE WINDOW"],
              ["media", "MEDIA"],
              ["clock", "CLOCK"],
              ["bluetooth", "BLUETOOTH"],
              ["downloads", "ACTIVE DOWNLOADS"],
              ["weather", "WEATHER"],
            ] as [keyof Settings["statusbar"]["chips"], string][]
          ).map(([chip, label]) => (
            <Toggle
              key={chip}
              label={label}
              checked={bar.chips[chip]}
              onChange={(v) => update({ statusbar: { chips: { [chip]: v } } })}
            />
          ))}
          <Toggle label="Date" checked={bar.showDate} onChange={(v) => update({ statusbar: { showDate: v } })} />
          <Toggle
            label="Seconds"
            checked={bar.showSeconds}
            onChange={(v) => update({ statusbar: { showSeconds: v } })}
          />
        </div>
      </SettingsGroup>

      {bar.chips.weather && (
        <SettingsGroup
          title="Weather chip"
          hint="Powered by Open-Meteo. An empty location uses approximate network location; a city name or latitude,longitude also works."
        >
          <SettingRow label="Location" hint="Leave empty to detect automatically.">
            <input
              type="text"
              value={bar.weatherLocation}
              placeholder="Prague or 50.09,14.42"
              onChange={(e) => update({ statusbar: { weatherLocation: e.target.value } })}
            />
          </SettingRow>
          <SettingRow label="Units">
            <select
              value={bar.weatherUnit}
              onChange={(e) => update({ statusbar: { weatherUnit: e.target.value as "c" | "f" } })}
            >
              <option value="c">Celsius</option>
              <option value="f">Fahrenheit</option>
            </select>
          </SettingRow>
        </SettingsGroup>
      )}

      <BackgroundGroup module="statusbar" value={bar.bgTransparency} update={update} />
      <WindowGroup moduleKey="statusbar" win={bar.win} setWin={setWin} monitors={monitors} />
    </>
  );
}
