# CLAUDE.md — mgcj-dashboard

This is the React / Vite / TypeScript web dispatch dashboard for the M&G C&J taxi dispatch platform. Used by dispatchers (`profiles.role === 'admin'`) to manage live rides, scheduled rides, drivers, and reviews.

**For shared project context** (architecture principles, revenue model, Supabase schema conventions, cross-repo technical learnings), see the root-level `CLAUDE.md` at `/home/victor/Documents/projects/CLAUDE.md`. This file only covers what's specific to this repo.

---

## Repo-Specific Stack Details

- Deployed at: `vellon-dispatch.vercel.app`
- Hosting: Vercel, auto-deploy on push to `main`. **This line used to say the repo has no CI and no `vercel.json`; both are now false** — see the CI section below (`build.yml`, `secret-scan.yml`) and the committed `vercel.json`.
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
- **`LoginPage.tsx`** — **email** + emailed-code login (`supabase.auth.signInWithOtp` /
  `verifyOtp`), since 2026-09-28. It was phone + SMS OTP until then; staff sign in by email
  and **only** by email — there is no phone fallback in this screen, deliberately (Phase 1 of
  `mgcj-app/.claude/notes/email-auth-design.md`). Two details are load-bearing:
  `shouldCreateUser: false`, because a login screen that can mint an account produces the
  half-made `profiles` row of the four-week registration outage; and the `email_is_dispatch()`
  pre-check, which reads **`auth.users.email`**, not `profiles.email` — the latter is the
  free-text receipt address and can legitimately differ, so a pre-check reading it would say
  "sent" for an address that can never receive a code. After OTP verification it checks `profiles.role === 'admin'` and immediately signs the user back out with an error if not — non-admins never reach the dashboard shell even momentarily.
- **`DashboardPage.tsx`** — the main shell. Owns: the left icon nav (Rides / Drivers tabs + Analytics/Reports/Sign-out utility buttons), the always-mounted Google Map, the "Active rides" / "Scheduled rides" / "Recent" ride list (with inline assign-driver, cancel, and edit actions), the "New ride" manual booking modal (with Google Places autocomplete + Distance Matrix fare estimation), the ride-detail modal (read view that toggles into an edit form for non-terminal rides), the Drivers tab (driver invite codes + driver list), and `DriverDetailPanel` (a slide-in panel replacing the map when a driver is selected, showing their stats and ride history).
  - **Scheduled ride coverage** (`ScheduledRideCard`, ~line 792): since the mobile app's `scheduled_ride_rearchitecture` (2026-07-06), scheduled rides no longer get a driver assigned at booking time — the backend's `scheduled-release`/`scheduled-coverage-monitor` crons handle dynamic release automatically. Dispatch's role here is purely oversight: each card shows a `coverage_status` pill (`coverageDisplay()`, line 780) — "Covered"/"At risk"/"No drivers" — computed client-side from `ride.coverage_status`, but treated as "Healthy" and ignored if the ride is >24h out. A rollup coverage bar at the top of the section (line ~3052) counts `uncovered`/`at_risk` rides within the next 24h.
  - **Manual assignment** (`assignDriver(rideId, driverId)`, line ~2070) is always available as an override, and behaves differently depending on whether the ride's `scheduled_at` is still in the future: for a still-future scheduled ride it sets `{ driver_id, status: 'scheduled', confirmed_by_driver: false }`; for a ride whose scheduled time has already passed (effectively due now) it sets `{ driver_id, status: 'offered', confirmed_by_driver: false }`. Both paths go through the driver's normal accept/decline flow (`AssignedRideScreen`/`AssignedRidesListScreen` in `mgcj-app`) — **fixed 2026-07-12**: this previously force-set `confirmed_by_driver: true` on the scheduled path, silently skipping the driver's accept step entirely (they'd see the ride already "confirmed" with no chance to decline). `ScheduledRideCard` and the ride-detail modal only show the driver's name once `confirmed_by_driver` is true; until then they show "⏳ Waiting for [driver] to confirm".
  - **Driver decline** (**added 2026-07-12**): a driver declining an unconfirmed assignment goes through `mgcj-app`'s `decline-assigned-ride` Edge Function (service role — RLS blocks a driver from nulling their own `driver_id` directly, see `mgcj-app/CLAUDE.md`). This clears `driver_id`/`confirmed_by_driver`, recomputes `coverage_status` (not a hardcoded value), and appends to `declined_by` (deduped — see `append_declined_by` migration `20260712_dedupe_declined_by.sql` in `mgcj-app`). Since the ride's `status` stays `'scheduled'` with `driver_id` cleared, it automatically re-enters the normal `scheduled-release` dynamic pipeline on the next tick — no dispatch action required for that part. Dispatch's own visibility: the ride-detail modal shows a "Declined by" row (deduped driver names, only rendered when `declined_by` is non-empty) that stays live via a small effect resyncing `rideDetail` from the realtime `rides` state; both "Assign driver" driver lists tag a previously-declined driver with "(declined)" rather than hard-blocking reassignment to them — dispatch may have context (mistaken decline, changed circumstances) the system doesn't.
  - **Preferred driver** (added 2026-07-11, New Ride modal + ride-edit modal): distinct from "Assign driver"/manual assignment above — setting a preferred driver does **not** touch `driver_id` or `status` at all. It only writes `preferred_driver_id`/`preferred_driver_exclusive`, leaving the ride `scheduled` and untouched until the mobile-app backend's `scheduled-release` cron picks it up automatically at the normal dynamic-release window and offers it to that driver then. Only shown when the ride is still `scheduled` with no `driver_id` set yet (mutually exclusive with manual assignment — picking a driver in "Assign driver" clears any preferred-driver state in the New Ride modal). Defaults to soft preference (falls back to the pool automatically if that driver isn't viable at release time); an "Exclusive" checkbox opts into the harder guarantee (only ever offered to that driver, re-pinged and dispatch-alerted on no response, never substituted — see `reassign-stale-rides` in `mgcj-app/CLAUDE.md`). The driver dropdown is scoped to the ride's vehicle class (matching drivers, plus any-class drivers), mirroring how the backend's own eligibility filters work.
- **`AnalyticsPage.tsx`** — a self-contained reporting page with its own left sub-nav for four sections: **Revenue** (KPIs, cash/card split, time-series chart via raw SVG polylines, driver earnings table, peak hour/day bar charts), **Ride History** (rides grouped by month/year, expandable, with per-month/per-year PDF-via-`window.print()` and CSV export), **Reviews** (star-rating reviews left by passengers, filterable by driver/rating, low-rating ones flagged and markable as "reviewed by dispatch"), and **Drivers** (per-driver earnings/cancel-rate/rating table). Mounted permanently inside `DashboardPage` and shown/hidden via `display: showAnalytics ? "flex" : "none"` rather than conditional rendering.
- **`ReportsPage.tsx`** — passenger-submitted safety/behavior reports against drivers (`driver_reports` table — reasons like unsafe driving, harassment, wrong vehicle, etc.). Status workflow is `open → reviewed | dismissed`. `unsafe_driving` and `harassment` are flagged as "high severity" in the UI. Takes an `onBadgeChange(count)` prop so `DashboardPage` can show an open-report count badge on its nav icon. Same always-mounted/`display:none` pattern as `AnalyticsPage`.
- **`SettingsPage.tsx`** — left-tab settings shell (own internal `section` state, not an overlay page like Analytics/Reports). **Pricing**: base fare + rate/km, written to `companies`. **Vehicle Classes**: per-company vehicle class CRUD (name/capacity/surcharge) against `vehicle_classes`. **Support** *(added 2026-07-12)* — dispatch's own problem-report channel to the vendor (Vellon), unrelated to `ReportsPage.tsx`'s passenger→driver safety reports: a category (bug / driver issue / billing / feature request / other) + free-text form inserts into `dispatch_reports` (`mgcj-app` migration `20260712_dispatch_reports.sql`), which fires `mgcj-app`'s `notify-dispatch-report` Edge Function via a Supabase Database Webhook (configured in the Supabase dashboard, not SQL) to email `support@vellon.ca`. Visibility is **company-wide, not per-admin** — RLS scopes `dispatch_reports` by `company_id` only, so every admin at a company sees every report filed there, matching the current flat admin role model (see root `CLAUDE.md` — a future owner/dispatcher permission split was explicitly deferred, not built preemptively).

### Key hooks / context

- **`useAuth.ts`** (`src/hooks/useAuth.ts`) — the only custom hook in the repo. Wraps `supabase.auth.getSession()` + `onAuthStateChange`, fetches the matching `profiles` row (retrying up to 5 times with a 500ms backoff to cover replication lag right after signup), and exposes `{ session, profile, loading, signOut }`. Explicitly ignores sessions where `session.user.is_anonymous` is true — anonymous sessions are created transiently during guest ride booking (see `createManualBooking` in `DashboardPage.tsx`) and must never replace the dispatcher's own session. Uses a `fetchingForRef` guard against the double-fetch-on-mount issue documented in the root `CLAUDE.md`.
- There's no React context — `profile` and `onSignOut` are passed down as plain props from `App.tsx` into `DashboardPage`. No state management library (Redux/Zustand/etc.); all state is local `useState`/`useRef` per page.
- **Realtime**: `DashboardPage` subscribes to a single Supabase Realtime channel (`dashboard-rt`) for `postgres_changes` on `rides` (any event → `fetchAll`) and `drivers` (any event → `fetchDrivers`). This is backed up by a 15-second polling `setInterval(fetchAll, 15000)` as a belt-and-suspenders refresh — so live updates aren't purely realtime-dependent. `AnalyticsPage` and `ReportsPage` have no realtime subscriptions; they only fetch on mount/filter-change.
  - The same `rides` UPDATE stream also drives a **coverage-degradation toast** (~line 1138): whenever a scheduled ride within 24h has its `coverage_status` severity increase (`covered→at_risk→uncovered`), a 6-second toast fires ("No eligible drivers for HH:MM ride" / "HH:MM ride is at risk"). This is how dispatch actually discovers scheduling problems written by the mobile-app backend's `scheduled-coverage-monitor`/`broadcast-scheduled-ride` — there's no separate push notification to the dashboard, it's realtime-derived only.

### Map integration

`DashboardPage.tsx` is the sole owner of the Google Map. It lazy-loads the Maps JS script (`libraries=places`) by injecting a `<script id="gmaps">` tag if not already present, then initializes a single `google.maps.Map` instance into a `ref={mapRef}` div once `mapRef.current.offsetHeight > 0` (polled via `setTimeout` retry, since the div has zero height until the flex layout settles). The map and its `markersRef` (a `Map<string, google.maps.Marker>`) live in refs, not state, and the map is **never unmounted** — when the Drivers tab's `DriverDetailPanel` is open, the underlying map div is hidden with `style={{ visibility: selectedDriver ? "hidden" : "visible" }}` rather than being removed from the tree, matching the "keep Maps div mounted" rule in the root `CLAUDE.md`. A `resize` event is manually triggered after switching away from Analytics/Reports/driver-detail views since the map's container size can change while it was hidden. Markers are split into driver markers (`driver-{id}`, persistent, position updated in place) and ride pickup/dropoff markers (`pickup-{id}`/`dropoff-{id}`, fully cleared and redrawn on every `fetchRides()`).

---

## Local Conventions

- **New top-level sections are added as overlay pages inside `DashboardPage`, not new routes.** `AnalyticsPage` and `ReportsPage` both follow the same pattern: a standalone component permanently mounted inside `DashboardPage`'s JSX, toggled visible via a `showX` boolean and `display: showX ? "flex" : "none"` (never conditionally rendered/unmounted) so internal state and the map underneath survive switching. Follow this precedent for any new dashboard-level section rather than introducing a router.
- **Per-page scoped CSS-in-template-string, no shared design tokens.** Every page defines its own `<style>{\`...\`}</style>` block with hand-prefixed class names (`db-`, `an-`, `rp-`, `login-`, `dd-`). Hex colors (brand orange `#E8500A`, panel bg `#1E2A3A`, page bg `#111827`, danger `#F87171`/`#E24B4A`, success `#1D9E75`, etc.) and the `STATUS_COLORS` maps are **still copy-pasted independently into `DashboardPage.tsx`, `AnalyticsPage.tsx` and `ReportsPage.tsx`** — if you change a status colour you change it in several places by hand. **The LABEL maps are no longer duplicated**: `STATUS_LABELS`, `CANCEL_REASON_LABELS`, `SETTLEMENT_ROUTE_LABELS`, `REFUND_REASON_LABELS`, the driver-report reasons, the flag reasons and `noShowEvidence()` all moved to **`src/lib/labels.ts`** on 2026-10-04 when they became translation keys. i18n is what forced that: three verbatim copies of one list are survivable in English and become three parallel key sets in every added language, each able to drift silently in a language the person editing cannot read. Colours stayed put because they are styling, not copy.

- **`cancelled_reason` display** (added 2026-07-11, both `DashboardPage.tsx` and `AnalyticsPage.tsx`): the status badge itself stays plain red/"Cancelled" regardless of reason — the reason is never baked into the badge. Instead it's added as one more row in each page's existing `[label, value][]` detail-row list (same plain pattern as "Pickup"/"Payment"/etc, no special styling): a `"Cancelled reason"` row is conditionally appended — after "Scheduled" in `DashboardPage.tsx`'s ride-detail modal, at the end of the list in `AnalyticsPage.tsx`'s ride-detail modal (which has no "Scheduled" row to key off) — only when `status === 'cancelled' && cancelled_reason` is set. Both pages now read one `CANCEL_REASON_KEYS` map from `src/lib/labels.ts` (it was a per-page copy until 2026-10-04). Four reasons currently exist, covering both immediate and scheduled rides: `timeout` and `missed_window` are system auto-cancels from the mobile-app backend's `expire-pending-rides` (immediate ride with no driver found in 5 min, and scheduled ride whose pickup time passed 20+ min with no driver ever engaged, respectively); `passenger_cancelled` is stamped client-side wherever the passenger app cancels a ride (`ScheduledRidesScreen.tsx` for scheduled, `PassengerHomeScreen.tsx::cancelRide()` for whatever ride is currently active/tracked — immediate or scheduled); `dispatch_cancelled` is stamped by this dashboard's own `cancelRide()`. Any new cancel-mutation call site (either repo) should stamp a `cancelled_reason` — a bare `{ status: 'cancelled' }` update with no reason silently falls back to the plain "Cancelled" badge with no detail row. Note: neither reason can ever appear in the driver-detail panel's ride history, since both only apply to rides that never got a `driver_id` assigned, and that panel's query is scoped to a specific driver's rides. Any query feeding a ride-detail modal must select `cancelled_reason` (`AnalyticsPage.tsx`'s `RideRow` type and `fetchRideHistory()` mapping were updated to carry it through).
- **Modals are plain conditionally-rendered overlay divs** (`{x && <div className="*-modal-overlay">...}`), not a shared `<Modal>` component — each page reimplements its own overlay/modal/close-button markup.
- **CSV export**: a small local `downloadCSV(filename, headers, rows)` helper in `AnalyticsPage.tsx` builds a CSV string client-side and triggers a download via a `Blob` + temporary `<a>` click — no server endpoint involved.
- **PDF export** is actually a `window.open()` + `document.write()` of styled HTML followed by `win.print()` (see `printReport()` in `AnalyticsPage.tsx`) — relies on the user choosing "Save as PDF" in the browser print dialog, there's no real PDF generation library.
- **Manual ride booking and ride editing both use the same Google Places Autocomplete + Distance Matrix pattern**: an `Autocomplete` bound to an `<input ref>`, a `place_changed` listener that sets both the address string and `{lat, lng}` coords, and a `useEffect` keyed on the coords pair that calls `DistanceMatrixService` to recompute a fare estimate (`4 + distance_km * 1.8`, rounded to cents). When adding new address-editing UI, mirror this rather than re-deriving fare logic.
- Status-gating convention: `NON_EDITABLE_STATUSES` (`in_progress`, `completed`, `cancelled`) in `DashboardPage.tsx` controls whether the ride-edit UI is shown — follow this same allow/deny-set pattern for any future ride-state-dependent UI gating rather than inlining status checks ad hoc.

---

## Multi-language (i18n) — shipped 2026-10-04

The dashboard is bilingual (en + fr), the same shape as `mgcj-app`'s client half
and deliberately parallel to it: `src/i18n/` holds the runtime, `src/i18n/locales/{en,fr}.json`
the bundles (**955 keys each**), and `npm run check:i18n` is the gate. en+fr is a
**pause, not the final list** — see the tier table in
`mgcj-app/.claude/notes/i18n-design.md`, which prices a language by its script,
not its word count.

**This reopened a scope decision.** That design note recorded `mgcj-dashboard` as
out of scope ("staff-facing, small known audience"); Victor reversed it on
2026-10-04 and the note now says so. Don't re-close it from the old line.

### Precedence: explicit pick in THIS browser > `navigator.languages`

Two sources, and **the scope is the browser, not the account** — the full
reasoning is at the top of `src/i18n/LocaleContext.tsx`. Same model as the board
map's saved opening view (`db-map-home:` in `DashboardPage.tsx`): localStorage
with nothing in `profiles` behind it, because a desk preference belongs to the
desk. Two rules from it:

- **`"system"` means "nothing chosen in THIS browser"**, not "follow the OS", so
  there is no resume-time re-sync — a browser language change means a reload.
- **The storage key is bare, not keyed by profile id**, unlike `savedViewKey`.
  Deliberate: the locale resolves at *module load*, before any session exists, so
  a per-profile key would boot in the browser language and flip after login. The
  consequence is that dispatchers sharing a workstation share a language pick.

**It used to be three sources, with `profiles.locale` in the middle, mirrored by
`src/i18n/useLocaleSync.ts`. Both are gone (2026-10-07).** A pick made at the
office came back as source 2 on every other browser still on `"system"`, so
choosing French at one desk silently turned the home laptop French — the opposite
of per-station. Don't reintroduce the mirror-write; if a dispatcher's language
should ever follow them between machines, that is a new decision, not a
regression to fix.

**The column itself stays and is still load-bearing** — the Edge Functions
compose push/email copy from `profiles.locale` for passengers and drivers
(`mgcj-app` migration `20261003000000`). It is simply not a dashboard input any
more, and `locale` is out of `PROFILE_COLUMNS`. Staff were always out of scope
for the server-composed copy the column exists for.

### What the scanner cannot see, and what was wrong because of it

`node scripts/find-strings.mjs src` (also `npm run find:strings`) is the app's AST
scanner, ported. Its RULES ARE SCAR TISSUE — the header in that file lists nine
shapes a regex version shipped English through. Three findings specific to here:

- **68 `toLocale*` calls, 66 of them with a hardcoded `"en-CA"`.** A hardcoded tag
  survives a translation sweep intact and wrong: French labels above English
  dates, nothing failing, no string for a scanner to find. All now go through
  **`src/i18n/format.ts`**. The two that passed `[]`/`undefined` were worse —
  they followed the browser and so ignored an explicit pick too.
- **Labels COMPUTED from identifiers.** `tab.charAt(0).toUpperCase() + tab.slice(1)`
  and `p.charAt(0).toUpperCase() + p.slice(1)` rendered "Rides"/"Today" that
  existed as no string anywhere. Flagged as `DERIVED`; the fix is a key map.
  **The `DERIVED` rule was DEAD from the day it was written** (found 2026-10-05):
  it tested the callee's source text for `.toUpperCase()` *with parens*, and a
  callee's own text never contains the trailing `()` of its own call —
  `p.charAt(0).toUpperCase()` has the callee `p.charAt(0).toUpperCase`. It could
  not fire on any input, so the two sites it was credited with finding were found
  by eye, and a third survived in the Drivers section. It is now in the control.
- **`label === "Settlement"`** gated the warning styling on a detail row. A
  translation turns that into never-true, silently. Both sides now read one
  `const settlementLabel = t(…)`, and the receipt's `lbl === "Total"` the same
  way. Note the first pass "fixed" only the comparison while the row's label
  stayed a raw literal inside an array the scanner skipped — consistent, English,
  and one translation away from the bug it was supposed to close.
- **Month and weekday names were three hardcoded arrays** (`["Jan".."Dec"]`,
  `["Sun".."Sat"]` twice) driving chart axes. They are `monthShort()` /
  `weekdayShort()` in `format.ts` now, NOT nineteen translation keys: `Intl`
  already knows every locale's names and cannot drift, whereas a key only moves
  when a human remembers it. Nineteen keys would have recreated the hardcoded-
  `"en-CA"` bug one layer up. One of the two weekday arrays was also the Map KEY
  its chart bucketed on, so localising it in place would have silently re-keyed
  the buckets; that chart now buckets by day index and formats at the edge.

### The gate read 0 while six surfaces were English — read before trusting a count

On 2026-10-04 this section said "1469 candidate strings → 0, control-verified."
The next morning Victor opened the dashboard in French and found English table
headers in Ride History, Settlements, Receipts and Drivers, English filter chips
(`All/Open/Resolved`), English period chips in Drivers, and English chart axes —
in about two minutes. **What the count measures is "no string literal in a
position the scanner covers", which is not "no English."** Treat a clean scan as
one input, never as the verification.

Two rules compounded into the hole, and the shape is worth remembering because
both looked individually reasonable:

- **`inDataArray`** silenced any anonymous array of 4+ string literals as a data
  list — written for the vehicle make/model tables, and a table-header row
  (`{["Date","Ride","Passenger",…].map(h => <th>{h}</th>)}`) is exactly that
  shape. Count is NOT the discriminator; both are arrays of words.
- **The two-word gate** in `hasWords` then hid every single-word element —
  `"Date"`, `"Resolved"`, `"Drop-off"` — because an array element was in no
  vouched-for position.

The fix is one new vouched-for position, `inMappedJsxArray`: an array element
reached by `.map()`/`.flatMap()` whose result renders in JSX reports single words
like JSX text does, and `inDataArray` is consulted only when that is false. It
walks up through nested arrays so tuple chips (`[["open","Open"],…]`) report too,
which over-reports the enum half of each tuple — the right direction, since an
enum takes one `i18n-ok` and a missed label takes a customer noticing.

**`scripts/control-i18n.mjs` (`npm run control:i18n`, and it runs inside
`check:i18n`) is the real lesson.** The first control seeded two strings into
positions the scanner ALREADY covered, so it tested the plumbing and proved
nothing about coverage — it passed throughout. A scanner control must seed **one
case per rule** and assert the expected `kind`, plus a silent half so coverage
cannot be bought by reporting everything. 13 cases today. Verified by reverting
both bugs: the three new cases fail and the old scanner prints "0 candidates",
which is precisely the false-clean it shipped.

**Currency is deliberately NOT localized** (Victor, 2026-10-04): money stays
`$4.86` in every language, so the ~140 hand-built `` `$${n.toFixed(2)}` `` sites
are correct as they are. `fr-CA` renders `4,86 $`, whose decimal comma breaks CSV
parsing against a comma delimiter — revisit the two together or neither.

### The receipt is rendered in THREE places — read before touching tax or totals

Fixed 2026-10-05. `send-ride-receipt` (the emailed PDF) had already been
corrected to read a frozen per-ride tax rate; this repo kept `fare / 1.15` in
**both** of its receipt renderers — `printReceipt()`'s HTML and the
receipt-detail modal — so the same ride produced two documents with different
numbers. Three defects, in increasing severity:

1. **The rate.** Nova Scotia moved to 14% on 2025-04-01, so `1.15` had been
   wrong since.
2. **The gate.** The split was drawn UNCONDITIONALLY, gating only the
   registration line on `hst_number`. A company under the $30k small-supplier
   threshold — ordinary for a Valley operator — got a receipt claiming tax it
   never collected and cannot remit, off which a passenger could claim an input
   tax credit. The quieter defect and the worse one.
3. **Recomputing at all.** `ride_receipts` already stores `tax_rate_percent`,
   `tax_amount` and `tax_label`, rounded once at send time — the record of what
   was actually printed. Deriving the figure again is how two copies of one
   number disagree by a cent.

So `receiptTax()` in `AnalyticsPage.tsx` reads the row and does no arithmetic
beyond `fare - tax_amount`, and its `taxed` gate is byte-for-byte the Edge
Function's (`rate != null && amount != null`). **There is no tax rate anywhere
in this repo now** — if you find yourself typing one, the number belongs in
`companies.tax_rate_percent` and arrives frozen on the row.

Two things that follow:

- **A receipt sent before `20260930000000` has all three columns NULL and
  prints no tax line.** Deliberate, and the same choice the function makes: an
  understated receipt is a lesser defect than one asserting uncollected tax.
- **`select("*")` was already returning those columns.** Only the `ReceiptRow`
  type and the math were behind, so nothing failed and nothing logged — the
  wrong number simply rendered. A type that is missing a column it receives is
  invisible to tsc in exactly this direction.

The general rule: **this repo renders money but must never derive it.** Same
family as `rides.completed_at` and `platform_fee_percent_at_completion` — the
document is the snapshot, not a recomputation from live settings.

### Conventions that keep the gate honest

- **Key maps hold KEYS, never English.** Module scope is evaluated before a
  language is active, so English there freezes and a `t()` there resolves against
  whatever locale booted. ~133 such values exist; `check:i18n` resolves all of
  them (they are invisible to the literal-`t()` scan, which is why that check
  was added).
- **`// i18n-ok`** opts a vetted non-copy site out, on its own line or the line
  directly ABOVE the reported line — a marker three lines up does nothing.
  There are a handful: an SVG path, a plate/phone format example, EWKT, CSS
  media queries, export filenames, and `MessagesPage`'s day-GROUPING key (which
  keeps `en-CA` on purpose, for YYYY-MM-DD).
- **Mid-sentence labels get their own key.** `periodLabel.toLowerCase()` is an
  English-only trick; `analytics.periodPhrase.*` exists because "ce mois-ci"
  cannot be produced by case-folding "Month".
- **Markup in a template literal is filtered structurally**, by stripping tags —
  so `printReport()`'s document reports nothing while real copy inside markup
  still does. Verified by control, both directions.
- **Server error strings stay English.** `err.message` from PostgREST or an Edge
  Function is surfaced as-is: staff are out of scope for server-composed copy
  (the two skipped `notify-*` functions in the app's design note). Our own
  fallbacks are translated.

**Report a clean scan only with a control.** "0 across 0 files" and a tool
measuring nothing look identical. Drop a known English string plus a
`toLocaleDateString("en-CA")` into a temp file under `src/`, confirm both are
found, delete it. Ran 2026-10-04: 2 found, then 0.


## Known Local Issues / WIP

- **`coverageDisplay()` (~line 780) masks real coverage state beyond 24h out** — flagged 2026-07-12, not yet fixed. It hardcodes "Healthy"/green for any ride scheduled >24h ahead regardless of the actual `ride.coverage_status`, and the realtime toast/rollup bar are likewise gated to the next 24h. Agreed direction (not yet implemented): the override should stay for `at_risk` (transient — drivers exist but none are online right now, meaningless noise weeks out) but **not** for `uncovered` (structural — the company owns zero drivers of that vehicle class at all, doesn't self-resolve, worth surfacing no matter how far out the ride is booked). Related: the corresponding admin push notifications on `uncovered`/`at_risk` transitions were removed from the mobile-app backend on 2026-07-12 (dispatch only uses this dashboard, never the mobile app) — see `mgcj-app/CLAUDE.md`'s Edge Functions section — so this dashboard-side indicator is now the *only* way dispatch finds out, making the >24h masking more consequential than before.
- **`STATUS_COLORS` duplication** across `DashboardPage.tsx`, `AnalyticsPage.tsx`, and `ReportsPage.tsx` (see Local Conventions above) — a real risk of the three drifting out of sync if one is edited without the others. The matching *label* maps were hoisted into `src/lib/labels.ts` on 2026-10-04; the colours are what is left.
- **Ride address edits don't re-geocode unless the dispatcher picks a new autocomplete suggestion.** Editing a ride's pickup/drop-off via the detail modal updates `pickup_lat`/`pickup_lng`/`dropoff_lat`/`dropoff_lng` only when `editPickupCoords`/`editDropoffCoords` are set from a selected place; a manually-typed address with no matching suggestion silently leaves the old coordinates in place (and the fare auto-recalculation effect, gated on `editAddressChanged`, won't fire either).
- No automated tests of any kind in this repo (no test runner configured, no `*.test.*`/`*.spec.*` files).
- No router and no code-splitting — `AnalyticsPage` and `ReportsPage` (each 2000+ lines) are always mounted and bundled into the initial `DashboardPage` render regardless of whether the dispatcher ever opens them.

---

## CI (`.github/workflows/`)

- **`secret-scan.yml`** — gitleaks over full history.
- **`build.yml`** — `npm ci` + `npm run check:event-types` + `npm run check:i18n` + `npm run build`
  (`tsc -b && vite build`, so it typechecks too). Both checks are text-to-text and
  credential-free, which is why they ride in this job; both run before the build
  because they are the faster and more specific failure.
  Runs with **dummy** `VITE_*` values and needs no secrets: Vite substitutes
  `import.meta.env.*` as literal strings at build time and nothing reaches the network, so
  fake credentials compile identically to real ones.

Two things keep it honest. `npm ci` (not `install`) installs strictly from the lockfile.
And a stale `*.tsbuildinfo` would let `tsc -b` skip the work and pass vacuously — a fresh
checkout has none, and the file is now gitignored so it can never be committed into the gate.

**Lint is deliberately not in the gate**: `npm run lint` currently reports 309 problems
(279 errors). A gate that fails on pre-existing style debt is one that gets switched off.
Clear the backlog first, then add it.
