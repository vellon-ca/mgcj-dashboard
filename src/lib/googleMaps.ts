// One place the Maps JS API URL is built, and one place the script tag is
// managed.
//
// Why this exists: the Maps JS API loads ONCE per page, with a fixed set of
// libraries baked into the URL. DashboardPage used to build that URL inline
// with `libraries=places`. The moment a second surface needed `drawing`, the
// two became order-dependent — whichever mounted first won, and the other
// silently got a `google.maps.drawing is undefined`. Sharing the URL builder
// removes the race by construction rather than by remembering.
//
// `geometry` is in the list even though the service-area editor does NOT use it
// for containment (that is the server's job, via company_serves_point — a
// browser-side point-in-polygon that disagrees with enforcement is worse than
// none). It is here for bounds/distance maths.
//
// `drawing` is deliberately ABSENT. google.maps.drawing.DrawingManager was
// removed from the Maps JS API in v3.65 — @types/google.maps ships it as an
// empty deprecated stub, which is how we found out. The service-area editor
// hand-rolls polygon and circle drawing on core Polygon/Circle overlays
// instead; those are not going anywhere. Another entry for the Maps API
// modernization backlog.

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

export const MAPS_LIBRARIES = "places,geometry";

export function mapsScriptUrl(): string {
  return `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=${MAPS_LIBRARIES}`;
}

let loadPromise: Promise<void> | null = null;

/**
 * Resolves once `google.maps` is usable. Safe to call from several components
 * at once — they all await the same load.
 *
 * Self-healing on failure, same as the original DashboardPage loader: a
 * transient error (network blip, quota, CSP) would otherwise leave a dead
 * <script id="gmaps"> in the DOM and strand every map until a full reload, so
 * the dead tag is removed and the load retried with backoff.
 */
export function loadGoogleMaps(): Promise<void> {
  if (typeof google !== "undefined" && google.maps) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    let attempts = 0;

    const tryLoad = () => {
      if (typeof google !== "undefined" && google.maps) {
        resolve();
        return;
      }
      // A tag is already there and still loading — wait for it rather than
      // appending a second one.
      const existing = document.getElementById("gmaps");
      if (existing) {
        setTimeout(tryLoad, 300);
        return;
      }

      attempts += 1;
      const s = document.createElement("script");
      s.id = "gmaps";
      s.src = mapsScriptUrl();
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        s.remove();
        if (attempts < 8) {
          setTimeout(tryLoad, Math.min(1000 * attempts, 8000));
        } else {
          loadPromise = null; // let a later mount try again from scratch
          reject(new Error("Google Maps failed to load"));
        }
      };
      document.head.appendChild(s);
    };

    tryLoad();
  });

  return loadPromise;
}

// Shared with DashboardPage so the two maps look like the same product. These
// are DashboardPage's original values, moved here rather than re-picked — a
// second palette that is nearly the same is worse than one that is shared.
export const darkMapStyle: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#1d2c3f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8ec3b9" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a3646" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#253d56" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#2c6675" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1626" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
