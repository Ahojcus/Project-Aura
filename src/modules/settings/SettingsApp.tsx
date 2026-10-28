import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useSettings, hasTauri, NOTCH_FX_LABELS, NOTCH_FX_DESCRIPTIONS, NOTCH_FX_MUSIC } from "../../store/settings";
import type { ModuleKey, Settings, NotchFx } from "../../store/settings";
import { NotchFxBackdrop } from "../../lib/notch-fx";

type Section = "general" | "appearance" | "wallpaper" | "notch" | "shortcuts" | "todo";

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: "general", label: "General", icon: "🏠" },
  { id: "appearance", label: "Clock", icon: "🕐" },
  { id: "wallpaper", label: "Wallpaper", icon: "🖼" },
  { id: "notch", label: "Smart Notch", icon: "🏝" },
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
          Ctrl+Shift+, or Ctrl+Shift++ opens this panel.
        </div>
      </aside>

      {/* key={section} re-mounts the wrapper on nav change → replays the
          entrance animation; children above Panel keep their state */}
      <main className="settings-content">
        <div key={section} className="panel-anim">
        {section === "general" && (
          <Panel title="General">
            <Row label="Theme" hint="Switch between dark and light surfaces">
              <Segmented
                options={["dark", "light"]}
                value={settings.theme}
                onChange={(v) => update({ theme: v })}
              />
            </Row>
            <Row label="Accent color" hint="Used across widgets, notch and controls">
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
            <Row label="Start with Windows" hint="Launch Aura automatically when you sign in — starts quietly in the tray">
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
                  onChange={(v) => update({ modules: { [m.key]: v } })}
                />
              </Row>
            ))}
          </Panel>
        )}

        {section === "appearance" && (
          <Panel title="Clock">
            <Row label="Clock layout" hint="Three minimal layouts">
              <Segmented
                options={["digital", "analog", "minimal"]}
                value={settings.clock.layout}
                onChange={(v) => update({ clock: { layout: v } })}
              />
            </Row>
            <Row label="24-hour format" hint="Uncheck for 12h with AM/PM">
              <Switch on={!settings.clock.format12h} onChange={(v) => update({ clock: { format12h: !v } })} />
            </Row>
            <Row label="Timezone" hint="Clock renders in this zone instead of the system one">
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
            </Row>
            <Row label="Show date" hint="Weekday/month line under the time">
              <Switch on={settings.clock.showDate} onChange={(v) => update({ clock: { showDate: v } })} />
            </Row>
            <Row label="Show seconds" hint="Seconds tick in the digital and minimal layouts">
              <Switch on={settings.clock.showSeconds} onChange={(v) => update({ clock: { showSeconds: v } })} />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer, input behavior, size and typography.</p>
            <ModuleWindowEditor module="clock" opts={{ capacity: true }} />
          </Panel>
        )}

        {section === "wallpaper" && (
          <Panel title="Wallpaper Engine">
            <Row label="Enabled" hint="Master toggle (also in General → Modules)">
              <Switch
                on={settings.modules.wallpaper}
                onChange={(v) => update({ modules: { wallpaper: v } })}
              />
            </Row>
            <Divider />
            <p className="section-sub">Window — layer and input behavior. Coordinates live in the Scaling/Position sliders below.</p>
            <ModuleWindowEditor module="wallpaper" opts={{ coordinates: false, text: false, capacity: false }} />
            <WallpaperLibraryEditor />
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
            <Row label={`Scaling · ${settings.wallpaper.scale.toFixed(2)}×`} hint="Zoom into the image or video">
              <Slider
                min={0.5}
                max={3}
                step={0.05}
                value={settings.wallpaper.scale}
                onChange={(v) => update({ wallpaper: { scale: v } })}
              />
            </Row>
            <Row label={`Position X · ${settings.wallpaper.offsetX}`} hint="Horizontal pan, percent">
              <Slider
                min={-100}
                max={100}
                step={1}
                value={settings.wallpaper.offsetX}
                onChange={(v) => update({ wallpaper: { offsetX: v } })}
              />
            </Row>
            <Row label={`Position Y · ${settings.wallpaper.offsetY}`} hint="Vertical pan, percent">
              <Slider
                min={-100}
                max={100}
                step={1}
                value={settings.wallpaper.offsetY}
                onChange={(v) => update({ wallpaper: { offsetY: v } })}
              />
            </Row>
            <Row label={`Dimming · ${settings.wallpaper.dimmer}%`} hint="Darkens the wallpaper so icons and widgets read better">
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
                <Row label={`Playback speed · ${settings.wallpaper.playbackRate.toFixed(2)}×`} hint="Video playback rate">
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
                  hint="Hardware-accelerated video playback volume"
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
            <Row label="Media Player" hint="Local Spotify / system media via Windows SMTC: title, artist, album art, progress, play/pause">
              <Switch
                on={settings.notch.widgets.media}
                onChange={(v) => update({ notch: { widgets: { media: v } } })}
              />
            </Row>
            <Row label="System Monitors" hint="CPU, RAM and network speed, polled natively every 1.5s">
              <Switch
                on={settings.notch.widgets.monitors}
                onChange={(v) => update({ notch: { widgets: { monitors: v } } })}
              />
            </Row>
            <Row label="Focus Timer" hint="Countdown with presets (5/15/25/50 min) and a chime when it ends — mini countdown in the pill while running">
              <Switch
                on={settings.notch.widgets.timer}
                onChange={(v) => update({ notch: { widgets: { timer: v } } })}
              />
            </Row>
            <Row label="Clipboard History" hint="Recent copied text with one-click copy-back — the Windows clipboard is polled every 2s">
              <Switch
                on={settings.notch.widgets.clipboard}
                onChange={(v) => update({ notch: { widgets: { clipboard: v } } })}
              />
            </Row>
            <Row label="Bluetooth Devices" hint="Battery percentage for connected headphones, mice and other paired devices">
              <Switch
                on={settings.notch.widgets.bluetooth}
                onChange={(v) => update({ notch: { widgets: { bluetooth: v } } })}
              />
            </Row>
            <Row label="Quick Shortcuts" hint="One-click access to apps and URLs">
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
              hint="Height of the collapsed strip"
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
              hint="How solid the glass reads — higher is more opaque"
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
              hint="Roundness of the pill and expanded panel"
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
              hint="Strength of the accent halo and aura — 0 turns all glow off"
            >
              <Slider
                min={0}
                max={100}
                step={5}
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
              hint="Below 1× is snappier and cheaper, above 1× is more dramatic"
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
            <p className="section-sub">Collapsed pill — what shows at 44px.</p>
            <Row label="Show “Aura” label" hint="Just the status dot and live indicators when off">
              <Switch
                on={settings.notch.collapsed.showName}
                onChange={(v) => update({ notch: { collapsed: { showName: v } } })}
              />
            </Row>
            <Row label="Show clock in pill" hint="Live time next to the label, follows the clock format setting">
              <Switch
                on={settings.notch.collapsed.showClock}
                onChange={(v) => update({ notch: { collapsed: { showClock: v } } })}
              />
            </Row>
            <Divider />
            <Row label="Bring notch to front" hint="Re-show the widget after moving or hiding it">
              <InvokeButton label="Reshow notch" target="notch" />
            </Row>
          </Panel>
        )}

        {section === "shortcuts" && (
          <Panel title="Shortcuts">
            <Row label="Global shortcut" hint="Ctrl + Shift + , or Ctrl + Shift + + toggles this settings panel from anywhere">
              <div className="inline-actions">
                <kbd>Ctrl+Shift+,</kbd>
                <kbd>Ctrl+Shift++</kbd>
              </div>
            </Row>
            <Divider />
            <ShortcutEditor />
          </Panel>
        )}

        {section === "todo" && (
          <Panel title="To-Do module">
            <Row label="Enabled" hint="Master toggle (also in General → Modules)">
              <Switch on={settings.modules.todo} onChange={(v) => update({ modules: { todo: v } })} />
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
      <Row label="Layer" hint="Topmost = always above other windows · On screen = normal window · Bottommost = pinned to the very bottom (wallpaper embeds behind desktop icons)">
        <Segmented
          options={["topmost", "normal-on-screen", "bottommost"] as const}
          value={win.level === "normal" ? "normal-on-screen" : win.level}
          onChange={(v) => setWin({ level: (v === "normal-on-screen" ? "normal" : v) as typeof win.level })}
        />
      </Row>
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
      <Row label="Draggable" hint="Shows a drag grab handle / drag region so you can move the widget">
        <Switch on={win.draggable} onChange={(v) => setWin({ draggable: v })} />
      </Row>
      {opts.capacity && (
        <>
          <Row label={`Capacity width · ${win.capacity.width.toFixed(2)}×`} hint="Window width as a multiple of the default size">
            <Slider
              min={0.4}
              max={2}
              step={0.05}
              value={win.capacity.width}
              onChange={(v) => setWin({ capacity: { ...win.capacity, width: v } })}
            />
          </Row>
          <Row label={`Capacity height · ${win.capacity.height.toFixed(2)}×`} hint="Window height as a multiple of the default size">
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
          <p className="section-sub">Text style — typography of this widget's text.</p>
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
          <Row label={`Text size · ${win.text.sizeScale.toFixed(2)}×`} hint="Scales every text element in the widget">
            <Slider
              min={0.6}
              max={1.8}
              step={0.05}
              value={win.text.sizeScale}
              onChange={(v) => setWin({ text: { ...win.text, sizeScale: v } })}
            />
          </Row>
          <Row label="Font weight" hint="Heavy to light strokes">
            <Segmented
              options={["inherit", "300", "400", "600", "700"] as const}
              value={win.text.weight === 0 ? "inherit" : String(win.text.weight) as "300" | "400" | "600" | "700" | "inherit"}
              onChange={(v) => setWin({ text: { ...win.text, weight: v === "inherit" ? 0 : Number(v) } })}
            />
          </Row>
          <Row label="Text color" hint="Custom text color — clear to keep the theme colors">
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

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const badgeRef = useRef<HTMLButtonElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [tip, setTip] = useState<TipPos | null>(null);

  /** Position the fixed popover under/over the badge, clamped to the viewport. */
  const open = (immediately = false) => {
    if (!hint) return;
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
    };
    if (immediately) place();
    else timerRef.current = window.setTimeout(place, 160);
  };
  const hide = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setTip(null);
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
      {tip && hint && (
        <div
          className={`info-tip-pop${tip.above ? " above" : ""}`}
          role="tooltip"
          style={
            { left: tip.left, top: tip.top, "--caret-x": `${tip.caretX}px` } as CSSProperties
          }
        >
          {hint}
        </div>
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
  return (
    <input
      type="range"
      className="slim"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
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
                  <span className="wp-tile-video">🎬</span>
                )}
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
