import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSettings, useModuleWindow } from "../../store/settings";
import { hasTauri } from "../../store/settings";
import type { Settings } from "../../store/settings";
import { dragHandle } from "../../lib/drag";

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

export function NotchApp() {
  const notch = useSettings((s) => s.settings.notch);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [sys, setSys] = useState<SystemSnapshot | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry[]>([]);
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [appsBump, setAppsBump] = useState(0);
  const [expanded, setExpanded] = useState(false); // CSS animation state
  const [windowExpanded, setWindowExpanded] = useState(false); // actual window geometry
  const [timer, setTimer] = useState<TimerState>({ running: false, totalMs: 0, leftMs: 0 });
  const artKey = useRef("");

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

  // Measured height of the expanded panel — the window grows to fit every
  // enabled widget instead of clipping at a fixed 330px.
  const expandedRef = useRef<HTMLDivElement | null>(null);
  const [contentH, setContentH] = useState(0);
  const widgetsKey = [
    notch.widgets.run,
    notch.widgets.media,
    notch.widgets.monitors,
    notch.widgets.timer,
    notch.widgets.bluetooth,
    notch.widgets.clipboard,
    notch.widgets.shortcuts,
  ].map((b) => Number(b)).join("");
  useEffect(() => {
    let raf = 0;
    const id = window.setTimeout(() => {
      raf = requestAnimationFrame(() => {
        const h = expandedRef.current?.scrollHeight ?? 0;
        if (h > 0) setContentH(Math.ceil(h) + 6);
      });
    }, 60); // let widget content settle after toggles
    return () => {
      window.clearTimeout(id);
      cancelAnimationFrame(raf);
    };
  }, [widgetsKey, art]);

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

  // --------------------------------------------------- expand/collapse timing
  const expandTimer = useRef(0);
  const shrinkTimer = useRef(0);

  /**
   * Hover-driven expand/collapse with sequenced animations (timings are
   * user-configurable, see `notch.animation` in the settings store):
   * - opening:  widen the window first, then the CSS reveals the content;
   * - closing:  let the CSS fade-out play (content shrinks back), THEN snap
   *             the window back — the layout effect applies the collapsed
   *             geometry once `expanded` flips to false.
   */
  const setExpandedState = (value: boolean, delay = 0) => {
    window.clearTimeout(expandTimer.current);
    window.clearTimeout(shrinkTimer.current);
    expandTimer.current = window.setTimeout(() => {
      if (value) {
        setWindowExpanded(true); // widen the window first…
        setExpanded(true);       // …then the CSS reveals the content
      } else {
        setExpanded(false);      // CSS fade-out starts now…
        // …and the window snaps back after the fade — layout effect handles it
        shrinkTimer.current = window.setTimeout(
          () => setWindowExpanded(false),
          Math.max(0, Math.round(220 / notch.animation.speed)),
        );
      }
    }, delay);
  };

  const anyWidget = Object.values(notch.widgets).some(Boolean);

  // Customization knobs → CSS custom properties consumed by notch.css
  const customVars = {
    "--nblur": `${notch.appearance.blur}px`,
    "--nglass": String(notch.appearance.glassOpacity),
    "--nradius": `${notch.appearance.radius}px`,
    "--nglow": String(notch.appearance.glow),
    ...((notch.appearance.ambientColor ? { "--nambient": notch.appearance.ambientColor } : {})),
    "--nspeed": String(1 / Math.max(0.2, notch.animation.speed)),
    ...winStyle,
  } as CSSProperties;

  const pillClasses = [
    "notch-pill",
    expanded ? "open" : "",
    notch.appearance.ambientArt ? "" : "no-ambient",
    notch.animation.stagger ? "" : "no-stagger",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`notch-root${notch.layout === "bar" ? " bar" : ""}${notch.placement.startsWith("bottom") ? " bottom" : ""}`}
      style={customVars}
    >
      <div
        className={pillClasses}
        onMouseEnter={() => setExpandedState(true, notch.animation.hoverDelay)}
        onMouseLeave={() => setExpandedState(false, notch.animation.closeDelay)}
        onClick={() => !expanded && setExpandedState(true, 0)}
      >
        <div className="notch-collapsed">
          <span
            className="notch-dot"
            {...(winConf.draggable ? { onPointerDown: dragHandle } : undefined)}
            title={winConf.draggable ? "Drag to move the notch" : undefined}
          />
          {notch.collapsed.showName && <span className="notch-name">Aura</span>}
          {notch.widgets.timer && timer.running && (
            <span className="notch-mini-timer">⏱ {fmtTime(timer.leftMs)}</span>
          )}
          {notch.widgets.monitors && sys && (
            <span className="notch-mini-mon">{sys.cpuPercent.toFixed(0)}% · {sys.memUsedGb.toFixed(0)}GB</span>
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
        </div>

        <div className="notch-expanded" ref={expandedRef}>
          {!anyWidget && (
            <div className="notch-empty">No notch widgets enabled — enable them in Settings.</div>
          )}
          {notch.widgets.run && <RunWidget apps={apps} onRescan={reloadApps} />}
          {notch.widgets.media && (
            <MediaWidget
              media={media}
              art={art}
              ambient={notch.appearance.ambientArt}
              ambientColor={notch.appearance.ambientColor}
            />
          )}
          {notch.widgets.timer && (
            <TimerWidget timer={timer} onStart={startTimer} onToggle={toggleTimer} onReset={resetTimer} />
          )}
          {notch.widgets.monitors && <MonitorsWidget sys={sys} />}
          {notch.widgets.bluetooth && <BluetoothWidget devices={devices} />}
          {notch.widgets.clipboard && <ClipboardWidget entries={clipboard} />}
          {notch.widgets.shortcuts && <ShortcutsWidget shortcuts={notch.shortcuts} />}
        </div>
      </div>
    </div>
  );
}

/**
 * Widget components live at MODULE scope, not inside NotchApp. Defining them
 * inline recreated their function identity on every parent re-render (the 1s
 * media poll), which remounted the whole expanded subtree every second and
 * replayed the opening/stagger animation each time.
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

function MonitorsWidget({ sys }: { sys: SystemSnapshot | null }) {
  const cpu = sys?.cpuPercent ?? 0;
  const ramPct = sys && sys.memTotalGb > 0 ? Math.min(100, (sys.memUsedGb / sys.memTotalGb) * 100) : 0;
  return (
    <div className="notch-section notch-monitors">
      <div className="notch-stat">
        <div className="notch-ringwrap">
          <div
            className="notch-ring"
            style={{ background: `conic-gradient(var(--accent) ${sys ? cpu : 0}%, var(--ntrack) 0)` }}
          />
          <span className="notch-ring-text">{sys ? `${cpu.toFixed(0)}%` : "—"}</span>
        </div>
        <span className="stat-label">CPU</span>
      </div>
      <div className="notch-stat">
        <div className="notch-ringwrap">
          <div
            className="notch-ring"
            style={{ background: `conic-gradient(var(--accent) ${ramPct}%, var(--ntrack) 0)` }}
          />
          <span className="notch-ring-text">{sys ? `${sys.memUsedGb.toFixed(1)}G` : "—"}</span>
        </div>
        <span className="stat-label">RAM</span>
      </div>
      <div className="notch-stat">
        <div className="notch-net">↓ {sys ? fmtRate(sys.netDownBps) : "—"}</div>
        <span className="stat-label">Down</span>
      </div>
      <div className="notch-stat">
        <div className="notch-net">↑ {sys ? fmtRate(sys.netUpBps) : "—"}</div>
        <span className="stat-label">Up</span>
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
  if (entries.length === 0) {
    return (
      <div className="notch-section notch-clip">
        <span className="notch-small">Copy some text anywhere — snippets appear here.</span>
      </div>
    );
  }
  return (
    <div className="notch-section notch-clip">
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
      <div className="notch-section-head">
        <span>Run</span>
        <button
          className="nrun-rescan"
          title="Re-scan Start Menu apps"
          onClick={onRescan}
          aria-label="Re-scan Start Menu apps"
        >
          ↻
        </button>
      </div>
      <input
        className="nrun-input"
        placeholder="Search apps or type a URL / path…"
        value={query}
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
          } else if (e.key === "Escape") {
            setQuery("");
          }
        }}
      />
      {q && (
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
        </div>
      )}
    </div>
  );
}
