import { useEffect, useState } from "react";
import { useModuleWindow, useSettings } from "../../store/settings";
import { dragHandle } from "../../lib/drag";
import { useHitRegion } from "../../lib/hitRegion";

/** Formats a Date in the selected timezone / 12h / 24h preferences. */
function getParts(date: Date, timezone: string | null, format12h: boolean) {
  const read = (tz: string | null) =>
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: format12h,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      second: "2-digit",
      timeZone: tz ?? undefined,
    }).formatToParts(date);

  let parts: Array<{ type: string; value: string }>;
  try {
    parts = read(timezone);
  } catch {
    // Unknown/removed timezone: fall back to the system zone.
    parts = read(null);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    hour: get("hour").padStart(2, "0"),
    minute: get("minute"),
    second: get("second").padStart(2, "0"),
    ampm: get("dayPeriod").replace(/[^A-Za-z]/g, ""),
    weekday: get("weekday"),
    month: get("month"),
    day: get("day"),
    year: get("year"),
  };
}

export function ClockModule() {
  const clock = useSettings((s) => s.settings.clock);
  const draggable = useSettings((s) => s.settings.clock.win.draggable);
  useModuleWindow("clock");
  useHitRegion(".clock-root", 20, 8);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const t = getParts(now, clock.timezone, clock.format12h);
  const hour = clock.format12h ? t.hour : String(Number(t.hour) % 24).padStart(2, "0");
  const time = `${hour}:${t.minute}${clock.showSeconds ? ":" + t.second : ""}`;
  const dateText = `${t.weekday}, ${t.month} ${t.day}${clock.showYear ? `, ${t.year}` : ""}`;
  const drag = draggable ? { onPointerDown: dragHandle, title: "Drag to move" } : {};

  if (clock.layout === "analog") {
    const h = (Number(t.hour) % 12) + Number(t.minute) / 60;
    const m = Number(t.minute) + Number(t.second) / 60;
    const s = Number(t.second);
    const hand = (angle: number, length: number, width: number) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      return (
        <line
          x1={80}
          y1={80}
          x2={80 + Math.cos(rad) * length}
          y2={80 + Math.sin(rad) * length}
          stroke="currentColor"
          strokeWidth={width}
          strokeLinecap="round"
        />
      );
    };
    return (
      <div className="clock-root" {...drag}>
        <svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label={`Analog clock ${time}`}>
          <circle cx="80" cy="80" r="74" fill="none" stroke="currentColor" strokeWidth="1" />
          {Array.from({ length: 12 }).map((_, i) => {
            const rad = ((i * 30 - 90) * Math.PI) / 180;
            return (
              <circle
                key={i}
                cx={80 + Math.cos(rad) * 66}
                cy={80 + Math.sin(rad) * 66}
                r={i % 3 === 0 ? 2 : 1}
                fill="currentColor"
              />
            );
          })}
          {hand(h * 30, 38, 4)}
          {hand(m * 6, 56, 3)}
          {hand(s * 6, 62, 1)}
          <circle cx="80" cy="80" r="3" fill="var(--accent)" />
        </svg>
        {clock.showDate && <div className="clock-date">{dateText}</div>}
      </div>
    );
  }

  if (clock.layout === "minimal") {
    return (
      <div className="clock-root" {...drag}>
        <div className="clock-minimal">
          {time}
          {clock.format12h && <span className="clock-ampm">{t.ampm}</span>}
        </div>
        {clock.showDate && <div className="clock-date">{dateText}</div>}
      </div>
    );
  }

  return (
    <div className="clock-root" {...drag}>
      <div className="clock-digital">
        {time}
        {clock.format12h && <span className="clock-ampm">{t.ampm}</span>}
      </div>
      {clock.showDate && <div className="clock-date">{dateText}</div>}
    </div>
  );
}
