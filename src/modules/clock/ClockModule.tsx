import { useEffect, useState } from "react";
import { useSettings, useModuleWindow } from "../../store/settings";
import { dragHandle } from "../../lib/drag";

/** Formats a Date in the user's selected timezone / 12h / 24h preferences. */
function getParts(date: Date, timezone: string | null, format12h: boolean) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: format12h,
    day: "numeric",
    weekday: "short",
    month: "short",
    second: "2-digit",
    timeZone: timezone ?? undefined,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    hour: get("hour").padStart(2, "0"),
    minute: get("minute"),
    second: get("second").padStart(2, "0"),
    ampm: get("dayPeriod").replace(/[^A-Za-z]/g, ""),
    weekday: get("weekday"),
    month: get("month"),
    day: get("day"),
  };
}

export function ClockModule() {
  const clock = useSettings((s) => s.settings.clock);
  const draggable = useSettings((s) => s.settings.clock.win.draggable);
  const winStyle = useModuleWindow("clock");
  const glass = clock.background ? "glass" : "no-bg";
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const t = getParts(now, clock.timezone, clock.format12h);
  const hour = clock.format12h ? t.hour : String(Number(t.hour) % 24).padStart(2, "0");
  const time = `${hour}:${t.minute}${clock.showSeconds ? ":" + t.second : ""}`;
  const dateText = `${t.weekday}, ${t.month} ${t.day}`;

  if (clock.layout === "analog") {
    const h = Number(t.hour) % 12 + Number(t.minute) / 60;
    const m = Number(t.minute) + Number(t.second) / 60;
    const s = Number(t.second);
    const hand = (angle: number, length: number, w: number, color: string, cap: string) => {
      const rad = ((angle - 90) * Math.PI) / 180;
      const cx = 80;
      const cy = 80;
      return (
        <line
          x1={cx}
          y1={cy}
          x2={cx + Math.cos(rad) * length}
          y2={cy + Math.sin(rad) * length}
          stroke={color}
          strokeWidth={w}
          strokeLinecap={cap as "round" | "butt"}
        />
      );
    };
    return (
      <div className={`widget ${glass}`} style={winStyle} {...(draggable ? { onPointerDown: dragHandle } : undefined)}>
        <div className="clock-analog">
          <svg width="160" height="160" viewBox="0 0 160 160">
            <circle cx="80" cy="80" r="74" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
            {Array.from({ length: 12 }).map((_, i) => {
              const rad = ((i * 30 - 90) * Math.PI) / 180;
              return (
                <circle
                  key={i}
                  cx={80 + Math.cos(rad) * 66}
                  cy={80 + Math.sin(rad) * 66}
                  r={i % 3 === 0 ? 2.4 : 1.4}
                  fill={i % 3 === 0 ? "var(--accent)" : "var(--muted)"}
                />
              );
            })}
            {hand(h * 30, 38, 4.5, "var(--text)", "round")}
            {hand(m * 6, 56, 3, "var(--text)", "round")}
            {hand(s * 6, 62, 1.5, "var(--accent)", "round")}
            <circle cx="80" cy="80" r="3.5" fill="var(--accent)" />
          </svg>
        </div>
        {clock.showDate && <div className="clock-date" style={{ textAlign: "center" }}>{dateText}</div>}
      </div>
    );
  }

  if (clock.layout === "minimal") {
    return (
      <div className={`widget ${glass}`} style={winStyle} {...(draggable ? { onPointerDown: dragHandle } : undefined)}>
        <div className="clock-minimal">
          {time}
          {clock.format12h && <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 15 }}>{t.ampm}</span>}
        </div>
        {clock.showDate && <div className="clock-date">{dateText}</div>}
      </div>
    );
  }

  return (
    <div className={`widget glass ${glass}`} style={winStyle} {...(draggable ? { onPointerDown: dragHandle } : undefined)}>
      <div className="clock-digital">
        {time}
        {clock.format12h && <span className="ampm">{t.ampm}</span>}
      </div>
      {clock.showDate && <div className="clock-date">{dateText}</div>}
    </div>
  );
}
