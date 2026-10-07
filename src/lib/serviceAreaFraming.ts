// Where a map should open, for THIS company.
//
// Design: mgcj-app/.claude/notes/service-areas-plan.md §2
//
// Every map in the platform used to open on a hardcoded Annapolis Valley
// centre. That is fine for the two customers we started with and absurd for the
// next one — a dispatcher in Montreal would stare at Kentville every session,
// and unlike the phone apps the dashboard has no GPS to correct it.
//
// The fix is not a better constant. A company's own service areas answer
// position AND extent from one source: fit their bounding box and the zoom
// number disappears too — a one-town company gets a tight frame, a company
// serving a town plus the airport gets a frame wide enough to show both, and
// nobody picks a number.
//
// Order: drawn areas -> the company's city. Two rungs, both real, no constant.
//
// ...except for WHERE TO LOOK, which is a different question from how far the
// territory reaches. `prefer: "locality"` flips the order to city-first, and
// the dispatch board asks for it. A union bbox answers extent honestly and
// answers position badly: add an area 60 km out for the airport and the
// midpoint of the union lands in empty farmland between the two clusters, so
// the board opened on nothing. The city is the one coordinate that means "where
// the work is". When a company has no city set, the areas rung under
// "locality" falls back to the centre of their LARGEST area rather than the
// union midpoint, for the same reason — the big polygon is the town.
//
// There used to be a third: a hardcoded Kentville. It is deleted. A Nova Scotia
// coordinate is not a sensible default for a company in Moncton, and leaving it
// as the floor meant the wrong answer was always available — so nothing ever
// forced the right one to exist. The city is asked once at onboarding and
// geocoded then, so by the time any map renders there is a real answer.
//
// The city carries its Places VIEWPORT, not just a centre. That is what lets
// Moncton frame as Moncton rather than as a point plus a guessed zoom — the
// same reason drawn areas are the best rung.

import { supabase } from "./supabase";

// Shown only while the real frame is still resolving, and for a company that
// has drawn nothing AND has no city — which, once the city is required at
// onboarding, is nobody. Deliberately a wide continental view rather than a
// specific place: a map of the wrong city reads as a bug, a zoomed-out map
// reads as "loading".
export const NEUTRAL_CENTER = { lat: 45.0, lng: -75.0 };
export const NEUTRAL_ZOOM = 4;

export interface CompanyFrame {
  bounds: google.maps.LatLngBoundsLiteral | null;
  center: google.maps.LatLngLiteral;
  /** Which rung of the fallback chain answered — useful when a map looks wrong
   *  and you need to know whether it is data or code. */
  source: "areas" | "city" | "neutral";
}

interface AreaRow {
  area_geojson: { coordinates: number[][][][] } | null;
}

interface Box { north: number; south: number; east: number; west: number }

function boxCenter(b: Box): google.maps.LatLngLiteral {
  return { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
}

/** Planar shoelace area, only ever compared against other rings from the same
 *  company, so the unit does not matter — but the longitude scaling does: a
 *  degree of longitude is ~0.7 of a degree of latitude at 45 N, so without the
 *  cosine a wide-but-short area can outrank a genuinely larger one. Scaled by
 *  the ring's own mean latitude, which over one town is as good as exact. */
function ringArea(ring: number[][]): number {
  let latSum = 0;
  for (const [, lat] of ring) latSum += lat;
  const kx = Math.cos((latSum / ring.length) * Math.PI / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * ring[i][1] - (ring[i][0] * kx) * ring[j][1];
  }
  return Math.abs(a / 2);
}

export async function fetchCompanyFrame(
  companyId: string,
  opts?: { prefer?: "extent" | "locality" },
): Promise<CompanyFrame> {
  const [areasRes, companyRes] = await Promise.all([
    supabase
      .from("service_areas_geo")
      .select("area_geojson")
      .eq("company_id", companyId)
      .eq("active", true),
    supabase
      .from("companies")
      // One literal string, not a concatenation: supabase-js parses this at the
      // TYPE level, and a concatenated expression is opaque to it — the row
      // then infers as GenericStringError and every field access fails.
      .select("service_city_lat, service_city_lng, service_city_north, service_city_south, service_city_east, service_city_west")
      .eq("id", companyId)
      .maybeSingle(),
  ]);

  const areas = (areasRes.data ?? []) as AreaRow[];

  let union: Box | null = null;
  let biggest: { area: number; box: Box } | null = null;
  for (const a of areas) {
    for (const polygon of a.area_geojson?.coordinates ?? []) {
      // GeoJSON: ring 0 is the outer boundary, the rest are holes. A hole
      // neither extends the box nor counts toward "which area is biggest".
      const outer = polygon[0];
      if (!outer?.length) continue;
      let box: Box = { north: -Infinity, south: Infinity, east: -Infinity, west: Infinity };
      for (const [lng, lat] of outer) {
        box = {
          north: Math.max(box.north, lat), south: Math.min(box.south, lat),
          east: Math.max(box.east, lng),   west: Math.min(box.west, lng),
        };
      }
      union = union
        ? {
            north: Math.max(union.north, box.north), south: Math.min(union.south, box.south),
            east: Math.max(union.east, box.east),    west: Math.min(union.west, box.west),
          }
        : box;
      const size = ringArea(outer);
      if (!biggest || size > biggest.area) biggest = { area: size, box };
    }
  }

  const prefer = opts?.prefer ?? "extent";
  const areaFrame = (): CompanyFrame | null => {
    if (!union) return null;
    // "extent" wants the whole territory; "locality" wants the main town, so it
    // frames the largest single area and ignores the far-flung ones.
    const box = prefer === "locality" && biggest ? biggest.box : union;
    return { bounds: box, center: boxCenter(box), source: "areas" };
  };

  if (prefer === "extent") {
    const f = areaFrame();
    if (f) return f;
  }

  const c = companyRes.data;
  if (c?.service_city_lat != null && c?.service_city_lng != null) {
    const hasViewport =
      c.service_city_north != null && c.service_city_south != null &&
      c.service_city_east != null && c.service_city_west != null;
    return {
      // The viewport is why a city beats a pin: it frames the whole city at the
      // right zoom instead of guessing a span around a point.
      bounds: hasViewport
        ? {
            north: c.service_city_north, south: c.service_city_south,
            east: c.service_city_east,   west: c.service_city_west,
          }
        : null,
      center: { lat: c.service_city_lat, lng: c.service_city_lng },
      source: "city",
    };
  }

  // Reached only by "locality", and only for a company with no city set: the
  // areas rung is still far better than a continental view.
  const f = areaFrame();
  if (f) return f;

  return { bounds: null, center: NEUTRAL_CENTER, source: "neutral" };
}

/** Apply a frame to a live map. Bounds win over a centre when we have them:
 *  they carry the extent, which is the half a centre cannot express.
 *
 *  `minZoom` puts a floor under the fit, for surfaces that would rather show
 *  usable streets than the whole territory — see the dispatch board's call.
 *  The editor passes nothing, because there the extent IS the subject. */
export function applyFrame(
  map: google.maps.Map,
  frame: CompanyFrame,
  opts?: { minZoom?: number },
) {
  if (frame.bounds) {
    map.fitBounds(frame.bounds, 48);
    // The fit's zoom isn't readable on the next line — fitBounds settles over
    // a frame or two — so clamp once the map goes idle. setZoom keeps the
    // centre fitBounds just computed, so this tightens the view without
    // moving it off the company's territory.
    const floor = opts?.minZoom;
    if (floor != null) {
      google.maps.event.addListenerOnce(map, "idle", () => {
        const z = map.getZoom();
        if (z != null && z < floor) map.setZoom(floor);
      });
    }
  } else {
    map.setCenter(frame.center);
    map.setZoom(frame.source === "neutral" ? NEUTRAL_ZOOM : 11);
  }
}
