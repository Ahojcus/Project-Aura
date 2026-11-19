import type { NotchWidgetKey } from "../store/settings";

const GLYPHS = {
  home: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  pin: (
    <>
      <path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" />
      <path d="M12 13v7" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  media: (
    <>
      <path d="M9 18V6l9-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="15" cy="16" r="3" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="8" y="5" width="3.2" height="14" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.4" y="5" width="3.2" height="14" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  previous: (
    <>
      <path d="M18 5.5v13L8.5 12z" fill="currentColor" stroke="none" />
      <rect x="4.6" y="5.5" width="2.2" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  next: (
    <>
      <path d="M6 5.5v13L15.5 12z" fill="currentColor" stroke="none" />
      <rect x="17.2" y="5.5" width="2.2" height="13" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  lights: <path d="M4 18v-5M8 18V8M12 18V5M16 18v-7M20 18V9" />,
  volume: (
    <>
      <path d="M4 7h9M18 7h2M4 17h3M11 17h9" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  shelf: (
    <>
      <path d="M4 5h16v13H4z" />
      <path d="M4 12h4l2 2h4l2-2h4" />
    </>
  ),
  clipboard: (
    <>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4V3h6v1M9 9h6M9 13h6M9 17h4" />
    </>
  ),
  download: <path d="M12 4v10M8 11l4 4 4-4M5 19h14" />,
  cloak: <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6ZM4 4l16 16" />,
  stats: <path d="M4 17l4-5 3 3 4-7 5 4M4 20h16" />,
  weather: (
    <>
      <path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.4 1.5A3.5 3.5 0 0 0 7 18Z" />
      <path d="M8 5V3M5 7 3.5 5.5M12 4V2" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 13V9M9 3h6" />
    </>
  ),
  shortcuts: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h2M13 9h2M7 14h8" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  run: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </>
  ),
  bluetooth: <path d="M8 7l8 10-4 3V4l4 3L8 17" />,
};

/** Every glyph the notch chrome draws (24x24 stroke icons). */
export type NotchGlyphName = keyof typeof GLYPHS;

/** Which glyph a widget tab shows. */
export const NOTCH_WIDGET_GLYPH: Record<NotchWidgetKey, NotchGlyphName> = {
  run: "run",
  media: "media",
  musicLights: "lights",
  monitors: "stats",
  timer: "timer",
  bluetooth: "bluetooth",
  clipboard: "clipboard",
  shortcuts: "shortcuts",
  volume: "volume",
  shelf: "shelf",
  downloads: "download",
  cloak: "cloak",
  weather: "weather",
  forecast: "weather",
  edgeLight: "light",
};

export function NotchGlyph({ icon, size = 18 }: { icon: NotchGlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[icon]}
    </svg>
  );
}
