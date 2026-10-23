// One ranking for every "assign a driver" list on the dashboard: the live-ride
// panel, the scheduled ride card and the booking form. They were three copies
// that had drifted — only one knew about commitment clashes, none checked the
// vehicle, none showed distance — and dispatch read the order as meaningful
// when it was just the order the roster loaded in.
//
// Two modes, because a driver's CURRENT position only means something when the
// pickup is close in time:
//   soon  (immediate, or pickup within SOON_MINS): closest first, by real drive
//         time when check-ride-conflicts has returned it, straight line until.
//   later: free at that time first, then on shift, then a "now N km" hint.
// SOON_MINS matches check-ride-conflicts, which stops fetching drive times
// past it — keep them equal.
import { driverPresence } from "./presence";
import type { Driver } from "../types";

/** A roster row as the dashboard holds it: drivers.* plus the merged profile. */
export type RosterDriver = Driver & {
  last_seen_at?: string | null;
  car_number?: string | null;
  push_token?: string | null;
  profile?: Driver["profile"] & {
    is_active?: boolean | null;
    deleted_at?: string | null;
    deactivation_pending?: boolean | null;
  };
};

export const SOON_MINS = 90;

export interface VehicleClassOption {
  id: string;
  // The MINIMUM SEATS a vehicle needs to serve this class (20261005010000).
  capacity: number | null;
  restricted: boolean | null;
}

// The dashboard's copy of the capability predicate. The authority is
// supabase/functions/_shared/vehicleMatch.ts in mgcj-app — change both.
//
// EXACT SIZE unless the ride carries scheduled-release's substitution
// permission. A seven-seat van is not a candidate for a four-seat booking: it
// is the only vehicle that can serve a seven-seat one, and the fare is frozen
// to the class booked. Dispatch can still override — this only ranks and
// labels, and dispatch-assign-ride turns a mismatch into a confirmable warning.
export function driverFitsClass(
  d: { seats: number | null; wheelchair_accessible: boolean | null; vehicle_class_id: string | null },
  cls: VehicleClassOption | undefined,
  needsWheelchair: boolean,
  allowLarger = false,
): boolean {
  if (cls) {
    const seats = d.seats ?? 0;
    const need = cls.capacity ?? 0;
    if (allowLarger ? seats < need : seats !== need) return false;
    if (cls.restricted && d.vehicle_class_id !== cls.id) return false;
  }
  if (needsWheelchair && !d.wheelchair_accessible) return false;
  return true;
}

export type Issue = "clash" | "declined" | "vehicle" | "offShift" | "onRide" | "unreachable";

export type Distance =
  | { kind: "drive"; mins: number; km: number } // Distance Matrix, from check-ride-conflicts
  | { kind: "approx"; km: number }              // straight line, soon mode
  | { kind: "now"; km: number };                // straight line, later mode: a hint only

export interface Clash {
  direction?: "after" | "before";
  misses: boolean;
  commitment_at: string;
  minutes_short: number | null;
}

export interface RankedDriver {
  driver: RosterDriver;
  issues: Issue[];
  /** In the lower, labelled group. */
  demoted: boolean;
  distance: Distance | null;
  clash: Clash | null;
  closest: boolean;
  current: boolean;
}

export interface RankRide {
  pickup_lat: number | null;
  pickup_lng: number | null;
  scheduled_at?: string | null;
  vehicle_class_id?: string | null;
  requires_wheelchair?: boolean | null;
  allow_larger_vehicle?: boolean | null;
  declined_by?: string[] | null;
  driver_id?: string | null;
}

export interface RankInput {
  ride: RankRide;
  drivers: RosterDriver[];
  /** Drivers on an assigned / arriving / in-progress ride right now. */
  busyDriverIds: Set<string>;
  vehicleClasses: VehicleClassOption[];
  conflicts?: Map<string, Clash>;
  drive?: Map<string, { mins: number; km: number }>;
  now?: number;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line km as rough minutes, only so drivers with and without a real
// drive time can share one sort. Same constants as commitment.ts's reposition
// estimate; never shown.
function sortMins(d: Distance | null): number {
  if (!d) return Infinity;
  if (d.kind === "drive") return d.mins;
  return ((d.km * 1.35) / 40) * 60;
}

/** A driver whose account can be given work at all. */
function accountUsable(d: RosterDriver): boolean {
  const p = d.profile;
  return !p || (p.is_active !== false && !p.deleted_at && !p.deactivation_pending);
}

export function isSoon(scheduledAt: string | null | undefined, now = Date.now()): boolean {
  return !scheduledAt || new Date(scheduledAt).getTime() - now <= SOON_MINS * 60_000;
}

export function rankDrivers(input: RankInput): { soon: boolean; ranked: RankedDriver[] } {
  const { ride, drivers, busyDriverIds, vehicleClasses, conflicts, drive } = input;
  const now = input.now ?? Date.now();
  const scheduled = !!ride.scheduled_at;
  const soon = isSoon(ride.scheduled_at, now);
  const cls = vehicleClasses.find((c) => c.id === ride.vehicle_class_id);
  const declined = new Set(ride.declined_by ?? []);
  const hasPickup = ride.pickup_lat != null && ride.pickup_lng != null;

  const pool = drivers.filter((d) => {
    if (!accountUsable(d)) return false;
    // An immediate ride can only go to someone working right now. A scheduled
    // one can go to anyone on the roster: release decides later whether they
    // turned up (mgcj-app scheduled-release, releaseAssignedRide).
    if (!scheduled) return driverPresence(d, now) !== "offline" && !busyDriverIds.has(d.id);
    return true;
  });

  const ranked: RankedDriver[] = pool.map((d) => {
    const presence = driverPresence(d, now);
    const clash = conflicts?.get(d.id)?.misses ? conflicts.get(d.id)! : null;
    const issues: Issue[] = [];
    if (clash) issues.push("clash");
    if (declined.has(d.id)) issues.push("declined");
    if (!driverFitsClass(d, cls, !!ride.requires_wheelchair, ride.allow_larger_vehicle === true)) {
      issues.push("vehicle");
    }
    // A quiet heartbeat is NOT an issue (2026-10-23): it means the app is in
    // the background and the car is parked — a driver waiting at a stand —
    // and assign-ride offers to them like anyone else (mgcj-app
    // _shared/presence.ts). Demoting them here would make the picker a third
    // ordering that disagrees with auto-dispatch.
    if (scheduled && presence === "offline") issues.push("offShift");
    if (scheduled && soon && busyDriverIds.has(d.id)) issues.push("onRide");
    // No push token: an offer IS a push, so the app cannot be told about this
    // ride (mgcj-app presence.ts isDriverDispatchable). Includes the seeded
    // demo drivers, which presence reads as online because last_seen_at is NULL.
    if (!d.push_token) issues.push("unreachable");

    // Off shift and no token are real problems only when the pickup is close:
    // for a ride tomorrow the driver can come on shift or re-enable alerts.
    const demoted = issues.some((i) => (i !== "offShift" && i !== "unreachable") || soon);

    let distance: Distance | null = null;
    const hasPos = hasPickup && d.current_lat != null && d.current_lng != null && presence !== "offline";
    const live = drive?.get(d.id);
    if (soon && live) {
      distance = { kind: "drive", mins: live.mins, km: live.km };
    } else if (hasPos) {
      const km = Math.round(haversineKm(d.current_lat!, d.current_lng!, ride.pickup_lat!, ride.pickup_lng!) * 10) / 10;
      distance = soon ? { kind: "approx", km } : { kind: "now", km };
    }

    return { driver: d, issues, demoted, distance, clash, closest: false, current: d.id === ride.driver_id };
  });

  ranked.sort((a, b) => {
    if (a.demoted !== b.demoted) return Number(a.demoted) - Number(b.demoted);
    if (a.demoted && a.issues.length !== b.issues.length) return a.issues.length - b.issues.length;
    if (!soon) {
      const aOff = a.issues.includes("offShift");
      const bOff = b.issues.includes("offShift");
      if (aOff !== bOff) return Number(aOff) - Number(bOff);
    }
    return sortMins(a.distance) - sortMins(b.distance);
  });

  if (soon && ranked[0] && !ranked[0].demoted && ranked[0].distance) ranked[0].closest = true;
  return { soon, ranked };
}
