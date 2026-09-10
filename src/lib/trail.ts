// Driver trail: turning a day's worth of raw GPS fixes into something a
// dispatcher can read.
//
// The fixes come from `driver_locations` (mgcj-app migration 20260768), written
// by the driver app's background location task. Everything here is pure — no
// Google Maps, no Supabase — so the segmenting rules can be reasoned about (and
// changed) without touching the map code.

export type TrailFix = {
  recorded_at: string;
  lat: number;
  lng: number;
  ride_id: string | null;
};

export type LatLng = { lat: number; lng: number };

export type TrailSegment = {
  /** The fare this stretch was driven for, or null for idle/between-fares. */
  rideId: string | null;
  points: Array<LatLng & { t: number }>;
};

export type TrailStop = {
  at: LatLng;
  from: number;
  to: number;
  minutes: number;
};

export type Trail = {
  segments: TrailSegment[];
  stops: TrailStop[];
  /** Metres driven, jitter filtered. */
  distanceM: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Milliseconds spent stopped, i.e. the sum of the stops below. */
  idleMs: number;
  fixCount: number;
};

/**
 * Below this, movement between two consecutive fixes is treated as GPS jitter
 * rather than travel. A parked car wanders several metres between readings, and
 * over a 10-hour shift that noise otherwise sums to kilometres the car never
 * drove — a distance figure a driver would rightly dispute.
 */
const JITTER_M = 15;

/**
 * A gap longer than this breaks the line. Fixes are distance-triggered while
 * idle, so a long gap usually means "parked", but it can also mean a tunnel, a
 * dead zone, or a closed app — and in every one of those cases we do NOT know
 * the car went in a straight line. Drawing one would invent a route, which is
 * the one thing a trail used as evidence must never do.
 */
const GAP_MS = 6 * 60_000;

/** How close consecutive fixes must stay to count as the same stop. */
const STOP_RADIUS_M = 60;

/** …and for how long, before it is worth showing as a stop at all. */
const STOP_MIN_MS = 5 * 60_000;

export function metresBetween(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Build the drawable trail. `fixes` must be ordered by recorded_at ascending.
 */
export function buildTrail(fixes: TrailFix[]): Trail {
  const empty: Trail = {
    segments: [],
    stops: [],
    distanceM: 0,
    firstAt: null,
    lastAt: null,
    idleMs: 0,
    fixCount: 0,
  };
  if (fixes.length === 0) return empty;

  const points = fixes.map((f) => ({
    lat: f.lat,
    lng: f.lng,
    t: new Date(f.recorded_at).getTime(),
    rideId: f.ride_id,
  }));

  const segments: TrailSegment[] = [];
  let current: TrailSegment | null = null;
  let distanceM = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = i > 0 ? points[i - 1] : null;

    // Start a new segment when the fare changes or the line would have to jump
    // a gap. Both are real discontinuities; joining across either draws a route
    // that was never driven.
    const breaks =
      !current ||
      !prev ||
      prev.rideId !== p.rideId ||
      p.t - prev.t > GAP_MS;

    if (breaks) {
      current = { rideId: p.rideId, points: [] };
      segments.push(current);
    } else if (prev) {
      const d = metresBetween(prev, p);
      if (d >= JITTER_M) distanceM += d;
    }
    current!.points.push({ lat: p.lat, lng: p.lng, t: p.t });
  }

  const stops = findStops(points);
  return {
    segments: segments.filter((s) => s.points.length > 0),
    stops,
    distanceM: Math.round(distanceM),
    firstAt: points[0].t,
    lastAt: points[points.length - 1].t,
    idleMs: stops.reduce((sum, s) => sum + (s.to - s.from), 0),
    fixCount: points.length,
  };
}

/**
 * Runs of consecutive fixes that stayed inside STOP_RADIUS_M for at least
 * STOP_MIN_MS. Anchored on the first fix of the run rather than a rolling
 * centroid: a rolling anchor lets a slow crawl through traffic drift across
 * town while every step stays "near" the last one, reporting a two-mile
 * shuffle as one stationary stop.
 */
function findStops(
  points: Array<LatLng & { t: number }>,
): TrailStop[] {
  const stops: TrailStop[] = [];
  let anchor = 0;

  for (let i = 1; i <= points.length; i++) {
    const beyond =
      i === points.length ||
      metresBetween(points[anchor], points[i]) > STOP_RADIUS_M;
    if (!beyond) continue;

    const last = i - 1;
    const duration = points[last].t - points[anchor].t;
    if (last > anchor && duration >= STOP_MIN_MS) {
      stops.push({
        at: { lat: points[anchor].lat, lng: points[anchor].lng },
        from: points[anchor].t,
        to: points[last].t,
        minutes: Math.round(duration / 60_000),
      });
    }
    anchor = i;
  }
  return stops;
}

/**
 * The position at a given instant, for the timeline scrubber: the last fix at
 * or before `t`. Returns null before the first fix — and deliberately does not
 * extrapolate past a gap, since "where was the car at 2pm" has no honest answer
 * when nothing was recorded around 2pm.
 */
export function positionAt(
  trail: Trail,
  t: number,
): { at: LatLng; fixT: number; stale: boolean } | null {
  let best: (LatLng & { t: number }) | null = null;
  for (const seg of trail.segments) {
    for (const p of seg.points) {
      if (p.t <= t && (!best || p.t > best.t)) best = p;
    }
  }
  if (!best) return null;
  return {
    at: { lat: best.lat, lng: best.lng },
    fixT: best.t,
    stale: t - best.t > GAP_MS,
  };
}

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatKm(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}
