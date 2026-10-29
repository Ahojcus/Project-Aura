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
  /** Full duration of the current session — drives the progress ring. */
  totalMs: number;
  /** Remaining time when paused (while running, derive from endAt). */
  leftMs: number;
  /** Absolute wall-clock deadline while running. Deriving from a timestamp
   *  instead of decrementing per tick keeps the countdown accurate even when
   *  the hidden notch webview throttles its timers to ~1s. */
  endAt: number | null;
  /** Session completed — ring full, "Done ✓". Cleared by the next start,
   *  reset, preset press or the auto-dismiss timer in the finish effect. */
  finished: boolean;
}

const TIMER_PRESETS = [5, 15, 25, 50];

function fmtDone(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

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

/** Openable panels: the individual widget tabs + the default Home dashboard. */
type PanelKey = TabKey | "home";

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
  const [activeTab, setActiveTab] = useState<PanelKey | null>(null);
  const [windowExpanded, setWindowExpanded] = useState(false);
  const [timer, setTimer] = useState<TimerState>({ running: false, totalMs: 0, leftMs: 0, endAt: null, finished: false });
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
        // +12 slack: Windows fractional display scales round the native
        // webview's physical height, which can eat a few px — too little
        // slack and a scrollbar appears for content that actually fits.
        if (h > 0) setContentH(Math.ceil(h) + 12);
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
        const next = Math.ceil(h) + 12;
        setContentH((prev) => (Math.abs(next - prev) > 1 ? next : prev));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [expanded]);

  // Compact idle width: while collapsed, the icon row + window buttons hide
  // (CSS .idle) in any layout, so the strip shrinks to what's left —
  // dot · clock · mini bars. The native window follows this measurement.
  // NOTE: deliberately keyed WITHOUT the network-rate value — `.net-chip`
  // reserves a constant width (see notch.css), so throughput samples must
  // never re-measure/re-fit the window or the pill would drift sideways
  // every second while speeds change.
  const collapsedRef = useRef<HTMLDivElement | null>(null);
  const [idleW, setIdleW] = useState<number | null>(null);
  // Any collapsed-pill content change alters the idle width → re-measure.
  // (The network VALUE stays out on purpose — see the .net-chip comment.)
  const collapsedKey = [
    notch.collapsed.showName,
    notch.collapsed.showClock,
    notch.collapsed.showTimer,
    notch.collapsed.showMem,
    notch.collapsed.showNet,
    notch.collapsed.showMedia,
  ]
    .map(Number)
    .join("");
  const idleMeasureKey = `${widgetsKey}|${collapsedKey}|${notch.layout}|${timer.running}|${timer.finished}`;
  useEffect(() => {
    if (windowExpanded) return;
    const id = window.requestAnimationFrame(() => {
      // Sum the VISIBLE children + gaps + padding — never the bar's own
      // scrollWidth, which always spans the window and would feed the
      // measured width back into the width, growing the notch forever.
      const el = collapsedRef.current;
      if (!el) return;
      const cs = getComputedStyle(el);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const gap = parseFloat(cs.gap) || 0;
      const visible = Array.from(el.children).filter(
        (c) => c instanceof HTMLElement && getComputedStyle(c as HTMLElement).display !== "none",
      );
      const kids = visible.reduce((s, c) => s + (c as HTMLElement).getBoundingClientRect().width, 0);
      const content = pad + kids + gap * Math.max(0, visible.length - 1);
      if (content > 60) {
        setIdleW((prev) => {
          const next = Math.min(Math.ceil(content) + 12, 660);
          return Math.abs(next - (prev ?? 0)) > 3 ? next : prev;
        });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [idleMeasureKey, windowExpanded]);

  // Roll-out tween: the native window glides between the compact idle pill
  // and the full bar over 1.2 s — both on hover (idle → full) and unhover
  // (full → idle). Each step passes a fit_width override; the final call
  // without one lands the exact Rust-computed geometry.
  const tweenRaf = useRef(0);
  const lastTweenState = useRef(windowExpanded);
  // Latest layout args (see comment at the top of the tween effect).
  const layoutArgsRef = useRef({
    layout: "notch" as string,
    placement: "top-center" as string,
    length: 240,
    thickness: 44,
    expanded: false,
    monitor: null as number[] | null,
    contentHeight: 0,
    collapsedWidth: null as number | null,
  });
  useEffect(() => {
    if (!hasTauri()) return;

    const baseArgs = {
      layout: notch.layout,
      placement: notch.placement,
      length: notch.length,
      thickness: notch.thickness,
      expanded: windowExpanded,
      monitor: monitorArg,
      contentHeight: contentH,
      collapsedWidth: idleW,
    };
    // LIVE snapshot: closure args freeze at effect-creation time, but the
    // panel height measurement often commits *while* the 1.2 s roll-out
    // tween is still running. The in-flight guard drops the mid-tween
    // invoke (correctly), so the final "exact geometry" invoke MUST read the
    // freshest values — otherwise a stale height wins and the panel scrolls
    // forever. Every invoke below goes through this ref.
    layoutArgsRef.current = baseArgs;
    // Manual coordinates run without tweens: window_apply pins the spot.
    if (winConf.x != null && winConf.y != null) {
      window.cancelAnimationFrame(tweenRaf.current);
      tweenRaf.current = 0;
      void invoke("notch_apply_layout", layoutArgsRef.current);
      void invoke("window_apply", { label: "notch", x: winConf.x, y: winConf.y, monitor: monitorArg });
      return;
    }

    // Only a real open/close transition (re)starts the tween. A rerun from
    // some other dep (content height settling, idle re-measure, layout
    // change) must NOT cancel an in-flight tween and snap the width — that
    // was cutting the roll-out leg short.
    if (windowExpanded === lastTweenState.current) {
      if (tweenRaf.current) return; // tween in flight — final frame covers it
      void invoke("notch_apply_layout", layoutArgsRef.current);
      return;
    }
    lastTweenState.current = windowExpanded;
    window.cancelAnimationFrame(tweenRaf.current);

    // Mirror of the Rust width clamps (keep in sync with commands.rs).
    const sw = window.screen?.width ?? 1920;
    const fullWidth =
      notch.layout === "bar"
        ? sw * Math.min(1, Math.max(0.25, notch.length / 100))
        : Math.max(660, Math.min(sw * 0.8, Math.max(160, notch.length)));

    if (idleW == null) {
      void invoke("notch_apply_layout", baseArgs);
      return;
    }
    // 1.2 s both ways (scaled by the Settings animation speed multiplier).
    const ms = Math.max(120, Math.round(1200 / Math.max(0.2, notch.animation.speed)));
    const from = windowExpanded ? idleW : fullWidth;
    const to = windowExpanded ? fullWidth : idleW;
    const t0 = performance.now();
    // Compositor budget: each step of this tween is an IPC invoke + a NATIVE
    // window resize, which re-lays-out the webview. Uncapped rAF on a 144Hz+
    // display more than doubles those calls for zero visible gain and makes
    // the motion stutter — so cap at ~60 steps/s and skip sub-pixel steps.
    const STEP_MS = 1000 / 60;
    let lastStep = t0 - STEP_MS; // nothing sent yet — the first frame always goes
    let lastSent = Math.round(from);
    // Direction-aware curves. Open: out-back (s=0.75 ⇒ ~3% overshoot) — the
    // window bursts wide fast and settles with a springy kiss. Close:
    // smoothstep — starts calm so the fade-out has time to read before the
    // window rolls back, ends calm so it never slams shut.
    const outBack = (k: number) => {
      const s = 0.75;
      const p = k - 1;
      return 1 + (s + 1) * p * p * p + s * p * p;
    };
    const smoothStep = (k: number) => k * k * (3 - 2 * k);
    const frame = (t: number) => {
      if (t - lastStep < STEP_MS) {
        tweenRaf.current = window.requestAnimationFrame(frame);
        return;
      }
      lastStep = t;
      const k = Math.min(1, (t - t0) / ms);
      const eased = windowExpanded ? outBack(k) : smoothStep(k);
      const now = Math.round(from + (to - from) * eased);
      if (k >= 1 || now !== lastSent) {
        lastSent = now;
        void invoke("notch_apply_layout", { ...layoutArgsRef.current, fitWidth: now });
      }
      if (k < 1) {
        tweenRaf.current = window.requestAnimationFrame(frame);
      } else {
        tweenRaf.current = 0;
        void invoke("notch_apply_layout", layoutArgsRef.current); // exact final geometry, LATEST values
        // Mid-tween frames measure the panel at a narrower, wrapped width,
        // which can leave contentH too tall — or the loop paused. One settled
        // re-measure at the final (unwrapped) width pins the exact height.
        window.setTimeout(() => {
          const h = expandedRef.current?.scrollHeight ?? 0;
          if (h > 0) {
            const next = Math.ceil(h) + 12;
            setContentH((prev) => (Math.abs(next - prev) > 1 ? next : prev));
          }
        }, 90);
      }
    };
    tweenRaf.current = window.requestAnimationFrame(frame);
  }, [layoutKey, windowExpanded, contentH, idleW, winConf.x, winConf.y, winConf.monitor?.x, winConf.monitor?.y]);

  // -------------------------------------------------------------- focus timer
  // Ticks 4×/s reading the ABSOLUTE deadline (timer.endAt) — not subtracting
  // from itself — so throttled/missed ticks can never accumulate drift.
  useEffect(() => {
    if (!timer.running || timer.endAt == null) return;
    const tick = () => {
      const left = (timer.endAt as number) - Date.now();
      if (left <= 0) {
        if (hasTauri()) void invoke("notch_chime");
        setTimer((t) => (t.running ? { ...t, running: false, leftMs: 0, endAt: null, finished: true } : t));
      } else {
        setTimer((t) => (t.running ? { ...t, leftMs: left } : t));
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [timer.running, timer.endAt]);

  // Only ONE finish effect instance may chime/flip to Done even across
  // re-renders; the interval above owns that transition, this one just adds
  // the cleanup: a finished session auto-dismisses to "Ready" after 90s.
  useEffect(() => {
    if (!timer.finished) return;
    const id = window.setTimeout(() => setTimer({ running: false, totalMs: 0, leftMs: 0, endAt: null, finished: false }), 90_000);
    return () => window.clearTimeout(id);
  }, [timer.finished]);

  const startTimer = (minutes: number) =>
    setTimer({ running: true, totalMs: minutes * 60_000, leftMs: minutes * 60_000, endAt: Date.now() + minutes * 60_000, finished: false });
  const toggleTimer = () =>
    setTimer((t) => {
      if (t.finished || t.totalMs === 0) return t; // nothing to pause/resume
      if (t.running && t.endAt != null) {
        // Pause: freeze the remaining time from the absolute deadline.
        const left = Math.max(0, t.endAt - Date.now());
        return { ...t, running: false, leftMs: left, endAt: null, finished: false };
      }
      // Resume from the stored remainder.
      return { ...t, running: true, endAt: Date.now() + t.leftMs, finished: false };
    });
  const resetTimer = () => setTimer({ running: false, totalMs: 0, leftMs: 0, endAt: null, finished: false });
  /** Extend the running (or paused) session by n minutes without restarting. */
  const extendTimer = (minutes: number) =>
    setTimer((t) => {
      if (t.finished || t.totalMs === 0) return t;
      const add = minutes * 60_000;
      if (t.running && t.endAt != null) {
        return { ...t, totalMs: t.totalMs + add, leftMs: t.leftMs + add, endAt: t.endAt + add };
      }
      return { ...t, totalMs: t.totalMs + add, leftMs: t.leftMs + add, finished: false };
    });

  // ------------------------------------------------------- open/close timing
  const shrinkTimer = useRef(0);
  const enterTimer = useRef(0);
  const leaveTimer = useRef(0);
  const openedAt = useRef(0);
  /** Pin toggle: while pinned, the panel ignores hover-out and stays open. */
  const [pinned, setPinned] = useState(false);
  /** Last known pointer position inside the webview (enter/leave events). */
  const mousePos = useRef({ x: -1, y: -1 });

  /** Close: fade the panel out first, then snap the window back. */
  const closePanel = () => {
    window.clearTimeout(shrinkTimer.current);
    window.clearTimeout(leaveTimer.current);
    window.clearTimeout(enterTimer.current);
    setPinned(false); // a real close un-pins; reopening starts auto-close
    setActiveTab(null);
    shrinkTimer.current = window.setTimeout(
      () => setWindowExpanded(false),
      Math.max(0, Math.round(220 / notch.animation.speed)),
    );
  };

  /**
   * Open after hesitating over the bar — a passing cursor doesn't expand it.
   * Hover rolls out the Home dashboard, and the FIRST tab icon is the
   * dashboard's toggle: clicking it re-opens (or toggles) that same view.
   * The other icons switch to their individual panels from there.
   */
  const onMouseEnter = (e: ReactMouseEvent) => {
    mousePos.current = { x: e.clientX, y: e.clientY };
    window.clearTimeout(leaveTimer.current);
    if (activeTab !== null) return;
    window.clearTimeout(enterTimer.current);
    enterTimer.current = window.setTimeout(() => {
      if (document.elementFromPoint(mousePos.current.x, mousePos.current.y) === null) return;
      if (!anyWidget) return;
      window.clearTimeout(shrinkTimer.current);
      setActiveTab("home");
      setWindowExpanded(true);
      // Opening resizes the window under the cursor, which can fire a spurious
      // mouseleave; forgive leaves during this settle window.
      openedAt.current = Date.now();
    }, 100);
  };

  /**
   * Toggle a tab: clicking the open tab's icon closes the panel. The FIRST
   * enabled tab doubles as the Home dashboard toggle (same view hover shows),
   * so it closes while Home is open and switches back to it from any panel.
   */
  const toggleTab = (key: TabKey) => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
    const first = TAB_KEYS.find((k) => notch.widgets[k]);
    const isDashboardToggle = key === first;
    const opens = isDashboardToggle ? "home" : key;
    if (opens === activeTab) {
      closePanel();
      return;
    }
    window.clearTimeout(shrinkTimer.current);
    setActiveTab(opens);
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
    window.clearTimeout(enterTimer.current);
    // Pinned panels ignore hover-out entirely — that's the point of the pin.
    if (pinned) return;
    const px = e.clientX;
    const py = e.clientY;
    window.clearTimeout(leaveTimer.current);
    // Every scheduled close is verified: if the pointer actually left the
    // webview, the hit-test at the recorded point comes back empty and the
    // panel closes; a spurious mouseleave (window resizing under a stationary
    // cursor at open) finds the pill there and is forgiven. That verification
    // replaced an earlier "ignore leaves for 350 ms" guard, which wrongly
    // swallowed a REAL quick leave right after hover-open and left the panel
    // stuck open until the next enter.
    leaveTimer.current = window.setTimeout(() => {
      const hit = document.elementFromPoint(px, py);
      if (!hit) closePanel(); // pointer is genuinely outside the webview
    }, notch.animation.closeDelay);
  };

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
    notch.background ? "" : "no-bg",
  ]
    .filter(Boolean)
    .join(" ");

  const tabs = TAB_KEYS.filter((k) => notch.widgets[k]);

  return (
    <div
      className={`notch-root${notch.layout === "bar" ? " bar" : ""}${notch.placement.startsWith("bottom") ? " bottom" : ""}${windowExpanded ? "" : " idle"}`}
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
        <div className="notch-collapsed" ref={collapsedRef}
          {...(winConf.draggable ? { onPointerDown: dragHandle } : undefined)}
        >
          <span className="notch-tabs">
            {!anyWidget && <span className="notch-small nb-hint">No widgets enabled — set them up in Settings</span>}
            {tabs.map((key, i) => (
              <button
                key={key}
                className={`ntab${activeTab === (i === 0 ? "home" : key) ? " active" : ""}`}
                title={i === 0 ? "Dashboard — the default roll-out view" : TAB_TITLES[key]}
                aria-label={i === 0 ? "Dashboard" : TAB_TITLES[key]}
                aria-pressed={activeTab === (i === 0 ? "home" : key)}
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

          {/* Minimized-pill content — each live indicator is gated by its own
              notch.collapsed.* flag (independent of the expanded panel's
              widget tabs) so the pill can differ from the hover panel. */}
          <span className="notch-status" onPointerDown={(e) => e.stopPropagation()}>
            {notch.collapsed.showTimer && (timer.running || timer.finished) && (
              <span className={`notch-mini-timer${timer.finished ? " done" : timer.running ? "" : " paused"}`} title={timer.finished ? "Focus session done" : timer.running ? "Focus timer running" : "Focus timer paused"}>
                {timer.finished ? "⏱ done ✓" : `⏱ ${fmtTime(timer.leftMs)}`}
              </span>
            )}
            {notch.collapsed.showMem && sys && (
              <span className="nst-chip" title="Memory usage">
                {sys.memTotalGb > 0 ? `${Math.round((sys.memUsedGb / sys.memTotalGb) * 100)}%` : `${sys.memUsedGb.toFixed(0)}GB`}
              </span>
            )}
            {notch.collapsed.showNet && sys && (
              <span className="nst-chip net-chip" title="Network down / up">
                ↓{fmtRate(sys.netDownBps)}
              </span>
            )}
            {notch.collapsed.showMedia && media && (
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
                className={`nst-btn${pinned ? " pinned" : ""}`}
                title={pinned ? "Unpin — close again when the cursor leaves" : "Pin — keep the panel open"}
                aria-label={pinned ? "Unpin panel" : "Pin panel"}
                aria-pressed={pinned}
                onClick={() => {
                  const next = !pinned;
                  setPinned(next);
                  window.clearTimeout(leaveTimer.current);
                  // Unpinning while the cursor is already elsewhere closes
                  // as usual; unpinning under the cursor keeps it open.
                  if (!next) {
                    const { x: px, y: py } = mousePos.current;
                    if (px >= 0) {
                      leaveTimer.current = window.setTimeout(() => {
                        const hit = document.elementFromPoint(px, py);
                        if (!hit) closePanel();
                      }, notch.animation.closeDelay);
                    }
                  }
                }}
              >
                <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="12" x2="12" y1="17" y2="22" />
                  <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                </svg>
              </button>
            )}
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
          {activeTab === "home" && (
            <HomeWidget
              showMedia={notch.widgets.media}
              media={media}
              art={art}
              ambient={notch.appearance.ambientArt}
              ambientColor={notch.appearance.ambientColor}
              showTimer={notch.widgets.timer}
              timer={timer}
              onStart={startTimer}
              onToggle={toggleTimer}
              onReset={resetTimer}
              onExtend={extendTimer}
              showMonitors={notch.widgets.monitors}
              sys={sys}
              showBluetooth={notch.widgets.bluetooth}
              devices={devices}
            />
          )}
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
                  <TimerWidget timer={timer} onStart={startTimer} onToggle={toggleTimer} onReset={resetTimer} onExtend={extendTimer} />
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

/**
 * Default roll-out view: media card on the left, focus timer + system
 * monitors (+ Bluetooth, if enabled) stacked on the right — the hover
 * "home" dashboard. The tab icons switch to individual full panels from
 * here; every column only appears when its widget is enabled.
 */
function HomeWidget(props: {
  showMedia: boolean;
  media: MediaInfo | null;
  art: string | null;
  ambient: boolean;
  ambientColor?: string;
  showTimer: boolean;
  timer: TimerState;
  onStart: (m: number) => void;
  onToggle: () => void;
  onReset: () => void;
  onExtend: (m: number) => void;
  showMonitors: boolean;
  sys: SystemSnapshot | null;
  showBluetooth: boolean;
  devices: BtDevice[];
}) {
  const { showMedia, media, art, ambient, ambientColor, showTimer, timer, onStart, onToggle, onReset, onExtend, showMonitors, sys, showBluetooth, devices } = props;
  const right = (
    <>
      {showTimer && <TimerWidget timer={timer} onStart={onStart} onToggle={onToggle} onReset={onReset} onExtend={onExtend} />}
      {showMonitors && <MonitorsWidget sys={sys} />}
      {showBluetooth && <BluetoothWidget devices={devices} />}
    </>
  );
  const hasRight = showTimer || showMonitors || showBluetooth;
  if (showMedia && hasRight) {
    return (
      <div className="nhome">
        <MediaWidget media={media} art={art} ambient={ambient} ambientColor={ambientColor ?? ""} />
        <div className="nhome-right">{right}</div>
      </div>
    );
  }
  // A single enabled group renders alone, full width.
  return <div className="nhome single">{showMedia ? <MediaWidget media={media} art={art} ambient={ambient} ambientColor={ambientColor ?? ""} /> : right}</div>;
}

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
  onExtend,
}: {
  timer: TimerState;
  onStart: (minutes: number) => void;
  onToggle: () => void;
  onReset: () => void;
  onExtend: (minutes: number) => void;
}) {
  const active = timer.running || timer.leftMs > 0 || timer.finished;
  const pct = timer.totalMs > 0 ? Math.max(0, Math.min(100, (timer.leftMs / timer.totalMs) * 100)) : 0;
  const label = timer.finished ? "✓" : timer.leftMs > 0 ? fmtTime(timer.leftMs) : "Ready";
  const activePreset = TIMER_PRESETS.find((m) => Math.abs(timer.totalMs - m * 60_000) < 500);
  return (
    <div className={`notch-section notch-timer${timer.finished ? " finished" : ""}`}>
      <div className={`notch-ringwrap nft-ring${timer.finished ? " done" : timer.running ? "" : timer.leftMs > 0 ? " paused" : ""}`}>
        {/* conic ring: accent fills the REMAINING share and drains as time
            passes; a finished session stays full in green. */}
        <div
          className="notch-ring"
          style={{
            background: timer.finished
              ? "conic-gradient(var(--ok) 100%, var(--ntrack) 0)"
              : `conic-gradient(var(--accent) ${pct}%, var(--ntrack) 0)`,
          }}
        />
        <span className="notch-ring-text nft-clock">{label}</span>
      </div>
      <div className="nft-side">
        {timer.finished ? (
          <div className="nft-done">
            <span className="nft-done-title">Focus session done ✓</span>
            <span className="nft-done-meta">Finished {fmtDone(Date.now())} — pick your next focus</span>
          </div>
        ) : null}
        <div className="nft-presets">
          {TIMER_PRESETS.map((m) => (
            <button
              key={m}
              className={`nft-chip${activePreset === m ? " active" : ""}`}
              title={`Start a ${m} minute focus session`}
              onClick={() => onStart(m)}
            >
              {m}m
            </button>
          ))}
        </div>
        <div className="nft-ctl">
          {active && !timer.finished && (
            <>
              <button className="nft-chip primary" onClick={onToggle}>
                {timer.running ? "Pause" : "Resume"}
              </button>
              <button className="nft-chip" title="Add 5 minutes to the current session" onClick={() => onExtend(5)}>
                +5m
              </button>
              <button className="nft-chip" title="Add 15 minutes to the current session" onClick={() => onExtend(15)}>
                +15m
              </button>
            </>
          )}
          {!active && (
            <button className="nft-chip primary" onClick={onToggle} disabled>
              Start
            </button>
          )}
          {active && <button className="nft-chip" onClick={onReset}>Reset</button>}
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

  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12,
    hourCycle: hour12 ? "h12" : "h23",
  });
  const time = fmt.format(now);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(now);
  return (
    <span className="notch-pill-clock">
      <span className="nc-week">{day}</span>
      {time}
    </span>
  );
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
