import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettings, hasTauri, NOTCH_FX_LABELS, NOTCH_FX_DESCRIPTIONS, NOTCH_FX_MUSIC } from "../../store/settings";
import type { ModuleKey, Settings, NotchFx } from "../../store/settings";
import { NotchFxBackdrop } from "../../lib/notch-fx";

type Section = "general" | "appearance" | "wallpaper" | "notch" | "start" | "shortcuts" | "todo";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "🏠" },
  { id: "appearance", label: "Clock", icon: "🕐" },
  { id: "wallpaper", label: "Wallpaper", icon: "🖼" },
  { id: "notch", label: "Smart Notch", icon: "🏝" },
  { id: "start", label: "Start Launcher", icon: "🔍" },
  { id: "shortcuts", label: "Shortcuts", icon: "⚡" },
  { id: "todo", label: "To-Do", icon: "✅" },
];

const MODULES: { key: ModuleKey; label: string; hint: string }[] = [
  { key: "notch", label: "Smart Notch", hint: "Dynamic island-style bar at the top of the screen" },
  { key: "start", label: "Start Launcher", hint: "Spotlight-style app launcher — toggle anywhere with Alt+Space" },
  { key: "clock", label: "Clock Widget", hint: "Floating desktop clock (draggable, always on top)" },
  { key: "todo", label: "To-Do Widget", hint: "Floating task list with persistence" },
  { key: "wallpaper", label: "Wallpaper Engine", hint: "Image/video wallpapers behind your desktop icons" },
];

const ACCENTS = ["#6c7bff", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#38bdf8", "#f43f5e"];

const TIMEZONES = [
  { value: "", label: "System default" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "New York (ET)" },
  { value: "America/Chicago", label: "Chicago (CT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Berlin", label: "Berlin (CET)" },
  { value: "Europe/Istanbul", label: "Istanbul (TRT)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Kolkata", label: "Mumbai (IST)" },
  { value: "Asia/Singapore", label: "Singapore (SGT)" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Australia/Sydney", label: "Sydney (AET)" },
];

export function SettingsApp() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [section, setSection] = useState<Section>("general");

  // Keep the OS-level settings hotkey in sync with the saved config: applied
  // on boot (restores a custom combo after a restart) and on every change.
  // The Rust command tears down old registrations and registers the new one.
  useEffect(() => {
    if (!hasTauri()) return;
    void invoke("app_shortcut_set", {
      enabled: settings.hotkey.enabled,
      combo: settings.hotkey.combo.trim() || null,
    });
  }, [settings.hotkey.enabled, settings.hotkey.combo]);

  return (
    <div className="settings-app" data-theme={settings.theme}>
      <aside className="settings-sidebar">
        <div className="settings-brand">
          <span className="brand-dot" />
          Aura
        </div>
        <nav>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item ${section === s.id ? "active" : ""}`} onClick={() => setSection(s.id)}>
              <span className="nav-icon" aria-hidden>{s.id === "notch" ? "🄰" : s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-footnote">
          Changes apply live — no restart needed.
          <br />
          {settings.hotkey.enabled
            ? settings.hotkey.combo.trim() || "Ctrl+Shift+, or Ctrl+Shift++ opens this panel."
            : "Hotkey disabled — use the tray icon to open this panel."}
        </div>
      </aside>

      {/* key={section} re-mounts the wrapper on nav change → replays the
          entrance animation; children above Panel keep their state */}
      <main className="settings-content">
        <div key={section} className="panel-anim">
        {section === "general" && (
          <Panel title="General">
            <Row label="Theme">
              <Segmented
                options={["dark", "light"]}
                value={settings.theme}
                onChange={(v) => update({ theme: v })}
              />
            </Row>
            <Row label="Accent color">
              <div className="accent-row">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className={`accent-dot ${settings.accent === c ? "active" : ""}`}
                    style={{ background: c }}
                    onClick={() => update({ accent: c })}
                    aria-label={`Accent ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={settings.accent}
                  onChange={(e) => update({ accent: e.target.value })}
                  title="Custom accent"
                />
              </div>
            </Row>
            <Row label="Start with Windows">
              <Switch
                on={settings.launchOnStartup}
                onChange={(v) => {
                  update({ launchOnStartup: v });
                  if (hasTauri()) void invoke("autostart_set", { enabled: v });
                }}
              />
            </Row>
            <Divider />
            <p className="section-sub">Modules — disable what you don't use to keep idle memory low.</p>
            {MODULES.map((m) => (
              <Row key={m.key} label={m.label} hint={m.hint}>
                <Switch
                  on={settings.modules[m.key]}
                  onChange={(v) =>
                    update({
                      modules: { [m.key]: v },
                      // Turning the wallpaper on always re-pins it to the very
                      // bottom so apps can never end up behind it.
                      ...(m.key === "wallpaper" && v
                        ? { wallpaper: { win: { level: "bottommost" as const } } }
                        : {}),
                    })
                  }
                />
              </Row>
            ))}
          </Panel>
        )}

        {section === "appearance" && (
          <Panel title="Clock">
            <Row label="Clock layout">
              <Segmented
                options={["digital", "analog", "minimal"]}
                value={settings.clock.layout}
                onChange={(v) => update({ clock: { layout: v } })}
              />
            </Row>
            <Row label="24-hour format">
              <Switch on={!settings.clock.format12h} onChange={(v) => update({ clock: { format12h: !v } })} />
            </Row>
            <Row label="Timezone">
              <select
                value={settings.clock.timezone ?? ""}
                onChange={(e) => update({ clock: { timezone: e.target.value || null } })}
                style={{ width: 200 }}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value || "system"} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </Row><Row label="Background">
              <Switch
                on={settings.clock.background} onChange={(v) => update({ clock: { background: v } })} />
            </Row>
            <Row label="Show date">
              <Switch on={settings.clock.showDate} onChange={(v) => update({ clock: { showDate: v } })} />
            </Row>
            <Row label="Show seconds">
              <Switch on={settings.clock.showSeconds} onChange={(v) => update({ clock: { showSeconds: v } })} />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer, input behavior, size and typography.</p>
            <ModuleWindowEditor module="clock" opts={{ capacity: true }} />
          </Panel>
        )}

        {section === "wallpaper" && (
          <Panel title="Wallpaper Engine">
            <Row
              label="Enabled"
              hint="Master toggle (also in General → Modules) — enabling always pins the wallpaper to the very bottom, behind every app"
            >
              <Switch
                on={settings.modules.wallpaper}
                onChange={(v) =>
                  update(
                    v
                      ? { modules: { wallpaper: v }, wallpaper: { win: { level: "bottommost" as const } } }
                      : { modules: { wallpaper: v } },
                  )
                }
              />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer and input behavior. Coordinates live in the Scaling/Position sliders below.</p>
            <ModuleWindowEditor module="wallpaper" opts={{ coordinates: false, text: false, capacity: false }} />
            <WallpaperLibraryEditor />
            <PerDisplayWallpapers />
            {settings.wallpaper.path && !settings.wallpaper.library.some((i) => i.path === settings.wallpaper.path) && (
              <Row label="External file in use" hint={settings.wallpaper.path}>
                <span />
              </Row>
            )}
            <Row label="Fit" hint="Cover crops, contain fits, fill stretches">
              <Segmented
                options={["cover", "contain", "fill"]}
                value={settings.wallpaper.fit}
                onChange={(v) => update({ wallpaper: { fit: v as Settings["wallpaper"]["fit"] } })}
              />
            </Row>
            <Row label={`Scaling · ${settings.wallpaper.scale.toFixed(2)}×`}>
              <Slider
                min={0.5}
                max={3}
                step={0.05}
                value={settings.wallpaper.scale}
                onChange={(v) => update({ wallpaper: { scale: v } })}
              />
            </Row>
            <Row label={`Position X · ${settings.wallpaper.offsetX}`}>
              <Slider
                min={-100}
                max={100}
                step={1}
                value={settings.wallpaper.offsetX}
                onChange={(v) => update({ wallpaper: { offsetX: v } })}
              />
            </Row>
            <Row label={`Position Y · ${settings.wallpaper.offsetY}`}>
              <Slider
                min={-100}
                max={100}
                step={1}
                value={settings.wallpaper.offsetY}
                onChange={(v) => update({ wallpaper: { offsetY: v } })}
              />
            </Row>
            <Row label={`Dimming · ${settings.wallpaper.dimmer}%`}>
              <Slider
                min={0}
                max={100}
                step={5}
                value={settings.wallpaper.dimmer}
                onChange={(v) => update({ wallpaper: { dimmer: v } })}
              />
            </Row>
            {settings.wallpaper.kind === "video" && (
              <>
                <Row label={`Playback speed · ${settings.wallpaper.playbackRate.toFixed(2)}×`}>
                  <Slider
                    min={0.25}
                    max={2}
                    step={0.05}
                    value={settings.wallpaper.playbackRate}
                    onChange={(v) => update({ wallpaper: { playbackRate: v } })}
                  />
                </Row>
                <Row
                  label={`Volume · ${Math.round(settings.wallpaper.volume * 100)}%${settings.wallpaper.muted ? " (muted)" : ""}`}
                >
                  <Sliders
                    value={settings.wallpaper.volume}
                    muted={settings.wallpaper.muted}
                    onVolume={(v) => update({ wallpaper: { volume: v } })}
                    onMute={(m) => update({ wallpaper: { muted: m } })}
                  />
                </Row>
              </>
            )}
          </Panel>
        )}

        {section === "notch" && (
          <Panel title="Smart Notch">
            <Row label="Background">
              <Switch
                on={settings.notch.background}
                onChange={(v) => update({ notch: { background: v } })}
              />
            </Row>
            <Row label="Media Player">
              <Switch
                on={settings.notch.widgets.media}
                onChange={(v) => update({ notch: { widgets: { media: v } } })}
              />
            </Row>
            <Row label="System Monitors">
              <Switch
                on={settings.notch.widgets.monitors}
                onChange={(v) => update({ notch: { widgets: { monitors: v } } })}
              />
            </Row>
            <Row label="Focus Timer">
              <Switch
                on={settings.notch.widgets.timer}
                onChange={(v) => update({ notch: { widgets: { timer: v } } })}
              />
            </Row>
            <Row label="Clipboard History">
              <Switch
                on={settings.notch.widgets.clipboard}
                onChange={(v) => update({ notch: { widgets: { clipboard: v } } })}
              />
            </Row>
            <Row label="Bluetooth Devices">
              <Switch
                on={settings.notch.widgets.bluetooth}
                onChange={(v) => update({ notch: { widgets: { bluetooth: v } } })}
              />
            </Row>
            <Row label="Quick Shortcuts">
              <Switch
                on={settings.notch.widgets.shortcuts}
                onChange={(v) => update({ notch: { widgets: { shortcuts: v } } })}
              />
            </Row>
            <Row
              label="Searchable launcher"
              hint="Type in the notch to search installed apps, or run any URL / file path with Enter"
            >
              <Switch
                on={settings.notch.widgets.run}
                onChange={(v) => update({ notch: { widgets: { run: v } } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Layout — island or full bar, placed on any edge or corner.</p>
            <Row label="Layout" hint="Notch = compact island; Bar = full desktop bar pinned to an edge">
              <Segmented
                options={["notch", "bar"]}
                value={settings.notch.layout}
                onChange={(v) =>
                  update({
                    notch: {
                      layout: v as Settings["notch"]["layout"],
                      length: v === "bar" ? 40 : 240, // each mode keeps its own sensible default
                    },
                  })
                }
              />
            </Row>
            <Row
              label={`Position · ${settings.notch.placement}`}
              hint="Edge or corner the strip hugs (bottom placements expand upward)"
            >
              <Segmented
                options={["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]}
                value={settings.notch.placement}
                onChange={(v) => update({ notch: { placement: v as Settings["notch"]["placement"] } })}
              />
            </Row>
            <Row
              label={
                settings.notch.layout === "bar"
                  ? `Length · ${settings.notch.length}% of screen`
                  : `Length · ${settings.notch.length}px`
              }
              hint="Independent from thickness — notch mode uses pixels, bar mode a screen-width percentage"
            >
              <Slider
                min={settings.notch.layout === "bar" ? 25 : 200}
                max={settings.notch.layout === "bar" ? 100 : 800}
                step={settings.notch.layout === "bar" ? 5 : 10}
                value={settings.notch.length}
                onChange={(v) => update({ notch: { length: v } })}
              />
            </Row>
            <Row
              label={`Thickness · ${settings.notch.thickness}px`}
            >
              <Slider
                min={30}
                max={96}
                step={1}
                value={settings.notch.thickness}
                onChange={(v) => update({ notch: { thickness: v } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Appearance — glass surface quality.</p>
            <Row
              label={`Glass blur · ${settings.notch.appearance.blur}px`}
              hint="Backdrop blur behind the pill — 0 disables it entirely and uses the least GPU"
            >
              <Slider
                min={0}
                max={40}
                step={2}
                value={settings.notch.appearance.blur}
                onChange={(v) => update({ notch: { appearance: { blur: v } } })}
              />
            </Row>
            <Row
              label={`Opacity · ${Math.round(settings.notch.appearance.glassOpacity * 100)}%`}
            >
              <Slider
                min={30}
                max={100}
                step={1}
                value={Math.round(settings.notch.appearance.glassOpacity * 100)}
                onChange={(v) => update({ notch: { appearance: { glassOpacity: v / 100 } } })}
              />
            </Row>
            <Row
              label={`Corner radius · ${settings.notch.appearance.radius}px`}
            >
              <Slider
                min={14}
                max={40}
                step={1}
                value={settings.notch.appearance.radius}
                onChange={(v) => update({ notch: { appearance: { radius: v } } })}
              />
            </Row>
            <Row
              label={`Accent glow · ${Math.round(settings.notch.appearance.glow * 100)}%`}
            >
              <Slider
                min={0}
                max={100}
                step={1}
                value={Math.round(settings.notch.appearance.glow * 100)}
                onChange={(v) => update({ notch: { appearance: { glow: v / 100 } } })}
              />
            </Row>
            <Row
              label="Ambient light color"
              hint="Color of the light that glows around the notch and behind the media card — Auto follows the accent; a custom color replaces it everywhere"
            >
              <div className="accent-row">
                <button
                  className={`chip ${settings.notch.appearance.ambientColor === "" ? "active" : ""}`}
                  onClick={() => update({ notch: { appearance: { ambientColor: "" } } })}
                  title="Follow the accent color (default)"
                >
                  Auto
                </button>
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className={`accent-dot ${settings.notch.appearance.ambientColor === c ? "active" : ""}`}
                    style={{ background: c }}
                    onClick={() => update({ notch: { appearance: { ambientColor: c } } })}
                    aria-label={`Ambient ${c}`}
                  />
                ))}
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(settings.notch.appearance.ambientColor) ? settings.notch.appearance.ambientColor : "#6c7bff"}
                  onChange={(e) => update({ notch: { appearance: { ambientColor: e.target.value } } })}
                  title="Custom ambient color"
                />
              </div>
            </Row>
            <Row
              label="Album-art ambience"
              hint="Blurred copy of the playing artwork bleeds light into the media card — off saves per-track image work"
            >
              <Switch
                on={settings.notch.appearance.ambientArt}
                onChange={(v) => update({ notch: { appearance: { ambientArt: v } } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">
              Background effect — an animated scene behind the notch chrome and panels.
              “♪ Music” freezes on purpose while nothing is playing.
            </p>
            <div className="nfx-grid">
              {(Object.keys(NOTCH_FX_LABELS) as NotchFx[]).map((fx) => (
                <button
                  key={fx}
                  className={`nfx-tile${settings.notch.fx === fx ? " active" : ""}`}
                  title={NOTCH_FX_DESCRIPTIONS[fx]}
                  onClick={() => update({ notch: { fx } })}
                >
                  <span className="nfx-frame">
                    <NotchFxBackdrop fx={fx} playing />
                  </span>
                  <span className="nfx-tile-name">{NOTCH_FX_LABELS[fx]}</span>
                  <span className="nfx-tile-desc">{NOTCH_FX_DESCRIPTIONS[fx]}</span>
                  {NOTCH_FX_MUSIC.includes(fx) && <span className="nfx-badge">♪ Music</span>}
                </button>
              ))}
            </div>
            <Divider />
            <p className="section-sub">Motion — how the notch behaves.</p>
            <Row
              label={`Animation speed · ${settings.notch.animation.speed.toFixed(2)}×`}
            >
              <Slider
                min={0.25}
                max={2}
                step={0.05}
                value={settings.notch.animation.speed}
                onChange={(v) => update({ notch: { animation: { speed: v } } })}
              />
            </Row>
            <Row
              label="Staggered reveal"
              hint="Sections cascade in one after another when the notch opens"
            >
              <Switch
                on={settings.notch.animation.stagger}
                onChange={(v) => update({ notch: { animation: { stagger: v } } })}
              />
            </Row>
            <Row
              label={`Close grace · ${settings.notch.animation.closeDelay}ms`}
              hint="How long the panel stays open after the pointer leaves before it closes"
            >
              <Slider
                min={0}
                max={800}
                step={20}
                value={settings.notch.animation.closeDelay}
                onChange={(v) => update({ notch: { animation: { closeDelay: v } } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer, input behavior, position override and typography.</p>
            <ModuleWindowEditor module="notch" opts={{ capacity: false }} />
            <Divider />
            <p className="section-sub">Collapsed pill — what shows at 44px. Fully independent from the widget tabs above: the pill can show a chip while its expanded panel is hidden, and vice versa.</p>
            <Row label="Show “Aura” label">
              <Switch
                on={settings.notch.collapsed.showName}
                onChange={(v) => update({ notch: { collapsed: { showName: v } } })}
              />
            </Row>
            <Row label="Show clock in pill">
              <Switch
                on={settings.notch.collapsed.showClock}
                onChange={(v) => update({ notch: { collapsed: { showClock: v } } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Minimized pill — live indicators. Each one is its own switch and does not touch the hovered (expanded) panel.</p>
            <Row label="Mini timer chip">
              <Switch
                on={settings.notch.collapsed.showTimer}
                onChange={(v) => update({ notch: { collapsed: { showTimer: v } } })}
              />
            </Row>
            <Row label="Memory chip">
              <Switch
                on={settings.notch.collapsed.showMem}
                onChange={(v) => update({ notch: { collapsed: { showMem: v } } })}
              />
            </Row>
            <Row label="Network chip">
              <Switch
                on={settings.notch.collapsed.showNet}
                onChange={(v) => update({ notch: { collapsed: { showNet: v } } })}
              />
            </Row>
            <Row label="Mini media indicator">
              <Switch
                on={settings.notch.collapsed.showMedia}
                onChange={(v) => update({ notch: { collapsed: { showMedia: v } } })}
              />
            </Row>
            <Divider />
            <Row label="Bring notch to front">
              <InvokeButton label="Reshow notch" target="notch" />
            </Row>
          </Panel>
        )}

        {section === "start" && (
          <Panel title="Start Launcher">
            <Row label="Enabled">
              <Switch on={settings.modules.start} onChange={(v) => update({ modules: { start: v } })} />
            </Row>
            <Row label="Background">
              <Switch on={settings.start.background} onChange={(v) => update({ start: { background: v } })} />
            </Row>
          </Panel>
        )}

        {section === "shortcuts" && (
          <Panel title="Shortcuts">
            <Row label="Open settings hotkey" hint="Global key combination that shows/hides this settings panel from anywhere — off disables it entirely (the tray icon still opens the panel)">
              <Switch
                on={settings.hotkey.enabled}
                onChange={(v) => update({ hotkey: { enabled: v } })}
              />
            </Row>
            {settings.hotkey.enabled && (
              <Row label="Shortcut" hint="Click the box and press your own combination — at least one modifier (Ctrl/Alt/Shift/Win) plus a key. Esc cancels">
                <HotkeyRecorder combo={settings.hotkey.combo} />
              </Row>
            )}
            <Divider />
            <ShortcutEditor />
          </Panel>
        )}

        {section === "todo" && (
          <Panel title="To-Do module">
            <Row label="Enabled">
              <Switch on={settings.modules.todo} onChange={(v) => update({ modules: { todo: v } })} />
            </Row>
            <Row label="Background">
              <Switch on={settings.todo.background} onChange={(v) => update({ todo: { background: v } })} />
            </Row>
            <Row label="Task ordering" hint="Smart sorts by priority and due date; Created shows newest first">
              <Segmented
                options={["smart", "created"]}
                value={settings.todo.sort}
                onChange={(v) => update({ todo: { sort: v } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer, input behavior, size and typography.</p>
            <ModuleWindowEditor module="todo" opts={{ capacity: true }} />
            <CategoryEditor categories={settings.todo.categories} onChange={(next) => update({ todo: { categories: next } })} />
            <p className="section-sub">
              Tasks, due dates and priorities persist as JSON in local app storage — no external database required.
            </p>
          </Panel>
        )}
        </div>
      </main>
    </div>
  );
}

/**
 * Per-module window configuration editor: layer level (topmost / on screen /
 * bottommost), manual coordinates, click-through, dragging, capacity (window
 * size) and typography. Writes to that module's own `<module>.win` settings.
 */
const FONT_FAMILIES = [
  { value: "", label: "System default" },
  { value: "Segoe UI, sans-serif", label: "Segoe UI" },
  { value: "Arial, sans-serif", label: "Arial" },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "'JetBrains Mono', Consolas, monospace", label: "JetBrains Mono" },
  { value: "'Courier New', monospace", label: "Courier New" },
  { value: "'Times New Roman', serif", label: "Times New Roman" },
];

interface MonitorInfo {
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
}

function ModuleWindowEditor({
  module,
  opts,
}: {
  module: Exclude<ModuleKey, "settings">;
  opts: { capacity?: boolean; coordinates?: boolean; text?: boolean };
}) {
  const win = useSettings((s) => s.settings[module].win);
  const update = useSettings((s) => s.update);
  const setWin = (patch: Partial<typeof win>) => update({ [module]: { win: patch } });

  // Detect once on mount; `invoke` is a no-op in the browser preview.
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    if (!hasTauri()) return;
    invoke<MonitorInfo[]>("get_monitors")
      .then(setMonitors)
      .catch(() => {});
  }, []);

  const monitorKey = (m: MonitorInfo) => `${m.x},${m.y}`;
  // Primary display first, then the others left→right/top→bottom as enumerated.
  const ordered = [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary));
  const monitorLabel = (m: MonitorInfo, i: number) =>
    `Display ${i + 1} — ${m.width}×${m.height}${m.scale !== 1 ? ` @${Math.round(m.scale * 100)}%` : ""}${m.primary ? " · primary" : ""}`;
  const currentKey = win.monitor ? `${win.monitor.x},${win.monitor.y}` : "primary";

  return (
    <>
      <Row label="Screen" hint="Which display this widget lives on — auto keeps it on the primary; a missing/unplugged display falls back to primary too">
        <select
          value={currentKey}
          onChange={(e) => {
            if (e.target.value === "primary") {
              setWin({ monitor: null });
              return;
            }
            const [x, y] = e.target.value.split(",").map(Number);
            setWin({ monitor: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
          }}
          style={{ maxWidth: 240 }}
          disabled={ordered.length === 0}
        >
          <option value="primary">Primary display (auto)</option>
          {ordered.map((m, i) => (
            <option key={monitorKey(m)} value={monitorKey(m)}>
              {monitorLabel(m, i)}
            </option>
          ))}
        </select>
      </Row>
      {module === "wallpaper" ? (
        <Row
          label="Layer"
          hint="Always pinned to the very bottom (embedded behind your desktop icons) so apps can never end up behind it — locked by design"
        >
          <span className="chip active" style={{ cursor: "default" }} title="The wallpaper is forced to the bottom automatically">
            Bottommost · locked
          </span>
        </Row>
      ) : (
        <Row label="Layer" hint="Topmost = always above other windows · On screen = normal window · Bottommost = pinned to the very bottom (wallpaper embeds behind desktop icons)">
          <Segmented
            options={["topmost", "normal-on-screen", "bottommost"] as const}
            value={win.level === "normal" ? "normal-on-screen" : win.level}
            onChange={(v) => setWin({ level: (v === "normal-on-screen" ? "normal" : v) as typeof win.level })}
          />
        </Row>
      )}
      {opts.coordinates !== false && (
        <>
          <Row label={`Position X · ${win.x == null ? "auto" : win.x}`} hint="Left position in pixels inside the chosen display — auto lets Aura place it">
            <NumberInput
              value={win.x}
              onChange={(v) => setWin({ x: v })}
            />
          </Row>
          <Row label={`Position Y · ${win.y == null ? "auto" : win.y}`} hint="Manual top position in pixels">
            <NumberInput
              value={win.y}
              onChange={(v) => setWin({ y: v })}
            />
          </Row>
        </>
      )}
      <Row label="Click-through" hint="Mouse clicks pass straight through the window — you can't drag or interact with it while on">
        <Switch on={win.clickThrough} onChange={(v) => setWin({ clickThrough: v })} />
      </Row>
      <Row label="Draggable">
        <Switch on={win.draggable} onChange={(v) => setWin({ draggable: v })} />
      </Row>
      {opts.capacity && (
        <>
          <Row label={`Capacity width · ${win.capacity.width.toFixed(2)}×`}>
            <Slider
              min={0.4}
              max={2}
              step={0.05}
              value={win.capacity.width}
              onChange={(v) => setWin({ capacity: { ...win.capacity, width: v } })}
            />
          </Row>
          <Row label={`Capacity height · ${win.capacity.height.toFixed(2)}×`}>
            <Slider
              min={0.4}
              max={2}
              step={0.05}
              value={win.capacity.height}
              onChange={(v) => setWin({ capacity: { ...win.capacity, height: v } })}
            />
          </Row>
        </>
      )}
      {opts.text !== false && (
        <>
          <Divider />
          <p className="section-sub">Elements & text — the zoom of everything inside the widget, then typography.</p>
          <Row
            label={`Element scale · ${win.elementScale.toFixed(2)}×`}
            hint="Zoom of the widget's elements (rows, chips, panels) as a whole — like a capacity knob for content, without changing the window or the text-size setting"
          >
            <Slider
              min={0.7}
              max={1.6}
              step={0.05}
              value={win.elementScale}
              onChange={(v) => setWin({ elementScale: v })}
            />
          </Row>
          <Row label="Font family" hint="A few curated faces; pick Custom to type any installed font">
            <div className="inline-actions">
              <select
                value={FONT_FAMILIES.some((f) => f.value === win.text.family) ? win.text.family : "__custom"}
                onChange={(e) => setWin({ text: { ...win.text, family: e.target.value === "__custom" ? "Custom…" : e.target.value } })}
                style={{ maxWidth: 150 }}
              >
                {FONT_FAMILIES.map((f) => (
                  <option key={f.value || "system"} value={f.value || "__custom"}>{f.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Custom font"
                value={FONT_FAMILIES.some((f) => f.value === win.text.family) ? "" : win.text.family}
                onChange={(e) => setWin({ text: { ...win.text, family: e.target.value } })}
                style={{ width: 130 }}
              />
            </div>
          </Row>
          <Row label={`Text size · ${win.text.sizeScale.toFixed(2)}×`}>
            <Slider
              min={0.6}
              max={1.8}
              step={0.05}
              value={win.text.sizeScale}
              onChange={(v) => setWin({ text: { ...win.text, sizeScale: v } })}
            />
          </Row>
          <Row label="Font weight">
            <Segmented
              options={["inherit", "300", "400", "600", "700"] as const}
              value={win.text.weight === 0 ? "inherit" : String(win.text.weight) as "300" | "400" | "600" | "700" | "inherit"}
              onChange={(v) => setWin({ text: { ...win.text, weight: v === "inherit" ? 0 : Number(v) } })}
            />
          </Row>
          <Row label="Text color">
            <div className="accent-row">
              <input
                type="color"
                value={win.text.color || "#ffffff"}
                onChange={(e) => setWin({ text: { ...win.text, color: e.target.value } })}
                title="Text color"
              />
              <button className="btn" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setWin({ text: { ...win.text, color: "" } })}>
                Reset
              </button>
            </div>
          </Row>
        </>
      )}
    </>
  );
}

function NumberInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="inline-actions">
      <input
        type="number"
        style={{ width: 90 }}
        value={value ?? ""}
        placeholder="auto"
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
      <button className="btn" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => onChange(null)}>
        Auto
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="settings-title">{title}</h2>
      <div className="panel-list">{children}</div>
    </section>
  );
}

interface TipPos {
  left: number;
  top: number;
  above: boolean;
  caretX: number;
}

/** Module-level registry: only ONE hint popover may be open at a time.
 *  Opening a new one instantly closes the previous — stale popovers can
 *  otherwise linger (e.g. open via focus, then another badge hover) and
 *  stack on top of unrelated rows. */
const activeTip = { close: null as null | (() => void) };

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const badgeRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [tip, setTip] = useState<TipPos | null>(null);

  /** Position the fixed popover under/over the badge, clamped to the viewport. */
  const open = (immediately = false) => {
    if (!hint) return;
    // Singleton: kill whatever other row's popover is showing (and its timer).
    activeTip.close?.();
    const closeSelf = () => {
      setTip(null);
      if (activeTip.close === closeSelf) activeTip.close = null;
    };
    const place = () => {
      const b = badgeRef.current?.getBoundingClientRect();
      if (!b) return;
      const above = b.bottom + 150 > window.innerHeight;
      const left = Math.max(8, Math.min(b.left, window.innerWidth - 296));
      setTip({
        left,
        top: above ? b.top - 13 : b.bottom + 13,
        above,
        caretX: Math.max(14, b.left - left + b.width / 2),
      });
      activeTip.close = closeSelf;
    };
    if (immediately) place();
    else timerRef.current = window.setTimeout(place, 160);
  };
  const hide = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Only clear the singleton slot if it still points at THIS row's closer.
    if (activeTip.close) {
      const closer = activeTip.close;
      closer();
    }
  };

  // Scrolling or resizing the window unanchors a fixed tooltip — dismiss it.
  // Also cancels a pending open timer so a queued popover can't appear later.
  useEffect(() => {
    if (!tip) return;
    const dismiss = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setTip(null);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [tip]);

  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">
          {label}
          {hint && (
            <button
              ref={badgeRef}
              type="button"
              className={`info-tip${tip ? " open" : ""}`}
              aria-label={hint}
              onMouseEnter={() => open()}
              onMouseLeave={hide}
              onFocus={() => open(true)}
              onBlur={hide}
              onKeyDown={(e) => {
                if (e.key === "Escape") hide();
              }}
            >
              i
            </button>
          )}
        </div>
      </div>
      <div className="setting-control">{children}</div>
      {/* Portal to <body>: entrance animations leave a computed transform on
          .setting-row/.panel-anim, and ANY ancestor transform makes it the
          containing block for position: fixed — the popover would anchor to
          the row instead of the viewport and appear "elsewhere". A portal
          escapes every ancestor transform for good. */}
      {tip && hint &&
        createPortal(
          <div
            className={`info-tip-pop${tip.above ? " above" : ""}`}
            role="tooltip"
            style={
              { left: tip.left, top: tip.top, "--caret-x": `${tip.caretX}px` } as CSSProperties
            }
          >
            {hint}
          </div>,
          document.body,
        )}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((opt) => (
        <button
          key={opt}
          className={value === opt ? "active" : ""}
          onClick={() => onChange(opt)}
        >
          {opt === "none" ? "Off" : opt}
        </button>
      ))}
    </div>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  /** Ctrl+click swaps the slider for a number box so an exact value can be
   *  typed (Scaling, Position, Length…) instead of hunting for the pixel. */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const commit = () => {
      const n = Number(draft.replace(",", "."));
      if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      setEditing(false);
    };
    return (
      <input
        type="number"
        autoFocus
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        style={{ width: 130, padding: "5px 8px", borderRadius: 8, fontSize: 12 }}
      />
    );
  }

  return (
    <input
      type="range"
      className="slim"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      // Block the native thumb-jump on mouse-down, then open the number editor.
      onMouseDown={(e) => {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setDraft(String(value));
          setEditing(true);
        }
      }}
      title="Ctrl+click to type an exact value"
      style={{ width: 220 }}
    />
  );
}

function Sliders({
  value,
  muted,
  onVolume,
  onMute,
}: {
  value: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: (m: boolean) => void;
}) {
  return (
    <div className="inline-actions">
      <Switch on={muted} onChange={onMute} />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onVolume(Number(e.target.value))}
        style={{ width: 160 }}
      />
    </div>
  );
}

function InvokeButton({ label, target }: { label: string; target: string }) {
  return (
    <button
      className="btn"
      onClick={async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("set_module_visible", { label: target, visible: true });
        } catch {
          /* ignore */
        }
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Hotkey recorder: records a user-chosen global shortcut for the settings
// panel. Produces lowercase combos in the Rust global-shortcut plugin's
// syntax ("ctrl+shift+k"). Requires at least one modifier so everyday typing
// can never map a plain key to a system-wide hotkey.
// ---------------------------------------------------------------------------
const CODE_MAP: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Space: "space",
};

function codeToKey(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c.toLowerCase();
  if (/^Numpad/.test(c)) return c.toLowerCase(); // e.g. numpadplus, numpad0
  return CODE_MAP[c] ?? null;
}

function HotkeyRecorder({ combo }: { combo: string }) {
  const update = useSettings((s) => s.update);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(false);
        return;
      }
      const main = codeToKey(e);
      if (!main || main === "escape") return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      if (e.metaKey) mods.push("super");
      if (mods.length === 0) return; // modifiers first, then release on the key
      const next = [...mods, main].join("+");
      setListening(false);
      setError(null);
      // Register immediately so an invalid/taken combo is reported in place.
      if (hasTauri()) {
        void invoke("app_shortcut_set", { enabled: true, combo: next })
          .then(() => setError(null))
          .catch((err) => setError(String(err?.message ?? err)));
      }
      update({ hotkey: { combo: next } });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, update]);

  return (
    <div className="inline-actions" style={{ flexWrap: "wrap" }}>
      {listening ? (
        <button type="button" className="btn recording" onClick={() => setListening(false)}>
          Press keys… (Esc to cancel)
        </button>
      ) : (
        <button type="button" className="btn" onClick={() => setListening(true)}>
          {combo || "Default — Ctrl+Shift+,"}
        </button>
      )}
      {combo && (
        <button
          type="button"
          className="btn"
          onClick={() => update({ hotkey: { combo: "" } })}
          title="Back to the builtin default"
        >
          Reset
        </button>
      )}
      {error && <span className="hk-error">{error}</span>}
    </div>
  );
}

function ShortcutEditor() {
  const shortcuts = useSettings((s) => s.settings.notch.shortcuts);
  const update = useSettings((s) => s.update);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [icon, setIcon] = useState("⭐");

  const commit = () => {
    if (!name.trim() || !target.trim()) return;
    update({ notch: { shortcuts: [...shortcuts, { name: name.trim(), target: target.trim(), icon }] } });
    setName("");
    setTarget("");
  };

  return (
    <div className="shortcut-editor">
      <p className="section-sub">
        Notch quick shortcuts — open a URL or a local file/app from the Smart Notch.
      </p>
      <div className="shortcut-list">
        {shortcuts.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>No shortcuts yet.</div>
        )}
        {shortcuts.map((s, i) => (
          <div key={s.target} className="shortcut-row">
            <span>{s.icon}</span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
            <span
              style={{
                color: "var(--muted)",
                fontSize: 12,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.target}
            </span>
            <button
              className="btn danger"
              style={{ fontSize: 11, padding: "3px 10px" }}
              onClick={() => update({ notch: { shortcuts: shortcuts.filter((_, idx) => idx !== i) } })}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="shortcut-add">
        <input type="text" style={{ width: 46 }} value={icon} onChange={(e) => setIcon(e.target.value)} title="Emoji icon" />
        <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="text" placeholder="URL or file path" value={target} onChange={(e) => setTarget(e.target.value)} />
        <button className="btn primary" onClick={commit}>Add</button>
      </div>
    </div>
  );
}

function CategoryEditor({
  categories,
  onChange,
}: {
  categories: string[];
  onChange: (next: string[]) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="category-editor">
      <p className="section-sub">Categories available in the to-do widget.</p>
      <div className="shortcut-row" style={{ marginBottom: 8 }}>
        {categories.map((c) => (
          <span key={c} className="chip">
            {c}
            <button
              aria-label={`Remove ${c}`}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", marginLeft: 6 }}
              onClick={() => onChange(categories.filter((x) => x !== c))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="shortcut-add" style={{ maxWidth: 420 }}>
        <input
          type="text"
          placeholder="New category"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              onChange([...categories, value.trim()]);
              setValue("");
            }
          }}
        />
        <button
          className="btn primary"
          onClick={() => {
            if (value.trim()) {
              onChange([...categories, value.trim()]);
              setValue("");
            }
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Divider() {
  return <hr className="divider" />;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_EXTS = ["mp4", "webm"];

/** Picks the image/video kind for a path by extension. */
function kindOf(path: string): "image" | "video" {
  const lower = path.toLowerCase();
  return VIDEO_EXTS.some((e) => lower.endsWith(`.${e}`)) ? "video" : "image";
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Wallpaper library: an Add button (multi-select file dialog) + a drag-and-drop
 * zone. Every imported file is COPIED into Aura's own app-data wallpapers
 * folder (Rust: `wallpaper_import`), so the source can later be moved or
 * deleted. Clicking a tile applies it; ✕ removes the copy from disk too.
 */
/** Captured video first-frames, cached per file path — videos never change
 *  their copy after import, so one capture per library entry suffices. */
const videoThumbCache = new Map<string, string>();

/**
 * Thumbnail for a video wallpaper: loads the file in a hidden <video>, seeks
 * briefly into it and grabs a canvas frame. Falls back to the 🎬 placeholder
 * while loading or if the frame can't be captured (unseekable codecs etc.).
 */
function VideoThumb({ src, name }: { src: string; name: string }) {
  const [frame, setFrame] = useState<string | null>(() => videoThumbCache.get(src) ?? null);

  useEffect(() => {
    if (frame || !hasTauri()) return;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    let captured = false;

    const capture = () => {
      if (captured || !v.videoWidth) return;
      captured = true;
      try {
        // Fixed thumb width; keep the video's own aspect ratio.
        const w = 220;
        const h = Math.max(1, Math.round((v.videoHeight / v.videoWidth) * w));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, w, h);
        const url = canvas.toDataURL("image/jpeg", 0.72);
        videoThumbCache.set(src, url);
        setFrame(url);
      } catch {
        /* keep the placeholder */
      }
    };

    // Prefer a frame slightly into the clip; very short videos keep frame 0.
    v.addEventListener("loadedmetadata", () => {
      if ((v.duration || 0) > 1) {
        v.currentTime = Math.min(1.5, v.duration * 0.05);
      }
    });
    // Fires after the seek (or right away when no seek was needed).
    v.addEventListener("seeked", capture);
    v.addEventListener("loadeddata", () => {
      // No seek planned: this event IS the first frame.
      setTimeout(capture, 60);
    });

    return () => {
      v.removeEventListener("seeked", capture);
      v.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (frame) return <img src={frame} alt={name} loading="lazy" />;
  return <span className="wp-tile-video wp-tile-video-loading">🎬</span>;
}

/**
 * Per-display wallpaper assignment: a select per connected display, offering
 * the library. “Default” removes the override so that display follows the
 * main wallpaper chosen above.
 */
function PerDisplayWallpapers() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const lib = settings.wallpaper.library;
  const displays = settings.wallpaper.displays ?? {};

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    if (!hasTauri()) return;
    invoke<MonitorInfo[]>("get_monitors").then(setMonitors).catch(() => {});
  }, []);

  if (monitors.length === 0) return null;

  return (
    <>
      <Divider />
      <p className="section-sub">
        Per-display wallpapers — give each connected screen its own image or video.
        They share the fit, scale and dimming settings above.
      </p>
      {monitors.map((m, i) => {
        const key = `${m.x},${m.y}`;
        const assigned = displays[key];
        return (
          <Row
            key={key}
            label={`Wallpaper on Display ${i + 1} — ${m.width}×${m.height}${m.primary ? " · primary" : ""}`}
            hint="Default follows the main wallpaper chosen in the library above; picking an entry pins it to just this display"
          >
            <select
              value={assigned?.path ?? ""}
              onChange={(e) => {
                const next = { ...displays };
                if (!e.target.value) {
                  delete next[key];
                } else {
                  const item = lib.find((l) => l.path === e.target.value);
                  if (item) next[key] = { path: item.path, kind: item.kind };
                }
                update({ wallpaper: { displays: next } });
              }}
              style={{ maxWidth: 240 }}
            >
              <option value="">Default — main wallpaper</option>
              {lib.map((l) => (
                <option key={l.path} value={l.path}>
                  {l.kind === "video" ? "🎬 " : "🖼 "}
                  {l.name}
                </option>
              ))}
            </select>
          </Row>
        );
      })}
      {monitors.length <= 1 && (
        <p className="section-sub">Connect a second display to give it a different wallpaper.</p>
      )}
    </>
  );
}

function WallpaperLibraryEditor() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const lib = settings.wallpaper.library;

  const apply = (item: { path: string; kind: "image" | "video" }) =>
    update({ wallpaper: { path: item.path, kind: item.kind } });

  const importPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    try {
      if (!hasTauri()) {
        // Browser preview: no filesystem — report and bail.
        console.warn("Wallpaper import needs the desktop app");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const added: { name: string; path: string; kind: "image" | "video" }[] = [];
      for (const p of paths) {
        try {
          const copied = await invoke<string>("wallpaper_import", { source: p });
          added.push({ name: baseName(p), path: copied, kind: kindOf(p) });
        } catch (e) {
          console.error("wallpaper_import failed", p, e);
        }
      }
      if (added.length === 0) return;
      const known = new Set(lib.map((i) => i.path));
      const merged = [...lib, ...added.filter((a) => !known.has(a.path))];
      const last = added[added.length - 1];
      // Import immediately applies the newest addition.
      update({ wallpaper: { library: merged, path: last.path, kind: last.kind } });
    } finally {
      setImporting(false);
    }
  };

  // OS drag-and-drop: Tauri delivers absolute paths of dropped files.
  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow().onDragDropEvent((ev) => {
        if (ev.payload.type === "enter") setDragOver(true);
        else if (ev.payload.type === "leave") setDragOver(false);
        else if (ev.payload.type === "drop") {
          setDragOver(false);
          void importPaths(ev.payload.paths ?? []);
        }
      }).then((un) => {
        unlisten = un;
      }),
    );
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addItem = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Media", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    await importPaths(paths);
  };

  const removeItem = async (item: { path: string }) => {
    try {
      if (hasTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("wallpaper_delete_copy", { path: item.path });
      }
    } catch (e) {
      console.error("wallpaper_delete_copy failed", e);
    }
    const next = lib.filter((i) => i.path !== item.path);
    const patch: Record<string, unknown> = { library: next };
    if (settings.wallpaper.path === item.path) {
      patch.path = "";
      patch.kind = "none";
    }
    update({ wallpaper: patch });
  };

  return (
    <div className="wp-library">
      <Row
        label="Add wallpaper"
        hint="Files are copied into Aura's own folder — add as many as you like, then switch between them"
      >
        <button className="btn primary" disabled={importing} onClick={addItem}>
          {importing ? "Copying…" : "Add wallpapers…"}
        </button>
      </Row>
      <div className={`wp-drop ${dragOver ? "over" : ""}`}>
        {hasTauri()
          ? `Drag & drop images or videos here to import them${importing ? " — copying…" : ""}`
          : "File import works in the Aura desktop app"}
      </div>
      {lib.length > 0 && (
        <div className="wp-grid">
          {lib.map((item) => {
            const active = settings.wallpaper.path === item.path;
            return (
              <div
                key={item.path}
                className={`wp-tile ${active ? "active" : ""}`}
                onClick={() => apply(item)}
                role="button"
                title={item.name}
              >
                {item.kind === "image" ? (
                  <img src={convertFileSrc(item.path)} alt={item.name} loading="lazy" />
                ) : (
                  <VideoThumb src={convertFileSrc(item.path)} name={item.name} />
                )}
                {item.kind === "video" && <span className="wp-tile-play" aria-hidden>▶</span>}
                <span className="wp-tile-name">{item.name}</span>
                {active && <span className="wp-tile-badge">In use</span>}
                <button
                  className="wp-tile-del"
                  aria-label={`Remove ${item.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeItem(item);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
