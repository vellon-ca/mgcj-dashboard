import i18next from "i18next";

/**
 * Driver presence on the dashboard: online or offline, and nothing in between.
 *
 * HISTORY. This used to derive a third state, "away", from `last_seen_at`
 * going quiet for 60s. That reading turned out to mean "the app is in the
 * background AND the car is not moving" — a driver parked at a stand with the
 * phone in their pocket, the normal working state for a small fleet — because
 * the driver app's location service only reports when the car moves. Since
 * 2026-10-23 dispatch ignores it entirely (mgcj-app _shared/presence.ts), so a
 * label calling those drivers "away" only told dispatch something untrue.
 *
 * `is_active` = what the driver intends, and is the whole answer here. Drivers
 * who have really gone are taken offline server-side (offer strikes, shift
 * auto-end, push-token retirement), which is what turns this to "offline".
 *
 * The one place staleness still MEANS something is a driver with a passenger
 * aboard (in_progress): they are moving almost all the time, so a position
 * that stops for minutes is usually a fault (app killed, phone dead, no
 * signal) and the passenger's tracking has frozen with it. NOT before pickup:
 * the ride cadence is distance-gated on both platforms (25 m), so a driver
 * waiting outside with the app backgrounded legitimately sends nothing. Even
 * in_progress, a car stuck in a standstill for 2+ minutes with the app in the
 * background can trip it — rare here, and the wording only claims the
 * location is not updating. See isRideSilent.
 */

export type DriverPresence = "online" | "offline";

export interface PresenceInput {
  is_active?: boolean | null;
  last_seen_at?: string | null;
}

export function driverPresence(d: PresenceInput): DriverPresence {
  return d.is_active ? "online" : "offline";
}

/**
 * How long a driver with a passenger aboard may go without a position before
 * we say so. Two minutes, not one: reporting is by distance, so a car held at
 * a long red light legitimately sends nothing for a while.
 */
export const RIDE_SILENT_MS = 2 * 60_000;

/**
 * "Location not updating" — only meaningful when the caller knows the ride is
 * in_progress; never use it for an idle driver (silence there is parking) or
 * one heading to / waiting at a pickup.
 * NULL last_seen_at is not silent: demo drivers and pre-heartbeat builds.
 */
export function isRideSilent(d: PresenceInput, now: number = Date.now()): boolean {
  if (!d.is_active || d.last_seen_at == null) return false;
  return now - new Date(d.last_seen_at).getTime() > RIDE_SILENT_MS;
}

/**
 * "4 min ago" — the age of the last position, for a silent on-ride driver.
 *
 * Deliberately coarse. The number a dispatcher acts on is the order of
 * magnitude ("a minute" vs "half an hour"), and second-level precision on a
 * screen that refreshes every 15s would just be noise that never sits still.
 */
export function lastSeenLabel(
  lastSeenAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!lastSeenAt) return null;
  const ms = now - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  // i18next's module `t` rather than the hook: this is a plain function called
  // from render AND from the driver-list sort, so it cannot hold a hook. The
  // re-render caveat is the same one src/i18n/format.ts documents — every
  // screen showing this label also shows translated copy, so it re-renders
  // with the language. Plural forms are `_one`/`_other` per locale, which is
  // why this passes `count` rather than pre-formatting the number in.
  if (mins < 1) return i18next.t("lastSeen.justNow");
  if (mins < 60) return i18next.t("lastSeen.minutes", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return i18next.t("lastSeen.hours", { count: hrs });
  return i18next.t("lastSeen.days", { count: Math.floor(hrs / 24) });
}
