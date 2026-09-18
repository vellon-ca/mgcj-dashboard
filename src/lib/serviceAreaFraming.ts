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

export async function fetchCompanyFrame(companyId: string): Promise<CompanyFrame> {
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

  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  let any = false;
  for (const a of areas) {
    for (const polygon of a.area_geojson?.coordinates ?? []) {
      for (const ring of polygon) {
        for (const [lng, lat] of ring) {
          north = Math.max(north, lat); south = Math.min(south, lat);
          east = Math.max(east, lng);  west = Math.min(west, lng);
          any = true;
        }
      }
    }
  }

  if (any) {
    return {
      bounds: { north, south, east, west },
      center: { lat: (north + south) / 2, lng: (east + west) / 2 },
      source: "areas",
    };
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

  return { bounds: null, center: NEUTRAL_CENTER, source: "neutral" };
}

/** Apply a frame to a live map. Bounds win over a centre when we have them:
 *  they carry the extent, which is the half a centre cannot express. */
export function applyFrame(map: google.maps.Map, frame: CompanyFrame) {
  if (frame.bounds) {
    map.fitBounds(frame.bounds, 48);
  } else {
    map.setCenter(frame.center);
    map.setZoom(frame.source === "neutral" ? NEUTRAL_ZOOM : 11);
  }
}
