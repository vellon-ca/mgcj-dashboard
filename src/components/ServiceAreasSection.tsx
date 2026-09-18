// Settings -> Service Areas: where this company picks up and drops off.
//
// Design: mgcj-app/.claude/notes/service-areas-plan.md §5
//
// Two drawing modes, and the second one is the point:
//   • Polygon  — freehand, for the home territory.
//   • Circle   — search a place, drop a pin, drag a radius. This is what makes
//                "add the airport" a ten-second job instead of the fiddly
//                tracing exercise where an owner gives up and the feature goes
//                unused. A circle round-trips as a circle (shape_kind +
//                centre + radius on the row); the polygon Postgres generates
//                from it is the only geometry anything reads.
//
// Drawing is hand-rolled on core Polygon/Circle overlays. google.maps.drawing's
// DrawingManager was REMOVED from the Maps JS API in v3.65 — @types/google.maps
// ships it as an empty deprecated stub, which is how this surfaced (three
// compile errors, not a runtime surprise). Polygon and Circle are core and are
// not going anywhere, so: map clicks accumulate a draft ring, double-click (or
// the Finish button) closes it; circle mode drops a 2 km circle on one click
// which the owner then drags to size.
//
// Containment is NEVER computed here. The impact readout calls
// service_area_impact(), which runs the same company_serves_point() the booking
// path runs. A browser-side google.maps.geometry.poly.containsLocation preview
// that disagrees with enforcement would be worse than no preview — that exact
// client/server split produced both the $0.75 ride and the un-surcharged
// vehicle class.

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { loadGoogleMaps, darkMapStyle } from "../lib/googleMaps";
import { fetchCompanyFrame, applyFrame, NEUTRAL_CENTER, NEUTRAL_ZOOM } from "../lib/serviceAreaFraming";

interface Props {
  companyId: string;
}

type ShapeKind = "polygon" | "circle";

interface ServiceArea {
  id: string;
  name: string;
  allows_pickup: boolean;
  allows_dropoff: boolean;
  active: boolean;
  shape_kind: ShapeKind;
  center_lat: number | null;
  center_lng: number | null;
  radius_m: number | null;
  area_geojson: {
    type: "MultiPolygon";
    coordinates: number[][][][]; // [polygon][ring][vertex][lng,lat]
  } | null;
}

interface CompanyCity {
  service_city: string | null;
  service_city_lat: number | null;
  service_city_lng: number | null;
}

interface Impact {
  total: number;
  pickup_refused: number;
  dropoff_refused: number;
}

// The editor's own map opens wide and is immediately reframed — on the areas if
// any exist, on the company's city otherwise (see src/lib/serviceAreaFraming).
// The hardcoded Annapolis Valley centre that used to be here is deleted along
// with every other copy of it.

const AREA_COLOR = "#E8500A";       // brand orange, matches the Settings accent
const AREA_COLOR_DROPOFF = "#A855F7"; // purple: dropoff-only, i.e. a destination

function colorFor(a: Pick<ServiceArea, "allows_pickup" | "allows_dropoff" | "active">) {
  if (!a.active) return "#6B7280";
  return a.allows_pickup ? AREA_COLOR : AREA_COLOR_DROPOFF;
}

/** GeoJSON MultiPolygon -> the LatLng rings the Maps API draws. */
function geoJsonToPaths(
  gj: ServiceArea["area_geojson"],
): google.maps.LatLngLiteral[][] {
  if (!gj) return [];
  const paths: google.maps.LatLngLiteral[][] = [];
  for (const polygon of gj.coordinates) {
    for (const ring of polygon) {
      paths.push(ring.map(([lng, lat]) => ({ lat, lng })));
    }
  }
  return paths;
}

/** Ring -> EWKT, the format the base table accepts on write (verified through
 *  PostgREST 2026-09-17). PostGIS wants the ring closed; neither a hand-drawn
 *  draft nor an edited Polygon path ever repeats the first vertex. */
function ringToEwkt(path: google.maps.LatLngLiteral[]): string {
  const pts = path.map(p => `${p.lng} ${p.lat}`);
  if (pts.length && pts[0] !== pts[pts.length - 1]) pts.push(pts[0]);
  return `SRID=4326;MULTIPOLYGON(((${pts.join(",")})))`;
}

const toLiterals = (path: google.maps.LatLng[]): google.maps.LatLngLiteral[] =>
  path.map(p => ({ lat: p.lat(), lng: p.lng() }));

export default function ServiceAreasSection({ companyId }: Props) {
  const [areas, setAreas] = useState<ServiceArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactBlocked, setImpactBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState<ShapeKind | null>(null);
  const [city, setCity] = useState<CompanyCity | null>(null);
  const cityInputRef = useRef<HTMLInputElement | null>(null);
  const [draftCount, setDraftCount] = useState(0);

  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  // Drawing mode is read inside a map-click listener registered once, so it has
  // to come from a ref — a captured state value would be whatever it was at
  // mount forever. Same stale-closure trap as the RN timers.
  const drawModeRef = useRef<ShapeKind | null>(null);
  const draftRef = useRef<google.maps.LatLngLiteral[]>([]);
  const draftPolyRef = useRef<google.maps.Polygon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // id -> the drawn overlay, so selection/colour/removal don't re-render the map
  const shapesRef = useRef<
    Map<string, google.maps.Polygon[] | google.maps.Circle>
  >(new Map());
  const selectedIdRef = useRef<string | null>(null);
  const geometryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = areas.find(a => a.id === selectedId) ?? null;

  // ── data ────────────────────────────────────────────────────────────────

  const fetchAreas = useCallback(async () => {
    const { data, error } = await supabase
      .from("service_areas_geo")
      .select(
        "id, name, allows_pickup, allows_dropoff, active, shape_kind, center_lat, center_lng, radius_m, area_geojson",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: true });

    if (error) {
      setError(error.message);
      setAreas([]);
    } else {
      setAreas((data ?? []) as ServiceArea[]);
    }
    setLoading(false);
  }, [companyId]);

  const fetchCity = useCallback(async () => {
    const { data } = await supabase
      .from("companies")
      .select("service_city, service_city_lat, service_city_lng")
      .eq("id", companyId)
      .maybeSingle();
    if (data) setCity(data as CompanyCity);
  }, [companyId]);

  const fetchImpact = useCallback(async () => {
    const { data, error } = await supabase.rpc("service_area_impact", {
      p_company_id: companyId,
      p_limit: 200,
    });
    if (error) {
      // A transient failure is a missing readout, not a broken editor. But
      // insufficient_privilege is NOT transient — it means this session's
      // company (from the JWT, via get_my_company_id()) is not the company this
      // page is editing, and the readout would otherwise just never appear with
      // no explanation. That is the single number keeping an owner from
      // quietly losing fares, so its absence has to be visible.
      if (error.code === "42501" || /not permitted/i.test(error.message)) {
        setImpact(null);
        setImpactBlocked(true);
      }
      return;
    }
    setImpactBlocked(false);
    if (Array.isArray(data) && data[0]) setImpact(data[0] as Impact);
  }, [companyId]);

  useEffect(() => {
    fetchAreas();
    fetchImpact();
    fetchCity();
  }, [fetchAreas, fetchImpact, fetchCity]);

  // ── map ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    loadGoogleMaps()
      .then(() => {
        if (cancelled || !mapDivRef.current || mapRef.current) return;

        mapRef.current = new google.maps.Map(mapDivRef.current, {
          center: NEUTRAL_CENTER,
          zoom: NEUTRAL_ZOOM,
          styles: darkMapStyle,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
        });

        // Drawing, by hand. One click listener, dispatching on the mode ref.
        mapRef.current.addListener("click", (e: google.maps.MapMouseEvent) => {
          const mode = drawModeRef.current;
          const ll = e.latLng;
          if (!mode || !ll) return;

          if (mode === "circle") {
            // One click is the whole interaction: drop a 2 km circle, then let
            // them drag it to size. Asking for a centre AND a radius before
            // anything exists is the fiddly version this replaces.
            createArea({
              kind: "circle",
              center: { lat: ll.lat(), lng: ll.lng() },
              radiusM: 2000,
            });
            return;
          }

          draftRef.current = [...draftRef.current, { lat: ll.lat(), lng: ll.lng() }];
          setDraftCount(draftRef.current.length);
          renderDraft();
        });

        // Double-click closes the ring, the way every map editor behaves. The
        // Finish button does the same thing for anyone who doesn't try it.
        mapRef.current.addListener("dblclick", () => {
          if (drawModeRef.current === "polygon") finishPolygon();
        });

        // Same framing the dispatch map uses, so the editor opens where the
        // company works rather than wherever the last constant pointed.
        fetchCompanyFrame(companyId)
          .then(frame => { if (mapRef.current) applyFrame(mapRef.current, frame); })
          .catch(() => { /* neutral view already showing */ });

        // City picker. `(cities)` restricts predictions to localities, so an
        // owner cannot accidentally set their company's map to a coffee shop.
        // Geocoded ONCE here and stored — the answer never changes, and doing
        // it at read time would be a billed Places call per dispatcher per
        // page load.
        if (cityInputRef.current) {
          const cityAc = new google.maps.places.Autocomplete(cityInputRef.current, {
            types: ["(cities)"],
            fields: ["geometry", "formatted_address", "name"],
          });
          cityAc.addListener("place_changed", async () => {
            const place = cityAc.getPlace();
            const loc = place?.geometry?.location;
            if (!loc) return;
            // The VIEWPORT is the reason a city beats a dropped pin: it frames
            // the whole city at the right zoom instead of guessing a span.
            const vp = place.geometry?.viewport;
            const ne = vp?.getNorthEast();
            const sw = vp?.getSouthWest();
            await supabase
              .from("companies")
              .update({
                service_city: place.formatted_address ?? place.name ?? null,
                service_city_lat: loc.lat(),
                service_city_lng: loc.lng(),
                service_city_north: ne?.lat() ?? null,
                service_city_south: sw?.lat() ?? null,
                service_city_east: ne?.lng() ?? null,
                service_city_west: sw?.lng() ?? null,
              })
              .eq("id", companyId);
            fetchCity();
            if (!areas.length && mapRef.current) {
              if (vp) mapRef.current.fitBounds(vp, 48);
              else { mapRef.current.setCenter(loc); mapRef.current.setZoom(11); }
            }
          });
        }

        // Place search: the fast path to a destination area. Picking a result
        // recentres and drops a default 2 km circle the owner can then drag.
        if (searchInputRef.current) {
          const ac = new google.maps.places.Autocomplete(searchInputRef.current, {
            fields: ["geometry", "name"],
          });
          ac.bindTo("bounds", mapRef.current);
          ac.addListener("place_changed", () => {
            const place = ac.getPlace();
            const loc = place?.geometry?.location;
            if (!loc || !mapRef.current) return;
            mapRef.current.setCenter(loc);
            mapRef.current.setZoom(13);
            createArea({
              kind: "circle",
              center: { lat: loc.lat(), lng: loc.lng() },
              radiusM: 2000,
              name: place.name ?? undefined,
              // A searched place is almost always a DESTINATION (the airport,
              // the hospital in the next town), not somewhere they park cars.
              // Defaulting pickup on would quietly widen their pickup area to
              // wherever they last searched.
              allowsPickup: false,
            });
            if (searchInputRef.current) searchInputRef.current.value = "";
          });
        }
      })
      .catch(() => {
        if (!cancelled) setError("Google Maps failed to load.");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the toolbar into the ref the click listener reads, and make the
  // cursor say what a click will do.
  useEffect(() => {
    drawModeRef.current = drawMode;
    mapRef.current?.setOptions({
      draggableCursor: drawMode ? "crosshair" : null,
      // A stray double-click while drawing must close the ring, not zoom.
      disableDoubleClickZoom: drawMode === "polygon",
    });
    if (!drawMode) clearDraft();
  }, [drawMode]);

  // Overlays are rebuilt only when the GEOMETRY changes — not on every row
  // change. Ticking "pick up here" used to refetch, replace the areas array,
  // and destroy/recreate every shape, which throws away the editable handles on
  // the circle the owner is in the middle of dragging. Colour and weight are a
  // separate, cheap restyle below.
  const geomKey = areas
    .map(a =>
      [a.id, a.shape_kind, a.center_lat, a.center_lng, a.radius_m,
       a.area_geojson ? JSON.stringify(a.area_geojson).length : 0].join(":"),
    )
    .join("|");

  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;

    shapesRef.current.forEach(shape => {
      if (Array.isArray(shape)) shape.forEach(p => p.setMap(null));
      else shape.setMap(null);
    });
    shapesRef.current.clear();

    const bounds = new google.maps.LatLngBounds();
    let any = false;

    for (const a of areas) {
      const color = colorFor(a);
      const opts = {
        map,
        fillColor: color,
        fillOpacity: a.active ? 0.18 : 0.08,
        strokeColor: color,
        strokeWeight: a.id === selectedId ? 3 : 2,
        clickable: true,
      };

      if (a.shape_kind === "circle" && a.center_lat != null && a.center_lng != null) {
        const circle = new google.maps.Circle({
          ...opts,
          center: { lat: a.center_lat, lng: a.center_lng },
          radius: Number(a.radius_m ?? 0),
          editable: a.id === selectedId,
          draggable: a.id === selectedId,
        });
        circle.addListener("click", () => setSelectedId(a.id));
        if (a.id === selectedId) {
          circle.addListener("radius_changed", () => persistCircle(a.id, circle));
          circle.addListener("center_changed", () => persistCircle(a.id, circle));
        }
        shapesRef.current.set(a.id, circle);
        const b = circle.getBounds();
        if (b) { bounds.union(b); any = true; }
      } else {
        const polys = geoJsonToPaths(a.area_geojson).map(path => {
          const poly = new google.maps.Polygon({
            ...opts,
            paths: path,
            editable: a.id === selectedId,
          });
          poly.addListener("click", () => setSelectedId(a.id));
          if (a.id === selectedId) {
            const push = () => persistPolygon(a.id, poly);
            poly.getPath().addListener("set_at", push);
            poly.getPath().addListener("insert_at", push);
            poly.getPath().addListener("remove_at", push);
          }
          path.forEach(p => { bounds.extend(p); any = true; });
          return poly;
        });
        shapesRef.current.set(a.id, polys);
      }
    }

    // THE framing rule (plan §2): the areas are the map's extent. Only fall
    // back to a constant when there is nothing at all to frame.
    if (any && selectedIdRef.current === null) {
      map.fitBounds(bounds, 48);
    }
    selectedIdRef.current = selectedId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomKey, selectedId]);

  // Restyle in place: active/pickup flags change colour and opacity, and none
  // of that needs the overlay torn down.
  useEffect(() => {
    for (const a of areas) {
      const shape = shapesRef.current.get(a.id);
      if (!shape) continue;
      const style = {
        fillColor: colorFor(a),
        strokeColor: colorFor(a),
        fillOpacity: a.active ? 0.18 : 0.08,
        strokeWeight: a.id === selectedId ? 3 : 2,
      };
      if (Array.isArray(shape)) shape.forEach(poly => poly.setOptions(style));
      else shape.setOptions(style);
    }
  }, [areas, selectedId]);

  // ── draft polygon ───────────────────────────────────────────────────────

  function renderDraft() {
    if (!mapRef.current) return;
    const path = draftRef.current;
    if (!draftPolyRef.current) {
      draftPolyRef.current = new google.maps.Polygon({
        map: mapRef.current,
        fillColor: AREA_COLOR,
        fillOpacity: 0.12,
        strokeColor: AREA_COLOR,
        strokeWeight: 2,
        clickable: false,
      });
    }
    draftPolyRef.current.setPath(path);
  }

  function clearDraft() {
    draftRef.current = [];
    setDraftCount(0);
    draftPolyRef.current?.setMap(null);
    draftPolyRef.current = null;
  }

  function finishPolygon() {
    const path = draftRef.current;
    // Two points is a line, not an area. Silently ignoring is right here: the
    // user is mid-gesture, and an error toast for "keep clicking" is noise.
    if (path.length < 3) return;
    clearDraft();
    createArea({ kind: "polygon", path });
  }

  // ── writes ──────────────────────────────────────────────────────────────

  async function createArea(spec: {
    kind: ShapeKind;
    path?: google.maps.LatLngLiteral[];
    center?: google.maps.LatLngLiteral;
    radiusM?: number;
    name?: string;
    allowsPickup?: boolean;
  }) {
    setDrawMode(null);
    setSaving(true);
    setError(null);

    const row: Record<string, unknown> = {
      company_id: companyId,
      name: spec.name ?? (spec.kind === "circle" ? "New area" : "New service area"),
      shape_kind: spec.kind,
      allows_pickup: spec.allowsPickup ?? true,
      allows_dropoff: true,
    };

    if (spec.kind === "circle") {
      row.center_lat = spec.center!.lat;
      row.center_lng = spec.center!.lng;
      row.radius_m = spec.radiusM;
      // No `area` sent. The BEFORE INSERT trigger generates it from
      // centre+radius, and NOT NULL is checked AFTER before-triggers run
      // (verified live 2026-09-17). Sending a placeholder polygon would be a
      // second, wrong description of the same shape for the instant before the
      // trigger overwrote it.
    } else {
      row.area = ringToEwkt(spec.path!);
    }

    const { data, error } = await supabase
      .from("service_areas")
      .insert(row)
      .select("id")
      .maybeSingle();

    setSaving(false);
    if (error) { setError(error.message); return; }
    await fetchAreas();
    await fetchImpact();
    if (data?.id) setSelectedId(data.id);
  }

  async function patch(id: string, fields: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from("service_areas")
      .update(fields)
      .eq("id", id);
    setSaving(false);
    if (error) { setError(error.message); return; }
    await fetchAreas();
    await fetchImpact();
  }

  // Geometry edits fire continuously while a vertex or radius is being dragged.
  // Persisting each one would be a round trip per mouse-move, and every reply
  // rebuilds the overlays — which would yank the shape out from under the hand
  // dragging it. Settle first, then write once.
  function persistGeometryDebounced(id: string, fields: () => Record<string, unknown>) {
    if (geometryTimer.current) clearTimeout(geometryTimer.current);
    geometryTimer.current = setTimeout(() => patch(id, fields()), 700);
  }

  function persistCircle(id: string, circle: google.maps.Circle) {
    persistGeometryDebounced(id, () => {
      const c = circle.getCenter()!;
      return {
        center_lat: c.lat(),
        center_lng: c.lng(),
        radius_m: Math.round(circle.getRadius()),
        // area is regenerated by the trigger; nothing to send.
        shape_kind: "circle",
      };
    });
  }

  function persistPolygon(id: string, poly: google.maps.Polygon) {
    persistGeometryDebounced(id, () => ({
      shape_kind: "polygon",
      area: ringToEwkt(toLiterals(poly.getPath().getArray())),
    }));
  }

  async function removeArea(id: string) {
    if (!confirm("Delete this service area? Bookings there will be refused once enforcement is on.")) return;
    setSaving(true);
    const { error } = await supabase.from("service_areas").delete().eq("id", id);
    setSaving(false);
    if (error) { setError(error.message); return; }
    if (selectedId === id) setSelectedId(null);
    await fetchAreas();
    await fetchImpact();
  }

  // ── the "this refuses everything" guard (plan §5) ───────────────────────
  //
  // The database fails open per-end, so this state is not an outage — but it is
  // never what the owner meant, and silently papering over it is how they find
  // out from a passenger instead of from us.
  const activeAreas = areas.filter(a => a.active);
  const noPickupArea = activeAreas.length > 0 && !activeAreas.some(a => a.allows_pickup);
  const noDropoffArea = activeAreas.length > 0 && !activeAreas.some(a => a.allows_dropoff);

  return (
    <div className="sa-root">
      <style>{`
        .sa-map { width: 100%; height: 420px; border-radius: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,0.06); background: #0e1626; }
        .sa-city { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
        .sa-city-label { font-size: 12px; color: #9CA3AF; font-weight: 600; }
        .sa-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
        .sa-btn { height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #1E2A3A; color: #E2E8F0; font-size: 13px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; }
        .sa-btn:hover { background: #24344a; }
        .sa-btn.active { background: rgba(232,80,10,0.15); border-color: #E8500A; color: #E8500A; }
        .sa-search { flex: 1; min-width: 200px; height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #1E2A3A; color: #E2E8F0; font-size: 13px; font-family: system-ui, sans-serif; }
        .sa-grid { display: grid; grid-template-columns: 1fr 300px; gap: 14px; align-items: start; }
        @media (max-width: 900px) { .sa-grid { grid-template-columns: 1fr; } }
        .sa-card { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 12px; }
        .sa-card + .sa-card { margin-top: 8px; }
        .sa-card.selected { border-color: #E8500A; }
        .sa-name { width: 100%; background: transparent; border: none; color: #E2E8F0; font-size: 13px; font-weight: 600; font-family: system-ui, sans-serif; padding: 0; }
        .sa-name:focus { outline: none; border-bottom: 1px solid rgba(255,255,255,0.2); }
        .sa-meta { font-size: 11px; color: #6B7280; margin-top: 2px; }
        .sa-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #9CA3AF; margin-top: 8px; cursor: pointer; }
        .sa-del { background: none; border: none; color: #6B7280; font-size: 11px; cursor: pointer; padding: 0; margin-top: 8px; }
        .sa-del:hover { color: #ef4444; }
        .sa-impact { border-radius: 10px; padding: 12px; font-size: 12px; line-height: 1.5; margin-bottom: 10px; }
        .sa-impact.ok { background: rgba(29,158,117,0.1); border: 1px solid rgba(29,158,117,0.25); color: #6ee7b7; }
        .sa-impact.warn { background: rgba(232,80,10,0.1); border: 1px solid rgba(232,80,10,0.3); color: #fdba74; }
        .sa-warn { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; border-radius: 10px; padding: 10px 12px; font-size: 12px; margin-bottom: 10px; }
        .sa-empty { color: #6B7280; font-size: 12px; padding: 8px 0; }
        .sa-list { min-width: 0; }

        /* Tall mode. Paired with .st-content-fill in SettingsPage: the root
           claims the leftover height, the grid claims what the header,
           warnings and toolbar leave behind, and the map stretches into it.
           Only the area list scrolls — a company with thirty areas shouldn't
           have to scroll the map off the screen to reach the last one.
           Same 900px breakpoint the grid already collapses at; below it the
           two stack and a fixed-height map with normal page scroll is right.
           min-height:0 on every link in the chain, or flex children refuse to
           shrink below their content and the whole column overflows instead. */
        @media (min-width: 901px) {
          .sa-root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
          .sa-grid { flex: 1; min-height: 0; align-items: stretch; }
          .sa-map { height: 100%; min-height: 320px; }
          .sa-list { overflow-y: auto; min-height: 0; padding-right: 4px; }
          .sa-list::-webkit-scrollbar { width: 4px; }
          .sa-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        }
      `}</style>

      <div className="st-header">
        <div>
          <div className="st-title">Service Areas</div>
          <div className="st-subtitle">
            Where you pick up and where you'll drive to. Draw your town freehand, and
            add far destinations — the airport, the next city — by searching for them.
            Anywhere you haven't drawn is somewhere you don't serve.
          </div>
        </div>
      </div>

      {areas.length === 0 && !loading && (
        <div className="sa-impact ok">
          No areas drawn yet, so you currently serve <strong>everywhere</strong>.
          Nothing is refused until you draw your first area.
        </div>
      )}

      {noPickupArea && (
        <div className="sa-warn">
          None of your active areas allow <strong>pickups</strong>. Tick "pick up here"
          on the area you work out of — otherwise this list only describes where you'll
          drive to.
        </div>
      )}
      {noDropoffArea && (
        <div className="sa-warn">
          None of your active areas allow <strong>drop-offs</strong>.
        </div>
      )}

      {impact && impact.total > 0 && (impact.pickup_refused > 0 || impact.dropoff_refused > 0) && (
        <div className="sa-impact warn">
          Of your last {impact.total} rides, these areas would have refused{" "}
          <strong>{impact.pickup_refused}</strong> on pickup and{" "}
          <strong>{impact.dropoff_refused}</strong> on drop-off.
        </div>
      )}
      {impact && impact.total > 0 && impact.pickup_refused === 0 && impact.dropoff_refused === 0 && areas.length > 0 && (
        <div className="sa-impact ok">
          These areas cover all of your last {impact.total} rides.
        </div>
      )}

      {impactBlocked && (
        <div className="sa-warn">
          Can't check these areas against your recent rides — this account's
          company doesn't match the one being edited.
        </div>
      )}

      {error && <div className="sa-warn">{error}</div>}

      <div className="sa-city">
        <span className="sa-city-label">Your city</span>
        <input
          ref={cityInputRef}
          className="sa-search"
          defaultValue={city?.service_city ?? ""}
          placeholder="Search your city — e.g. Moncton, NB"
        />
        <span className="sa-meta">
          {city?.service_city
            ? "Frames your maps until you draw an area."
            : "Not set — your maps have nothing to open on."}
        </span>
      </div>

      <div className="sa-toolbar">
        <button
          className={`sa-btn${drawMode === "polygon" ? " active" : ""}`}
          onClick={() => setDrawMode(drawMode === "polygon" ? null : "polygon")}
        >
          {drawMode === "polygon"
            ? draftCount === 0
              ? "Click the map to start…"
              : `${draftCount} point${draftCount === 1 ? "" : "s"} — double-click to close`
            : "Draw an area"}
        </button>

        {drawMode === "polygon" && draftCount >= 3 && (
          <button className="sa-btn active" onClick={finishPolygon}>
            Finish area
          </button>
        )}
        {drawMode === "polygon" && draftCount > 0 && (
          <button className="sa-btn" onClick={clearDraft}>
            Clear
          </button>
        )}

        <button
          className={`sa-btn${drawMode === "circle" ? " active" : ""}`}
          onClick={() => setDrawMode(drawMode === "circle" ? null : "circle")}
        >
          {drawMode === "circle" ? "Click a centre point…" : "Drop a circle"}
        </button>
        <input
          ref={searchInputRef}
          className="sa-search"
          placeholder="Or search a destination — airport, hospital, next town…"
        />
        {saving && <span className="sa-meta">Saving…</span>}
      </div>

      <div className="sa-grid">
        <div ref={mapDivRef} className="sa-map" />

        <div className="sa-list">
          {loading && <div className="sa-empty">Loading…</div>}
          {!loading && areas.length === 0 && (
            <div className="sa-empty">
              Nothing drawn yet. Start with the town you work out of.
            </div>
          )}
          {areas.map(a => (
            <div
              key={a.id}
              className={`sa-card${a.id === selectedId ? " selected" : ""}`}
              onClick={() => setSelectedId(a.id)}
            >
              <input
                className="sa-name"
                defaultValue={a.name}
                onClick={e => e.stopPropagation()}
                onBlur={e => {
                  const v = e.target.value.trim();
                  if (v && v !== a.name) patch(a.id, { name: v });
                }}
              />
              <div className="sa-meta">
                {a.shape_kind === "circle"
                  ? `Circle · ${(Number(a.radius_m ?? 0) / 1000).toFixed(1)} km radius`
                  : "Drawn area"}
                {!a.active && " · inactive"}
              </div>

              <label className="sa-check" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={a.allows_pickup}
                  onChange={e => patch(a.id, { allows_pickup: e.target.checked })}
                />
                Pick up here
              </label>
              <label className="sa-check" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={a.allows_dropoff}
                  onChange={e => patch(a.id, { allows_dropoff: e.target.checked })}
                />
                Drop off here
              </label>
              <label className="sa-check" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={a.active}
                  onChange={e => patch(a.id, { active: e.target.checked })}
                />
                Active
              </label>

              <button
                className="sa-del"
                onClick={e => { e.stopPropagation(); removeArea(a.id); }}
              >
                Delete
              </button>
            </div>
          ))}
          {selected && (
            <div className="sa-meta" style={{ marginTop: 10 }}>
              Selected areas can be reshaped on the map — drag a vertex, or drag the
              circle's edge. Changes save as you go.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
