/**
 * Display formatting for the human-readable identifiers.
 *
 * Mirrors mgcj-app/src/lib/numbering.ts. The two repos are separate git repos
 * with no shared package, so this is a deliberate duplicate rather than an
 * oversight — if you change the formatting rules here, change them there too.
 *
 * Storage and display are separate on purpose:
 *   • drivers.driver_number is an int issued from a per-company counter; the
 *     prefix and padding are the company's display convention and can change
 *     without rewriting anyone's number.
 *   • drivers.car_number is TEXT already rendered — whatever is painted on the
 *     car, which dispatch types in and can be "12A".
 *   • rides.ride_ref is stored bare (6 chars) so the unique index is on the
 *     canonical value; the space is display only.
 *
 * See mgcj-app/supabase/migrations/20260774_ride_ref.sql and 20260775.
 */

export interface NumberFormat {
  prefix: string;
  pad: number;
}

/** "K7M4Q2" -> "K7M 4Q2". Grouped 3-3 because these get read aloud. */
export function formatRideRef(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.length === 6 ? `${ref.slice(0, 3)} ${ref.slice(3)}` : ref;
}

/** Strips the display space so typed input matches the stored value. */
export function normalizeRideRef(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/**
 * formatNumber(7, { prefix: "D-", pad: 3 }) -> "D-007"
 * formatNumber(7, { prefix: "",   pad: 0 }) -> "7"
 */
export function formatNumber(
  n: number | null | undefined,
  fmt: NumberFormat | null | undefined,
): string {
  if (n === null || n === undefined) return "";
  const prefix = fmt?.prefix ?? "";
  const pad = fmt?.pad ?? 0;
  return prefix + String(n).padStart(pad, "0");
}

/**
 * A driver number as an identifier label.
 *
 * "#7" when the company uses bare numbers, "D-007" when it has set a prefix —
 * prefixing an already-prefixed number would read "#D-007", which is nonsense.
 * The "#" exists only to mark a bare integer as an identifier rather than a
 * count. Keep this rule in one place: it is used on the roster card and in the
 * driver detail panel, and the two disagreeing would look like a bug.
 */
export function formatDriverNumber(
  n: number | null | undefined,
  fmt: NumberFormat | null | undefined,
): string | null {
  if (n === null || n === undefined) return null;
  const rendered = formatNumber(n, fmt);
  return fmt?.prefix ? rendered : `#${rendered}`;
}
