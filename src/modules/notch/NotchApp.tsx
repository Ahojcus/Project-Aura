import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useSettings, useModuleWindow } from "../../store/settings";
import { hasTauri } from "../../store/settings";
import type { Settings } from "../../store/settings";
import { dragHandle } from "../../lib/drag";
import { NotchFxBackdrop } from "../../lib/notch-fx";

interface MediaInfo {
  title: string;
  artist: string;
  status: string;
  positionMs: number;
  durationMs: number;
  trackKey: string;
}

interface SystemSnapshot {
  cpuPercent: number;
  memUsedGb: number;
  memTotalGb: number;
  netDownBps: number;
  netUpBps: number;
}

interface ClipboardEntry {
  text: string;
  at_ms: number;
}

interface BtDevice {
  name: string;
  battery_percent: number | null;
}

interface AppInfo {
  name: string;
  target: string;
}

interface TimerState {
  running: boolean;
  totalMs: number;
  leftMs: number;
}

const TIMER_PRESETS = [5, 15, 25, 50];

function fmtRate(bps: number): string {
  if (bps <= 0) return "0";
  const kb = bps / 1024;
  if (kb < 1024) return `${kb.toFixed(0)}KB/s`;
  return `${(kb / 1024).toFixed(1)}MB/s`;
}

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtAgo(atMs: number): string {
  const s = Math.max(0, (Date.now() - atMs) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function deviceIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("mouse")) return "🖱";
  if (n.includes("keyboard")) return "⌨️";
  if (n.includes("pen")) return "🖊";
  if (n.includes("watch") || n.includes("band")) return "⌚";
  if (n.includes("buds") || n.includes("head") || n.includes("airpods")) return "🎧";
  return "📶";
}

// ---------------------------------------------------------------------------
// Monochrome line icons (24×24 stroke SVGs, each a self-contained component
// so React always renders them with the SVG namespace) for the tab bar
// ---------------------------------------------------------------------------

const ICON_STROKE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const RunIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </svg>
);
const MediaIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <path d="M9 18V5.5L21 3v12.5" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="15.5" r="3" />
  </svg>
);
const MonitorsIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </svg>
);
const TimerIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);
const BluetoothIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <path d="M6.5 7.5 17 17l-5 4V3l5 4L6.5 16.5" />
  </svg>
);
const ClipboardIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 2h6v4H9z" />
  </svg>
);
const ShortcutsIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H13z" />
  </svg>
);
const SettingsIcon = () => (
  <svg {...ICON_STROKE} aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// Monotonic tab order so the icon row never reshuffles when widgets toggle.
type TabKey = "run" | "media" | "monitors" | "timer" | "bluetooth" | "clipboard" | "shortcuts";
const TAB_KEYS: TabKey[] = ["run", "media", "monitors", "timer", "bluetooth", "clipboard", "shortcuts"];
const TAB_ICONS: Record<TabKey, () => ReactNode> = {
  run: RunIcon,
  media: MediaIcon,
  monitors: MonitorsIcon,
  timer: TimerIcon,
  bluetooth: BluetoothIcon,
  clipboard: ClipboardIcon,
  shortcuts: ShortcutsIcon,
};

export function NotchApp() {
  const notch = useSettings((s) => s.settings.notch);
  const clockFmt12h = useSettings((s) => s.settings.clock.format12h);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [sys, setSys] = useState<SystemSnapshot | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsBump, setAppsBump] = useState(0);
  // Click-driven UX: activeTab = which panel is open (CSS reveal), and the
  // window geometry flips *after* the fade-out so closing looks smooth.
  const [activeTab, setActiveTab] = useState<TabKey | null>(null);
  const [windowExpanded, setWindowExpanded] = useState(false);
  const [timer, setTimer] = useState<TimerState>({ running: false, totalMs: 0, leftMs: 0 });
  const artKey = useRef("");
  const expanded = activeTab !== null;

  // Per-module window configuration: layer level, manual coordinates,
  // click-through; returns text-style CSS vars for the widget.
  const winStyle = useModuleWindow("notch");
  const winConf = useSettings((s) => s.settings.notch.win);

  // ---------------------------------------------------------------- polling
  useEffect(() => {
    if (!notch.widgets.media) return;
    const id = window.setInterval(async () => {
      try {
        const info = await invoke<MediaInfo | null>("get_media_info");
        setMedia(info);
        if (info && info.trackKey !== artKey.current) {
          artKey.current = info.trackKey;
          const a = await invoke<{ dataUrl: string } | null>("get_media_art");
          setArt(a?.dataUrl ?? null);
        }
      } catch {
        /* backend not ready yet */
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [notch.widgets.media]);

  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        setSys(await invoke<SystemSnapshot | null>("get_system_info"));
      } catch {
        /* backend not ready yet */
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!notch.widgets.clipboard) {
      setClipboard([]);
      return;
    }
    const poll = async () => {
      try {
        setClipboard(await invoke<ClipboardEntry[]>("get_clipboard_history"));
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => window.clearInterval(id);
  }, [notch.widgets.clipboard]);

  useEffect(() => {
    if (!notch.widgets.bluetooth) {
      setDevices([]);
      return;
    }
    const poll = async () => {
      try {
        setDevices(await invoke<BtDevice[]>("get_bluetooth_battery"));
      } catch {
        /* ignore */
      }
    };
    void poll();
    const id = window.setInterval(poll, 15000);
    return () => window.clearInterval(id);
  }, [notch.widgets.bluetooth]);

  useEffect(() => {
    if (!notch.widgets.run) {
      setApps([]);
      return;
    }
    const fetchApps = async () => {
      try {
        setApps(await invoke<AppInfo[]>("get_apps"));
      } catch {
        /* backend not ready yet */
      }
    };
    void fetchApps();
  }, [notch.widgets.run, appsBump]);

  /** Re-walk the Start Menu, then refresh the local copy. */
  const reloadApps = () => {
    if (!hasTauri()) return;
    void invoke("rescan_apps").finally(() => setAppsBump((n) => n + 1));
  };

  // ------------------------------------------------------------- layout engine
  const layoutKey = `${notch.layout}|${notch.placement}|${notch.length}|${notch.thickness}`;
  // Target display: origin coordinates identify the monitor; null = primary.
  const monitorArg = winConf.monitor ? [winConf.monitor.x, winConf.monitor.y] : null;

  // Measured height of the open panel — the window grows to fit it instead of
  // clipping at a fixed size.
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const [contentH, setContentH] = useState(0);
  const widgetsKey = TAB_KEYS.map((k) => Number(notch.widgets[k])).join("");
  useEffect(() => {
    let raf = 0;
    const id = window.setTimeout(() => {
      raf = requestAnimationFrame(() => {
        const h = expandedRef.current?.scrollHeight ?? 0;
        if (h > 0) setContentH(Math.ceil(h) + 6);
      });
    }, 60); // let panel content settle after toggles
    return () => {
      window.clearTimeout(id);
      cancelAnimationFrame(raf);
    };
  }, [widgetsKey, art, activeTab]);

  // Live re-measurement *while a panel is open*. scrollHeight changes as
  // dynamic content arrives that the widget toggles don't track — a song
  // gaining its progress row, clipboard entries added by Copy, typed Run
  // results, the timer control row — so the window grows in sync instead of
  // clipping items. Loop runs only while open (zero idle cost).
  useEffect(() => {
    if (!expanded) return;
    let raf = 0;
    const tick = () => {
      const h = expandedRef.current?.scrollHeight ?? 0;
      if (h > 0) {
        const next = Math.ceil(h) + 6;
        setContentH((prev) => (Math.abs(next - prev) > 1 ? next : prev));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [expanded]);

  useEffect(() => {
    if (!hasTauri()) return;
    void invoke("notch_apply_layout", {
      layout: notch.layout,
      placement: notch.placement,
      length: notch.length,
      thickness: notch.thickness,
      expanded: windowExpanded,
      monitor: monitorArg,
      contentHeight: contentH,
    });
    // Manual coordinates (win.x/y) override the engine's anchor placement.
    if (winConf.x != null && winConf.y != null) {
      void invoke("window_apply", { label: "notch", x: winConf.x, y: winConf.y, monitor: monitorArg });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, windowExpanded, contentH, winConf.x, winConf.y, winConf.monitor?.x, winConf.monitor?.y]);

  // -------------------------------------------------------------- focus timer
  useEffect(() => {
    if (!timer.running) return;
    const id = window.setInterval(() => {
      setTimer((t) => {
        if (!t.running) return t;
        const left = t.leftMs - 250;
        if (left <= 0) {
          if (hasTauri()) void invoke("notch_chime");
          return { running: false, totalMs: 0, leftMs: 0 };
        }
        return { ...t, leftMs: left };
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [timer.running]);

  const startTimer = (minutes: number) => setTimer({ running: true, totalMs: minutes * 60_000, leftMs: minutes * 60_000 });
  const toggleTimer = () => setTimer((t) => ({ ...t, running: !t.running }));
  const resetTimer = () => setTimer({ running: false, totalMs: 0, leftMs: 0 });

  // ------------------------------------------------------- open/close timing
  const shrinkTimer = useRef(0);
  const leaveTimer = useRef(0);
  const openedAt = useRef(0);

  /** Close: fade the panel out first, then snap the window back. */
  const closePanel = () => {
    window.clearTimeout(shrinkTimer.current);
    window.clearTimeout(leaveTimer.current);
    setActiveTab(null);
    shrinkTimer.current = window.setTimeout(
      () => setWindowExpanded(false),
      Math.max(0, Math.round(220 / notch.animation.speed)),
    );
  };

  /** Toggle a tab: clicking the same icon closes the panel. */
  const toggleTab = (key: TabKey) => {
    window.clearTimeout(leaveTimer.current);
    if (key === activeTab) {
      closePanel();
      return;
    }
    window.clearTimeout(shrinkTimer.current);
    setActiveTab(key);
    setWindowExpanded(true);
    // Opening resizes the window under the cursor, which can fire a spurious
    // mouseleave; forgive leaves during this settle window.
    openedAt.current = Date.now();
  };
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, notch.animation.speed]);

  /**
   * Closing affordances: Esc, the ✕ button, and leaving the window (with the
   * settings' close-delay as grace so a slipped cursor doesn't slam it shut).
   *
   * A pointer-leave must be verified before closing: when the window GROWS
   * under a stationary cursor (panel opening while the pointer rests on the
   * bar), WebView2 dispatches mouseleave even though the cursor is still over
   * the notch — which used to make the notch open and then close itself in a
   * flicker loop. At expiry, hit-test the recorded cursor position: if there
   * is still an element under it the pointer never actually left.
   */
  const onMouseLeave = (e: ReactMouseEvent) => {
    if (Date.now() - openedAt.current < 350) return; // settling after open
    const px = e.clientX;
    const py = e.clientY;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      const hit = document.elementFromPoint(px, py);
      if (!hit) closePanel(); // pointer is genuinely outside the webview
    }, notch.animation.closeDelay);
  };
  const onMouseEnter = () => window.clearTimeout(leaveTimer.current);

  const anyWidget = TAB_KEYS.some((k) => notch.widgets[k]);

  // Customization knobs → CSS custom properties consumed by notch.css
  const customVars = {
    "--nblur": `${notch.appearance.blur}px`,
    "--nglass": String(notch.appearance.glassOpacity),
    "--nradius": `${notch.appearance.radius}px`,
    "--nglow": String(notch.appearance.glow),
    ...((notch.appearance.ambientColor ? { "--nambient": notch.appearance.ambientColor } : {})),
    "--nspeed": String(1 / Math.max(0.2, notch.animation.speed)),
    "--nbar": `${notch.thickness}px`,
    ...winStyle,
  } as CSSProperties;

  const pillClasses = [
    "notch-pill",
    expanded ? "open" : "",
    notch.appearance.ambientArt ? "" : "no-ambient",
  ]
    .filter(Boolean)
    .join(" ");

  const tabs = TAB_KEYS.filter((k) => notch.widgets[k]);

  return (
    <div
      className={`notch-root${notch.layout === "bar" ? " bar" : ""}${notch.placement.startsWith("bottom") ? " bottom" : ""}`}
      style={customVars}
    >      <div
        className={pillClasses}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {/* Selected animated background scene (Settings → Smart Notch →
           Background effect); sits behind bar + panel, freezes while idle for
           the music-reactive scenes. */}
        <NotchFxBackdrop fx={notch.fx} playing={media?.status === "playing"} />
        <div className="notch-collapsed"
          {...(winConf.draggable ? { onPointerDown: dragHandle } : undefined)}
        >
          <span className="notch-tabs">
            {!anyWidget && <span className="notch-small nb-hint">No widgets enabled — set them up in Settings</span>}
            {tabs.map((key) => (
              <button
                key={key}
                className={`ntab${activeTab === key ? " active" : ""}`}
                title={TAB_TITLES[key]}
                aria-label={TAB_TITLES[key]}
                aria-pressed={activeTab === key}
                onClick={() => toggleTab(key)}
              >
                {TAB_ICONS[key]()}
              </button>
            ))}
          </span>

          <span
            className="notch-dot"
            title={winConf.draggable ? "Drag to move the notch" : "Status"}
          />

          <span className="notch-status" onPointerDown={(e) => e.stopPropagation()}>
            {notch.widgets.timer && timer.running && (
              <span className="notch-mini-timer">⏱ {fmtTime(timer.leftMs)}</span>
            )}
            {notch.widgets.monitors && sys && (
              <span className="nst-chip" title="Memory usage">
                {sys.memTotalGb > 0 ? `${Math.round((sys.memUsedGb / sys.memTotalGb) * 100)}%` : `${sys.memUsedGb.toFixed(0)}GB`}
              </span>
            )}
            {notch.widgets.monitors && sys && (
              <span className="nst-chip" title="Network down / up">
                ↓{fmtRate(sys.netDownBps)}
              </span>
            )}
            {notch.widgets.media && media && (
              media.durationMs > 0 ? (
                /* real song progress — advances with the track (Windows SMTC
                   carries no audio spectrum, so bars can't "dance" to music) */
                <span
                  className={`notch-mini-progress${media.status === "playing" ? "" : " paused"}`}
                  title={`${media.title} — ${media.status}`}
                >
                  <span style={{ width: `${Math.min(100, Math.max(0, (media.positionMs / media.durationMs) * 100))}%` }} />
                </span>
              ) : (
                /* no timeline available — fall back to the decorative bars */
                <span
                  className={`notch-eq${media.status === "playing" ? "" : " paused"}`}
                  title={`${media.title} — ${media.status}`}
                >
                  <i /><i /><i />
                </span>
              )
            )}
            {notch.collapsed.showClock && <PillClock hour12={clockFmt12h} />}
            <button
              className="nst-btn"
              title="Open Aura settings"
              aria-label="Open Aura settings"
              onClick={() => {
                if (hasTauri()) void invoke("toggle_settings");
              }}
            >
              <SettingsIcon />
            </button>
            {expanded && (
              <button
                className="nst-btn"
                title="Close panel"
                aria-label="Close panel"
                onClick={closePanel}
              >
                <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} fill="none" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </span>
        </div>

        <div className="notch-expanded" ref={expandedRef}>
          {tabs.map((key) =>
            activeTab !== key ? null : (
              <div key={key} className="npanel">
                {key === "run" && <RunWidget apps={apps} onRescan={reloadApps} />}
                {key === "media" && (
                  <MediaWidget
                    media={media}
                    art={art}
                    ambient={notch.appearance.ambientArt}
                    ambientColor={notch.appearance.ambientColor}
                  />
                )}
                {key === "timer" && (
                  <TimerWidget timer={timer} onStart={startTimer} onToggle={toggleTimer} onReset={resetTimer} />
                )}
                {key === "monitors" && <MonitorsWidget sys={sys} />}
                {key === "bluetooth" && <BluetoothWidget devices={devices} />}
                {key === "clipboard" && <ClipboardWidget entries={clipboard} />}
                {key === "shortcuts" && <ShortcutsWidget shortcuts={notch.shortcuts} />}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

const TAB_TITLES: Record<TabKey, string> = {
  run: "Run — search apps and open URLs",
  media: "Now playing",
  monitors: "System monitor",
  timer: "Focus timer",
  bluetooth: "Bluetooth devices",
  clipboard: "Clipboard history",
  shortcuts: "Shortcuts",
};

/**
 * Widget components live at MODULE scope, not inside NotchApp. Defining them
 * inline recreated their function identity on every parent re-render (the 1s
 * media poll), which remounted the whole panel subtree every second and
 * replayed the opening animation each time.
 */

function MediaWidget({
  media,
  art,
  ambient,
  ambientColor,
}: {
  media: MediaInfo | null;
  art: string | null;
  ambient: boolean;
  ambientColor: string;
}) {
  const dur = media?.durationMs ?? 0;
  const pos = media?.positionMs ?? 0;
  const tinted = ambient && !!ambientColor;
  return (
    <div className={`notch-section notch-media${ambient ? "" : " plain"}`}>
      {tinted ? (
        <div className="notch-ambient tinted" aria-hidden />
      ) : (
        art && ambient && <img className="notch-ambient" src={art} alt="" aria-hidden />
      )}
      <div className="notch-row">
        <div className="notch-art">
          {art ? <img src={art} alt="" /> : <div className="notch-art-fallback">♪</div>}
        </div>
        <div className="notch-track">
          <div className="notch-title">{media?.title || "Nothing playing"}</div>
          <div className="notch-artist">{media?.artist || "—"}</div>
        </div>
        <button
          className="notch-playbtn"
          aria-label="Toggle playback"
          onClick={() => {
            if (hasTauri()) void invoke("toggle_media_playback");
          }}
        >
          {media?.status === "playing" ? "⏸" : "▶"}
        </button>
      </div>
      {dur > 0 && (
        <>
          <div className="notch-progress">
            <div style={{ width: `${Math.min(100, Math.max(0, (pos / dur) * 100))}%` }} />
          </div>
          <div className="notch-times">
            <span>{fmtTime(pos)}</span>
            <span>{fmtTime(dur)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function TimerWidget({
  timer,
  onStart,
  onToggle,
  onReset,
}: {
  timer: TimerState;
  onStart: (minutes: number) => void;
  onToggle: () => void;
  onReset: () => void;
}) {
  const pct = timer.totalMs > 0 ? Math.max(0, Math.min(100, (timer.leftMs / timer.totalMs) * 100)) : 0;
  const label = timer.leftMs > 0 ? fmtTime(timer.leftMs) : "Ready";
  return (
    <div className="notch-section notch-timer">
      <div className="notch-ringwrap nft-ring">
        <div
          className="notch-ring"
          style={{
            background: `conic-gradient(var(--accent) ${timer.running || pct > 0 ? pct : 0}%, var(--ntrack) 0)`,
          }}
        />
        <span className="notch-ring-text nft-clock">{label}</span>
      </div>
      <div className="nft-side">
        <div className="nft-presets">
          {TIMER_PRESETS.map((m) => (
            <button key={m} className="nft-chip" onClick={() => onStart(m)}>{m}m</button>
          ))}
        </div>
        <div className="nft-ctl">
          <button className="nft-chip" onClick={onToggle} disabled={timer.leftMs === 0}>
            {timer.running ? "Pause" : "Start"}
          </button>
          <button className="nft-chip" onClick={onReset}>Reset</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Monitor panel: flat Processor/Memory bar rows (like the reference mock)
 * plus Download/Upload tiles — replaces the old 4-up donut grid, which
 * cramped once every widget lived in one column.
 */
function MonitorsWidget({ sys }: { sys: SystemSnapshot | null }) {
  const cpu = sys?.cpuPercent ?? 0;
  const ramPct = sys && sys.memTotalGb > 0 ? Math.min(100, (sys.memUsedGb / sys.memTotalGb) * 100) : 0;
  const ramGb = sys?.memUsedGb ?? 0;
  return (
    <div className="notch-section notch-monitors">
      <div className="nstat">
        <span className="nstat-label">Processor</span>
        <span className="nstat-bar">
          <i style={{ width: `${Math.min(100, Math.max(0, cpu))}%` }} />
        </span>
        <span className="nstat-value">{sys ? `${cpu.toFixed(0)}%` : "—"}</span>
      </div>
      <div className="nstat">
        <span className="nstat-label">Memory</span>
        <span className="nstat-bar">
          <i style={{ width: `${ramPct}%` }} />
        </span>
        <span className="nstat-value">{sys ? `${ramPct.toFixed(0)}% · ${ramGb.toFixed(1)}GB` : "—"}</span>
      </div>
      <div className="nmon-net">
        <div className="nmon-tile">
          <span className="nnet-dir">↓ Download</span>
          <span className="nnet-rate">{sys ? fmtRate(sys.netDownBps) : "—"}</span>
        </div>
        <div className="nmon-tile">
          <span className="nnet-dir">↑ Upload</span>
          <span className="nnet-rate">{sys ? fmtRate(sys.netUpBps) : "—"}</span>
        </div>
      </div>
    </div>
  );
}

function BluetoothWidget({ devices }: { devices: BtDevice[] }) {
  return (
    <div className="notch-section notch-bt">
      {devices.length === 0 && (
        <span className="notch-small">No connected Bluetooth devices with battery info (or paired devices are off).</span>
      )}
      {devices.slice(0, 4).map((d) => (
        <div key={d.name} className="nbt-row">
          <span className="nbt-name">{deviceIcon(d.name)} {d.name}</span>
          <span className={`nbt-batt${d.battery_percent == null ? " unknown" : d.battery_percent < 20 ? " low" : ""}`}>
            {d.battery_percent != null ? `${d.battery_percent}%` : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClipboardWidget({ entries }: { entries: ClipboardEntry[] }) {
  return (
    <div className="notch-section notch-clip">
      <div className="notch-section-head"><span>Copied text</span></div>
      {entries.length === 0 && (
        <span className="notch-small">Copy some text anywhere — snippets appear here.</span>
      )}
      {entries.slice(0, 6).map((e, i) => (
        <button
          key={`${e.at_ms}-${i}`}
          className="ncb-item"
          title="Click to copy back to the clipboard"
          onClick={() => {
            if (hasTauri()) void invoke("copy_clipboard_text", { text: e.text });
          }}
        >
          <span className="ncb-text">{e.text}</span>
          <span className="ncb-time">{fmtAgo(e.at_ms)}</span>
        </button>
      ))}
    </div>
  );
}

function ShortcutsWidget({ shortcuts }: { shortcuts: Settings["notch"]["shortcuts"] }) {
  return (
    <div className="notch-section notch-shortcuts">
      {shortcuts.length === 0 && <span className="notch-small">Add quick shortcuts in Settings → Shortcuts.</span>}
      {shortcuts.map((s) => (
        <button
          key={s.target}
          className="notch-btn wide"
          title={s.target}
          onClick={() => {
            if (hasTauri()) void invoke("open_shortcut", { target: s.target });
          }}
        >
          <span className="sc-ico">{s.icon}</span>
          {s.name}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Searchable run launcher: search over Start Menu apps + typed URLs/paths,
// with keyboard navigation (↑ ↓ Enter Esc) and click selection.
// ---------------------------------------------------------------------------

interface RunItem {
  name: string;
  target: string;
  typed: boolean;
}

/** Live clock shown in the bar when Settings → Smart Notch →
 *  Collapsed → Show clock is on. Own interval so the main app doesn't
 *  re-render every second. */
function PillClock({ hour12 }: { hour12: boolean }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const text = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12,
    hourCycle: hour12 ? "h12" : "h23",
  }).format(now);
  return <span className="notch-pill-clock">{text}</span>;
}

function RunWidget({ apps, onRescan }: { apps: AppInfo[]; onRescan: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const q = query.trim().toLowerCase();

  const hits = useMemo(() => {
    if (!q) return [];
    const starts: AppInfo[] = [];
    const contains: AppInfo[] = [];
    for (const a of apps) {
      const n = a.name.toLowerCase();
      if (n.startsWith(q)) starts.push(a);
      else if (n.includes(q)) contains.push(a);
    }
    return [...starts, ...contains].slice(0, 6);
  }, [apps, q]);

  const items = useMemo(() => {
    const list: RunItem[] = hits.map((a) => ({ name: a.name, target: a.target, typed: false }));
    if (q) {
      list.push({
        name:
          query.includes(".") || query.includes("://") || /^[a-z]:\\/i.test(query)
            ? `Open ${query.trim()}`
            : `Search web for “${query.trim()}”`,
        target: query.trim(),
        typed: true,
      });
    }
    return list;
  }, [hits, q, query]);

  useEffect(() => setSel(0), [q]);

  const run = (item: RunItem) => {
    if (hasTauri()) void invoke("open_shortcut", { target: item.target });
    setQuery("");
  };

  return (
    <div className="notch-section notch-run">
      <input
        className="nrun-input"
        placeholder="Search apps or type a URL / path…"
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && items[sel]) {
            e.preventDefault();
            run(items[sel]);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(items.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          }
        }}
      />
      {q ? (
        <div className="nrun-list">
          {items.map((it, i) => (
            <button
              key={`${it.typed ? "typed" : "app"}:${it.target}:${i}`}
              className={`nrun-row${i === sel ? " sel" : ""}`}
              title={it.target}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
            >
              <span className="nrun-ico">{it.typed ? "↵" : it.name.charAt(0).toUpperCase()}</span>
              <span className="nrun-name">{it.name}</span>
              {!it.typed && <span className="nrun-type">app</span>}
            </button>
          ))}
          <button
            className="nrun-rescan as-row"
            title="Re-scan Start Menu apps"
            onClick={onRescan}
            aria-label="Re-scan Start Menu apps"
          >
            ↻ Re-scan Start Menu
          </button>
        </div>
      ) : (
        <button
          className="nrun-rescan as-row"
          title="Re-scan Start Menu apps"
          onClick={onRescan}
          aria-label="Re-scan Start Menu apps"
        >
          ↻ Re-scan Start Menu
        </button>
      )}
    </div>
  );
}
