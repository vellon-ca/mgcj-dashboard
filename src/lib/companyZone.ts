// The company's IANA time zone, which every date and time on the dashboard is
// shown, entered and bucketed in. See mgcj-app/.claude/notes/timezone-design.md.
//
// One clock per company: the dispatcher's screen, the driver's and
// passenger's apps and every SMS name the same time for the same ride. The
// BROWSER's zone is not used, deliberately (Victor, 2026-10-24): a desk
// computer with a wrong or unset zone would show and, worse, BOOK rides an
// hour off, and a dispatcher covering from another province would read a
// different clock from the drivers.
//
// A module singleton rather than a React context, for the same reason the
// active language is (i18n/format.ts): about half the date call sites are
// module-level helpers (CSV builders, printReport's HTML) that cannot call a
// hook. It is set by useAuth BEFORE the profile is published, and every page
// renders behind that gate, so no page formats before it is known.
//
// The wall-clock maths is a second copy of mgcj-app's src/lib/format.ts
// (zonedParts / zonedWallClockToInstant). Change both — same arrangement as
// cardLabel.ts.

// The fallback before a company is known (sign-in screen) — a zone id, not copy.
const FALLBACK_ZONE = "America/Halifax"; // i18n-ok

const BROWSER_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
})();

let zone = BROWSER_ZONE;

/** Set from the signed-in admin's `companies.timezone`; null resets. */
export function setCompanyTimeZone(next: string | null | undefined): void {
  if (!next) {
    zone = BROWSER_ZONE;
    return;
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: next }).format(0);
    zone = next;
  } catch {
    console.warn(`[companyZone] unusable zone ${next}; keeping ${zone}`);
  }
}

/** The zone every date on the dashboard is in. */
export function companyTimeZone(): string {
  return zone;
}

// ── Wall clock <-> instant ───────────────────────────────────────────────────

export type ZonedParts = {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching Date.prototype.getDay(). */
  weekday: number;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant, on the company's clock. */
export function zonedParts(value: Date | string | number, tz = zone): ZonedParts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const d = value instanceof Date ? value : new Date(value);
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(d)) if (p.type !== "literal") out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

type Wall = { year: number; month: number; day: number; hour?: number; minute?: number };

function wallMs(p: Wall): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0);
}

function offsetMs(instantMs: number, tz: string): number {
  const whole = Math.floor(instantMs / 60_000) * 60_000;
  return wallMs(zonedParts(whole, tz)) - whole;
}

/**
 * The instant at which the company's clock reads `p`. A repeated time
 * (fall-back) is the FIRST occurrence; a skipped one (spring-forward) moves
 * forward by the gap. Same rule as the app's picker.
 */
export function zonedToInstant(p: Wall, tz = zone): Date {
  const wall = wallMs(p);
  const DAY = 86_400_000;
  const before = offsetMs(wall - DAY, tz);
  const after = offsetMs(wall + DAY, tz);
  const hits = [...new Set([before, after])]
    .map((o) => wall - o)
    .filter((t) => wallMs(zonedParts(t, tz)) === wall);
  if (hits.length) return new Date(Math.min(...hits));
  return new Date(wall - before);
}

// ── The shapes the pages actually need ───────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** 'YYYY-MM-DD' of an instant on the company's clock. */
export function zonedDayISO(value: Date | string | number = new Date()): string {
  const p = zonedParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'YYYY-MM' of an instant on the company's clock. */
export function zonedMonthKey(value: Date | string | number = new Date()): string {
  const p = zonedParts(value);
  return `${p.year}-${pad(p.month)}`;
}

/** The instant the company's day 'YYYY-MM-DD' starts (plus `addDays`). */
export function dayStart(isoDate: string, addDays = 0): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return zonedToInstant({ year: y, month: m, day: d + addDays });
}

/** Midnight today, the 1st of this month, Jan 1 this year — company clock. */
export function startOfToday(now = new Date()): Date {
  const p = zonedParts(now);
  return zonedToInstant({ year: p.year, month: p.month, day: p.day });
}
export function startOfMonth(now = new Date(), addMonths = 0): Date {
  const p = zonedParts(now);
  return zonedToInstant({ year: p.year, month: p.month + addMonths, day: 1 });
}
export function startOfYear(now = new Date(), year?: number): Date {
  const p = zonedParts(now);
  return zonedToInstant({ year: year ?? p.year, month: 1, day: 1 });
}

/** `<input type="datetime-local">` value for an instant: 'YYYY-MM-DDTHH:mm'
 *  on the company's clock. The input itself has no zone. */
export function toDateTimeLocal(value: Date | string | number): string {
  const p = zonedParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The instant a `datetime-local` value means on the company's clock.
 *  `new Date(value)` would read it on the BROWSER's clock. */
export function fromDateTimeLocal(value: string): Date {
  const [date, time = "00:00"] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedToInstant({ year: y, month: m, day: d, hour: h, minute: mi });
}
