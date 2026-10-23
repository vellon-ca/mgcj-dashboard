import i18next from "i18next";

/**
 * Driver presence, derived — online vs away vs offline.
 *
 * WHY THIS EXISTS: the dashboard used to render a driver's dot and status from
 * `drivers.is_active` alone. That flag is the driver's own on/off switch and
 * says nothing about whether their phone is still reachable, so a driver who
 * closed the app showed a green "Available" dot indefinitely.
 *
 * The backend compensated by reaching in and flipping `is_active` to false
 * after 5 minutes of silence (`reap_stale_drivers`). That made the dot honest
 * at the cost of destroying the driver's own setting — they had to notice and
 * tap themselves back online — and it could not distinguish "went home" from
 * "phone locked in a pocket at the taxi stand", because the heartbeat only
 * runs while the app is FOREGROUNDED.
 *
 * Deriving here instead means the dashboard tells the truth on its own, from
 * data it already downloads (`fetchDrivers` selects `*`, so `last_seen_at` has
 * always been in the payload and was simply never read). It is also FASTER
 * than the reaper: away shows within a minute rather than five.
 *
 * `is_active` = what the driver intends. `last_seen_at` = what we observe.
 * Keep them separate; do not write one from the other.
 *
 * MIRRORS `mgcj-app/supabase/functions/_shared/presence.ts` — same 60s
 * threshold and the same NULL tolerance, deliberately, so a dispatcher can
 * trust that this screen and dispatch are talking about the same drivers. If
 * that file's threshold changes, change this one. (Separate repos; there is no
 * shared module to import.)
 *
 * What "away" MEANS has changed twice. Until mgcj-app 20260766 it was
 * "dispatch is skipping them"; then "dispatch uses them only if nobody fresher
 * is free". Since 2026-10-23 dispatch ignores it entirely
 * (mgcj-app _shared/presence.ts): the heartbeat goes quiet when the app is in
 * the background AND the car is parked, which is a driver waiting at a stand.
 * So "away" is now purely informational — app not on screen, not moving — and
 * must never demote or exclude a driver anywhere on this dashboard either
 * (lib/driverRanking.ts no longer does).
 */

/** 6 missed 10s heartbeats. Matches the dispatch filter exactly. */
export const PRESENCE_STALE_MS = 60_000;

export type DriverPresence = "online" | "away" | "offline";

export interface PresenceInput {
  is_active?: boolean | null;
  last_seen_at?: string | null;
}

/**
 * NULL `last_seen_at` counts as ONLINE, matching the backend.
 *
 * Two populations depend on this and both would be misreported as "away"
 * without it: app builds predating the heartbeat (a store rollout is not
 * atomic), and the seeded demo drivers used to make the map look real during a
 * pitch, which were inserted straight into the table and have never run the
 * app. Note it is also what a driver who goes offline cleanly writes, but that
 * path sets `is_active = false` too, so it is caught by the check above.
 */
export function driverPresence(
  d: PresenceInput,
  now: number = Date.now(),
): DriverPresence {
  if (!d.is_active) return "offline";
  if (d.last_seen_at == null) return "online";
  return new Date(d.last_seen_at).getTime() >= now - PRESENCE_STALE_MS
    ? "online"
    : "away";
}

/** "App in the background and not moving." Informational only — see header. */
export function isDriverAway(d: PresenceInput, now: number = Date.now()) {
  return driverPresence(d, now) === "away";
}

/**
 * "4 min ago" — the age of the last heartbeat, for an away driver.
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
