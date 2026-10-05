// Locale-aware date/time formatting.
//
// WHY THIS FILE EXISTS: the dashboard had 68 `toLocale*` calls and all but two
// of them passed a HARDCODED "en-CA". A hardcoded tag survives a translation
// sweep completely intact and completely wrong — a dispatcher who picks French
// gets French labels above English dates, with nothing failing, nothing
// logging, and a clean string scanner. The two exceptions (`[]` and `undefined`
// as the locale argument) are worse, because they follow the BROWSER and so
// ignore an explicit pick too.
//
// These read the active language off the i18next singleton rather than taking
// it as an argument, because roughly half the call sites are module-level
// helpers (CSV row builders, `printReport`'s HTML, status formatters) that are
// not components and cannot call a hook. The re-render caveat that comes with
// that: changing language re-renders every `useTranslation()` consumer, and
// every page that renders a date also renders translated copy, so in practice
// the dates re-format with the labels. A component that renders a date and NO
// translated string would keep a stale format until its next render — if one
// ever exists, give it `useTranslation()` or read `useLocale().locale`.
//
// ── CURRENCY IS DELIBERATELY NOT HERE ──
//
// Money stays `$4.86` in every language (Victor, 2026-10-04), so the ~140
// hand-built `` `$${n.toFixed(2)}` `` sites are correct as they stand and are
// NOT a gap this file is meant to close. Two reasons: `fr-CA` renders `4,86 $`,
// whose decimal comma breaks CSV parsing against a comma delimiter in Excel;
// and a mixed-language dispatch room reading the same screen over someone's
// shoulder should see one unambiguous number. If that is ever revisited, the
// CSV writer needs solving in the same change, not after it.

import i18next from "i18next";
import { DEFAULT_LOCALE, metaFor } from "./locales";

/** The region-qualified tag to hand Intl — see `intlTag` in locales.ts. */
export function intlLocale(): string {
  return metaFor(i18next.language || DEFAULT_LOCALE).intlTag;
}

type DateInput = Date | string | number;

function toDate(v: DateInput): Date {
  return v instanceof Date ? v : new Date(v);
}

export function fmtDate(v: DateInput, opts?: Intl.DateTimeFormatOptions): string {
  return toDate(v).toLocaleDateString(intlLocale(), opts);
}

export function fmtTime(v: DateInput, opts?: Intl.DateTimeFormatOptions): string {
  return toDate(v).toLocaleTimeString(intlLocale(), opts);
}

export function fmtDateTime(v: DateInput, opts?: Intl.DateTimeFormatOptions): string {
  return toDate(v).toLocaleString(intlLocale(), opts);
}

/** Plain integers and counts — thousands separators follow the locale
 *  (`1 234` in fr-CA). Not for money; see the note above. */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(intlLocale(), opts);
}

/** A month heading like "October 2026" / "octobre 2026". The Ride History
 *  grouping builds these from a derived `YYYY-MM` key, so no string scanner
 *  can see them as copy — they are the formatting half of the same hazard. */
export function fmtMonthYear(year: number, month1to12: number): string {
  return new Date(year, month1to12 - 1, 1).toLocaleDateString(intlLocale(), {
    month: "long",
    year: "numeric",
  });
}

/**
 * Short month and weekday names for CHART AXES.
 *
 * These exist because Analytics held three hardcoded arrays —
 * `["Jan".."Dec"]` and `["Sun".."Sat"]` twice — as plain string literals.
 * Turning those nineteen strings into nineteen translation keys would have
 * been the wrong fix, and wrong in a way this file was written to prevent: a
 * key only moves with the language when a human remembers to translate it,
 * whereas `Intl` already knows every locale's month names and cannot drift.
 * It is the same mistake as the 66 hardcoded `"en-CA"` tags, one layer up.
 *
 * The reference dates are fixed and formatted in UTC so a negative-offset
 * timezone cannot roll the date back a day and shift every label by one — the
 * classic off-by-one in this exact helper.
 */
export function monthShort(month1to12: number): string {
  return new Date(Date.UTC(2024, month1to12 - 1, 15)).toLocaleDateString(intlLocale(), {
    month: "short",
    timeZone: "UTC",
  });
}

/** `0` = Sunday, matching `Date.prototype.getDay()`. 2024-01-07 was a Sunday. */
export function weekdayShort(day0Sun: number): string {
  return new Date(Date.UTC(2024, 0, 7 + day0Sun)).toLocaleDateString(intlLocale(), {
    weekday: "short",
    timeZone: "UTC",
  });
}
