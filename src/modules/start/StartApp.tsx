import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSettings, hasTauri } from "../../store/settings";

interface AppInfo {
  name: string;
  target: string;
}

interface RunItem {
  name: string;
  target: string;
  typed: boolean;
  /** Matches the query, a history entry, or a suggestion. */
  kind: "app" | "history" | "typed";
}

interface HistEntry {
  target: string;
  name: string;
  /** Launch count — most-used floats to the top when there are ties. */
  count: number;
  lastAt: number;
}

const HISTORY_KEY = "aura.start.history.v1";
const MAX_HISTORY = 24;

function loadHistory(): HistEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistEntry[]) : [];
  } catch {
    return [];
  }
}

function rememberLaunch(item: RunItem): HistEntry[] {
  const now = Date.now();
  const list = loadHistory();
  const idx = list.findIndex((h) => h.target === item.target);
  let entry: HistEntry;
  if (idx >= 0) {
    const prev = list[idx];
    entry = { target: item.target, name: item.name, count: prev.count + 1, lastAt: now };
    list.splice(idx, 1);
  } else {
    entry = { target: item.target, name: item.name, count: 1, lastAt: now };
  }
  list.unshift(entry);
  const next = list.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}

/**
 * Start — a Spotlight/Win+Run style launcher.
 *
 * The window (label "start") is created hidden and toggled from anywhere with
 * the global Alt+Space shortcut (registered in Rust). It is disabled together
 * with the module: when modules.start is off, a `start_set_enabled(false)`
 * mutes the shortcut so Alt+Space does nothing.
 */
export function StartApp() {
  const startModuleEnabled = useSettings((s) => s.settings.modules.start);

  // Tell the Rust side whether the launcher module is on, so the global
  // shortcut toggles only when the feature is enabled.
  useEffect(() => {
    if (hasTauri()) void invoke("start_set_enabled", { enabled: startModuleEnabled });
  }, [startModuleEnabled]);

  if (!startModuleEnabled) return null;

  return <Launcher />;
}

const SKELETON_ROWS = 5;

function Launcher() {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [scanning, setScanning] = useState(true);
  const [history, setHistory] = useState<HistEntry[]>(loadHistory);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cache the Start Menu scan once per window life; results are instant after.
  useEffect(() => {
    if (!hasTauri()) {
      setScanning(false);
      return;
    }
    const fetch = async () => {
      try {
        setApps(await invoke<AppInfo[]>("get_apps"));
      } catch {
        /* backend not ready yet */
      }
      setScanning(false);
    };
    void fetch();
  }, []);

  /** Meaningful app order for the empty state: recents first, then the rest. */
  const recentApps = useMemo(() => {
    const byTarget = new Map(apps.map((a) => [a.target, a]));
    const seen = new Set<string>();
    const out: AppInfo[] = [];
    for (const h of history) {
      const a = byTarget.get(h.target);
      if (a && !seen.has(h.target)) {
        seen.add(h.target);
        out.push(a);
      }
    }
    for (const a of apps) {
      if (!seen.has(a.target)) {
        seen.add(a.target);
        out.push(a);
      }
    }
    return out;
  }, [apps, history]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Empty state: recent launches, then suggested apps.
      const recents: RunItem[] = history
        .slice(0, 6)
        .map((h) => ({ name: h.name, target: h.target, typed: false, kind: "history" }));
      const suggestions: RunItem[] = recentApps
        .slice(0, Math.max(0, 6 - recents.length))
        .map((a) => ({ name: a.name, target: a.target, typed: false, kind: "app" }));
      return [...recents, ...suggestions];
    }
    const hits: AppInfo[] = [];
    const contains: AppInfo[] = [];
    for (const a of apps) {
      const n = a.name.toLowerCase();
      if (n.startsWith(q)) hits.push(a);
      else if (n.includes(q)) contains.push(a);
    }
    const list: RunItem[] = [...hits, ...contains]
      .slice(0, 8)
      .map((a) => ({ name: a.name, target: a.target, typed: false, kind: "app" }));
    if (list.length === 0 && apps.length > 0) {
      // Fuzzy: consecutive-chars abbreviation match ("vscode" → "Visual Studio Code").
      for (const a of apps) {
        const n = a.name.toLowerCase();
        if (hasConsecutive(n, q.replace(/\s+/g, ""))) {
          list.push({ name: a.name, target: a.target, typed: false, kind: "app" });
          if (list.length >= 8) break;
        }
      }
    }
    const t = query.trim();
    const url = t.includes("://") || t.includes("www.") || (/^\S+\.\S+$/.test(t) && !t.startsWith("."));
    const path = /^[a-z]:\\/i.test(t) || t.startsWith("shell:");
    list.push({
      name: url ? `Open ${t}` : path ? `Open ${t}` : `Search web for “${t}”`,
      target: t,
      typed: true,
      kind: "typed",
    });
    return list;
  }, [apps, query, history, recentApps]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    if (hasTauri()) void inputRef.current?.focus();
  }, []);

  const run = (item: RunItem) => {
    if (item.kind !== "typed") setHistory(rememberLaunch(item));
    if (hasTauri()) void invoke("open_shortcut", { target: item.target });
    // Small delay so the launch happens before the window hides itself.
    window.setTimeout(() => void hideWindow(), 60);
  };

  const hideWindow = async () => {
    if (!hasTauri()) return;
    // Reset so the next Alt+Space opens a clean palette.
    setQuery("");
    setSel(0);
    try {
      await getCurrentWebviewWindow().hide();
    } catch {
      /* ignore */
    }
  };

  // Close on blur and re-arm on focus — the launcher dismisses itself like
  // Win+S style palettes, and Alt+Space re-showing the OS window makes the
  // webview refocus the input (with a clean query).
  useEffect(() => {
    if (!hasTauri()) return;
    let cancelled = false;
    const unlisten = getCurrentWebviewWindow().onFocusChanged(({ payload: focused }) => {
      if (cancelled) return;
      if (focused) {
        setQuery("");
        setSel(0);
        inputRef.current?.focus();
      } else {
        void hideWindow();
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = hasTauri() && scanning;
  const emptyWithNoData = !query && history.length === 0 && recentApps.length === 0;

  return (
    <div className="start-root">
      <div className="start-card">
        <div className="start-inputrow">
          <span className="start-searchicon" aria-hidden>⌕</span>
          <input
            ref={inputRef}
            className="start-input"
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
                void hideWindow();
              }
            }}
          />
        </div>
        {pending && emptyWithNoData ? (
          <div className="start-list">
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <div key={i} className="start-row skeleton">
                <span className="start-ico" />
                <span className="start-name skel" />
                <span className="start-type">…</span>
              </div>
            ))}
          </div>
        ) : emptyWithNoData ? (
          <div className="start-list">
            <div className="start-empty">No installed apps found — type a URL, path or search query to run it.</div>
          </div>
        ) : (
          <div className={`start-list${query ? "" : " no-head"}`}>
            {!query && (
              <div className="start-section-label">
                {items.some((it) => it.kind === "history") ? "Recent" : "Apps"}
              </div>
            )}
            {items.map((it, i) => (
              <button
                key={`${it.kind}:${it.target}:${i}`}
                className={`start-row${i === sel ? " sel" : ""}`}
                title={it.target}
                style={{ "--i": i } as CSSProperties}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(it)}
              >
                <span className="start-ico">
                  {it.kind === "typed" ? "↵" : it.kind === "history" ? "↻" : it.name.charAt(0).toUpperCase()}
                </span>
                <span className="start-name">{it.name}</span>
                <span className="start-type">{it.kind === "typed" && "run"}</span>
              </button>
            ))}
          </div>
        )}
        <div className="start-hint">
          <span className="start-kbd">Alt+Space</span> close
          <i>·</i>
          <span className="start-kbd">Esc</span> dismiss
          <i>·</i>
          <span className="start-kbd">↑↓</span> browse
          <i>·</i>
          <span className="start-kbd">Enter</span> launch
        </div>
      </div>
    </div>
  );
}

/** True when every word's chars appear in order in `name` (crude abbreviation match). */
function hasConsecutive(name: string, query: string): boolean {
  let qi = 0;
  for (const ch of name) {
    if (qi < query.length && ch === query[qi]) qi++;
  }
  return qi === query.length;
}
