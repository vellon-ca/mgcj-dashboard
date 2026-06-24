# CLAUDE.md — mgcj-dashboard

This is the React / Vite / TypeScript web dispatch dashboard for the M&G C&J taxi dispatch platform. Used by dispatchers (`profiles.role === 'admin'`) to manage live rides, scheduled rides, drivers, and reviews.

**For shared project context** (architecture principles, revenue model, Supabase schema conventions, cross-repo technical learnings), see the root-level `CLAUDE.md` at `/home/victor/Documents/projects/CLAUDE.md`. This file only covers what's specific to this repo.

---

## Repo-Specific Stack Details

- Deployed at: `mgcj-dashboard.vercel.app`
- Hosting: Vercel, auto-deploy on push to `main` (the repo has no other branches and no CI config — no GitHub Actions, no `vercel.json`).
- Env vars / secrets managed: locally via a gitignored `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GOOGLE_MAPS_KEY`), read through `import.meta.env` in `src/lib/supabase.ts` and `src/pages/DashboardPage.tsx`. Where the production values live (presumably Vercel project settings) isn't configured anywhere in this repo — can't confirm from the code alone.

---

## App Structure

```
src/
├── main.tsx                # ReactDOM root, imports global index.css
├── App.tsx                 # auth gate: loading / LoginPage / "admin only" wall / DashboardPage
├── index.css                # global reset only (box-sizing, scrollbars, focus/placeholder) — no design tokens, no Tailwind
├── types.ts                 # shared domain types: Profile, Driver, Ride, DriverInvite
├── hooks/
│   └── useAuth.ts           # Supabase session/profile state
├── lib/
│   └── supabase.ts          # Supabase client init from VITE_ env vars
└── pages/                   # there is no components/ directory — each page is one large, self-contained file
    ├── LoginPage.tsx
    ├── DashboardPage.tsx     # 2300+ lines: nav shell, live map, ride list/booking/editing, drivers tab
    ├── AnalyticsPage.tsx     # 2280+ lines: revenue/ride-history/reviews/drivers reporting, rendered as an "overlay" inside DashboardPage
    └── ReportsPage.tsx       # passenger-submitted driver safety reports, also rendered as an overlay inside DashboardPage
```

There's no router — `App.tsx` switches screens purely on auth state, and `DashboardPage.tsx` switches "screens" purely on local `tab`/`showAnalytics`/`showReports` state. No Tailwind/CSS-in-JS library either: each page injects its own scoped CSS via a `<style>{\`...\`}</style>` template-literal block, with class names prefixed by page initials (`db-`, `an-`, `rp-`, `dd-` for `DriverDetailPanel`, `login-`) to avoid collisions.

### Key pages / tabs

- **`App.tsx`** — not a page itself, but the top-level gate: shows a loading screen while `useAuth` resolves, `LoginPage` if unauthenticated, an "Access denied — Staff only" wall if the logged-in profile's `role !== 'admin'`, otherwise `DashboardPage`.
- **`LoginPage.tsx`** — phone + SMS OTP login (`supabase.auth.signInWithOtp` / `verifyOtp`). After OTP verification it checks `profiles.role === 'admin'` and immediately signs the user back out with an error if not — non-admins never reach the dashboard shell even momentarily.
- **`DashboardPage.tsx`** — the main shell. Owns: the left icon nav (Rides / Drivers tabs + Analytics/Reports/Sign-out utility buttons), the always-mounted Google Map, the "Active rides" / "Scheduled rides" / "Recent" ride list (with inline assign-driver, cancel, and edit actions), the "New ride" manual booking modal (with Google Places autocomplete + Distance Matrix fare estimation), the ride-detail modal (read view that toggles into an edit form for non-terminal rides), the Drivers tab (driver invite codes + driver list), and `DriverDetailPanel` (a slide-in panel replacing the map when a driver is selected, showing their stats and ride history).
- **`AnalyticsPage.tsx`** — a self-contained reporting page with its own left sub-nav for four sections: **Revenue** (KPIs, cash/card split, time-series chart via raw SVG polylines, driver earnings table, peak hour/day bar charts), **Ride History** (rides grouped by month/year, expandable, with per-month/per-year PDF-via-`window.print()` and CSV export), **Reviews** (star-rating reviews left by passengers, filterable by driver/rating, low-rating ones flagged and markable as "reviewed by dispatch"), and **Drivers** (per-driver earnings/cancel-rate/rating table). Mounted permanently inside `DashboardPage` and shown/hidden via `display: showAnalytics ? "flex" : "none"` rather than conditional rendering.
- **`ReportsPage.tsx`** — passenger-submitted safety/behavior reports against drivers (`driver_reports` table — reasons like unsafe driving, harassment, wrong vehicle, etc.). Status workflow is `open → reviewed | dismissed`. `unsafe_driving` and `harassment` are flagged as "high severity" in the UI. Takes an `onBadgeChange(count)` prop so `DashboardPage` can show an open-report count badge on its nav icon. Same always-mounted/`display:none` pattern as `AnalyticsPage`.

### Key hooks / context

- **`useAuth.ts`** (`src/hooks/useAuth.ts`) — the only custom hook in the repo. Wraps `supabase.auth.getSession()` + `onAuthStateChange`, fetches the matching `profiles` row (retrying up to 5 times with a 500ms backoff to cover replication lag right after signup), and exposes `{ session, profile, loading, signOut }`. Explicitly ignores sessions where `session.user.is_anonymous` is true — anonymous sessions are created transiently during guest ride booking (see `createManualBooking` in `DashboardPage.tsx`) and must never replace the dispatcher's own session. Uses a `fetchingForRef` guard against the double-fetch-on-mount issue documented in the root `CLAUDE.md`.
- There's no React context — `profile` and `onSignOut` are passed down as plain props from `App.tsx` into `DashboardPage`. No state management library (Redux/Zustand/etc.); all state is local `useState`/`useRef` per page.
- **Realtime**: `DashboardPage` subscribes to a single Supabase Realtime channel (`dashboard-rt`) for `postgres_changes` on `rides` (any event → `fetchAll`) and `drivers` (any event → `fetchDrivers`). This is backed up by a 15-second polling `setInterval(fetchAll, 15000)` as a belt-and-suspenders refresh — so live updates aren't purely realtime-dependent. `AnalyticsPage` and `ReportsPage` have no realtime subscriptions; they only fetch on mount/filter-change.

### Map integration

`DashboardPage.tsx` is the sole owner of the Google Map. It lazy-loads the Maps JS script (`libraries=places`) by injecting a `<script id="gmaps">` tag if not already present, then initializes a single `google.maps.Map` instance into a `ref={mapRef}` div once `mapRef.current.offsetHeight > 0` (polled via `setTimeout` retry, since the div has zero height until the flex layout settles). The map and its `markersRef` (a `Map<string, google.maps.Marker>`) live in refs, not state, and the map is **never unmounted** — when the Drivers tab's `DriverDetailPanel` is open, the underlying map div is hidden with `style={{ visibility: selectedDriver ? "hidden" : "visible" }}` rather than being removed from the tree, matching the "keep Maps div mounted" rule in the root `CLAUDE.md`. A `resize` event is manually triggered after switching away from Analytics/Reports/driver-detail views since the map's container size can change while it was hidden. Markers are split into driver markers (`driver-{id}`, persistent, position updated in place) and ride pickup/dropoff markers (`pickup-{id}`/`dropoff-{id}`, fully cleared and redrawn on every `fetchRides()`).

---

## Local Conventions

- **New top-level sections are added as overlay pages inside `DashboardPage`, not new routes.** `AnalyticsPage` and `ReportsPage` both follow the same pattern: a standalone component permanently mounted inside `DashboardPage`'s JSX, toggled visible via a `showX` boolean and `display: showX ? "flex" : "none"` (never conditionally rendered/unmounted) so internal state and the map underneath survive switching. Follow this precedent for any new dashboard-level section rather than introducing a router.
- **Per-page scoped CSS-in-template-string, no shared design tokens.** Every page defines its own `<style>{\`...\`}</style>` block with hand-prefixed class names (`db-`, `an-`, `rp-`, `login-`, `dd-`). Hex colors (brand orange `#E8500A`, panel bg `#1E2A3A`, page bg `#111827`, danger `#F87171`/`#E24B4A`, success `#1D9E75`, etc.) and `STATUS_COLORS`/`STATUS_LABELS` ride-status maps are **copy-pasted independently into `DashboardPage.tsx`, `AnalyticsPage.tsx`, and `ReportsPage.tsx`** (the latter has its own distinct map for report statuses). There's no shared constants/theme file — if you change a status color or label, you currently have to change it in multiple places by hand.
- **Modals are plain conditionally-rendered overlay divs** (`{x && <div className="*-modal-overlay">...}`), not a shared `<Modal>` component — each page reimplements its own overlay/modal/close-button markup.
- **CSV export**: a small local `downloadCSV(filename, headers, rows)` helper in `AnalyticsPage.tsx` builds a CSV string client-side and triggers a download via a `Blob` + temporary `<a>` click — no server endpoint involved.
- **PDF export** is actually a `window.open()` + `document.write()` of styled HTML followed by `win.print()` (see `printReport()` in `AnalyticsPage.tsx`) — relies on the user choosing "Save as PDF" in the browser print dialog, there's no real PDF generation library.
- **Manual ride booking and ride editing both use the same Google Places Autocomplete + Distance Matrix pattern**: an `Autocomplete` bound to an `<input ref>`, a `place_changed` listener that sets both the address string and `{lat, lng}` coords, and a `useEffect` keyed on the coords pair that calls `DistanceMatrixService` to recompute a fare estimate (`4 + distance_km * 1.8`, rounded to cents). When adding new address-editing UI, mirror this rather than re-deriving fare logic.
- Status-gating convention: `NON_EDITABLE_STATUSES` (`in_progress`, `completed`, `cancelled`) in `DashboardPage.tsx` controls whether the ride-edit UI is shown — follow this same allow/deny-set pattern for any future ride-state-dependent UI gating rather than inlining status checks ad hoc.

---

## Known Local Issues / WIP

- **`STATUS_COLORS`/`STATUS_LABELS` duplication** across `DashboardPage.tsx`, `AnalyticsPage.tsx`, and `ReportsPage.tsx` (see Local Conventions above) — a real risk of the three drifting out of sync if one is edited without the others.
- **Ride address edits don't re-geocode unless the dispatcher picks a new autocomplete suggestion.** Editing a ride's pickup/drop-off via the detail modal updates `pickup_lat`/`pickup_lng`/`dropoff_lat`/`dropoff_lng` only when `editPickupCoords`/`editDropoffCoords` are set from a selected place; a manually-typed address with no matching suggestion silently leaves the old coordinates in place (and the fare auto-recalculation effect, gated on `editAddressChanged`, won't fire either).
- No automated tests of any kind in this repo (no test runner configured, no `*.test.*`/`*.spec.*` files).
- No router and no code-splitting — `AnalyticsPage` and `ReportsPage` (each 2000+ lines) are always mounted and bundled into the initial `DashboardPage` render regardless of whether the dispatcher ever opens them.
