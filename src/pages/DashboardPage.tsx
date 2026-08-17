import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { invokeFunction } from "../lib/invokeFunction";
import { logDispatchEvent } from "../lib/logDispatchEvent";
import type { Ride, Driver, Profile, DriverInvite } from "../types";
import AnalyticsPage from "./AnalyticsPage";
import ReportsPage from "./ReportsPage";
import DiscountsPage from "./DiscountsPage";
import SettingsPage from "./SettingsPage";
import AnnouncementsPage from "./AnnouncementsPage";
import MessagesPage from "./MessagesPage";

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

const STATUS_COLORS: Record<string, string> = {
  pending: "#F59E0B",
  offered: "#F59E0B",
  assigned: "#4a9eff",
  driver_arriving: "#4a9eff",
  in_progress: "#E8500A",
  completed: "#1D9E75",
  cancelled: "#E24B4A",
  scheduled: "#A855F7",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  offered: "Offered",
  assigned: "Assigned",
  driver_arriving: "Arriving",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  scheduled: "Scheduled",
};
// Gates the Edit button in the ride-DETAIL modal, which only renders for a
// ride that is not in LIVE_STATUSES — so in practice this set decides for
// completed/cancelled only. in_progress was listed here but never reached it;
// it is dropped so the set doesn't imply a mid-ride ride is uneditable. It is
// not: edit-ride's DROPOFF_EDITABLE accepts in_progress, and dispatch enters
// that edit from the live-panel card below, not from here. The fields the
// server does refuse mid-ride (pickup, scheduled_at, and vehicle class by our
// own choice) are locked individually in the form.
const NON_EDITABLE_STATUSES = new Set(["completed", "cancelled"]);
// Live/active rides: clicking one opens the docked live panel (not the modal).
const LIVE_STATUSES = new Set([
  "pending",
  "offered",
  "assigned",
  "driver_arriving",
  "in_progress",
]);

// ── Attention panel ────────────────────────────────────────────────────────
// An aggregate "is anything wrong right now" view. Every item here ALSO has a
// surface on its own ride card (the flag badge, AssignmentHold) — that overlap
// is deliberate, not an oversight to clean up: a card badge only helps a
// dispatcher already looking at that card, and this answers the question
// without scanning the board.
//
// Sources are pure functions from state to AlertItem[], so adding one later is
// an entry in buildAlerts() rather than a rendering change. Clicking a row
// opens the ride — the panel is a way INTO the board, never a place to action
// things in isolation.
type AlertItem = {
  key: string;
  tier: "act_now" | "watch";
  source: "passenger_flag" | "assignment_hold";
  rideId: string;
  title: string;
  detail?: string;
  at: string;
};

// A flag needs dispatch only while the ride is still happening. The flag ROW is
// kept on a finished ride — it is the record of what happened, and Reports →
// Ride escalations reads it — but a completed trip is not something dispatch
// can act on, so it must leave the attention surfaces.
const TERMINAL_RIDE = new Set(["completed", "cancelled"]);

function isOpenFlag(r: any): boolean {
  return (
    !!r.passenger_flagged_at &&
    !r.passenger_flag_resolved_at &&
    !TERMINAL_RIDE.has(r.status)
  );
}

function buildAlerts(rides: any[]): AlertItem[] {
  const items: AlertItem[] = [];

  for (const r of rides) {
    // Stored, so it has history and an archive. Only dispatch clears it.
    if (isOpenFlag(r)) {
      const codes: string[] = [...(r.passenger_flag_reasons ?? [])].sort(
        (a, b) => FLAG_REASON_ORDER.indexOf(a) - FLAG_REASON_ORDER.indexOf(b),
      );
      items.push({
        key: `flag:${r.id}`,
        tier: "act_now",
        source: "passenger_flag",
        rideId: r.id,
        title: FLAG_REASON_LABELS[codes[0]] ?? "Passenger reported a problem",
        detail:
          codes.length > 1
            ? codes.slice(1).map((c) => FLAG_REASON_LABELS[c] ?? c).join(" · ")
            : (r.passenger_flag_note ?? undefined),
        at: r.passenger_flag_updated_at ?? r.passenger_flagged_at,
      });
    }

    // Derived, so it clears itself when the ride gets a driver or
    // expire-pending-rides cancels it at the 5-minute mark. No dismissal state
    // to keep, and deliberately no history.
    if (
      (r.status === "pending" || r.status === "offered") &&
      (r.assignment_hold_reason === "no_drivers" ||
        r.assignment_hold_reason === "all_declined")
    ) {
      items.push({
        key: `hold:${r.id}`,
        tier: "act_now",
        source: "assignment_hold",
        rideId: r.id,
        title:
          r.assignment_hold_reason === "no_drivers"
            ? "No drivers online for this ride"
            : "Every driver declined this ride",
        detail: r.pickup_address ?? undefined,
        at: r.created_at,
      });
    }
  }

  // Tier first, then newest — a flag raised a minute ago outranks a hold from
  // five minutes ago, but neither outranks the tier above it.
  const rank = { act_now: 0, watch: 1 };
  return items.sort(
    (a, b) =>
      rank[a.tier] - rank[b.tier] ||
      new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
}

// Synthesised, not an audio file: no asset to bundle, nothing for the CSP to
// block, and no network fetch at the moment it matters. Two short tones — a
// rising interval reads as "look up", where a single beep reads as a UI click.
//
// The AudioContext is created lazily on first play and resumed, because a
// context built before any user gesture starts suspended. By the time a flag
// arrives the dispatcher has logged in and clicked, so resume() succeeds; if it
// somehow does not, this fails silently rather than throwing into the effect.
let alertAudioCtx: AudioContext | null = null;

function playAlertChime() {
  try {
    if (!alertAudioCtx) {
      const Ctor =
        window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return;
      alertAudioCtx = new Ctor();
    }
    const ctx = alertAudioCtx;
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    [
      { freq: 880, at: 0 },      // A5
      { freq: 1174.7, at: 0.13 } // D6
    ].forEach(({ freq, at }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Ramped, never stepped — a square-edged gain change is an audible click.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.16, now + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.18);
    });
  } catch {
    // Audio is a nicety; never let it break the alert itself.
  }
}

// Passenger escalations raised from the app during a live ride (flag_ride).
// A minimal surface for now: a badge on the active card and a resolve action.
// The dismissible home panel + archive is the next phase.
const FLAG_REASON_ORDER = [
  "not_in_car",
  "felt_unsafe",
  "driver_never_came",
  "wrong_destination",
  "other",
];
const FLAG_REASON_LABELS: Record<string, string> = {
  not_in_car: "Passenger says they're NOT in the car",
  driver_never_came: "Driver never arrived",
  wrong_destination: "Going the wrong way",
  felt_unsafe: "Passenger feels unsafe",
  other: "Problem reported",
};

// Distinguishes system-driven cancellations from a plain passenger cancel —
// surfaced as a dedicated section in the ride-detail modal (not baked into
// the badge, which stays plain red/"Cancelled" for every cancellation reason).
const CANCEL_REASON_LABELS: Record<string, string> = {
  timeout: "No drivers found in time",
  missed_window: "Missed scheduled window — no driver engaged",
  passenger_cancelled: "Cancelled by passenger",
  dispatch_cancelled: "Cancelled by dispatch",
};

const SETTLEMENT_ROUTE_LABELS: Record<string, string> = {
  driver_transfer: "Paid directly to the driver",
  company_transfer: "Routed to your company account",
  platform_invoiced: "Held by Vellon — pending invoice",
  transfer_failed: "Transfer failed — contact Vellon support",
  transfer_reversed: "Payout reversed — charge was disputed",
  refund_reversed: "Payout reversed — ride was refunded",
  refund_review: "Refunded — payout under review by Vellon",
  reversal_failed: "Payout reversal failed — contact Vellon support",
  retransfer_failed: "Dispute won, but re-payout failed — contact Vellon support",
};

const REFUND_REASON_LABELS: Record<string, string> = {
  driver_fault: "driver/company at fault",
  platform_mistake: "platform mistake — Vellon absorbed",
  goodwill: "goodwill — Vellon absorbed",
};

function rideStatusColor(ride: { status: string }): string {
  return STATUS_COLORS[ride.status];
}

function rideStatusLabel(ride: { status: string }): string {
  return STATUS_LABELS[ride.status] ?? ride.status;
}

type Tab = "rides" | "drivers";

// URL-path-backed navigation: the section you're on is mirrored to the pathname
// (e.g. /analytics) via the History API so a browser refresh (or back/forward)
// restores it instead of dumping you on Rides. The `tab`/`show*` state below stays
// the render truth; the path is the source of truth on load and on popstate.
// Keep this list in sync with the nav sections. (Refresh on a deep path relies on
// the SPA rewrite in vercel.json so /analytics serves the app instead of 404ing.)
const VIEW_PATHS = [
  "rides",
  "drivers",
  "analytics",
  "reports",
  "discounts",
  "settings",
  "announcements",
  "messages",
] as const;
type View = (typeof VIEW_PATHS)[number];
function readViewPath(): View {
  const p =
    typeof window !== "undefined"
      ? window.location.pathname.replace(/^\/+/, "").replace(/\/+$/, "")
      : "";
  return (VIEW_PATHS as readonly string[]).includes(p) ? (p as View) : "rides";
}

const NAV_ITEMS: { tab: Tab; label: string }[] = [
  { tab: "rides", label: "Rides" },
  { tab: "drivers", label: "Drivers" },
];

function IconRides() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1" y="3" width="15" height="13" rx="2" />
      <path d="M16 8h4l3 3v5h-7V8z" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </svg>
  );
}
function IconDrivers() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}
function IconAnalytics() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
function IconReports() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconDiscounts() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.59 13.41L13.42 20.58a2 2 0 0 1-2.83 0L2.59 12.58a2 2 0 0 1 0-2.83l7.17-7.17a2 2 0 0 1 1.42-.58H17a2 2 0 0 1 2 2v6.41a2 2 0 0 1-.58 1.41z" />
      <circle cx="13" cy="7" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconAnnouncements() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}
function IconMessages() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconSignOut() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

const NAV_ICONS: Record<Tab, React.ReactElement> = {
  rides: <IconRides />,
  drivers: <IconDrivers />,
};

interface DiscountCodeOption {
  id: string;
  code: string;
  label: string | null;
  amount_type: "percent" | "fixed";
  amount: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
}

interface VehicleClassOption {
  id: string;
  name: string;
  capacity: number | null;
  surcharge_percent: number | null;
  is_active: boolean;
  display_order: number | null;
}

interface Stats {
  activeRides: number;
  driversOnline: number;
  completedToday: number;
  revenueToday: number;
  revenueWeek: number;
  revenueMonth: number;
  avgFare: number;
  cancelRate: number;
}

// Driver Detail Panel
// Flat-rate fare formula, mirrored from the mobile app's booking estimate:
// company base fare + company rate/km, plus the selected vehicle class's
// surcharge on top. Dispatch-booked fares always round up to the nearest
// dollar, regardless of payment method, so the estimate matches what will
// actually be charged.
function fareForDistance(
  metres: number,
  surchargePercent: number,
  paymentMethod: string,
  baseFare = 4,
  ratePerKm = 1.8,
): number {
  const raw = (baseFare + (metres / 1000) * ratePerKm) * (1 + surchargePercent / 100);
  // Cash rounds up to the whole dollar so nobody needs change; card doesn't.
  // This used to ceil unconditionally with the payment argument unread, which
  // made every card preview up to a dollar higher than what edit-ride and
  // create-payment-intent actually charge.
  return paymentMethod === "cash" ? Math.ceil(raw) : Math.round(raw * 100) / 100;
}

// Client-side preview of `compute_discount_for_booking` (percent/fixed code
// math only — student-discount eligibility needs a server roundtrip and is
// still resolved for real at submit time). Mirrors the same order of
// operations as createManualBooking: discount off the displayed base fare,
// then ceil again since manual bookings are always cash.
function applyDiscountPreview(baseFare: number, code: DiscountCodeOption | undefined): number {
  // Manual bookings are always cash; round up to the nearest dollar so the
  // preview matches what will actually be charged (see submit-time Math.ceil).
  if (!code) return Math.ceil(baseFare);
  const amount =
    code.amount_type === "percent"
      ? Math.round(baseFare * (code.amount / 100) * 100) / 100
      : Math.min(code.amount, baseFare);
  return Math.ceil(baseFare - amount);
}

const VAN_KEYWORDS = ['caravan', 'sienna', 'odyssey', 'transit', 'sprinter', 'express', 'savana', 'villager', 'entourage', 'sedona', 'routan', 'quest', 'windstar', 'promaster', 'econoline'];
const SUV_KEYWORDS = ['explorer', 'tahoe', 'suburban', 'yukon', 'expedition', 'navigator', 'pathfinder', 'armada', 'sequoia', '4runner', 'highlander', 'pilot', 'traverse', 'enclave', 'acadia', 'terrain', 'equinox', 'escape', 'edge', 'flex', 'cx-9', 'qx', 'mdx', 'rdx', 'xt5', 'xt6', 'rav4', 'forester', 'outback', 'ascent', 'santa fe', 'tucson', 'telluride', 'sorento', 'palisade'];

function DriverDetailPanel({
  driver,
  rides,
  companyId,
  dispatcherId,
  onClose,
  onDeactivate,
  onActivate,
  onDelete,
  onVehicleUpdated,
  onOverlayChange,
}: {
  driver: any;
  rides: Ride[];
  companyId: string;
  dispatcherId: string;
  onClose: () => void;
  onDeactivate: (hasActiveRide: boolean) => void;
  onActivate: () => void;
  onDelete: () => void;
  onVehicleUpdated: (updates: Partial<Driver>) => void;
  onOverlayChange?: (active: boolean) => void;
}) {
  const [history, setHistory] = useState<any[]>([]);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalRides, setTotalRides] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<"deactivate" | "activate" | "delete" | null>(null);
  const [acting, setActing] = useState(false);

  const [vehicleClasses, setVehicleClasses] = useState<any[]>([]);
  const [editingVehicle, setEditingVehicle] = useState(false);
  const [vMake, setVMake] = useState('');
  const [vModel, setVModel] = useState('');
  const [vYear, setVYear] = useState('');
  const [vPlate, setVPlate] = useState('');
  const [vClassId, setVClassId] = useState('');
  const [classTouched, setClassTouched] = useState(false);
  const [vehicleSaving, setVehicleSaving] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  useEffect(() => {
    onOverlayChange?.(!!confirmAction || editingVehicle);
  }, [confirmAction, editingVehicle]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchDriverDetail();
  }, [driver.id]);

  useEffect(() => {
    supabase
      .from('vehicle_classes')
      .select('id, name, capacity, surcharge_percent, display_order')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('display_order')
      .then(({ data }) => setVehicleClasses(data ?? []));
  }, [companyId]);

  async function fetchDriverDetail() {
    setLoading(true);
    const [ridesRes, completedCountRes, reviewsRes, reportsRes] = await Promise.all([
      supabase
        .from("rides")
        .select(
          "id, status, cancelled_reason, pickup_address, dropoff_address, fare_final, fare_estimate, created_at, passenger_id",
        )
        .eq("driver_id", driver.id)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("rides")
        .select("*", { count: "exact", head: true })
        .eq("driver_id", driver.id)
        .eq("status", "completed"),
      supabase.from("ride_reviews").select("rating").eq("driver_id", driver.id),
      supabase
        .from("driver_reports")
        .select("id")
        .eq("driver_id", driver.id)
        .eq("status", "open"),
    ]);
    const rideRows = ridesRes.data ?? [];
    const passengerIds = rideRows
      .map((r: any) => r.passenger_id)
      .filter(Boolean);
    const nameMap = new Map<string, string>();
    if (passengerIds.length) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, name")
        .in("id", [...new Set(passengerIds)]);
      profiles?.forEach((p: any) => nameMap.set(p.id, p.name ?? "—"));
    }
    const enriched = rideRows.map((r: any) => ({
      ...r,
      passenger_name: nameMap.get(r.passenger_id) ?? "—",
    }));
    const reviews = reviewsRes.data ?? [];
    const avg = reviews.length
      ? reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length
      : null;
    setHistory(enriched);
    setTotalRides(completedCountRes.count ?? 0);
    setAvgRating(avg);
    setOpenReports(reportsRes.data?.length ?? 0);
    setLoading(false);
  }

  function suggestClassId(model: string): string {
    const m = model.toLowerCase();
    let target = 'Sedan';
    if (VAN_KEYWORDS.some(w => m.includes(w))) target = 'Van';
    else if (SUV_KEYWORDS.some(w => m.includes(w))) target = 'SUV';
    const found = vehicleClasses.find((c: any) => c.name.toLowerCase() === target.toLowerCase());
    return found?.id ?? vehicleClasses[0]?.id ?? '';
  }

  function openVehicleEdit() {
    setVMake(driver.vehicle_make ?? '');
    setVModel(driver.vehicle_model ?? '');
    setVYear(driver.vehicle_year ? String(driver.vehicle_year) : '');
    setVPlate(driver.plate_number ?? '');
    setVClassId(driver.vehicle_class_id ?? vehicleClasses[0]?.id ?? '');
    setClassTouched(false);
    setVehicleError(null);
    setEditingVehicle(true);
  }

  function handleModelChange(val: string) {
    setVModel(val);
    if (!classTouched && vehicleClasses.length > 1) {
      const suggested = suggestClassId(val);
      if (suggested) setVClassId(suggested);
    }
  }

  async function saveVehicle() {
    setVehicleError(null);
    setVehicleSaving(true);
    const { error } = await supabase
      .from('drivers')
      .update({
        vehicle_make: vMake.trim() || null,
        vehicle_model: vModel.trim() || null,
        vehicle_year: vYear ? parseInt(vYear) : null,
        plate_number: vPlate.trim() || null,
        vehicle_class_id: vClassId || null,
      })
      .eq('id', driver.id);
    setVehicleSaving(false);
    if (error) { setVehicleError(error.message); return; }
    setEditingVehicle(false);
    const updatedClass = vehicleClasses.find((c: any) => c.id === vClassId);
    onVehicleUpdated({
      vehicle_make: vMake.trim() || null,
      vehicle_model: vModel.trim() || null,
      vehicle_year: vYear ? parseInt(vYear) : null,
      plate_number: vPlate.trim() || null,
      vehicle_class_id: vClassId || null,
    });
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "driver.vehicle_updated",
      details: {
        driver_id: driver.id,
        driver_name: driver.profile?.name ?? null,
        make: vMake.trim() || null,
        model: vModel.trim() || null,
        year: vYear ? parseInt(vYear) : null,
        plate: vPlate.trim() || null,
        vehicle_class: updatedClass?.name ?? null,
      },
    });
  }

  const name = driver.profile?.name ?? "Unknown";
  const avatarUrl = driver.profile?.avatar_url ?? null;
  const initials = name
    .split(" ")
    .map((n: string) => n[0])
    .join("")
    .slice(0, 2);
  const activeRide = rides.find(
    (r) =>
      r.driver_id === driver.id &&
      ["offered", "assigned", "driver_arriving", "in_progress"].includes(
        r.status,
      ),
  );
  const isAccountActive: boolean = driver.profile?.is_active ?? true;
  const isDeactivationPending: boolean = driver.profile?.deactivation_pending ?? false;

  async function handleConfirm() {
    setActing(true);
    if (confirmAction === "deactivate") onDeactivate(!!activeRide);
    else if (confirmAction === "activate") onActivate();
    else if (confirmAction === "delete") await onDelete();
    setActing(false);
    setConfirmAction(null);
  }

  return (
    <div className="dd-panel">
      <div className="dd-header">
        <button className="dd-back" onClick={onClose}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to map
        </button>
      </div>

      {/* Inline confirmation overlay */}
      {confirmAction && (
        <div className="dd-confirm-overlay">
          <div className="dd-confirm-box">
            {confirmAction === "delete" ? (
              <>
                <div className="dd-confirm-title">Delete driver?</div>
                <div className="dd-confirm-body">
                  <strong>{name}</strong>'s account will be permanently deactivated and they will no longer be able to sign in. Their ride history is preserved for reporting.
                </div>
                <div className="dd-confirm-warning">
                  This cannot be undone.
                </div>
              </>
            ) : confirmAction === "deactivate" ? (
              <>
                <div className="dd-confirm-title">
                  {activeRide ? "Schedule deactivation?" : "Deactivate driver?"}
                </div>
                <div className="dd-confirm-body">
                  {activeRide
                    ? `${name} is currently on a ride. Their account will be deactivated as soon as the ride completes.`
                    : `${name} will be locked out of the app immediately and won't receive new rides.`}
                </div>
              </>
            ) : (
              <>
                <div className="dd-confirm-title">Activate driver?</div>
                <div className="dd-confirm-body">
                  {name} will regain full access to the app and start receiving rides again.
                </div>
              </>
            )}
            <div className="dd-confirm-actions">
              <button
                className="dd-confirm-cancel"
                onClick={() => setConfirmAction(null)}
                disabled={acting}
              >
                Cancel
              </button>
              <button
                className={`dd-confirm-ok${confirmAction === "delete" ? " danger" : confirmAction === "activate" ? " green" : ""}`}
                onClick={handleConfirm}
                disabled={acting}
              >
                {acting ? "…" : confirmAction === "delete" ? "Delete driver" : confirmAction === "activate" ? "Activate" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="dd-scroll">
        <div className="dd-profile">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="dd-avatar-photo"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="dd-avatar-initials">{initials}</div>
          )}
          <div className="dd-profile-info">
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
              <div className="dd-profile-name" style={{ marginBottom: 0 }}>{name}</div>
              <div
                className="dd-status-dot"
                style={{ background: !isAccountActive ? "#EF4444" : driver.is_active ? "#1D9E75" : "#374151", flexShrink: 0 }}
              />
              <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="dd-action-edit" onClick={openVehicleEdit}>Edit vehicle</button>
                {isAccountActive ? (
                  <button
                    className="dd-action-deactivate"
                    onClick={() => setConfirmAction("deactivate")}
                  >
                    Deactivate
                  </button>
                ) : (
                  <button
                    className="dd-action-activate"
                    onClick={() => setConfirmAction("activate")}
                  >
                    Activate
                  </button>
                )}
                <button
                  className="dd-action-delete"
                  disabled={!!activeRide}
                  title={activeRide ? "Cannot delete a driver on an active ride" : undefined}
                  onClick={() => setConfirmAction("delete")}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="dd-profile-sub">
              {driver.vehicle_make} {driver.vehicle_model} ·{" "}
              {driver.plate_number ?? "—"}
              {vehicleClasses.length > 0 && ` · ${vehicleClasses.find((c: any) => c.id === driver.vehicle_class_id)?.name ?? "No class"}`}
            </div>
            <div className="dd-profile-phone">
              {driver.profile?.phone ?? "—"}
            </div>
          </div>
        </div>
        <div className="dd-status-row">
          {!isAccountActive ? (
            <span className="dd-pill dd-pill-red">Deactivated</span>
          ) : isDeactivationPending ? (
            <span className="dd-pill dd-pill-amber">⏳ Deactivation pending</span>
          ) : driver.is_active ? (
            activeRide ? (
              <span className="dd-pill dd-pill-orange">● On a ride</span>
            ) : (
              <span className="dd-pill dd-pill-green">● Available</span>
            )
          ) : (
            <span className="dd-pill dd-pill-gray">Offline</span>
          )}
          {openReports > 0 && (
            <span className="dd-pill dd-pill-red">
              ⚠ {openReports} open report{openReports > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="dd-stats">
          <div className="dd-stat-box">
            <div className="dd-stat-val">{totalRides}</div>
            <div className="dd-stat-lbl">Completed</div>
          </div>
          <div className="dd-stat-box">
            <div
              className="dd-stat-val"
              style={{
                color:
                  avgRating !== null
                    ? avgRating >= 4
                      ? "#1D9E75"
                      : avgRating >= 3
                        ? "#F59E0B"
                        : "#E24B4A"
                    : "#6B7280",
              }}
            >
              {avgRating !== null ? `★ ${avgRating.toFixed(1)}` : "—"}
            </div>
            <div className="dd-stat-lbl">Avg rating</div>
          </div>
          <div className="dd-stat-box">
            <div
              className="dd-stat-val"
              style={{ color: openReports > 0 ? "#F87171" : "#F1F5F9" }}
            >
              {openReports}
            </div>
            <div className="dd-stat-lbl">Open reports</div>
          </div>
        </div>

        {/* Vehicle edit overlay */}
        {editingVehicle && (
          <div className="dd-confirm-overlay">
            <div className="dd-confirm-box" style={{ maxWidth: 340 }}>
              <div className="dd-confirm-title">Edit vehicle</div>
              <div className="dd-vehicle-grid" style={{ marginBottom: 10 }}>
                <div className="dd-vehicle-field">
                  <div className="dd-vehicle-field-label">Make</div>
                  <input className="dd-vehicle-input" value={vMake} onChange={e => setVMake(e.target.value)} placeholder="e.g. Dodge" />
                </div>
                <div className="dd-vehicle-field">
                  <div className="dd-vehicle-field-label">Model</div>
                  <input className="dd-vehicle-input" value={vModel} onChange={e => handleModelChange(e.target.value)} placeholder="e.g. Grand Caravan" />
                </div>
                <div className="dd-vehicle-field">
                  <div className="dd-vehicle-field-label">Year</div>
                  <input className="dd-vehicle-input" value={vYear} onChange={e => setVYear(e.target.value)} placeholder="2021" type="number" min="1990" max="2030" />
                </div>
                <div className="dd-vehicle-field">
                  <div className="dd-vehicle-field-label">Plate</div>
                  <input className="dd-vehicle-input" value={vPlate} onChange={e => setVPlate(e.target.value.toUpperCase())} placeholder="ABC 123" />
                </div>
              </div>
              {vehicleClasses.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="dd-vehicle-field-label" style={{ marginBottom: 6 }}>Vehicle class</div>
                  <div className="dd-class-picker">
                    {vehicleClasses.map((vc: any) => (
                      <button
                        key={vc.id}
                        className={`dd-class-option${vClassId === vc.id ? ' selected' : ''}`}
                        onClick={() => { setVClassId(vc.id); setClassTouched(true); }}
                        type="button"
                      >
                        <div className="dd-class-name">{vc.name}</div>
                        <div className="dd-class-cap">{vc.capacity} seats</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {vehicleError && <div className="dd-vehicle-error" style={{ marginBottom: 10 }}>{vehicleError}</div>}
              <div className="dd-confirm-actions">
                <button className="dd-confirm-cancel" onClick={() => setEditingVehicle(false)}>Cancel</button>
                <button className="dd-confirm-ok" onClick={saveVehicle} disabled={vehicleSaving}>
                  {vehicleSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="dd-section-label">Ride history</div>
        {loading ? (
          <div className="dd-empty">Loading…</div>
        ) : history.length === 0 ? (
          <div className="dd-empty">No rides yet</div>
        ) : (
          history.map((ride) => (
            <div key={ride.id} className="dd-ride-row">
              <div className="dd-ride-row-left">
                <span
                  className="db-status-badge"
                  style={{
                    background: rideStatusColor(ride) + "18",
                    color: rideStatusColor(ride),
                    border: `1px solid ${rideStatusColor(ride)}30`,
                    fontSize: 10,
                  }}
                >
                  {rideStatusLabel(ride)}
                </span>
                <div className="dd-ride-passenger">{ride.passenger_name}</div>
                <div className="dd-ride-addr">
                  {ride.pickup_address} → {ride.dropoff_address}
                </div>
                <div className="dd-ride-time">
                  {new Date(ride.created_at).toLocaleString("en-CA", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  } as any)}
                </div>
              </div>
              <div className="dd-ride-fare">
                {ride.fare_final
                  ? `$${ride.fare_final.toFixed(2)}`
                  : ride.fare_estimate
                    ? `$${ride.fare_estimate.toFixed(2)}`
                    : "—"}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Why auto-dispatch placed nobody. assign-ride used to give up silently on all
// of these — the ride just sat `pending` until it expired, and dispatch's only
// clue was noticing a card that never moved. `driver_committed` is the one that
// needs a human: somebody IS free, they're just confirmed for a scheduled
// pickup they'd miss, and only a dispatcher knows whether this trip is a
// two-minute hop worth the risk. The assign-driver override below is the
// escape hatch.
function AssignmentHold({ ride }: { ride: any }) {
  const reason = ride.assignment_hold_reason;
  // Only meaningful while nobody holds the ride — a manual override clears it
  // server-side, but don't render a stale pill in the gap either way.
  if (!reason || (ride.status !== "pending" && ride.status !== "offered")) return null;

  // driver_committed deliberately renders NOTHING here. Committed drivers are a
  // permanent background condition of a company that takes bookings, so a card
  // banner for it is noise on every ride. The signal moved to where it's
  // actionable: committed drivers sink to the bottom of the "Assign driver"
  // list, amber, labelled with the pickup they're due at, behind a
  // confirmation. no_drivers/all_declined stay — those are genuinely abnormal.
  let title = "";
  let body: string | null = null;
  if (reason === "no_drivers") {
    title = "No drivers online";
    body = "Nobody is on shift for this vehicle class.";
  } else if (reason === "all_declined") {
    title = "Every driver declined";
    body = "No one left to offer this to automatically.";
  }
  // driver_committed lands here with no title — render nothing at all rather
  // than an empty amber box.
  if (!title) return null;

  return (
    <div
      style={{
        marginTop: 8,
        padding: "7px 9px",
        borderRadius: 8,
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.35)",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "#F59E0B" }}>
        {title}
      </div>
      {body && (
        <div style={{ fontSize: 11, marginTop: 2, opacity: 0.85 }}>{body}</div>
      )}
    </div>
  );
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function coverageDisplay(ride: any): { label: string; color: string; bg: string } {
  const minsUntil = ride.scheduled_at
    ? (new Date(ride.scheduled_at).getTime() - Date.now()) / 60_000
    : Infinity;
  if (minsUntil > 24 * 60) return { label: "Healthy", color: "#1D9E75", bg: "rgba(29,158,117,0.12)" };
  const cov = ride.coverage_status ?? "covered";
  if (cov === "uncovered") return { label: "No drivers", color: "#F87171", bg: "rgba(248,113,113,0.12)" };
  if (cov === "at_risk")   return { label: "At risk",    color: "#F59E0B", bg: "rgba(245,158,11,0.12)" };
  return { label: "Covered", color: "#1D9E75", bg: "rgba(29,158,117,0.12)" };
}

// Scheduled Ride Card
function ScheduledRideCard({
  ride,
  assigningRide,
  onlineDrivers,
  onCardClick,
  onAssign,
  onCancelAssign,
  onAssignDriver,
  onEdit,
  onCancel,
}: {
  ride: any;
  assigningRide: string | null;
  onlineDrivers: any[];
  onCardClick: () => void;
  onAssign: () => void;
  onCancelAssign: () => void;
  onAssignDriver: (driverId: string) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const scheduledDate = ride.scheduled_at ? new Date(ride.scheduled_at) : null;
  const formattedDate = scheduledDate
    ? scheduledDate.toLocaleString("en-CA", {
        weekday: "short",
        month: "short",
        day: "numeric",
      } as any)
    : "—";
  const formattedTime = scheduledDate
    ? scheduledDate.toLocaleTimeString("en-CA", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
  const cov = coverageDisplay(ride);

  return (
    <div className="db-sched-card" onClick={onCardClick}>
      <div className="db-sched-datetime">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 1 }}
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="db-sched-date">{formattedDate}</span>
        <span className="db-sched-time-val">{formattedTime}</span>
        <span
          className="db-cov-pill"
          style={{ color: cov.color, background: cov.bg, borderColor: cov.color + "30" }}
        >
          {cov.label}
        </span>
      </div>
      <div className="db-sched-body">
        <div className="db-sched-name">
          {(ride as any).passenger?.name ?? "Unknown passenger"}
        </div>
        <div className="db-sched-addr">{ride.pickup_address}</div>
        <div className="db-sched-addr dest">{ride.dropoff_address}</div>
        {ride.fare_estimate && (
          <div className="db-sched-fare">${ride.fare_estimate.toFixed(2)}</div>
        )}
      </div>
      {ride.driver_id && ride.confirmed_by_driver && (
        <div className="db-sched-driver-row">
          <div className="db-sched-driver-dot" />
          <span className="db-sched-driver-name">
            {(ride as any).driver?.profile?.name ?? "Driver assigned"}
          </span>
        </div>
      )}
      {ride.driver_id && !ride.confirmed_by_driver && (
        <div className="db-pending-badge" style={{ margin: "8px 12px 0" }}>
          ⏳ Waiting for {(ride as any).driver?.profile?.name ?? "driver"} to confirm
        </div>
      )}
      <div style={{ padding: "8px 12px 10px" }}>
        {assigningRide === ride.id ? (
          <>
            <div className="db-assign-label" style={{ marginTop: 0 }}>
              Assign driver:
            </div>
            {onlineDrivers.map((d) => (
              <button
                key={d.id}
                className="db-assign-driver-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onAssignDriver(d.id);
                }}
              >
                {(d as any).profile?.name ?? "Driver"}
                {(ride.declined_by ?? []).includes(d.id) ? " (declined)" : ""}
              </button>
            ))}
            <button
              className="db-cancel-assign-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCancelAssign();
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="db-sched-assign-btn"
              onClick={(e) => {
                e.stopPropagation();
                onAssign();
              }}
            >
              {ride.driver_id ? "Reassign driver" : "Assign driver"}
            </button>
            <button
              className="db-sched-assign-btn"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              Edit
            </button>
            <button
              className="db-cancel-ride-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Dashboard Page
export default function DashboardPage({
  profile,
  companyName,
  onSignOut,
}: {
  profile: Profile;
  companyName: string | null;
  onSignOut: () => void;
}) {
  const isAdmin = profile.role === "admin";

  // Section to open on first paint, read from the URL path so a refresh keeps
  // you where you were. Discounts is admin-only, so fall back for non-admins.
  const initialView: View = (() => {
    const v = readViewPath();
    return v === "discounts" && !isAdmin ? "rides" : v;
  })();
  const urlSynced = useRef(false);

  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  // Per-driver-marker glide state: interpolates old→new position over the
  // measured update interval (Realtime on `drivers` fires per location write,
  // ~5s active / ~10s idle) so dots slide instead of teleporting.
  const driverAnimRef = useRef<
    Map<
      string,
      {
        from: google.maps.LatLngLiteral;
        to: google.maps.LatLngLiteral;
        render: google.maps.LatLngLiteral;
        startT: number;
        dur: number;
        lastT: number;
        bearing: number | null;
      }
    >
  >(new Map());
  const driverRafRef = useRef<number | null>(null);
  const mapInitialized = useRef(false);
  const latestDriversForMapRef = useRef<any[] | null>(null);
  // Road-snapped route drawn on-click for the focused ride (snapshot, not live).
  const routePolylineRef = useRef<google.maps.Polyline | null>(null);
  // While an active ride with an assigned driver is open, the map shows only
  // that driver's car. Null = show every online driver.
  const focusedDriverIdRef = useRef<string | null>(null);
  // Driver ids currently on a live ride — drives the busy (amber) car colour.
  const busyDriverIdsRef = useRef<Set<string>>(new Set());
  // Rendered-icon signature per marker, so we only rebuild/setIcon on a real
  // change (colour, heading bucket or focus) instead of every poll tick.
  const driverIconSigRef = useRef<Map<string, string>>(new Map());
  const driverIconCacheRef = useRef<Map<string, google.maps.Icon>>(new Map());

  const [rides, setRides] = useState<Ride[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  // Real per-driver verdicts for the ride whose assign picker is open, from
  // check-ride-conflicts. Keyed by driver id. Empty until the call returns —
  // the picker is usable immediately and the warnings arrive a beat later.
  const [conflicts, setConflicts] = useState<
    Map<string, { misses: boolean; commitment_at: string; minutes_short: number | null; free_at: string | null }>
  >(new Map());
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [confirmHoldAssign, setConfirmHoldAssign] = useState<{
    rideId: string;
    driverId: string;
    name: string;
    scheduledAt: string;
    minutesShort: number | null;
  } | null>(null);
  const [pendingInvites, setPendingInvites] = useState<DriverInvite[]>([]);
  const [stats, setStats] = useState<Stats>({
    activeRides: 0,
    driversOnline: 0,
    completedToday: 0,
    revenueToday: 0,
    revenueWeek: 0,
    revenueMonth: 0,
    avgFare: 0,
    cancelRate: 0,
  });
  const [tab, setTab] = useState<Tab>(
    initialView === "drivers" ? "drivers" : "rides",
  );
  const [showAnalytics, setShowAnalytics] = useState(initialView === "analytics");
  const [showReports, setShowReports] = useState(initialView === "reports");
  const [showDiscounts, setShowDiscounts] = useState(initialView === "discounts");
  const [showSettings, setShowSettings] = useState(initialView === "settings");
  const [showAnnouncements, setShowAnnouncements] = useState(
    initialView === "announcements",
  );
  const [showMessages, setShowMessages] = useState(initialView === "messages");
  const [driverChatUnreadCount, setDriverChatUnreadCount] = useState(0);
  const [cancelPendingId, setCancelPendingId] = useState<string | null>(null);
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<any | null>(null);
  // Which phone number was just copied from the live-ride card (for feedback).
  const [copiedPhone, setCopiedPhone] = useState<string | null>(null);
  const [detailOverlayActive, setDetailOverlayActive] = useState(false);
  const [driverSearch, setDriverSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [inviteName, setInviteName] = useState("");
  const [invitePhone, setInvitePhone] = useState("");

  function formatPhoneInput(value: string): string {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits.length ? `(${digits}` : "";
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookPassenger, setBookPassenger] = useState("+1 ");
  const [bookPassengerName, setBookPassengerName] = useState("");
  const [bookPassengerRegistered, setBookPassengerRegistered] = useState(false);
  const [bookPickup, setBookPickup] = useState("");
  const [bookPickupCoords, setBookPickupCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [bookDropoff, setBookDropoff] = useState("");
  const [bookDropoffCoords, setBookDropoffCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [bookFare, setBookFare] = useState("");
  const [bookFareLoading, setBookFareLoading] = useState(false);
  const [bookFareError, setBookFareError] = useState(false);
  const [bookDiscountCode, setBookDiscountCode] = useState("");
  const [discountCodes, setDiscountCodes] = useState<DiscountCodeOption[]>([]);
  const [bookVehicleClassId, setBookVehicleClassId] = useState("");
  const [bookDistanceMetres, setBookDistanceMetres] = useState<number | null>(null);
  const [bookBaseFare, setBookBaseFare] = useState<number | null>(null);
  const [vehicleClasses, setVehicleClasses] = useState<VehicleClassOption[]>([]);
  const [companyBaseFare, setCompanyBaseFare] = useState<number | null>(null);
  const [companyRatePerKm, setCompanyRatePerKm] = useState<number | null>(null);

  function surchargeFor(vehicleClassId: string): number {
    if (!vehicleClassId) return 0;
    return vehicleClasses.find((vc) => vc.id === vehicleClassId)?.surcharge_percent ?? 0;
  }
  const [bookDriver, setBookDriver] = useState("");
  const [bookScheduled, setBookScheduled] = useState("");
  const [bookPreferredDriver, setBookPreferredDriver] = useState("");
  const [bookPreferredExclusive, setBookPreferredExclusive] = useState(false);
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const activeRideIdsRef = useRef<string[]>([]);
  const pickupInputRef = useRef<HTMLInputElement>(null);
  const dropoffInputRef = useRef<HTMLInputElement>(null);
  const pickupAutocompleteRef = useRef<any>(null);
  const dropoffAutocompleteRef = useRef<any>(null);
  const [assigningRide, setAssigningRide] = useState<string | null>(null);
  const [rideDetail, setRideDetail] = useState<Ride | null>(null);

  // Keep the open ride-detail modal in sync with realtime updates to the
  // underlying `rides` array (e.g. a driver declining) instead of only
  // reflecting the snapshot taken at the moment the card was clicked.
  useEffect(() => {
    if (!rideDetail) return;
    const updated = rides.find((r) => r.id === rideDetail.id);
    if (updated && updated !== rideDetail) setRideDetail(updated);
  }, [rides, rideDetail]);
  const [editingRide, setEditingRide] = useState(false);
  const [editPickup, setEditPickup] = useState("");
  const [editPickupCoords, setEditPickupCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [editDropoff, setEditDropoff] = useState("");
  const [editDropoffCoords, setEditDropoffCoords] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [editFare, setEditFare] = useState("");
  const [editFareLoading, setEditFareLoading] = useState(false);
  const [editAddressChanged, setEditAddressChanged] = useState(false);
  // Whether the dispatcher typed the fare themselves. Only a typed fare is sent
  // as an override; otherwise the box is a preview and the server prices.
  const [editFareTouched, setEditFareTouched] = useState(false);
  const [editVehicleClassId, setEditVehicleClassId] = useState("");
  const [editVehicleClassTouched, setEditVehicleClassTouched] = useState(false);
  const [editDistanceMetres, setEditDistanceMetres] = useState<number | null>(null);
  const [editPayment, setEditPayment] = useState("");
  const [editScheduled, setEditScheduled] = useState("");
  const [editPreferredDriver, setEditPreferredDriver] = useState("");
  const [editPreferredExclusive, setEditPreferredExclusive] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editPickupInputRef = useRef<HTMLInputElement>(null);
  const editDropoffInputRef = useRef<HTMLInputElement>(null);
  const editPickupAutocompleteRef = useRef<any>(null);
  const editDropoffAutocompleteRef = useRef<any>(null);
  const [flaggedReviews, setFlaggedReviews] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertSound, setAlertSound] = useState(
    () => localStorage.getItem("db-alert-sound") !== "off",
  );
  const [navExpanded, setNavExpanded] = useState(false);
  const [coverageToast, setCoverageToast] = useState<string | null>(null);
  const coverageToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const tryInit = () => {
      if (cancelled || mapInitialized.current) return;
      if (!mapRef.current || mapRef.current.offsetHeight === 0) {
        setTimeout(tryInit, 150);
        return;
      }
      if ((window as any).google?.maps) {
        initMap();
        return;
      }
      // A script tag already exists — it's still loading. Poll for google to appear
      // rather than giving up forever (the old code returned and never retried).
      if (document.getElementById("gmaps")) {
        setTimeout(tryInit, 300);
        return;
      }
      attempts += 1;
      const s = document.createElement("script");
      s.id = "gmaps";
      s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places`;
      s.async = true;
      s.onload = () => {
        if (!cancelled) initMap();
      };
      // Without this, any transient failure (network blip, quota, CSP) leaves a dead
      // <script id="gmaps"> in the DOM and the map is stranded until a full page reload.
      // Drop the dead tag and retry with backoff so it self-heals.
      s.onerror = () => {
        s.remove();
        if (!cancelled && attempts < 8) {
          setTimeout(tryInit, Math.min(1000 * attempts, 8000));
        }
      };
      document.head.appendChild(s);
    };
    function initMap() {
      if (mapInitialized.current || !mapRef.current) return;
      mapInitialized.current = true;
      googleMapRef.current = new google.maps.Map(mapRef.current, {
        center: { lat: 45.0773, lng: -64.3601 },
        zoom: 11,
        styles: darkMapStyle,
        disableDefaultUI: true,
        zoomControl: true,
      });
      // fetchDrivers() commonly resolves before the Maps script/map finish loading,
      // so it has nowhere to draw markers. Flush whatever it last computed now that
      // the map exists, instead of waiting for the next poll/Realtime tick.
      if (latestDriversForMapRef.current) {
        renderDriverMarkers(latestDriversForMapRef.current);
      }
    }
    tryInit();
    return () => {
      cancelled = true;
      if (driverRafRef.current != null) {
        cancelAnimationFrame(driverRafRef.current);
        driverRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (
      !showAnalytics &&
      !showReports &&
      !showDiscounts &&
      !showSettings &&
      !showAnnouncements &&
      !showMessages &&
      !selectedDriver &&
      googleMapRef.current
    ) {
      setTimeout(() => {
        if (googleMapRef.current)
          google.maps.event.trigger(googleMapRef.current, "resize");
      }, 50);
    }
  }, [showAnalytics, showReports, showDiscounts, showSettings, showAnnouncements, showMessages, selectedDriver]);

  // Mirror the active view into the URL path so a refresh restores it. The first
  // sync (normalizing e.g. "/" to "/rides", or a no-op on a matching deep link)
  // uses replaceState; genuine navigations pushState so back/forward get entries.
  useEffect(() => {
    const path = `/${viewFromState()}`;
    if (window.location.pathname !== path) {
      if (urlSynced.current) {
        window.history.pushState(null, "", path);
      } else {
        window.history.replaceState(null, "", path);
      }
    }
    urlSynced.current = true;
  }, [
    tab,
    showAnalytics,
    showReports,
    showDiscounts,
    showSettings,
    showAnnouncements,
    showMessages,
  ]);

  // Browser back/forward: apply whatever view the path now points at.
  useEffect(() => {
    const onPop = () => applyView(readViewPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isAdmin]);

  useEffect(() => {
    fetchAll();
    const i = setInterval(fetchAll, 15000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    const ch = supabase
      .channel("dashboard-rt")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "rides" },
        (payload) => {
          if (payload.new) {
            setRides((prev) => {
              const existing = prev.find((r) => r.id === (payload.new as any).id);
              const next = prev.map((r) =>
                r.id === (payload.new as any).id
                  ? { ...r, ...(payload.new as any) }
                  : r,
              );
              computeStats(next);
              updateMapMarkers(next);
              if (["completed", "cancelled"].includes((payload.new as any).status)) fetchStats();
              const driverChanged =
                existing && existing.driver_id !== (payload.new as any).driver_id;
              if (!existing || driverChanged) fetchRides();

              // Coverage degradation toast — only for rides within 24 h
              const COV_SEV: Record<string, number> = { covered: 0, at_risk: 1, uncovered: 2 };
              const prevCov    = (existing as any)?.coverage_status ?? "covered";
              const newCov     = (payload.new as any).coverage_status;
              const schedAt    = (payload.new as any).scheduled_at;
              const minsUntil  = schedAt ? (new Date(schedAt).getTime() - Date.now()) / 60_000 : Infinity;
              if (newCov && minsUntil < 24 * 60 && COV_SEV[newCov] > (COV_SEV[prevCov] ?? 0)) {
                const when = (payload.new as any).scheduled_at
                  ? new Date((payload.new as any).scheduled_at).toLocaleTimeString("en-CA", {
                      hour: "numeric", minute: "2-digit", timeZone: "America/Halifax",
                    })
                  : "scheduled ride";
                const msg = newCov === "uncovered"
                  ? `No eligible drivers for ${when} ride`
                  : `${when} ride is at risk — no active drivers`;
                setCoverageToast(msg);
                if (coverageToastTimerRef.current) clearTimeout(coverageToastTimerRef.current);
                coverageToastTimerRef.current = setTimeout(() => setCoverageToast(null), 6000);
              }

              return next;
            });
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "rides" },
        () => fetchRides(),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "rides" },
        () => fetchRides(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "drivers" },
        fetchDrivers,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "driver_invites" },
        fetchInvites,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ride_reviews" },
        fetchReviewsBadge,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "ride_reviews" },
        fetchReviewsBadge,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  // Keep ref in sync so the polling interval always sees current active ride IDs
  // without needing to be in the dependency array (avoids restarting the interval).
  useEffect(() => {
    activeRideIdsRef.current = rides
      .filter((r) =>
        ["pending", "offered", "assigned", "driver_arriving", "in_progress"].includes(r.status),
      )
      .map((r) => r.id);
  }, [rides]);

  // Poll active ride statuses every 2 s — cheap query, guarantees sub-2s updates
  // regardless of Supabase Realtime CDC latency.
  useEffect(() => {
    const interval = setInterval(async () => {
      const ids = activeRideIdsRef.current;
      if (ids.length === 0) return;
      const { data } = await supabase
        .from("rides")
        .select("id, status, driver_id, confirmed_by_driver, fare_final")
        .in("id", ids);
      if (!data) return;
      setRides((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          const fresh = data.find((d: any) => d.id === r.id);
          if (!fresh) return r;
          const driverChanged = fresh.driver_id !== r.driver_id;
          if (driverChanged) fetchRides();
          if (
            fresh.status === r.status &&
            fresh.confirmed_by_driver === (r as any).confirmed_by_driver &&
            fresh.fare_final === r.fare_final &&
            !driverChanged
          )
            return r;
          changed = true;
          return { ...r, ...fresh };
        });
        if (!changed) return prev;
        computeStats(next);
        updateMapMarkers(next);
        return next;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  function toE164(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }

  function formatBookingPhone(value: string): string {
    const digits = value.replace(/\D/g, "").replace(/^1/, "").slice(0, 10);
    if (digits.length === 0) return "+1 ";
    if (digits.length <= 3) return `+1 (${digits}`;
    if (digits.length <= 6) return `+1 (${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  async function fetchAll() {
    await Promise.all([
      fetchRides(),
      fetchStats(),
      fetchDrivers(),
      fetchInvites(),
      fetchReviewsBadge(),
      fetchReportsBadge(),
      fetchDiscountCodes(),
      fetchVehicleClasses(),
      fetchCompanyPricing(),
    ]);
    setLoading(false);
  }

  async function fetchCompanyPricing() {
    if (!profile?.company_id) return;
    const { data } = await supabase
      .from("companies")
      .select("base_fare, rate_per_km")
      .eq("id", profile.company_id)
      .maybeSingle();
    setCompanyBaseFare(data?.base_fare ?? 4);
    setCompanyRatePerKm(data?.rate_per_km ?? 1.8);
  }

  async function fetchDiscountCodes() {
    if (!profile?.company_id) return;
    const { data } = await supabase
      .from("discount_codes")
      .select("id, code, label, amount_type, amount, starts_at, ends_at, active")
      .eq("company_id", profile.company_id)
      .eq("active", true)
      .order("code", { ascending: true });
    setDiscountCodes(data ?? []);
  }

  async function fetchVehicleClasses() {
    if (!profile?.company_id) return;
    const { data } = await supabase
      .from("vehicle_classes")
      .select("id, name, capacity, surcharge_percent, is_active, display_order")
      .eq("company_id", profile.company_id)
      .eq("is_active", true)
      .order("display_order", { ascending: true });
    setVehicleClasses(data ?? []);
  }

  async function fetchStats() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data } = await supabase
      .from("rides")
      .select("status, fare_final, fare_estimate, created_at")
      .eq("company_id", profile.company_id)
      .gte("created_at", monthStart);
    if (!data) return;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const fare = (r: any) => r.fare_final ?? r.fare_estimate ?? 0;
    const sum = (arr: any[]) => arr.reduce((s, r) => s + fare(r), 0);
    const completedToday = data.filter((r) => r.status === "completed" && new Date(r.created_at) >= todayStart);
    const completedWeek = data.filter((r) => r.status === "completed" && new Date(r.created_at) >= weekStart);
    const completedMonth = data.filter((r) => r.status === "completed");
    const total = data.filter((r) => ["completed", "cancelled"].includes(r.status));
    const cancelled = data.filter((r) => r.status === "cancelled");
    setStats((prev) => ({
      ...prev,
      completedToday: completedToday.length,
      revenueToday: sum(completedToday),
      revenueWeek: sum(completedWeek),
      revenueMonth: sum(completedMonth),
      avgFare: completedMonth.length ? sum(completedMonth) / completedMonth.length : 0,
      cancelRate: total.length ? (cancelled.length / total.length) * 100 : 0,
    }));
  }

  async function batchProfiles(
    ids: string[],
  ): Promise<
    Map<string, { name: string; phone: string; avatar_url: string | null }>
  > {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data } = await supabase
      .from("profiles")
      .select("id, name, phone, avatar_url")
      .in("id", unique);
    const map = new Map<
      string,
      { name: string; phone: string; avatar_url: string | null }
    >();
    data?.forEach((p: any) =>
      map.set(p.id, {
        name: p.name ?? "—",
        phone: p.phone ?? "",
        avatar_url: p.avatar_url ?? null,
      }),
    );
    return map;
  }

  async function fetchRides() {
    const { data } = await supabase
      .from("rides")
      .select("*")
      .eq("company_id", profile.company_id)
      .order("created_at", { ascending: false })
      .limit(150);
    if (!data) return;
    const passengerIds = data.map((r: any) => r.passenger_id).filter(Boolean);
    const driverIds = data.map((r: any) => r.driver_id).filter(Boolean);
    const profileMap = await batchProfiles([...passengerIds, ...driverIds]);
    const enriched = data.map((ride: any) => ({
      ...ride,
      passenger: profileMap.get(ride.passenger_id) ?? null,
      driver: ride.driver_id
        ? { profile: profileMap.get(ride.driver_id) ?? null }
        : null,
    }));
    setRides(enriched);
    updateMapMarkers(enriched);
    computeStats(enriched);
  }

  async function fetchDrivers() {
    const { data } = await supabase
      .from("drivers")
      .select("*")
      .order("is_active", { ascending: false });
    if (!data) return;
    const driverIds = data.map((d: any) => d.id);
    const [profileMap, classesRes] = await Promise.all([
      batchProfiles(driverIds),
      profile?.company_id
        ? supabase.from("vehicle_classes").select("id, name").eq("company_id", profile.company_id)
        : Promise.resolve({ data: [] }),
    ]);
    const classNameMap = new Map<string, string>(
      ((classesRes as any).data ?? []).map((c: any) => [c.id, c.name])
    );

    // Fetch account-status fields separately so a schema-cache miss on new columns
    // can't break the name/phone/avatar lookups in batchProfiles.
    const { data: statusRows, error: statusError } = await supabase
      .from("profiles")
      .select("id, is_active, deactivation_pending, deleted_at")
      .in("id", driverIds);
    if (statusError) console.error("[fetchDrivers] status query failed:", statusError);
    const statusMap = new Map<string, { is_active: boolean; deactivation_pending: boolean; deleted_at: string | null }>();
    statusRows?.forEach((p: any) =>
      statusMap.set(p.id, {
        is_active: p.is_active ?? true,
        deactivation_pending: p.deactivation_pending ?? false,
        deleted_at: p.deleted_at ?? null,
      }),
    );

    const enriched = data.map((d: any) => ({
      ...d,
      vehicle_class_name: d.vehicle_class_id ? (classNameMap.get(d.vehicle_class_id) ?? null) : null,
      profile: profileMap.get(d.id)
        ? { ...profileMap.get(d.id), ...(statusMap.get(d.id) ?? { is_active: true, deactivation_pending: false, deleted_at: null }) }
        : null,
    }));

    // If the status query failed entirely, preserve whatever is_active state
    // is already in local state rather than overwriting with the true fallback.
    const statusQueryFailed = !!statusError || statusMap.size === 0;

    setDrivers((prevDrivers: any[]) => {
      if (!statusQueryFailed) return enriched;
      const prevMap = new Map(prevDrivers.map((d: any) => [d.id, d]));
      return enriched.map((d: any) => {
        const prev = prevMap.get(d.id);
        if (prev?.profile && d.profile) {
          return { ...d, profile: { ...d.profile, is_active: prev.profile.is_active ?? true, deactivation_pending: prev.profile.deactivation_pending ?? false, deleted_at: prev.profile.deleted_at ?? null } };
        }
        return d;
      });
    });
    setStats((s) => ({
      ...s,
      driversOnline: enriched.filter((d: any) => d.is_active).length,
    }));
    setSelectedDriver((prev: any) => {
      if (!prev) return null;
      const next = enriched.find((d: any) => d.id === prev.id);
      if (!next) return prev;
      // If status query failed, preserve the optimistic is_active we already have
      if (statusQueryFailed && next.profile && prev.profile) {
        return { ...next, profile: { ...next.profile, is_active: prev.profile.is_active ?? true, deactivation_pending: prev.profile.deactivation_pending ?? false } };
      }
      return next;
    });
    latestDriversForMapRef.current = enriched;
    renderDriverMarkers(enriched);
  }

  // --- Driver car icons ----------------------------------------------------
  // Cars are drawn as an SVG puck (data-URI icon rather than a Symbol path so
  // the ring/shadow/glyph can each carry their own colour). Green = free,
  // amber = on a live ride; deliberately outside the pickup-blue/dropoff-orange
  // ride-endpoint palette so a car never reads as a ride marker.
  const DRIVER_COLOR_FREE = "#1D9E75";
  const DRIVER_COLOR_BUSY = "#F59E0B";

  // Material "directions_car", 24x24 viewBox — centred by the wrapping
  // transform below.
  const CAR_GLYPH_PATH =
    "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z";

  function buildCarIcon(
    color: string,
    bearing: number | null,
    focused: boolean,
  ): google.maps.Icon {
    const size = focused ? 52 : 42;
    const cacheKey = `${color}|${bearing ?? "x"}|${size}`;
    const hit = driverIconCacheRef.current.get(cacheKey);
    if (hit) return hit;

    // Heading wedge rides on the outside of the ring; omitted entirely until
    // the driver has moved far enough for a bearing to mean anything.
    const pointer =
      bearing == null
        ? ""
        : `<g transform="rotate(${bearing} 24 24)"><path d="M24 1.2 L29 8.8 L19 8.8 Z" fill="#fff"/></g>`;

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">` +
      `<defs><filter id="ds" x="-50%" y="-50%" width="200%" height="200%">` +
      `<feDropShadow dx="0" dy="1.5" stdDeviation="1.7" flood-color="#000" flood-opacity="0.45"/>` +
      `</filter></defs>` +
      `<g filter="url(#ds)">` +
      pointer +
      `<circle cx="24" cy="24" r="12.6" fill="${color}" stroke="#fff" stroke-width="2.4"/>` +
      `</g>` +
      `<g transform="translate(24 24) scale(0.74) translate(-12 -12)" fill="#fff">` +
      `<path d="${CAR_GLYPH_PATH}"/>` +
      `</g>` +
      `</svg>`;

    const icon: google.maps.Icon = {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(size / 2, size / 2),
    };
    driverIconCacheRef.current.set(cacheKey, icon);
    return icon;
  }

  // Repaint one car if (and only if) its colour/heading/focus actually changed.
  function applyDriverIcon(key: string) {
    const m = markersRef.current.get(key);
    if (!m) return;
    const id = key.slice("driver-".length);
    const busy = busyDriverIdsRef.current.has(id);
    const focused = focusedDriverIdRef.current === id;
    const bearing = driverAnimRef.current.get(key)?.bearing ?? null;
    const sig = `${busy}|${focused}|${bearing ?? "x"}`;
    if (driverIconSigRef.current.get(key) === sig) return;
    driverIconSigRef.current.set(key, sig);
    m.setIcon(
      buildCarIcon(busy ? DRIVER_COLOR_BUSY : DRIVER_COLOR_FREE, bearing, focused),
    );
    m.setZIndex(focused ? 300 : busy ? 200 : 100);
  }

  function refreshDriverIcons() {
    markersRef.current.forEach((_m, k) => {
      if (k.startsWith("driver-")) applyDriverIcon(k);
    });
  }

  function renderDriverMarkers(enriched: any[]) {
    if (!googleMapRef.current) return;
    const focus = focusedDriverIdRef.current;
    enriched
      .filter((d: any) => d.is_active && d.current_lat && d.current_lng)
      .forEach((d: any) => {
        const key = `driver-${d.id}`;
        const pos = { lat: d.current_lat!, lng: d.current_lng! };
        if (!markersRef.current.has(key)) {
          const m = new google.maps.Marker({
            position: pos,
            // Don't flash a car onto the map if a different driver is focused.
            map: !focus || focus === d.id ? googleMapRef.current! : null,
            title: d.profile?.name ?? "Driver",
            // Recolouring/rotating icons repaint poorly in the shared optimized
            // canvas; each car gets its own element instead.
            optimized: false,
          });
          markersRef.current.set(key, m);
        }
        animateDriverTo(key, pos);
        applyDriverIcon(key);
      });
    applyDriverVisibility();
  }

  // Single place that decides which driver cars are on the map: drops markers
  // for drivers who went offline/lost their fix, and hides everyone but the
  // focused driver while an active ride is open.
  function applyDriverVisibility() {
    const focus = focusedDriverIdRef.current;
    const live = new Set(
      (latestDriversForMapRef.current ?? [])
        .filter((d: any) => d.is_active && d.current_lat && d.current_lng)
        .map((d: any) => `driver-${d.id}`),
    );
    markersRef.current.forEach((m, k) => {
      if (!k.startsWith("driver-")) return;
      if (!live.has(k)) {
        m.setMap(null);
        markersRef.current.delete(k);
        driverAnimRef.current.delete(k);
        driverIconSigRef.current.delete(k);
        return;
      }
      const visible = !focus || k === `driver-${focus}`;
      m.setMap(visible ? googleMapRef.current : null);
      applyDriverIcon(k);
    });
  }

  async function fetchInvites() {
    const { data: pending } = await supabase
      .from("driver_invites")
      .select("*")
      .eq("used", false)
      .eq("company_id", profile.company_id)
      .order("created_at", { ascending: false });
    if (pending) setPendingInvites(pending);
  }

  async function fetchReviewsBadge() {
    const { data } = await supabase
      .from("ride_reviews")
      .select("id")
      .lte("rating", 2)
      .eq("reviewed_by_dispatch", false);
    setFlaggedReviews(data?.length ?? 0);
  }

  async function fetchReportsBadge() {
    const { data } = await supabase
      .from("driver_reports")
      .select("id")
      .eq("status", "open");
    setOpenReports(data?.length ?? 0);
  }

  function computeStats(rideData: Ride[]) {
    const active = rideData.filter((r) =>
      ["pending", "offered", "assigned", "driver_arriving", "in_progress"].includes(r.status),
    );
    setStats((prev) => ({ ...prev, activeRides: active.length }));
  }

  // --- Smooth driver-marker gliding (rAF lerp) -----------------------------
  const ANIM_MIN_MS = 1500;
  const ANIM_MAX_MS = 12000;
  const ANIM_SNAP_M = 1000; // teleport / GPS spike → snap, don't glide across it
  const BEARING_MIN_M = 12; // below this a "move" is just GPS jitter

  function metersBetween(
    a: google.maps.LatLngLiteral,
    b: google.maps.LatLngLiteral,
  ): number {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
    const x = dLng * Math.cos(lat);
    return Math.sqrt(dLat * dLat + x * x) * R;
  }

  // Compass bearing a→b, bucketed to 15° so a turning car doesn't churn
  // through icon swaps (each one is a real DOM image change).
  function bearingBetween(
    a: google.maps.LatLngLiteral,
    b: google.maps.LatLngLiteral,
  ): number {
    const rad = Math.PI / 180;
    const p1 = a.lat * rad;
    const p2 = b.lat * rad;
    const dl = (b.lng - a.lng) * rad;
    const y = Math.sin(dl) * Math.cos(p2);
    const x =
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    const deg = (Math.atan2(y, x) / rad + 360) % 360;
    return (Math.round(deg / 15) * 15) % 360;
  }

  function tickDriverAnims() {
    const now = performance.now();
    let active = false;
    driverAnimRef.current.forEach((a, key) => {
      const marker = markersRef.current.get(key);
      if (!marker) return;
      const t = a.dur <= 0 ? 1 : Math.min(1, (now - a.startT) / a.dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      a.render = {
        lat: a.from.lat + (a.to.lat - a.from.lat) * e,
        lng: a.from.lng + (a.to.lng - a.from.lng) * e,
      };
      marker.setPosition(a.render);
      if (t < 1) active = true;
    });
    driverRafRef.current = active
      ? requestAnimationFrame(tickDriverAnims)
      : null;
  }

  // Move a driver marker to `pos`, gliding from its current on-screen position.
  function animateDriverTo(key: string, pos: google.maps.LatLngLiteral) {
    const now = performance.now();
    const a = driverAnimRef.current.get(key);
    if (!a) {
      driverAnimRef.current.set(key, {
        from: pos,
        to: pos,
        render: pos,
        startT: now,
        dur: 0,
        lastT: now,
        bearing: null,
      });
      return;
    }
    // A parked car's GPS wanders a few metres every tick — only re-aim the
    // heading wedge on real movement, and keep the last heading otherwise
    // (including across a snap, where the direction is meaningless).
    const moved = metersBetween(a.to, pos);
    if (moved > BEARING_MIN_M && moved < ANIM_SNAP_M) {
      a.bearing = bearingBetween(a.to, pos);
    }
    if (metersBetween(a.render, pos) > ANIM_SNAP_M) {
      a.from = pos;
      a.to = pos;
      a.render = pos;
      a.startT = now;
      a.dur = 0;
    } else {
      a.from = { ...a.render }; // restart from where it visibly is right now
      a.to = pos;
      a.startT = now;
      a.dur = Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, now - a.lastT));
    }
    a.lastT = now;
    applyDriverIcon(key);
    if (driverRafRef.current == null) {
      driverRafRef.current = requestAnimationFrame(tickDriverAnims);
    }
  }

  function updateMapMarkers(rideData: Ride[]) {
    // Computed above the map guard: rides commonly load before the map does,
    // and the map-init flush of renderDriverMarkers needs this to already be
    // right or every car paints green until the next rides tick.
    busyDriverIdsRef.current = new Set(
      rideData
        .filter(
          (r) =>
            r.driver_id &&
            ["assigned", "driver_arriving", "in_progress"].includes(r.status),
        )
        .map((r) => r.driver_id as string),
    );
    if (!googleMapRef.current) return;
    refreshDriverIcons();
    markersRef.current.forEach((m, k) => {
      if (!k.startsWith("driver-")) {
        m.setMap(null);
        markersRef.current.delete(k);
      }
    });
    rideData
      .filter((r) =>
        [
          "pending",
          "offered",
          "assigned",
          "driver_arriving",
          "in_progress",
        ].includes(r.status),
      )
      .forEach((ride) => {
        const mk1 = new google.maps.Marker({
          position: { lat: ride.pickup_lat, lng: ride.pickup_lng },
          map: googleMapRef.current!,
          title: `Pickup: ${ride.pickup_address}`,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: "#4a9eff",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 1.5,
          },
        });
        const mk2 = new google.maps.Marker({
          position: { lat: ride.dropoff_lat, lng: ride.dropoff_lng },
          map: googleMapRef.current!,
          title: `Dropoff: ${ride.dropoff_address}`,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 7,
            fillColor: "#E8500A",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 1.5,
          },
        });
        markersRef.current.set(`pickup-${ride.id}`, mk1);
        markersRef.current.set(`dropoff-${ride.id}`, mk2);
      });
  }

  function clearRouteOverlay() {
    if (routePolylineRef.current) {
      routePolylineRef.current.setMap(null);
      routePolylineRef.current = null;
    }
  }

  function drawRouteOverlay(path: google.maps.LatLng[] | google.maps.LatLngLiteral[]) {
    if (!googleMapRef.current) return;
    clearRouteOverlay();
    routePolylineRef.current = new google.maps.Polyline({
      path,
      map: googleMapRef.current,
      strokeColor: "#E8500A",
      strokeOpacity: 0.9,
      strokeWeight: 4,
    });
  }

  function copyPhone(phone: string) {
    navigator.clipboard?.writeText(phone).then(() => {
      setCopiedPhone(phone);
      setTimeout(
        () => setCopiedPhone((p) => (p === phone ? null : p)),
        1500,
      );
    });
  }

  function focusRideOnMap(ride: Ride) {
    if (!googleMapRef.current) return;
    setSelectedRide(ride.id);
    setRideDetail(ride);

    const map = googleMapRef.current;
    const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
    const dropoff = { lat: ride.dropoff_lat, lng: ride.dropoff_lng };
    // Live driver position (if this ride has an assigned, located driver).
    const drv = ride.driver_id
      ? drivers.find((d) => d.id === ride.driver_id)
      : null;
    const driverPos =
      drv && (drv as any).current_lat && (drv as any).current_lng
        ? { lat: (drv as any).current_lat, lng: (drv as any).current_lng }
        : null;

    // Phase-aware geometry: for a ride in progress the pickup is history — the
    // relevant leg is the car's live position → drop-off. Before pickup, show
    // driver → pickup → drop-off (or just pickup → drop-off if no driver yet).
    const inProgress = ride.status === "in_progress";
    const origin = driverPos ?? pickup;
    const dest = dropoff;
    // Waypoints for the new Routes API: driver → pickup → drop-off before pickup.
    const intermediates = !inProgress && driverPos ? [pickup] : [];

    // Frame the relevant points.
    const bounds = new google.maps.LatLngBounds();
    bounds.extend(origin);
    bounds.extend(dest);
    if (!inProgress) bounds.extend(pickup);
    if (driverPos) bounds.extend(driverPos);
    map.fitBounds(bounds, 80);

    // Road-snapped snapshot via the Routes API (computeRoutes); straight-line
    // fallback if the key isn't authorized for Routes or the request fails.
    const fallbackPath = inProgress
      ? [origin, dest]
      : driverPos
        ? [origin, pickup, dest]
        : [pickup, dest];
    void computeRouteSnapshot(origin, dest, intermediates, fallbackPath);
  }

  async function computeRouteSnapshot(
    origin: google.maps.LatLngLiteral,
    destination: google.maps.LatLngLiteral,
    intermediates: google.maps.LatLngLiteral[],
    fallbackPath: google.maps.LatLngLiteral[],
  ) {
    try {
      const { Route } = (await google.maps.importLibrary("routes")) as any;
      const { routes } = await Route.computeRoutes({
        origin,
        destination,
        intermediates,
        travelMode: "DRIVING",
        fields: ["path"],
      });
      const path = routes?.[0]?.path;
      if (Array.isArray(path) && path.length > 0) {
        drawRouteOverlay(path.map((p: any) => ({ lat: p.lat, lng: p.lng })));
      } else {
        drawRouteOverlay(fallbackPath);
      }
    } catch (e) {
      // A REQUEST_DENIED here means the dashboard's Maps key isn't authorized
      // for the Routes API — enable "Routes API" and add it to the key.
      console.warn("[route] Routes API failed; drawing straight line", e);
      drawRouteOverlay(fallbackPath);
    }
  }

  // The route overlay only belongs to an open *active*-ride detail. Drop it when
  // the panel closes or switches to a Recent (completed/cancelled) ride.
  useEffect(() => {
    const active =
      rideDetail &&
      ["pending", "offered", "assigned", "driver_arriving", "in_progress"].includes(
        rideDetail.status,
      );
    if (!active) {
      clearRouteOverlay();
      if (!rideDetail) setSelectedRide(null);
    }
    // Solo the assigned driver while an active ride is open. A ride with no
    // driver yet keeps every car visible — dispatch is about to pick one.
    focusedDriverIdRef.current = active ? (rideDetail!.driver_id ?? null) : null;
    applyDriverVisibility();
  }, [rideDetail]);

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteName.trim() || !invitePhone.trim()) return;
    setInviteLoading(true);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const e164Phone = "+1" + invitePhone.replace(/\D/g, "");
    const { error } = await supabase.from("driver_invites").insert({
      name: inviteName.trim(),
      phone: e164Phone,
      code,
      used: false,
      created_by: profile.id,
      company_id: profile.company_id,
    });
    setInviteLoading(false);
    if (error) {
      alert(error.message);
      return;
    }
    setInviteSuccess(code);
    setInviteName("");
    setInvitePhone("");
    fetchInvites();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "invite.created",
      details: { code, name: inviteName.trim(), phone: e164Phone },
    });
  }

  async function revokeInvite(id: string) {
    const invite = pendingInvites.find((i) => i.id === id);
    await supabase.from("driver_invites").delete().eq("id", id);
    fetchInvites();
    if (invite) {
      logDispatchEvent({
        companyId: profile.company_id!,
        dispatcherId: profile.id,
        eventType: "invite.revoked",
        details: { code: invite.code, name: invite.name, phone: invite.phone },
      });
    }
  }

  useEffect(() => {
    if (!bookingOpen) return;
    const tryInit = () => {
      if (!(window as any).google?.maps?.places) {
        setTimeout(tryInit, 150);
        return;
      }
      const valleyBounds = new google.maps.LatLngBounds(
        new google.maps.LatLng(44.7, -65.2),
        new google.maps.LatLng(45.4, -63.8),
      );
      const opts = {
        bounds: valleyBounds,
        componentRestrictions: { country: "ca" },
        fields: ["formatted_address", "geometry"],
      };
      if (pickupInputRef.current && !pickupAutocompleteRef.current) {
        pickupAutocompleteRef.current = new google.maps.places.Autocomplete(
          pickupInputRef.current,
          opts,
        );
        pickupAutocompleteRef.current.addListener("place_changed", () => {
          const place = pickupAutocompleteRef.current.getPlace();
          if (place?.geometry?.location) {
            setBookPickup(place.formatted_address ?? "");
            setBookPickupCoords({
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
            });
          }
        });
      }
      if (dropoffInputRef.current && !dropoffAutocompleteRef.current) {
        dropoffAutocompleteRef.current = new google.maps.places.Autocomplete(
          dropoffInputRef.current,
          opts,
        );
        dropoffAutocompleteRef.current.addListener("place_changed", () => {
          const place = dropoffAutocompleteRef.current.getPlace();
          if (place?.geometry?.location) {
            setBookDropoff(place.formatted_address ?? "");
            setBookDropoffCoords({
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
            });
          }
        });
      }
    };
    setTimeout(tryInit, 100);
    return () => {
      pickupAutocompleteRef.current = null;
      dropoffAutocompleteRef.current = null;
    };
  }, [bookingOpen]);

  useEffect(() => {
    if (!editingRide) return;
    const tryInit = () => {
      if (!(window as any).google?.maps?.places) {
        setTimeout(tryInit, 150);
        return;
      }
      const valleyBounds = new google.maps.LatLngBounds(
        new google.maps.LatLng(44.7, -65.2),
        new google.maps.LatLng(45.4, -63.8),
      );
      const opts = {
        bounds: valleyBounds,
        componentRestrictions: { country: "ca" },
        fields: ["formatted_address", "geometry"],
      };
      if (editPickupInputRef.current && !editPickupAutocompleteRef.current) {
        editPickupAutocompleteRef.current = new google.maps.places.Autocomplete(
          editPickupInputRef.current,
          opts,
        );
        editPickupAutocompleteRef.current.addListener("place_changed", () => {
          const place = editPickupAutocompleteRef.current.getPlace();
          if (place?.geometry?.location) {
            setEditPickup(place.formatted_address ?? "");
            setEditPickupCoords({
              lat: place.geometry.location.lat(),
              lng: place.geometry.location.lng(),
            });
            setEditAddressChanged(true);
          }
        });
      }
      if (editDropoffInputRef.current && !editDropoffAutocompleteRef.current) {
        editDropoffAutocompleteRef.current = new google.maps.places.Autocomplete(
          editDropoffInputRef.current,
          opts,
        );
        editDropoffAutocompleteRef.current.addListener(
          "place_changed",
          () => {
            const place = editDropoffAutocompleteRef.current.getPlace();
            if (place?.geometry?.location) {
              setEditDropoff(place.formatted_address ?? "");
              setEditDropoffCoords({
                lat: place.geometry.location.lat(),
                lng: place.geometry.location.lng(),
              });
              setEditAddressChanged(true);
            }
          },
        );
      }
    };
    setTimeout(tryInit, 100);
    return () => {
      editPickupAutocompleteRef.current = null;
      editDropoffAutocompleteRef.current = null;
    };
  }, [editingRide]);

  useEffect(() => {
    if (!bookPickupCoords || !bookDropoffCoords) return;
    if (!(window as any).google?.maps) return;
    setBookFareLoading(true);
    setBookFareError(false);
    const service = new google.maps.DistanceMatrixService();
    service.getDistanceMatrix(
      {
        origins: [
          new google.maps.LatLng(bookPickupCoords.lat, bookPickupCoords.lng),
        ],
        destinations: [
          new google.maps.LatLng(bookDropoffCoords.lat, bookDropoffCoords.lng),
        ],
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (response, status) => {
        setBookFareLoading(false);
        const element = response?.rows[0]?.elements[0];
        if (status === "OK" && element?.status === "OK" && element.distance?.value) {
          setBookDistanceMetres(element.distance.value);
        } else {
          setBookFareError(true);
          setBookDistanceMetres(null);
        }
      },
    );
  }, [bookPickupCoords, bookDropoffCoords]);

  useEffect(() => {
    // Manual bookings are always cash; round up to the nearest dollar so the
    // displayed estimate matches the fare that gets saved. Re-runs whenever
    // the distance or the selected vehicle class (and its surcharge) changes.
    if (bookDistanceMetres == null) return;
    setBookBaseFare(
      fareForDistance(
        bookDistanceMetres,
        surchargeFor(bookVehicleClassId),
        "cash",
        companyBaseFare ?? 4,
        companyRatePerKm ?? 1.8,
      ),
    );
  }, [bookDistanceMetres, bookVehicleClassId, companyBaseFare, companyRatePerKm]);

  useEffect(() => {
    // Layers the selected discount code on top of the base fare so picking
    // one from the dropdown updates the estimate immediately, without
    // waiting for compute_discount_for_booking (still the source of truth
    // — re-validated, including student discount, at submit time).
    if (bookBaseFare == null) return;
    const code = discountCodes.find((c) => c.code === bookDiscountCode);
    setBookFare(applyDiscountPreview(bookBaseFare, code).toFixed(2));
  }, [bookBaseFare, bookDiscountCode, discountCodes]);

  useEffect(() => {
    // Fetches the distance for the current pickup/dropoff unconditionally
    // (including on initial edit-form load) so it's cached and ready for
    // the recalculation effect below — without needing to re-fetch it
    // separately just because the vehicle class changed.
    if (!editPickupCoords || !editDropoffCoords) return;
    if (!(window as any).google?.maps) return;
    setEditFareLoading(true);
    const service = new google.maps.DistanceMatrixService();
    service.getDistanceMatrix(
      {
        origins: [
          new google.maps.LatLng(editPickupCoords.lat, editPickupCoords.lng),
        ],
        destinations: [
          new google.maps.LatLng(
            editDropoffCoords.lat,
            editDropoffCoords.lng,
          ),
        ],
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (response, status) => {
        setEditFareLoading(false);
        const element = response?.rows[0]?.elements[0];
        setEditDistanceMetres(
          status === "OK" && element?.status === "OK" && element.distance?.value
            ? element.distance.value
            : null,
        );
      },
    );
  }, [editPickupCoords, editDropoffCoords]);

  useEffect(() => {
    // Recalculates the fare when the dispatcher changed the pickup/dropoff,
    // or explicitly picked a different vehicle class — but not on the
    // initial values populated from the ride when the edit form opens,
    // which would otherwise silently overwrite a manually-set fare.
    if (editDistanceMetres == null) return;
    if (!editAddressChanged && !editVehicleClassTouched) return;
    setEditFare(
      fareForDistance(
        editDistanceMetres,
        surchargeFor(editVehicleClassId),
        editPayment,
        companyBaseFare ?? 4,
        companyRatePerKm ?? 1.8,
      ).toFixed(2),
    );
    // This just overwrote whatever was in the box, so it is a preview again —
    // not a dispatcher's chosen price.
    setEditFareTouched(false);
  }, [editDistanceMetres, editAddressChanged, editVehicleClassTouched, editVehicleClassId, editPayment, companyBaseFare, companyRatePerKm]);

  async function createManualBooking(e: React.FormEvent) {
    e.preventDefault();
    if (!bookPickupCoords) {
      setBookError("Please select a pickup address from the dropdown.");
      return;
    }
    if (!bookDropoffCoords) {
      setBookError("Please select a drop-off address from the dropdown.");
      return;
    }
    setBookLoading(true);
    setBookError(null);
    try {
      const phone = toE164(bookPassenger);
      let { data: passengerProfile } = await supabase
        .from("profiles")
        .select("id, name")
        .eq("phone", phone)
        .maybeSingle();
      if (!passengerProfile) {
        const currentSession = (await supabase.auth.getSession()).data.session;
        const savedAccessToken = currentSession?.access_token;
        const savedRefreshToken = currentSession?.refresh_token;
        if (!savedAccessToken || !savedRefreshToken) {
          setBookError(
            "Session error — please refresh the page and try again.",
          );
          setBookLoading(false);
          return;
        }
        const { data: anonData, error: anonError } =
          await supabase.auth.signInAnonymously();
        if (anonError || !anonData.user) {
          await supabase.auth.setSession({
            access_token: savedAccessToken,
            refresh_token: savedRefreshToken,
          });
          setBookError(
            `Could not create guest account: ${anonError?.message ?? "unknown error"}`,
          );
          setBookLoading(false);
          return;
        }
        const guestId = anonData.user.id;
        const { data: newProfile, error: insertError } = await supabase
          .from("profiles")
          .upsert(
            {
              id: guestId,
              phone,
              name: bookPassengerName.trim() || "Guest",
              role: "passenger",
            },
            { onConflict: "id" },
          )
          .select("id, name")
          .single();
        const { error: restoreError } =
          await supabase.auth.setSession({
            access_token: savedAccessToken,
            refresh_token: savedRefreshToken,
          });
        if (restoreError) {
          setBookError(
            "Session error restoring dispatcher — please refresh and try again.",
          );
          setBookLoading(false);
          return;
        }
        if (insertError || !newProfile) {
          setBookError(
            `Could not create guest profile: ${insertError?.message ?? "unknown error"} (code: ${insertError?.code})`,
          );
          setBookLoading(false);
          return;
        }
        passengerProfile = newProfile;
      }
      const baseFare = parseFloat(bookFare) || null;
      let finalFare = baseFare;
      let preDiscountFare: number | null = null;
      let discountAmount: number | null = null;
      let discountType: string | null = null;
      let discountCodeId: string | null = null;

      if (baseFare != null && baseFare > 0) {
        const { data: discountRaw, error: discountError } = await supabase
          .rpc("compute_discount_for_booking", {
            p_user_id: passengerProfile.id,
            p_company_id: profile.company_id,
            p_fare: baseFare,
            p_code: bookDiscountCode.trim() || null,
          })
          .maybeSingle();
        const discount = discountRaw as {
          discounted_fare: number;
          discount_amount: number;
          discount_type: string | null;
          code_id: string | null;
          code_status: string;
        } | null;

        if (bookDiscountCode.trim() && discount?.code_status && discount.code_status !== "ok") {
          const messages: Record<string, string> = {
            not_found: "Discount code not found.",
            inactive: "This discount code is no longer active.",
            not_started: "This discount code isn't active yet.",
            expired: "This discount code has expired.",
            maxed: "This discount code has reached its usage limit.",
            already_used: "This passenger has already used this code.",
          };
          setBookError(
            messages[discount.code_status] ?? "Couldn't apply that discount code.",
          );
          setBookLoading(false);
          return;
        }

        if (!discountError && discount) {
          finalFare = discount.discounted_fare ?? baseFare;
          discountAmount = discount.discount_amount ?? 0;
          discountType = discount.discount_type ?? null;
          discountCodeId = discount.code_id ?? null;
          preDiscountFare = (discountAmount ?? 0) > 0 ? baseFare : null;
        }
      }

      // Manual bookings are always cash; round up to the nearest dollar so
      // the fare doesn't require exact change.
      if (finalFare != null) {
        finalFare = Math.ceil(finalFare);
      }

      const rideData: any = {
        passenger_id: passengerProfile.id,
        company_id: profile.company_id,
        status: "pending",
        pickup_address: bookPickup.trim(),
        pickup_lat: bookPickupCoords.lat,
        pickup_lng: bookPickupCoords.lng,
        dropoff_address: bookDropoff.trim(),
        dropoff_lat: bookDropoffCoords.lat,
        dropoff_lng: bookDropoffCoords.lng,
        fare_estimate: finalFare,
        pre_discount_fare: preDiscountFare,
        discount_amount: discountAmount,
        discount_type: discountType,
        discount_code_id: discountCodeId,
        payment_method: "cash",
        vehicle_class_id: bookVehicleClassId || null,
      };
      if (bookScheduled) {
        rideData.status = "scheduled";
        rideData.scheduled_at = new Date(bookScheduled).toISOString();
      }
      if (bookDriver) {
        rideData.driver_id = bookDriver;
        rideData.status = bookScheduled ? "scheduled" : "offered";
      } else if (bookScheduled && bookPreferredDriver) {
        // No immediate driver assignment — just bias the automatic release
        // pipeline toward this driver. Ride stays 'scheduled', untouched,
        // until scheduled-release picks it up on its own.
        rideData.preferred_driver_id = bookPreferredDriver;
        rideData.preferred_driver_exclusive = bookPreferredExclusive;
      }
      const { error } = await supabase.from("rides").insert(rideData);
      if (error) {
        setBookError(error.message);
        setBookLoading(false);
        return;
      }
      logDispatchEvent({
        companyId: profile.company_id!,
        dispatcherId: profile.id,
        eventType: "ride.created",
        details: {
          passenger_name: passengerProfile.name,
          pickup_address: bookPickup,
          dropoff_address: bookDropoff,
          fare: finalFare,
          scheduled: !!bookScheduled,
          driver_id: bookDriver || null,
        },
      });
      setBookingOpen(false);
      setBookPassenger("+1 ");
      setBookPassengerName("");
      setBookPickup("");
      setBookPickupCoords(null);
      setBookDropoff("");
      setBookDropoffCoords(null);
      setBookFare("");
      setBookFareError(false);
      setBookPassengerRegistered(false);
      setBookDiscountCode("");
      setBookVehicleClassId("");
      setBookDistanceMetres(null);
      setBookBaseFare(null);
      setBookDriver("");
      setBookScheduled("");
      setBookPreferredDriver("");
      setBookPreferredExclusive(false);
      fetchRides();
    } catch (e: any) {
      setBookError(e.message);
    } finally {
      setBookLoading(false);
    }
  }

  async function assignDriver(rideId: string, driverId: string) {
    const ride = rides.find((r) => r.id === rideId);
    // (the scheduled-vs-immediate branch now lives in dispatch-assign-ride)
    const prevDriverId = ride?.driver_id ?? null;
    const prevDriver = prevDriverId ? drivers.find((d) => d.id === prevDriverId) : null;
    const newDriver = drivers.find((d) => d.id === driverId);
    // Server-side since 2026-08-15: a driver can soft-claim a scheduled ride
    // (preferred_driver_id + claimed_at, driver_id still null). A direct write
    // here set driver_id but left the claim behind, and scheduled-release would
    // then hand the ride back to the old claimant on its next tick, silently
    // undoing this assignment. dispatch-assign-ride clears the claim in the same
    // write and pushes the displaced driver.
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/dispatch-assign-ride`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ ride_id: rideId, driver_id: driverId }),
      },
    );
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: res.statusText }));
      alert(`Failed to assign driver: ${error}`);
      setAssigningRide(null);
      return;
    }
    setAssigningRide(null);
    fetchRides();
    if (prevDriverId) {
      logDispatchEvent({
        companyId: profile.company_id!,
        dispatcherId: profile.id,
        eventType: "ride.reassigned",
        rideId,
        details: {
          from_driver_name: prevDriver?.profile?.name ?? null,
          from_driver_id: prevDriverId,
          to_driver_name: newDriver?.profile?.name ?? null,
          to_driver_id: driverId,
        },
      });
    } else {
      logDispatchEvent({
        companyId: profile.company_id!,
        dispatcherId: profile.id,
        eventType: "ride.assigned",
        rideId,
        details: {
          driver_name: newDriver?.profile?.name ?? null,
          driver_id: driverId,
        },
      });
    }
  }

  async function cancelRide(rideId: string) {
    const ride = rides.find((r) => r.id === rideId);
    // settle-ride, not a direct .update(): a card ride carries a live Stripe
    // authorization, and a bare status write left the passenger's money held
    // until Stripe expired it ~7 days later.
    const { error } = await invokeFunction(
      "settle-ride",
      { ride_id: rideId, action: "cancel" },
      "Couldn't cancel this ride — the payment hold could not be released.",
    );
    if (error) {
      alert(error);
      return;
    }
    fetchRides();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "ride.cancelled",
      rideId,
      details: {
        passenger_name: (ride as any)?.passenger?.name ?? null,
        pickup_address: ride?.pickup_address ?? null,
        dropoff_address: ride?.dropoff_address ?? null,
        scheduled_at: (ride as any)?.scheduled_at ?? null,
      },
    });
  }

  // Resolving keeps the flag and stamps it, rather than clearing it: an
  // escalation that can be erased is one dispatch can lose track of mid-triage.
  async function resolveFlag(rideId: string) {
    const { error } = await supabase
      .from("rides")
      .update({ passenger_flag_resolved_at: new Date().toISOString() })
      .eq("id", rideId);
    if (error) { alert(error.message); return; }
    fetchRides();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "ride.flag_resolved",
      rideId,
    });
  }

  function startEditRide(ride: Ride) {
    setEditPickup(ride.pickup_address);
    setEditPickupCoords({ lat: ride.pickup_lat, lng: ride.pickup_lng });
    setEditDropoff(ride.dropoff_address);
    setEditDropoffCoords({ lat: ride.dropoff_lat, lng: ride.dropoff_lng });
    // Pre-discount, deliberately. The auto-recalc effect below writes a
    // pre-discount `fareForDistance` value into this same box, and edit-ride
    // treats `fare_override` as pre-discount and applies the discount itself.
    // Seeding it from the post-discount `fare_estimate` would make the field
    // mean two different things depending on whether an address was touched,
    // and would subtract the discount a second time on save.
    const prefillFare = ride.pre_discount_fare ?? ride.fare_estimate;
    setEditFare(prefillFare != null ? String(prefillFare) : "");
    setEditPayment(ride.payment_method);
    setEditVehicleClassId(ride.vehicle_class_id ?? "");
    setEditVehicleClassTouched(false);
    setEditDistanceMetres(null);
    setEditScheduled(
      ride.scheduled_at
        ? new Date(
            new Date(ride.scheduled_at).getTime() -
              new Date(ride.scheduled_at).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    );
    setEditAddressChanged(false);
    setEditFareTouched(false);
    setEditPreferredDriver(ride.preferred_driver_id ?? "");
    setEditPreferredExclusive(ride.preferred_driver_exclusive ?? false);
    setEditError(null);
    setEditingRide(true);
  }

  // Dispatch edits go through edit-ride, not a direct `.update()`.
  //
  // The direct write was legal — both freeze triggers exempt is_staff() — and
  // it did re-price client-side, so the fare was never stale. What it could not
  // do is move the Stripe authorization. capture-payment captures the
  // PaymentIntent's authorized amount and writes THAT back over the fare, so a
  // dispatcher changing a destination produced a charge and a receipt that
  // agreed with each other and disagreed with the ride. It also skipped the
  // soft-claim release, the notified_*/leave_by resets on a time change, and
  // the commitment guard.
  //
  // Only the preferred-driver fields still go direct: they aren't frozen, they
  // don't move money, and edit-ride has no opinion about them.
  async function saveRideEdits(rideId: string, confirmConflict = false) {
    const ride = rideDetail;
    if (!ride) return;

    // The address inputs null their coords on any keystroke, so text that
    // wasn't picked from the autocomplete leaves them null. Writing that would
    // send a new address string with stale coordinates — the exact fare/route
    // mismatch this whole path exists to prevent.
    if (!editPickupCoords || !editDropoffCoords) {
      setEditError(
        "Pick both addresses from the suggestions list so the fare can be recalculated.",
      );
      return;
    }

    const moved = (
      coords: { lat: number; lng: number },
      address: string,
      oldLat: number,
      oldLng: number,
      oldAddress: string,
    ) =>
      coords.lat !== oldLat ||
      coords.lng !== oldLng ||
      address.trim() !== (oldAddress ?? "").trim();

    const pickupMoved = moved(
      editPickupCoords, editPickup, ride.pickup_lat, ride.pickup_lng, ride.pickup_address,
    );
    const dropoffMoved = moved(
      editDropoffCoords, editDropoff, ride.dropoff_lat, ride.dropoff_lng, ride.dropoff_address,
    );

    const newScheduledISO = editScheduled
      ? new Date(editScheduled).toISOString()
      : null;
    const scheduledMoved =
      !!newScheduledISO &&
      !!ride.scheduled_at &&
      new Date(ride.scheduled_at).getTime() !== new Date(newScheduledISO).getTime();

    const classMoved = (editVehicleClassId || null) !== (ride.vehicle_class_id ?? null);

    const preferredEditable = ride.status === "scheduled" && !ride.driver_id;
    const preferredMoved =
      preferredEditable &&
      ((editPreferredDriver || null) !== (ride.preferred_driver_id ?? null) ||
        (editPreferredDriver ? editPreferredExclusive : false) !==
          (ride.preferred_driver_exclusive ?? false));

    // Only send a typed fare. An untouched box holds the client-side preview,
    // and forwarding that as an override would defeat the server pricing —
    // mid-ride especially, where the preview is a naive pickup -> dropoff
    // figure and the server charges driven + remaining.
    const fareOverride =
      editFareTouched && editFare !== "" ? parseFloat(editFare) : null;

    if (
      !pickupMoved && !dropoffMoved && !scheduledMoved &&
      !classMoved && !preferredMoved && fareOverride == null
    ) {
      setEditingRide(false);
      return;
    }

    setEditSaving(true);
    setEditError(null);

    if (pickupMoved || dropoffMoved || scheduledMoved || classMoved || fareOverride != null) {
      const body: Record<string, unknown> = { ride_id: rideId, action: "relocate" };
      if (pickupMoved)
        body.pickup = { ...editPickupCoords, address: editPickup.trim() };
      if (dropoffMoved)
        body.dropoff = { ...editDropoffCoords, address: editDropoff.trim() };
      if (scheduledMoved) body.scheduled_at = newScheduledISO;
      if (classMoved) body.vehicle_class_id = editVehicleClassId || null;
      if (fareOverride != null) body.fare_override = fareOverride;
      if (confirmConflict) body.confirm_conflict = true;

      const { data, error } = await invokeFunction(
        "edit-ride",
        body,
        "Couldn't save these changes.",
      );

      if (error) {
        setEditSaving(false);
        // A commitment clash is a warning for dispatch, not a refusal — they
        // are the escape hatch the passenger-facing version points at. Confirm
        // and re-send. (assignDriver / check-ride-conflicts behave the same.)
        if ((data as any)?.requires_confirmation) {
          const short = (data as any)?.conflict?.minutes_short;
          if (
            window.confirm(
              `${error}` +
                (short ? ` They'd be about ${Math.round(short)} min short.` : "") +
                "\n\nSave anyway?",
            )
          ) {
            saveRideEdits(rideId, true);
          }
          return;
        }
        setEditError(error);
        return;
      }

      // Report the change against the fare the ride actually HAD, not against
      // the box. The box holds a pre-discount preview and the server returns a
      // post-discount figure, so comparing those two would fire on almost every
      // edit and train dispatch to dismiss it.
      const serverFare = (data as any)?.fare_estimate;
      const previousFare = (data as any)?.previous_fare ?? ride.fare_estimate;
      if (
        serverFare != null &&
        previousFare != null &&
        Math.abs(Number(serverFare) - Number(previousFare)) >= 0.01
      ) {
        alert(
          `Fare changed from $${Number(previousFare).toFixed(2)} to ` +
            `$${Number(serverFare).toFixed(2)}.`,
        );
      }
    }

    if (preferredMoved) {
      // Not frozen and not money — a plain write is right here.
      const { error: prefError } = await supabase
        .from("rides")
        .update({
          preferred_driver_id: editPreferredDriver || null,
          preferred_driver_exclusive: editPreferredDriver ? editPreferredExclusive : false,
        })
        .eq("id", rideId);
      if (prefError) {
        setEditSaving(false);
        setEditError(prefError.message);
        return;
      }
      // edit-ride writes its own dispatch_events row for everything it handles,
      // so this is logged here only when the preference was the change.
      if (!pickupMoved && !dropoffMoved && !scheduledMoved && !classMoved && fareOverride == null) {
        logDispatchEvent({
          companyId: profile.company_id!,
          dispatcherId: profile.id,
          eventType: "ride.scheduled_modified",
          rideId,
          details: {
            preferred_driver_id: editPreferredDriver || null,
            preferred_driver_exclusive: editPreferredDriver ? editPreferredExclusive : false,
          },
        });
      }
    }

    setEditSaving(false);
    setEditingRide(false);
    setRideDetail(null);
    fetchRides();
  }

  function patchDriverProfile(driverId: string, patch: Record<string, unknown>) {
    setSelectedDriver((prev: any) =>
      prev?.id === driverId
        ? { ...prev, profile: { ...prev.profile, ...patch } }
        : prev,
    );
    setDrivers((prev: any[]) =>
      prev.map((d: any) =>
        d.id === driverId ? { ...d, profile: { ...d.profile, ...patch } } : d,
      ),
    );
  }

  async function deactivateDriver(driverId: string, hasActiveRide: boolean) {
    const driverName = selectedDriver?.profile?.name ?? null;
    if (hasActiveRide) {
      const { data: updated, error } = await supabase.from("profiles").update({ deactivation_pending: true }).eq("id", driverId).select("id, is_active, deactivation_pending");
      if (error) { console.error("[deactivate] pending update failed:", error); alert(`Deactivation failed: ${error.message}`); return; }
      if (!updated?.length) { alert("Deactivation failed: no rows updated — check RLS or company_id mismatch."); return; }
      patchDriverProfile(driverId, { deactivation_pending: true });
    } else {
      const { data: updated, error } = await supabase.from("profiles").update({ is_active: false, deactivation_pending: false }).eq("id", driverId).select("id, is_active, deactivation_pending");
      if (error) { console.error("[deactivate] direct update failed:", error); alert(`Deactivation failed: ${error.message}`); return; }
      if (!updated?.length) { alert("Deactivation failed: no rows updated — check RLS or company_id mismatch."); return; }
      patchDriverProfile(driverId, { is_active: false, deactivation_pending: false });
    }
    fetchDrivers();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "driver.suspended",
      details: { driver_id: driverId, driver_name: driverName, pending: hasActiveRide },
    });
  }

  async function activateDriver(driverId: string) {
    const driverName = selectedDriver?.profile?.name ?? null;
    const { error } = await supabase.from("profiles").update({ is_active: true, deactivation_pending: false }).eq("id", driverId);
    if (error) { console.error("[activate] update failed:", error); alert(`Activation failed: ${error.message}`); return; }
    patchDriverProfile(driverId, { is_active: true, deactivation_pending: false });
    fetchDrivers();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "driver.reactivated",
      details: { driver_id: driverId, driver_name: driverName },
    });
  }

  async function deleteDriver(driverId: string) {
    const driverName = selectedDriver?.profile?.name ?? null;
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-driver`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ driver_id: driverId }),
      },
    );
    if (!res.ok) {
      const { error } = await res.json();
      alert(`Failed to delete driver: ${error}`);
      return;
    }
    setSelectedDriver(null);
    fetchDrivers();
    logDispatchEvent({
      companyId: profile.company_id!,
      dispatcherId: profile.id,
      eventType: "driver.deleted",
      details: { driver_id: driverId, driver_name: driverName },
    });
  }

  function navigateTo(dest: "analytics" | "reports" | "discounts" | "settings" | "announcements" | "messages" | "main") {
    setShowAnalytics(dest === "analytics");
    setShowReports(dest === "reports");
    setShowDiscounts(dest === "discounts");
    setShowSettings(dest === "settings");
    setShowAnnouncements(dest === "announcements");
    setShowMessages(dest === "messages");
  }

  // Collapse the current tab/overlay state into the single active view. Overlay
  // priority mirrors `topbarTitle` below so the hash round-trips consistently.
  function viewFromState(): View {
    if (showAnalytics) return "analytics";
    if (showReports) return "reports";
    if (showDiscounts) return "discounts";
    if (showSettings) return "settings";
    if (showAnnouncements) return "announcements";
    if (showMessages) return "messages";
    return tab;
  }

  // Drive the tab/overlay state from a view id (used by the hashchange listener
  // for browser back/forward). Runs unconditionally — React bails on identical
  // setter values, so re-applying the current view is a no-op and can't loop.
  function applyView(v: View) {
    if (v === "discounts" && !isAdmin) v = "rides";
    if (v === "rides" || v === "drivers") {
      setTab(v);
      navigateTo("main");
    } else {
      navigateTo(v);
    }
    setSelectedDriver(null);
  }

  // A scheduled ride is "live" once the driver is actually working it, which
  // can be well before its scheduled_at — they head out early, or dispatch
  // released it ahead of time. Keying purely off `scheduled_at > now` used to
  // drop a driver_arriving/in_progress scheduled ride out of Active *and* out
  // of Scheduled, so it vanished from the dashboard entirely.
  const isLiveNow = (r: any) => {
    if (["driver_arriving", "in_progress"].includes(r.status)) return true;
    if (r.en_route_at) return true; // driver tapped "On my way"
    return !(r.scheduled_at && new Date(r.scheduled_at) > new Date());
  };

  const alerts = buildAlerts(rides);

  // Toast + auto-open live here, NOT inside the setRides updater where they
  // started. React invokes an updater during render and may discard or
  // double-run side effects in it, so the auto-open silently never fired. The
  // coverage toast below still uses that pattern and is likely just as
  // unreliable — worth moving next time it is touched.
  const seenFlagsRef = useRef<Map<string, string>>(new Map());
  const flagsSeededRef = useRef(false);

  useEffect(() => {
    const current = new Map<string, string>();
    for (const r of rides as any[]) {
      if (isOpenFlag(r)) {
        current.set(r.id, r.passenger_flag_updated_at ?? r.passenger_flagged_at);
      }
    }

    // First pass seeds silently, same discipline as the driver digest's NULL
    // watermark: otherwise every page load pops the panel for escalations
    // dispatch has already dealt with.
    if (!flagsSeededRef.current) {
      // Wait for rides to actually load. The effect's first run happens with an
      // empty array — before fetchRides resolves — and seeding THAT made every
      // existing flag look new a moment later, so a refresh re-announced
      // escalations dispatch had already seen.
      if (rides.length === 0) return;
      seenFlagsRef.current = current;
      flagsSeededRef.current = true;
      // Open on load if anything is already outstanding — but silently. The
      // panel is the DURABLE state ("these things are unresolved"), so it
      // should be visible after a refresh; the toast and chime are the EVENT
      // signal ("this just happened") and would be lying if they repeated for
      // an escalation dispatch has already seen.
      if (current.size > 0) setAlertsOpen(true);
      return;
    }

    // A changed stamp counts as new — that is how an added reason on a ride
    // already flagged re-announces itself.
    const fresh = [...current].filter(
      ([id, stamp]) => seenFlagsRef.current.get(id) !== stamp,
    );
    seenFlagsRef.current = current;
    if (fresh.length === 0) return;

    setAlertsOpen(true);
    if (alertSound) playAlertChime();

    const ride = (rides as any[]).find((r) => r.id === fresh[0][0]);
    const codes: string[] = [...(ride?.passenger_flag_reasons ?? [])].sort(
      (a, b) => FLAG_REASON_ORDER.indexOf(a) - FLAG_REASON_ORDER.indexOf(b),
    );
    const label =
      (FLAG_REASON_LABELS[codes[0]] ?? "Passenger reported a problem") +
      (codes.length > 1 ? ` (+${codes.length - 1} more)` : "");
    setCoverageToast(
      current.size > 1
        ? `${current.size} rides flagged by passengers — check the board`
        : `${label} — check the ride`,
    );
    if (coverageToastTimerRef.current) clearTimeout(coverageToastTimerRef.current);
    coverageToastTimerRef.current = setTimeout(() => setCoverageToast(null), 12000);
  }, [rides, alertSound]);

  const activeRides = rides.filter(
    (r) =>
      [
        "pending",
        "offered",
        "assigned",
        "driver_arriving",
        "in_progress",
      ].includes(r.status) && isLiveNow(r),
  );
  // Asked once per picker-open, not per render: the answer needs live drive
  // times, so it costs Distance Matrix elements. It's a human-initiated action,
  // so once each time dispatch looks is the right cadence.
  useEffect(() => {
    if (!assigningRide) {
      setConflicts(new Map());
      return;
    }
    let cancelled = false;
    setConflictsLoading(true);
    (async () => {
      const { data, error } = await invokeFunction("check-ride-conflicts", {
        ride_id: assigningRide,
      });
      if (cancelled) return;
      setConflictsLoading(false);
      if (error) {
        console.error("[conflicts]", error);
        return;
      }
      const m = new Map<string, any>();
      for (const c of data?.conflicts ?? []) m.set(c.driver_id, c);
      setConflicts(m);
    })();
    return () => {
      cancelled = true;
    };
  }, [assigningRide]);

  const scheduledRides = rides
    .filter(
      (r) =>
        (r as any).scheduled_at &&
        new Date((r as any).scheduled_at) > new Date() &&
        !["completed", "cancelled"].includes(r.status) &&
        !isLiveNow(r),
    )
    .sort(
      (a, b) =>
        new Date((a as any).scheduled_at).getTime() -
        new Date((b as any).scheduled_at).getTime(),
    );
  const recentRides = rides
    .filter((r) => ["completed", "cancelled"].includes(r.status))
    .slice(0, 30);
  const activeRideDriverIds = new Set(
    rides
      .filter((r) => ["assigned", "driver_arriving", "in_progress"].includes(r.status) && r.driver_id)
      .map((r) => r.driver_id),
  );
  const onlineDrivers = drivers.filter((d) => d.is_active && !activeRideDriverIds.has(d.id));
  const availableDiscountCodes = discountCodes.filter((c) => {
    const now = new Date();
    if (c.starts_at && now < new Date(c.starts_at)) return false;
    if (c.ends_at && now > new Date(c.ends_at)) return false;
    return true;
  });
  const topbarTitle = showAnalytics
    ? "Analytics"
    : showReports
      ? "Reports"
      : showDiscounts
        ? "Discounts"
        : showSettings
          ? "Settings"
          : showAnnouncements
            ? "Announcements"
            : showMessages
              ? "Messages"
              : tab.charAt(0).toUpperCase() + tab.slice(1);

  const filteredDrivers = (() => {
    const q = driverSearch.trim().toLowerCase();
    const base = drivers.filter(d => !(d as any).profile?.deleted_at);
    if (!q) return base;
    return base.filter(d => {
      const name = ((d as any).profile?.name ?? "").toLowerCase();
      const phone = ((d as any).profile?.phone ?? "").replace(/\D/g, "");
      const make = (d.vehicle_make ?? "").toLowerCase();
      const model = (d.vehicle_model ?? "").toLowerCase();
      const plate = (d.plate_number ?? "").toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      return name.includes(q) || make.includes(q) || model.includes(q) || plate.includes(q)
        || (qDigits.length > 0 && phone.includes(qDigits));
    });
  })();

  if (loading)
    return (
      <div
        style={{
          display: "flex",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          background: "#111827",
          color: "#E8500A",
          fontFamily: "system-ui",
        }}
      >
        Loading…
      </div>
    );

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; }
        .db-page { display: flex; height: 100vh; background: #111827; font-family: system-ui, -apple-system, sans-serif; overflow: hidden; position: relative; }
        .db-nav { width: 56px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; align-items: center; padding: 0; flex-shrink: 0; z-index: 30; transition: width 0.18s cubic-bezier(0.4,0,0.2,1); overflow: hidden; }
        .db-nav.expanded { width: 196px; }
        .db-nav-logo { width: 100%; height: 54px; display: flex; align-items: center; padding: 0 18px; flex-shrink: 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .db-nav-logo-text { font-size: 14px; font-weight: 700; color: #E8500A; letter-spacing: -0.3px; white-space: nowrap; }
        .db-nav-items { flex: 1; display: flex; flex-direction: column; padding: 8px 0; width: 100%; }
        .db-nav-item { display: flex; align-items: center; gap: 11px; width: 100%; height: 40px; padding: 0 19px; background: none; border: none; cursor: pointer; border-left: 2px solid transparent; transition: background 0.12s, border-color 0.12s; white-space: nowrap; }
        .db-nav-item:hover { background: rgba(255,255,255,0.05); }
        .db-nav-item.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); }
        .db-nav-icon { color: #6B7280; flex-shrink: 0; transition: color 0.12s; display: flex; align-items: center; position: relative; }
        .db-nav-item:hover .db-nav-icon, .db-nav-item.active .db-nav-icon { color: #E8500A; }
        .db-nav-label { font-size: 13px; font-weight: 500; color: #6B7280; transition: color 0.12s; }
        .db-nav-item:hover .db-nav-label, .db-nav-item.active .db-nav-label { color: #E8500A; }
        .db-nav-bottom { padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.06); width: 100%; display: flex; flex-direction: column; }
        .db-nav-profile { display: flex; align-items: center; gap: 11px; width: 100%; height: 48px; padding: 0 19px; margin-bottom: 4px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .db-nav-avatar { flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%; background: rgba(232,80,10,0.15); color: #E8500A; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
        .db-nav-profile-info { display: flex; flex-direction: column; overflow: hidden; }
        .db-nav-profile-name { font-size: 13px; font-weight: 600; color: #E2E8F0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-nav-profile-role { font-size: 10px; color: #6B7280; text-transform: capitalize; }
        .db-nav-utility { display: flex; align-items: center; gap: 11px; width: 100%; height: 40px; padding: 0 19px; background: none; border: none; cursor: pointer; white-space: nowrap; transition: background 0.12s; }
        .db-nav-utility:hover { background: rgba(255,255,255,0.05); }
        .db-nav-utility .db-nav-icon { color: #6B7280; }
        .db-nav-utility:hover .db-nav-icon { color: #9CA3AF; }
        .db-nav-utility .db-nav-label { color: #6B7280; }
        .db-nav-utility:hover .db-nav-label { color: #9CA3AF; }
        .db-nav-analytics .db-nav-icon { color: #6B7280; }
        .db-nav-analytics:hover .db-nav-icon, .db-nav-analytics.active-util .db-nav-icon { color: #A855F7; }
        .db-nav-analytics .db-nav-label { color: #6B7280; }
        .db-nav-analytics:hover .db-nav-label, .db-nav-analytics.active-util .db-nav-label { color: #A855F7; }
        .db-nav-reports .db-nav-icon { color: #6B7280; }
        .db-nav-reports:hover .db-nav-icon, .db-nav-reports.active-util .db-nav-icon { color: #F87171; }
        .db-nav-reports .db-nav-label { color: #6B7280; }
        .db-nav-reports:hover .db-nav-label, .db-nav-reports.active-util .db-nav-label { color: #F87171; }
        .db-nav-signout:hover .db-nav-icon { color: #E24B4A; }
        .db-nav-signout:hover .db-nav-label { color: #E24B4A; }
        .db-nav-settings .db-nav-icon { color: #6B7280; }
        .db-nav-settings:hover .db-nav-icon, .db-nav-settings.active-util .db-nav-icon { color: #60A5FA; }
        .db-nav-settings .db-nav-label { color: #6B7280; }
        .db-nav-settings:hover .db-nav-label, .db-nav-settings.active-util .db-nav-label { color: #60A5FA; }
        .db-badge-dot { position: absolute; top: -3px; right: -4px; width: 7px; height: 7px; border-radius: 50%; background: #E24B4A; border: 1.5px solid #0F1723; }
        .db-badge-count { margin-left: auto; font-size: 10px; font-weight: 700; background: rgba(226,75,74,0.15); color: #F87171; border-radius: 10px; padding: 1px 6px; }
        .db-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
        .db-topbar { height: 54px; background: #0F1723; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; padding: 0 20px; gap: 20px; flex-shrink: 0; z-index: 20; }
        .db-topbar-title { font-size: 14px; font-weight: 600; color: #F1F5F9; margin-right: auto; }
        .db-stat-row { display: flex; align-items: center; gap: 28px; margin-right: 20px; }
        .db-stat { display: flex; flex-direction: column; align-items: flex-end; }
        .db-stat-value { font-size: 15px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .db-stat-label { font-size: 10px; color: #6B7280; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 2px; }
        .db-stat-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: middle; position: relative; top: -1px; }
        .db-new-ride-btn { background: #E8500A; color: #fff; border: none; border-radius: 7px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: opacity 0.15s; white-space: nowrap; }
        .db-new-ride-btn:hover { opacity: 0.88; }
        .db-back-btn { background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; transition: color 0.12s, border-color 0.12s; }
        .db-back-btn:hover { color: #9CA3AF; border-color: rgba(255,255,255,0.15); }
        .db-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }
        .db-panel { width: 336px; background: #111827; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
        .db-panel-header { padding: 14px 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .db-panel-title { font-size: 11px; font-weight: 600; color: #6B7280; letter-spacing: 0.07em; text-transform: uppercase; }
        .db-panel-count { font-size: 22px; font-weight: 700; color: #F1F5F9; margin-top: 2px; line-height: 1; }
        .db-panel-scroll { flex: 1; overflow-y: auto; padding: 10px; }
        .db-panel-scroll::-webkit-scrollbar { width: 3px; }
        .db-panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .db-driver-search { width: 100%; box-sizing: border-box; margin-top: 8px; margin-bottom: 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; color: #E2E8F0; font-size: 12px; padding: 6px 10px; outline: none; font-family: system-ui, sans-serif; transition: border-color 0.12s; }
        .db-driver-search::placeholder { color: #4B5563; }
        .db-driver-search:focus { border-color: rgba(255,255,255,0.2); }
        .db-section-divider { margin: 10px 0 8px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; display: flex; justify-content: space-between; align-items: baseline; }
        .db-section-divider-title { font-size: 11px; font-weight: 600; color: #6B7280; letter-spacing: 0.07em; text-transform: uppercase; padding: 0 2px; }
        .db-section-divider-count { font-size: 13px; font-weight: 700; padding-right: 2px; }
        .db-empty { font-size: 13px; color: #6B7280; text-align: center; padding: 24px 0; }
        .db-ride-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: border-color 0.12s, background 0.12s; }
        .db-ride-card:hover { background: #213040; border-color: rgba(255,255,255,0.1); }
        .db-ride-card.selected { border-color: rgba(232,80,10,0.45); }
        .db-ride-card.dimmed { opacity: 0.7; }
        .db-ride-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; }
        .db-status-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 20px; letter-spacing: 0.02em; font-family: system-ui, -apple-system, sans-serif; }
        .db-ride-time { font-size: 11px; color: #6B7280; }
        .db-ride-name { font-size: 13px; font-weight: 600; color: #E2E8F0; margin-bottom: 3px; }
        .db-ride-addr { font-size: 11px; color: #6B7280; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-ride-addr.dest { color: rgba(232,80,10,0.8); }
        .db-ride-fare { font-size: 12px; font-weight: 600; color: #6B7280; margin-top: 4px; }
        .db-pending-badge { font-size: 11px; color: #F59E0B; background: rgba(245,158,11,0.08); border-radius: 6px; padding: 4px 8px; margin-top: 6px; border: 1px solid rgba(245,158,11,0.15); }
        .db-assign-btn { width: 100%; background: rgba(74,158,255,0.07); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 7px; padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; margin-top: 8px; transition: background 0.12s; }
        .db-assign-btn:hover { background: rgba(74,158,255,0.13); }
        .db-assign-label { font-size: 11px; color: #6B7280; margin: 8px 0 4px; }
        .db-assign-driver-btn { width: 100%; background: rgba(29,158,117,0.07); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 7px; padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; margin-bottom: 4px; transition: background 0.12s; }
        .db-assign-driver-btn:hover { background: rgba(29,158,117,0.13); }
        .db-cancel-assign-btn { background: transparent; color: #6B7280; border: none; font-size: 11px; cursor: pointer; padding: 4px 0; font-family: system-ui, sans-serif; transition: color 0.12s; }
        .db-cancel-assign-btn:hover { color: #9CA3AF; }
        .db-cancel-ride-btn { background: rgba(226,75,74,0.07); color: #F87171; border: 1px solid rgba(226,75,74,0.2); border-radius: 7px; padding: 6px 10px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .db-cancel-ride-btn:hover { background: rgba(226,75,74,0.14); }
        .db-sched-card { background: #1a1f2e; border-radius: 10px; margin-bottom: 6px; border: 1px solid rgba(168,85,247,0.2); border-left: 3px solid #A855F7; cursor: pointer; overflow: hidden; transition: border-color 0.12s, background 0.12s; }
        .db-sched-card:hover { background: #1e2438; border-color: rgba(168,85,247,0.35); border-left-color: #A855F7; }
        .db-sched-datetime { display: flex; align-items: center; gap: 6px; background: rgba(168,85,247,0.08); padding: 7px 12px; border-bottom: 1px solid rgba(168,85,247,0.12); color: #A855F7; }
        .db-sched-date { font-size: 11px; font-weight: 600; color: #C084FC; flex: 1; }
        .db-sched-time-val { font-size: 12px; font-weight: 700; color: #E9D5FF; }
        .db-sched-body { padding: 10px 12px 0; }
        .db-sched-name { font-size: 13px; font-weight: 600; color: #E2E8F0; margin-bottom: 3px; }
        .db-sched-addr { font-size: 11px; color: #6B7280; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-sched-addr.dest { color: rgba(232,80,10,0.8); }
        .db-sched-fare { font-size: 12px; font-weight: 600; color: #6B7280; margin-top: 4px; }
        .db-sched-driver-row { display: flex; align-items: center; gap: 6px; margin: 8px 12px 0; padding: 5px 8px; background: rgba(29,158,117,0.06); border: 1px solid rgba(29,158,117,0.15); border-radius: 6px; }
        .db-sched-driver-dot { width: 6px; height: 6px; border-radius: 50%; background: #1D9E75; flex-shrink: 0; }
        .db-sched-driver-name { font-size: 11px; font-weight: 500; color: #1D9E75; }
        .db-sched-assign-btn { flex: 1; background: rgba(168,85,247,0.07); color: #C084FC; border: 1px solid rgba(168,85,247,0.2); border-radius: 7px; padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .db-sched-assign-btn:hover { background: rgba(168,85,247,0.13); }
        .db-cov-pill { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; border: 1px solid; margin-left: auto; flex-shrink: 0; letter-spacing: 0.02em; }
        .db-cov-bar { display: flex; align-items: center; gap: 7px; margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; border: 1px solid; }
        .db-cov-bar-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .db-cov-bar-text { font-size: 11px; font-weight: 600; }
        .db-cov-toast { position: fixed; bottom: 24px; right: 24px; display: flex; align-items: center; gap: 10px; background: #1E2A3A; border: 1px solid rgba(245,158,11,0.35); border-radius: 10px; padding: 12px 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); font-size: 13px; color: #F9FAFB; z-index: 9999; max-width: 320px; animation: db-toast-in 0.2s ease; }
        .db-cov-toast-icon { color: #F59E0B; font-size: 15px; flex-shrink: 0; }
        .db-cov-toast-close { background: none; border: none; color: #6B7280; cursor: pointer; font-size: 13px; padding: 0 0 0 6px; line-height: 1; flex-shrink: 0; }
        .db-cov-toast-close:hover { color: #9CA3AF; }
        @keyframes db-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .db-driver-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: border-color 0.12s, background 0.12s; }
        .db-driver-card:hover { background: #213040; border-color: rgba(255,255,255,0.1); }
        .db-driver-card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
        .db-driver-avatar { width: 34px; height: 34px; border-radius: 17px; background: #1E3A5F; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #4a9eff; flex-shrink: 0; border: 1px solid rgba(74,158,255,0.12); }
        .db-driver-avatar-photo { width: 34px; height: 34px; border-radius: 17px; object-fit: cover; flex-shrink: 0; border: 1px solid rgba(74,158,255,0.18); }
        .db-driver-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .db-driver-sub { font-size: 11px; color: #6B7280; margin-top: 1px; }
        .db-driver-phone { font-size: 11px; color: #6B7280; margin-top: 3px; }
        .db-online-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-left: auto; }
        .db-driver-status-on-ride { font-size: 11px; color: #E8500A; margin-top: 3px; font-weight: 500; }
        .db-driver-status-available { font-size: 11px; color: #1D9E75; margin-top: 3px; font-weight: 500; }
        .db-invite-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
        .db-invite-input { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #F1F5F9; outline: none; font-family: system-ui, sans-serif; transition: border-color 0.15s; }
        .db-invite-input:focus { border-color: rgba(232,80,10,0.35); }
        .db-invite-input::placeholder { color: #6B7280; }
        .db-phone-wrap { display: flex; align-items: center; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 0 12px; transition: border-color 0.15s; }
        .db-phone-wrap:focus-within { border-color: rgba(232,80,10,0.35); }
        .db-phone-prefix { font-size: 13px; color: #9CA3AF; font-family: system-ui, sans-serif; padding-right: 6px; border-right: 1px solid rgba(255,255,255,0.08); margin-right: 8px; white-space: nowrap; }
        .db-phone-input { flex: 1; background: transparent; border: none; padding: 10px 0; font-size: 13px; color: #F1F5F9; outline: none; font-family: system-ui, sans-serif; }
        .db-phone-input::placeholder { color: #6B7280; }
        .db-invite-btn { background: #E8500A; color: #fff; border: none; border-radius: 8px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: opacity 0.15s; }
        .db-invite-btn:hover { opacity: 0.88; }
        .db-invite-btn:disabled { opacity: 0.5; }
        .db-invite-success { background: rgba(29,158,117,0.07); border: 1px solid rgba(29,158,117,0.2); border-radius: 10px; padding: 16px; text-align: center; margin-bottom: 12px; }
        .db-invite-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); }
        .db-invite-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
        .db-invite-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .db-invite-phone { font-size: 11px; color: #6B7280; margin-bottom: 8px; }
        .db-invite-code-row { display: flex; align-items: center; justify-content: space-between; }
        .db-invite-code { font-size: 15px; font-weight: 700; color: #E8500A; letter-spacing: 0.18em; }
        .db-revoke-btn { background: rgba(226,75,74,0.08); color: #F87171; border: 1px solid rgba(226,75,74,0.2); border-radius: 6px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .db-revoke-btn:hover { background: rgba(226,75,74,0.14); }
        .db-map-wrap { flex: 1; position: relative; min-height: 0; overflow: hidden; }
        .db-map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
        .db-overlay { flex: 1; overflow: hidden; background: #111827; display: flex; flex-direction: column; }
        .db-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .db-modal { background: #1E2A3A; border-radius: 14px; padding: 26px; width: 100%; max-width: 440px; border: 1px solid rgba(255,255,255,0.08); max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif; }
        .db-modal-title { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-bottom: 20px; font-family: system-ui, -apple-system, sans-serif; }
        .db-modal-label { font-size: 11px; color: #6B7280; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; display: block; margin-bottom: 6px; font-family: system-ui, -apple-system, sans-serif; }
        .db-modal-input { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #E2E8F0; outline: none; width: 100%; font-family: system-ui, -apple-system, sans-serif; transition: border-color 0.15s; }
        .db-modal-input:focus { border-color: rgba(232,80,10,0.4); }
        .db-modal-input::placeholder { color: #6B7280; }
        .db-modal-select { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #E2E8F0; outline: none; width: 100%; cursor: pointer; font-family: system-ui, -apple-system, sans-serif; }
        .db-modal-select:disabled { opacity: 0.55; cursor: not-allowed; }
        .db-modal-hint { font-size: 11px; color: #6B7280; margin-top: 4px; font-family: system-ui, -apple-system, sans-serif; }
        .pac-container { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; margin-top: 4px; font-family: system-ui, -apple-system, sans-serif; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
        .pac-item { padding: 8px 12px; color: #9CA3AF; font-size: 13px; border-top: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
        .pac-item:first-child { border-top: none; }
        .pac-item:hover, .pac-item-selected { background: rgba(232,80,10,0.1); color: #E2E8F0; }
        .pac-item-query { color: #E2E8F0; font-size: 13px; }
        .pac-matched { color: #E8500A; font-weight: 600; }
        .pac-icon { display: none; }
        .pac-logo:after { display: none; }
        .db-modal-cancel-btn { flex: 1; background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; font-size: 14px; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .db-modal-cancel-btn:hover { background: rgba(255,255,255,0.04); }
        .db-modal-submit-btn { flex: 2; background: #E8500A; color: #fff; border: none; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: opacity 0.15s; }
        .db-modal-submit-btn:hover { opacity: 0.88; }
        .db-modal-submit-btn:disabled { opacity: 0.5; }
        /* Floating live-ride card — sits over the bottom-left of the map, list + map stay visible */
        .db-ride-float { position: absolute; left: 16px; top: 72px; z-index: 60; width: 300px; max-height: calc(100% - 88px); overflow-y: auto; background: rgba(22,31,46,0.97); backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.09); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; font-family: system-ui, -apple-system, sans-serif; animation: dbFloatIn 0.16s ease-out; }
        @keyframes dbFloatIn { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .db-ride-float-head { display: flex; align-items: center; gap: 8px; }
        .db-ride-float-time { font-size: 12px; color: #6B7280; }
        .db-ride-float-close { margin-left: auto; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #94A3B8; border-radius: 7px; width: 26px; height: 26px; font-size: 16px; line-height: 1; cursor: pointer; flex-shrink: 0; transition: background 0.12s; }
        .db-ride-float-close:hover { background: rgba(255,255,255,0.12); color: #E2E8F0; }
        .db-ride-float-pax { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-top: -2px; }
        .db-ride-float-contacts { display: flex; flex-direction: column; gap: 8px; }
        .db-phone-row { display: flex; align-items: center; gap: 8px; }
        .db-phone-role { font-size: 11px; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; width: 62px; flex-shrink: 0; }
        .db-phone-num { font-size: 13px; color: #E2E8F0; font-weight: 500; font-variant-numeric: tabular-nums; flex: 1; }
        /* Attention panel — an OVERLAY, not a layout column. A column would
           resize db-map-wrap, and the live-ride map.fitBounds framing was
           computed at the old width. Sits right; db-ride-float is left:16px so
           they never collide. */
        .db-alerts { position: absolute; right: 16px; top: 72px; z-index: 62; width: 312px; max-height: calc(100% - 88px); display: flex; flex-direction: column; background: rgba(22,31,46,0.97); backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.09); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); font-family: system-ui, -apple-system, sans-serif; animation: dbFloatIn 0.16s ease-out; overflow: hidden; }
        .db-alerts-head { display: flex; align-items: center; gap: 8px; padding: 13px 14px 11px; border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink: 0; }
        .db-alerts-title { font-size: 11px; font-weight: 600; color: #6B7280; letter-spacing: 0.07em; text-transform: uppercase; }
        .db-alerts-count { font-size: 10px; font-weight: 700; background: rgba(226,75,74,0.15); color: #F87171; border-radius: 10px; padding: 1px 7px; }
        .db-alerts-close { margin-left: auto; background: none; border: none; color: #6B7280; font-size: 15px; cursor: pointer; line-height: 1; padding: 2px 4px; }
        .db-alerts-close:hover { color: #E2E8F0; }
        .db-alerts-scroll { overflow-y: auto; padding: 8px; }
        .db-alerts-scroll::-webkit-scrollbar { width: 3px; }
        .db-alerts-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .db-alert-row { width: 100%; text-align: left; display: flex; gap: 9px; align-items: flex-start; padding: 9px 10px; border-radius: 9px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); cursor: pointer; margin-bottom: 6px; font-family: inherit; transition: background 0.12s, border-color 0.12s; }
        .db-alert-row:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.12); }
        .db-alert-row.flag { border-color: rgba(248,113,113,0.32); background: rgba(248,113,113,0.08); }
        .db-alert-row.flag:hover { background: rgba(248,113,113,0.13); }
        .db-alert-glyph { font-size: 13px; line-height: 16px; flex-shrink: 0; }
        .db-alert-body { display: block; flex: 1; min-width: 0; }
        .db-alert-title { display: block; font-size: 12px; font-weight: 700; color: #F1F5F9; line-height: 16px; }
        .db-alert-row.flag .db-alert-title { color: #F87171; }
        .db-alert-detail { display: block; font-size: 11px; color: #9CA3AF; line-height: 15px; margin-top: 2px; overflow-wrap: anywhere; }
        .db-alert-meta { display: block; font-size: 10px; color: #6B7280; margin-top: 3px; }
        .db-alerts-empty { padding: 22px 16px; text-align: center; color: #6B7280; font-size: 12px; }
        .db-alert-btn { position: relative; background: transparent; border: 1px solid rgba(255,255,255,0.10); border-radius: 7px; padding: 6px 11px; font-size: 13px; font-weight: 600; color: #9CA3AF; cursor: pointer; font-family: system-ui, sans-serif; transition: color 0.12s, border-color 0.12s; white-space: nowrap; }
        .db-alert-btn:hover { color: #E2E8F0; border-color: rgba(255,255,255,0.2); }
        .db-alert-btn.hot { color: #F87171; border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.08); }
        .db-flag-box { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(248,113,113,0.10); border: 1px solid rgba(248,113,113,0.35); display: flex; gap: 8px; align-items: flex-start; }
        .db-flag-glyph { color: #F87171; font-size: 13px; line-height: 16px; flex-shrink: 0; }
        .db-flag-body { flex: 1; min-width: 0; }
        .db-flag-head { color: #F87171; font-size: 12px; font-weight: 700; line-height: 16px; }
        /* Reasons hang off the same left edge as the heading — the icon lives in
           its own column, so nothing is faked with padding or spaces. */
        .db-flag-list { list-style: none; margin: 3px 0 0; padding: 0; }
        .db-flag-item { color: #FCA5A5; font-size: 11.5px; font-weight: 600; line-height: 16px; display: flex; gap: 6px; }
        .db-flag-item::before { content: "•"; color: rgba(248,113,113,0.65); flex-shrink: 0; }
        .db-flag-note { color: #FCA5A5; font-size: 11px; line-height: 15px; margin-top: 4px; opacity: 0.9; overflow-wrap: anywhere; }
        .db-flag-resolve { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); color: #E2E8F0; border-radius: 7px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: system-ui, -apple-system, sans-serif; }
        .db-flag-resolve:hover { background: rgba(255,255,255,0.12); }
        .db-phone-copy { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #E2E8F0; border-radius: 7px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer; flex-shrink: 0; transition: background 0.12s; font-family: system-ui, -apple-system, sans-serif; }
        .db-phone-copy:hover { background: rgba(255,255,255,0.12); }
        .db-live-driver { display: flex; align-items: center; justify-content: space-between; gap: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; padding: 12px 14px; }
        .db-live-driver-name { font-size: 14px; font-weight: 600; color: #E2E8F0; }
        .db-live-driver-veh { font-size: 12px; color: #94A3B8; margin-top: 2px; }
        .db-live-track { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; white-space: nowrap; }
        .db-live-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
        .db-live-route { display: flex; flex-direction: column; gap: 12px; position: relative; }
        .db-live-route::before { content: ""; position: absolute; left: 5px; top: 14px; bottom: 14px; width: 2px; background: rgba(255,255,255,0.12); }
        .db-live-stop { display: flex; gap: 12px; align-items: flex-start; position: relative; }
        .db-live-stop-dot { width: 12px; height: 12px; border-radius: 50%; margin-top: 2px; flex-shrink: 0; border: 2px solid #161F2E; box-shadow: 0 0 0 1px rgba(255,255,255,0.15); z-index: 1; }
        .db-live-stop-label { font-size: 11px; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
        .db-live-stop-addr { font-size: 13px; color: #E2E8F0; margin-top: 2px; line-height: 1.35; }
        .db-live-chips { display: flex; gap: 8px; }
        .db-live-chip { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .db-live-contact { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
        .db-detail-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .db-detail-label { font-size: 12px; color: #6B7280; font-weight: 500; font-family: system-ui, -apple-system, sans-serif; }
        .db-detail-value { font-size: 13px; color: #E2E8F0; font-weight: 500; max-width: 60%; text-align: right; font-family: system-ui, -apple-system, sans-serif; }
        .db-detail-row-warning { background: rgba(226,75,74,0.1); border-radius: 6px; padding: 9px 8px; margin: 2px 0; border-bottom: none; }
        .db-detail-value-warning { color: #E24B4A; font-weight: 700; }
        .dd-panel { position: absolute; inset: 0; background: #111827; display: flex; flex-direction: column; overflow: hidden; }
        .dd-header { height: 48px; background: #0F1723; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; padding: 0 16px; flex-shrink: 0; }
        .dd-back { display: flex; align-items: center; gap: 7px; background: none; border: none; color: #6B7280; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; padding: 0; transition: color 0.12s; }
        .dd-back:hover { color: #9CA3AF; }
        .dd-scroll { flex: 1; overflow-y: auto; padding: 16px; }
        .dd-scroll::-webkit-scrollbar { width: 3px; }
        .dd-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .dd-profile { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
        .dd-avatar-photo { width: 52px; height: 52px; border-radius: 26px; object-fit: cover; border: 2px solid rgba(74,158,255,0.2); flex-shrink: 0; }
        .dd-avatar-initials { width: 52px; height: 52px; border-radius: 26px; background: #1E3A5F; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; color: #4a9eff; flex-shrink: 0; border: 2px solid rgba(74,158,255,0.12); }
        .dd-profile-info { flex: 1; min-width: 0; }
        .dd-profile-name { font-size: 16px; font-weight: 700; color: #F1F5F9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dd-profile-sub { font-size: 12px; color: #6B7280; }
        .dd-profile-phone { font-size: 12px; color: #6B7280; margin-top: 2px; }
        .dd-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .dd-status-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .dd-pill { font-size: 11px; font-weight: 600; border-radius: 20px; padding: 3px 10px; }
        .dd-pill-green { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); }
        .dd-pill-orange { background: rgba(232,80,10,0.1); color: #E8500A; border: 1px solid rgba(232,80,10,0.2); }
        .dd-pill-gray { background: rgba(107,114,128,0.1); color: #6B7280; border: 1px solid rgba(107,114,128,0.2); }
        .dd-pill-red { background: rgba(226,75,74,0.1); color: #F87171; border: 1px solid rgba(226,75,74,0.2); }
        .dd-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 18px; }
        .dd-stat-box { background: #1E2A3A; border-radius: 10px; padding: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
        .dd-stat-val { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .dd-stat-lbl { font-size: 10px; color: #6B7280; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 3px; }
        .dd-section-label { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; margin-bottom: 8px; }
        .dd-empty { font-size: 13px; color: #6B7280; text-align: center; padding: 24px 0; }
        .dd-ride-row { background: #1E2A3A; border-radius: 10px; padding: 11px 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
        .dd-ride-row-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .dd-ride-passenger { font-size: 12px; font-weight: 600; color: #E2E8F0; margin-top: 4px; }
        .dd-ride-addr { font-size: 11px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dd-ride-time { font-size: 10px; color: #6B7280; }
        .dd-ride-fare { font-size: 13px; font-weight: 600; color: #6B7280; white-space: nowrap; padding-top: 2px; }
        .dd-pill-amber { background: rgba(245,158,11,0.1); color: #F59E0B; border: 1px solid rgba(245,158,11,0.2); }
        .dd-action-deactivate { background: rgba(245,158,11,0.08); color: #F59E0B; border: 1px solid rgba(245,158,11,0.2); border-radius: 7px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-action-deactivate:hover { background: rgba(245,158,11,0.15); }
        .dd-action-activate { background: rgba(29,158,117,0.08); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 7px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-action-activate:hover { background: rgba(29,158,117,0.15); }
        .dd-action-delete { background: rgba(226,75,74,0.07); color: #F87171; border: 1px solid rgba(226,75,74,0.2); border-radius: 7px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-action-delete:hover:not(:disabled) { background: rgba(226,75,74,0.14); }
        .dd-action-delete:disabled { opacity: 0.35; cursor: not-allowed; }
        .dd-confirm-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.65); display: flex; align-items: center; justify-content: center; z-index: 50; backdrop-filter: blur(2px); }
        .dd-confirm-box { background: #1E2A3A; border-radius: 14px; padding: 24px; max-width: 300px; width: calc(100% - 32px); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 16px 48px rgba(0,0,0,0.5); }
        .dd-confirm-title { font-size: 16px; font-weight: 700; color: #F1F5F9; margin-bottom: 10px; }
        .dd-confirm-body { font-size: 13px; color: #9CA3AF; line-height: 1.5; margin-bottom: 10px; }
        .dd-confirm-warning { font-size: 12px; color: #F87171; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.18); border-radius: 8px; padding: 8px 12px; margin-bottom: 18px; }
        .dd-confirm-actions { display: flex; gap: 8px; }
        .dd-confirm-cancel { flex: 1; background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 9px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-confirm-cancel:hover:not(:disabled) { background: rgba(255,255,255,0.05); }
        .dd-confirm-ok { flex: 1; background: rgba(245,158,11,0.12); color: #F59E0B; border: 1px solid rgba(245,158,11,0.25); border-radius: 8px; padding: 9px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-confirm-ok:hover:not(:disabled) { background: rgba(245,158,11,0.2); }
        .dd-confirm-ok.danger { background: rgba(226,75,74,0.1); color: #F87171; border-color: rgba(226,75,74,0.25); }
        .dd-confirm-ok.danger:hover:not(:disabled) { background: rgba(226,75,74,0.18); }
        .dd-confirm-ok.green { background: rgba(29,158,117,0.1); color: #1D9E75; border-color: rgba(29,158,117,0.25); }
        .dd-action-edit { background: rgba(74,158,255,0.07); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 7px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-action-edit:hover { background: rgba(74,158,255,0.14); }
        .dd-vehicle-card { background: #1E2A3A; border-radius: 10px; padding: 13px; margin-bottom: 4px; border: 1px solid rgba(255,255,255,0.05); }
        .dd-vehicle-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .dd-vehicle-field { display: flex; flex-direction: column; gap: 4px; }
        .dd-vehicle-field-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; }
        .dd-vehicle-input { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; color: #F1F5F9; font-size: 13px; font-family: system-ui, sans-serif; padding: 6px 10px; outline: none; width: 100%; box-sizing: border-box; }
        .dd-vehicle-input:focus { border-color: rgba(74,158,255,0.4); }
        .dd-class-picker { display: flex; gap: 6px; flex-wrap: wrap; }
        .dd-class-option { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 7px 12px; cursor: pointer; text-align: left; font-family: system-ui, sans-serif; transition: border-color 0.12s, background 0.12s; }
        .dd-class-option.selected { border-color: #4a9eff; background: rgba(74,158,255,0.08); }
        .dd-class-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .dd-class-cap { font-size: 11px; color: #6B7280; margin-top: 1px; }
        .dd-vehicle-error { font-size: 12px; color: #F87171; margin-top: 8px; }
        .dd-vehicle-actions { display: flex; gap: 8px; margin-top: 12px; }
        .dd-vehicle-cancel { flex: 1; background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; }
        .dd-vehicle-cancel:hover { background: rgba(255,255,255,0.04); }
        .dd-vehicle-save { flex: 1; background: #E8500A; color: #fff; border: none; border-radius: 8px; padding: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .dd-vehicle-save:hover:not(:disabled) { background: #D6470B; }
        .dd-vehicle-save:disabled { opacity: 0.5; cursor: not-allowed; }
        .dd-confirm-ok.green:hover:not(:disabled) { background: rgba(29,158,117,0.18); }
        .dd-confirm-ok:disabled, .dd-confirm-cancel:disabled { opacity: 0.45; cursor: not-allowed; }
      `}</style>

      <div className="db-page">
        <nav
          className={`db-nav${navExpanded ? " expanded" : ""}`}
          onMouseEnter={() => setNavExpanded(true)}
          onMouseLeave={() => setNavExpanded(false)}
        >
          <div className="db-nav-logo">
            {navExpanded ? (
              <span className="db-nav-logo-text">{companyName ?? 'M&G C&J'}</span>
            ) : (
              <IconMenu />
            )}
          </div>
          <div className="db-nav-items">
            {NAV_ITEMS.map(({ tab: t, label }) => (
              <button
                key={t}
                className={`db-nav-item${tab === t && !showAnalytics && !showReports && !showDiscounts && !showSettings && !showAnnouncements && !showMessages ? " active" : ""}`}
                onClick={() => {
                  setTab(t);
                  navigateTo("main");
                  setSelectedDriver(null);
                }}
              >
                <span className="db-nav-icon">{NAV_ICONS[t]}</span>
                {navExpanded && <span className="db-nav-label">{label}</span>}
              </button>
            ))}
            <button
              className={`db-nav-item${showAnnouncements ? " active" : ""}`}
              onClick={() => {
                navigateTo("announcements");
                setSelectedDriver(null);
              }}
            >
              <span className="db-nav-icon">
                <IconAnnouncements />
              </span>
              {navExpanded && <span className="db-nav-label">Announcements</span>}
            </button>
            <button
              className={`db-nav-item${showMessages ? " active" : ""}`}
              onClick={() => {
                navigateTo("messages");
                setSelectedDriver(null);
              }}
            >
              <span className="db-nav-icon">
                <IconMessages />
                {driverChatUnreadCount > 0 && !showMessages && <span className="db-badge-dot" />}
              </span>
              {navExpanded && <span className="db-nav-label">Messages</span>}
              {navExpanded && driverChatUnreadCount > 0 && (
                <span className="db-badge-count">{driverChatUnreadCount}</span>
              )}
            </button>
          </div>
          <div className="db-nav-bottom">
            <div className="db-nav-profile" title={profile.name ?? "Dispatcher"}>
              <span className="db-nav-avatar">
                {(profile.name ?? "?").trim().charAt(0).toUpperCase()}
              </span>
              {navExpanded && (
                <span className="db-nav-profile-info">
                  <span className="db-nav-profile-name">
                    {profile.name ?? "Dispatcher"}
                  </span>
                  <span className="db-nav-profile-role">{profile.role}</span>
                </span>
              )}
            </div>
            <button
              className={`db-nav-utility db-nav-analytics${showAnalytics ? " active-util" : ""}`}
              onClick={() => {
                navigateTo("analytics");
                setSelectedDriver(null);
              }}
            >
              <span className="db-nav-icon">
                <IconAnalytics />
                {flaggedReviews > 0 && !showAnalytics && (
                  <span className="db-badge-dot" />
                )}
              </span>
              {navExpanded && <span className="db-nav-label">Analytics</span>}
              {navExpanded && flaggedReviews > 0 && (
                <span className="db-badge-count">{flaggedReviews}</span>
              )}
            </button>
            <button
              className={`db-nav-utility db-nav-reports${showReports ? " active-util" : ""}`}
              onClick={() => {
                navigateTo("reports");
                setSelectedDriver(null);
              }}
            >
              <span className="db-nav-icon">
                <IconReports />
                {openReports > 0 && !showReports && (
                  <span className="db-badge-dot" />
                )}
              </span>
              {navExpanded && <span className="db-nav-label">Reports</span>}
              {navExpanded && openReports > 0 && (
                <span className="db-badge-count">{openReports}</span>
              )}
            </button>
            {isAdmin && (
              <button
                className={`db-nav-utility db-nav-discounts${showDiscounts ? " active-util" : ""}`}
                onClick={() => {
                  navigateTo("discounts");
                  setSelectedDriver(null);
                }}
              >
                <span className="db-nav-icon">
                  <IconDiscounts />
                </span>
                {navExpanded && <span className="db-nav-label">Discounts</span>}
              </button>
            )}
            <button
              className={`db-nav-utility db-nav-settings${showSettings ? " active-util" : ""}`}
              onClick={() => {
                navigateTo("settings");
                setSelectedDriver(null);
              }}
            >
              <span className="db-nav-icon">
                <IconSettings />
              </span>
              {navExpanded && <span className="db-nav-label">Settings</span>}
            </button>
            <button
              className="db-nav-utility db-nav-signout"
              onClick={onSignOut}
            >
              <span className="db-nav-icon">
                <IconSignOut />
              </span>
              {navExpanded && <span className="db-nav-label">Sign out</span>}
            </button>
          </div>
        </nav>

        <div className="db-main">
          <div className="db-topbar">
            <span className="db-topbar-title">
              {selectedDriver
                ? (selectedDriver.profile?.name ?? "Driver")
                : topbarTitle}
            </span>
            {!showAnalytics && !showReports && !showDiscounts && !showSettings && !showAnnouncements && !showMessages && !selectedDriver && (
              <div className="db-stat-row">
                <div className="db-stat">
                  <span className="db-stat-value">
                    <span
                      className="db-stat-dot"
                      style={{ background: "#F59E0B" }}
                    />
                    {stats.activeRides}
                  </span>
                  <span className="db-stat-label">Active</span>
                </div>
                <div className="db-stat">
                  <span className="db-stat-value">
                    <span
                      className="db-stat-dot"
                      style={{ background: "#1D9E75" }}
                    />
                    {stats.driversOnline}
                  </span>
                  <span className="db-stat-label">Online</span>
                </div>
                <div className="db-stat">
                  <span className="db-stat-value">{stats.completedToday}</span>
                  <span className="db-stat-label">Today</span>
                </div>
                <div className="db-stat">
                  <span className="db-stat-value" style={{ color: "#1D9E75" }}>
                    ${stats.revenueToday.toFixed(2)}
                  </span>
                  <span className="db-stat-label">Revenue</span>
                </div>
              </div>
            )}
            {!showAnalytics && !showReports && !showDiscounts && !showSettings && !showAnnouncements && !showMessages && !selectedDriver ? (
              <>
                {/* Always present, so "nothing needs me" is a readable state
                    rather than an absence. Turns red only for act_now. */}
                <button
                  className={
                    "db-alert-btn" +
                    (alerts.some((a) => a.tier === "act_now") ? " hot" : "")
                  }
                  onClick={() => setAlertsOpen((v) => !v)}
                  title="Needs attention"
                >
                  ⚑ {alerts.length}
                </button>
                <button
                  className="db-new-ride-btn"
                  onClick={() => setBookingOpen(true)}
                >
                  + New ride
                </button>
              </>
            ) : (
              <button
                className="db-back-btn"
                onClick={() => {
                  if (selectedDriver) {
                    setSelectedDriver(null);
                    return;
                  }
                  navigateTo("main");
                }}
              >
                ← Back
              </button>
            )}
          </div>

          <div
            className="db-overlay"
            style={{ display: showAnalytics ? "flex" : "none" }}
          >
            <AnalyticsPage companyName={companyName} companyId={profile.company_id!} dispatcherId={profile.id} />
          </div>
          <div
            className="db-overlay"
            style={{ display: showReports ? "flex" : "none" }}
          >
            <ReportsPage onBadgeChange={setOpenReports} isActive={showReports} companyId={profile.company_id!} adminId={profile.id} companyName={companyName} />
          </div>

          <div
            className="db-overlay"
            style={{ display: showDiscounts ? "flex" : "none" }}
          >
            {profile.company_id && (
              <DiscountsPage companyId={profile.company_id} adminId={profile.id} />
            )}
          </div>

          <div
            className="db-overlay"
            style={{ display: showSettings ? "flex" : "none" }}
          >
            {profile.company_id && (
              <SettingsPage companyId={profile.company_id} adminId={profile.id} isAdmin={isAdmin} />
            )}
          </div>

          <div
            className="db-overlay"
            style={{ display: showAnnouncements ? "flex" : "none" }}
          >
            {profile.company_id && (
              <AnnouncementsPage companyId={profile.company_id} adminId={profile.id} />
            )}
          </div>

          <div
            className="db-overlay"
            style={{ display: showMessages ? "flex" : "none" }}
          >
            {profile.company_id && (
              <MessagesPage
                companyId={profile.company_id}
                adminId={profile.id}
                isActive={showMessages}
                onUnreadChange={(count) => setDriverChatUnreadCount(count)}
              />
            )}
          </div>

          {cancelPendingId && (
            <div className="dd-confirm-overlay" style={{ position: "fixed", zIndex: 1000 }} onClick={() => setCancelPendingId(null)}>
              <div className="dd-confirm-box" onClick={(e) => e.stopPropagation()}>
                <div className="dd-confirm-title">Cancel this ride?</div>
                <div className="dd-confirm-body">
                  {(() => {
                    const r = rides.find((x) => x.id === cancelPendingId);
                    if (!r) return "This action cannot be undone.";
                    const who = `${(r as any).passenger?.name ?? "Passenger"} · ${r.pickup_address}`;
                    // Mid-ride is a different act from cancelling a ride that
                    // hasn't started: the trip is under way and the driver is
                    // paid nothing for the distance already driven.
                    if (r.status === "in_progress") {
                      return (
                        <>
                          {who}
                          <div style={{ marginTop: 8, color: "#F59E0B" }}>
                            This ride is under way. Any card hold is released and
                            the driver is not paid for the distance already
                            driven. Their screen will end the trip.
                          </div>
                        </>
                      );
                    }
                    return who;
                  })()}
                </div>
                <div className="dd-confirm-actions">
                  <button className="dd-confirm-cancel" onClick={() => setCancelPendingId(null)}>Keep ride</button>
                  <button
                    className="dd-confirm-ok danger"
                    onClick={() => { cancelRide(cancelPendingId); setCancelPendingId(null); }}
                  >
                    Cancel ride
                  </button>
                </div>
              </div>
            </div>
          )}

          {confirmHoldAssign && (
            <div className="dd-confirm-overlay" style={{ position: "fixed", zIndex: 1000 }} onClick={() => setConfirmHoldAssign(null)}>
              <div className="dd-confirm-box" onClick={(e) => e.stopPropagation()}>
                <div className="dd-confirm-title">Assign anyway?</div>
                <div className="dd-confirm-body">
                  {confirmHoldAssign.name} is due at a scheduled pickup at{" "}
                  {shortTime(confirmHoldAssign.scheduledAt)}.
                  {confirmHoldAssign.minutesShort != null
                    ? ` Taking this ride would put them there about ${confirmHoldAssign.minutesShort} minutes late.`
                    : " Drive times were unavailable, so this can't be checked."}{" "}
                  Assign anyway only if you know something the estimate doesn't.
                </div>
                <div className="dd-confirm-actions">
                  <button className="dd-confirm-cancel" onClick={() => setConfirmHoldAssign(null)}>
                    Keep held
                  </button>
                  <button
                    className="dd-confirm-ok danger"
                    onClick={() => {
                      assignDriver(confirmHoldAssign.rideId, confirmHoldAssign.driverId);
                      setConfirmHoldAssign(null);
                    }}
                  >
                    Assign anyway
                  </button>
                </div>
              </div>
            </div>
          )}

          <div
            className="db-body"
            style={{
              display:
                showAnalytics || showReports || showDiscounts || showSettings || showAnnouncements || showMessages ? "none" : "flex",
              position: "relative",
            }}
          >
            {detailOverlayActive && (
              <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)", zIndex: 40, pointerEvents: "none" }} />
            )}

            <div className="db-panel">
              {tab === "rides" && (
                <>
                  <div className="db-panel-header">
                    <div className="db-panel-title">Active rides</div>
                    <div className="db-panel-count">{activeRides.length}</div>
                  </div>
                  <div className="db-panel-scroll">
                    {activeRides.length === 0 && (
                      <div className="db-empty">No active rides</div>
                    )}
                    {activeRides.map((ride) => (
                      <div
                        key={ride.id}
                        className={`db-ride-card${selectedRide === ride.id ? " selected" : ""}`}
                        onClick={() =>
                          rideDetail?.id === ride.id
                            ? setRideDetail(null)
                            : focusRideOnMap(ride)
                        }
                      >
                        <div className="db-ride-card-top">
                          <span
                            className="db-status-badge"
                            style={{
                              background: rideStatusColor(ride) + "18",
                              color: rideStatusColor(ride),
                              border: `1px solid ${rideStatusColor(ride)}30`,
                            }}
                          >
                            {rideStatusLabel(ride)}
                          </span>
                          <span className="db-ride-time">
                            {new Date(ride.created_at).toLocaleTimeString(
                              "en-CA",
                              { hour: "numeric", minute: "2-digit" },
                            )}
                          </span>
                        </div>
                        <div className="db-ride-name">
                          {(ride as any).passenger?.name ?? "Unknown passenger"}
                        </div>
                        <div className="db-ride-addr">
                          {ride.pickup_address}
                        </div>
                        <div className="db-ride-addr dest">
                          {ride.dropoff_address}
                        </div>
                        {ride.fare_estimate && (
                          <div className="db-ride-fare">
                            ${ride.fare_estimate.toFixed(2)}
                          </div>
                        )}
                        <AssignmentHold ride={ride} />
                        {(ride as any).passenger_flagged_at &&
                          !(ride as any).passenger_flag_resolved_at &&
                          (() => {
                            // Most urgent first — array_agg returns the reasons
                            // alphabetically, which would bury "not in the car"
                            // under "wrong destination".
                            const codes: string[] = [
                              ...((ride as any).passenger_flag_reasons ?? []),
                            ].sort(
                              (a, b) =>
                                FLAG_REASON_ORDER.indexOf(a) -
                                FLAG_REASON_ORDER.indexOf(b),
                            );
                            const note = (ride as any).passenger_flag_note;
                            // One reason reads as a sentence; several need a
                            // heading, or the list has nothing to hang off.
                            const single = codes.length <= 1;
                            return (
                              <div className="db-flag-box">
                                <span className="db-flag-glyph">⚑</span>
                                <div className="db-flag-body">
                                  <div className="db-flag-head">
                                    {single
                                      ? (FLAG_REASON_LABELS[codes[0]] ??
                                         "Problem reported")
                                      : `Passenger flagged ${codes.length} issues`}
                                  </div>
                                  {!single && (
                                    <ul className="db-flag-list">
                                      {codes.map((code) => (
                                        <li key={code} className="db-flag-item">
                                          <span>
                                            {FLAG_REASON_LABELS[code] ?? code}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {note && (
                                    <div className="db-flag-note">“{note}”</div>
                                  )}
                                  <button
                                    className="db-flag-resolve"
                                    style={{ marginTop: 6 }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      resolveFlag(ride.id);
                                    }}
                                  >
                                    Mark resolved
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        {(ride.status === "pending" ||
                          ride.status === "offered" ||
                          ride.status === "assigned") && (
                          <div style={{ marginTop: 8 }}>
                            {assigningRide === ride.id ? (
                              <>
                                <div className="db-assign-label">
                                  Assign driver:
                                  {conflictsLoading ? " checking conflicts…" : ""}
                                </div>
                                {[...onlineDrivers]
                                  .sort(
                                    (a, b) =>
                                      // Free drivers first, committed ones last.
                                      // Stable within each group, so the roster
                                      // order dispatch already knows survives.
                                      Number(!!conflicts.get(a.id)?.misses) -
                                      Number(!!conflicts.get(b.id)?.misses),
                                  )
                                  .map((d) => {
                                  const conflict = conflicts.get(d.id);
                                  const heldFor = conflict?.misses ? conflict : null;
                                  const dName = (d as any).profile?.name ?? "Driver";
                                  return (
                                    <button
                                      key={d.id}
                                      className="db-assign-driver-btn"
                                      style={
                                        heldFor
                                          ? {
                                              background: "rgba(245,158,11,0.07)",
                                              color: "#F59E0B",
                                              borderColor: "rgba(245,158,11,0.3)",
                                            }
                                          : undefined
                                      }
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        // Overriding the guard is the one assign
                                        // that can strand a passenger who booked
                                        // days ago. It gets a confirmation.
                                        if (heldFor) {
                                          setConfirmHoldAssign({
                                            rideId: ride.id,
                                            driverId: d.id,
                                            name: dName,
                                            scheduledAt: heldFor.commitment_at,
                                            minutesShort: heldFor.minutes_short,
                                          });
                                          return;
                                        }
                                        assignDriver(ride.id, d.id);
                                      }}
                                    >
                                      {dName}
                                      {((ride as any).declined_by ?? []).includes(d.id) ? " (declined)" : ""}
                                      {heldFor
                                        ? ` · ${heldFor.minutes_short != null ? `${heldFor.minutes_short}m late for` : "due at"} ${shortTime(heldFor.commitment_at)}`
                                        : ""}
                                    </button>
                                  );
                                })}
                                <button
                                  className="db-cancel-assign-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAssigningRide(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  className="db-assign-btn"
                                  style={{ flex: 1, marginTop: 0 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAssigningRide(ride.id);
                                  }}
                                >
                                  {ride.driver_id
                                    ? "Reassign driver"
                                    : "Assign driver"}
                                </button>
                                <button
                                  className="db-assign-btn"
                                  style={{ flex: 1, marginTop: 0 }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setRideDetail(ride);
                                    startEditRide(ride);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  className="db-cancel-ride-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCancelPendingId(ride.id);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {ride.status === "driver_arriving" && (
                          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                            <button
                              className="db-assign-btn"
                              style={{ flex: 1, marginTop: 0 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRideDetail(ride);
                                startEditRide(ride);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="db-cancel-ride-btn"
                              style={{ flex: 1 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setCancelPendingId(ride.id);
                              }}
                            >
                              Cancel ride
                            </button>
                          </div>
                        )}
                        {/* A ride in progress still needs dispatch controls:
                            a driver who mis-marks pickup traps the passenger,
                            who has no cancel and can't rebook. This is the only
                            way out. Both actions are already permitted
                            server-side for an admin actor. */}
                        {ride.status === "in_progress" && (
                          <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                            <button
                              className="db-assign-btn"
                              style={{ flex: 1, marginTop: 0 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setRideDetail(ride);
                                startEditRide(ride);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="db-cancel-ride-btn"
                              style={{ flex: 1 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setCancelPendingId(ride.id);
                              }}
                            >
                              Cancel ride
                            </button>
                          </div>
                        )}
                        {ride.status === "offered" && (
                          <div className="db-pending-badge">
                            ⏳ Awaiting driver confirmation
                          </div>
                        )}
                      </div>
                    ))}

                    {scheduledRides.length > 0 && (
                      <>
                        <div className="db-section-divider">
                          <span className="db-section-divider-title">
                            Scheduled rides
                          </span>
                          <span
                            className="db-section-divider-count"
                            style={{ color: "#A855F7" }}
                          >
                            {scheduledRides.length}
                          </span>
                        </div>
                        {(() => {
                          const soon = scheduledRides.filter((r: any) =>
                            r.scheduled_at && (new Date(r.scheduled_at).getTime() - Date.now()) <= 24 * 60 * 60_000
                          );
                          const uncovered = soon.filter((r: any) => r.coverage_status === "uncovered").length;
                          const atRisk    = soon.filter((r: any) => r.coverage_status === "at_risk").length;
                          const barColor  = uncovered > 0 ? "#F87171" : atRisk > 0 ? "#F59E0B" : "#1D9E75";
                          const barText   = uncovered > 0
                            ? `${uncovered} uncovered${atRisk > 0 ? ` · ${atRisk} at risk` : ""}`
                            : atRisk > 0
                              ? `${atRisk} at risk within 24 h`
                              : soon.length > 0 ? "All covered within 24 h" : "No rides in next 24 h";
                          return (
                            <div className="db-cov-bar" style={{ borderColor: barColor + "30", background: barColor + "0d" }}>
                              <span className="db-cov-bar-dot" style={{ background: barColor }} />
                              <span className="db-cov-bar-text" style={{ color: barColor }}>{barText}</span>
                            </div>
                          );
                        })()}
                        {scheduledRides.map((ride) => (
                          <ScheduledRideCard
                            key={ride.id}
                            ride={ride}
                            assigningRide={assigningRide}
                            onlineDrivers={onlineDrivers}
                            onCardClick={() => setRideDetail(ride)}
                            onAssign={() => setAssigningRide(ride.id)}
                            onCancelAssign={() => setAssigningRide(null)}
                            onAssignDriver={(driverId) =>
                              assignDriver(ride.id, driverId)
                            }
                            onEdit={() => {
                              setRideDetail(ride);
                              startEditRide(ride);
                            }}
                            onCancel={() => setCancelPendingId(ride.id)}
                          />
                        ))}
                      </>
                    )}

                    <div className="db-section-divider">
                      <span className="db-section-divider-title">Recent</span>
                      <span
                        className="db-section-divider-count"
                        style={{ color: "#6B7280" }}
                      >
                        {recentRides.length}
                      </span>
                    </div>
                    {recentRides.map((ride) => (
                      <div
                        key={ride.id}
                        className="db-ride-card dimmed"
                        onClick={() => setRideDetail(ride)}
                      >
                        <div className="db-ride-card-top">
                          <span
                            className="db-status-badge"
                            style={{
                              background: rideStatusColor(ride) + "18",
                              color: rideStatusColor(ride),
                              border: `1px solid ${rideStatusColor(ride)}30`,
                            }}
                          >
                            {rideStatusLabel(ride)}
                          </span>
                          <span
                            className="db-ride-fare"
                            style={{ marginTop: 0 }}
                          >
                            {ride.fare_final
                              ? `$${ride.fare_final.toFixed(2)}`
                              : ride.fare_estimate
                                ? `$${ride.fare_estimate.toFixed(2)}`
                                : ""}
                          </span>
                        </div>
                        <div className="db-ride-name" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                          <span>{(ride as any).passenger?.name ?? "Unknown"}</span>
                          <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 400 }}>
                            {new Date(ride.created_at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </span>
                        </div>
                        <div className="db-ride-addr">
                          {ride.pickup_address} → {ride.dropoff_address}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {tab === "drivers" && (
                <>
                  <div className="db-panel-header">
                    <div className="db-panel-title">Drivers</div>
                    <div className="db-panel-count">{drivers.filter(d => !(d as any).profile?.deleted_at).length}</div>
                  </div>
                  <div className="db-panel-scroll">
                    <div
                      className="db-section-divider"
                      style={{ marginTop: 0, borderTop: "none", paddingTop: 4 }}
                    >
                      <span className="db-section-divider-title">
                        Add driver
                      </span>
                    </div>
                    <form
                      onSubmit={createInvite}
                      className="db-invite-form"
                      style={{ marginTop: 8 }}
                    >
                      <input
                        className="db-invite-input"
                        placeholder="Full name"
                        value={inviteName}
                        onChange={(e) => setInviteName(e.target.value)}
                      />
                      <div className="db-phone-wrap">
                        <span className="db-phone-prefix">+1</span>
                        <input
                          className="db-phone-input"
                          placeholder="(902) 123-4567"
                          value={invitePhone}
                          onChange={(e) => setInvitePhone(formatPhoneInput(e.target.value))}
                          maxLength={14}
                          inputMode="numeric"
                        />
                      </div>
                      <button
                        className="db-invite-btn"
                        type="submit"
                        disabled={inviteLoading}
                      >
                        {inviteLoading ? "Creating…" : "Generate invite code"}
                      </button>
                    </form>
                    {inviteSuccess && (
                      <div className="db-invite-success">
                        <div
                          style={{
                            fontSize: 11,
                            color: "#1D9E75",
                            marginBottom: 4,
                          }}
                        >
                          Invite code created!
                        </div>
                        <div
                          style={{
                            fontSize: 24,
                            fontWeight: 700,
                            letterSpacing: "0.2em",
                            color: "#F1F5F9",
                          }}
                        >
                          {inviteSuccess}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            marginTop: 4,
                          }}
                        >
                          Only works for the registered number.
                        </div>
                        <button
                          className="db-cancel-assign-btn"
                          style={{ marginTop: 8 }}
                          onClick={() => setInviteSuccess("")}
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                    {pendingInvites.length > 0 && (
                      <>
                        <div className="db-section-divider">
                          <span className="db-section-divider-title">
                            Pending invites
                          </span>
                          <span
                            className="db-section-divider-count"
                            style={{ color: "#F59E0B" }}
                          >
                            {pendingInvites.length}
                          </span>
                        </div>
                        {pendingInvites.map((invite) => (
                          <div key={invite.id} className="db-invite-card">
                            <div className="db-invite-card-top">
                              <div className="db-invite-name">
                                {invite.name}
                              </div>
                              <span
                                className="db-status-badge"
                                style={{
                                  background: "#F59E0B18",
                                  color: "#F59E0B",
                                  border: "1px solid #F59E0B30",
                                }}
                              >
                                Pending
                              </span>
                            </div>
                            <div className="db-invite-phone">
                              {invite.phone}
                            </div>
                            <div className="db-invite-code-row">
                              <span className="db-invite-code">
                                {invite.code}
                              </span>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  className="db-revoke-btn"
                                  style={{ fontSize: 11 }}
                                  onClick={() => navigator.clipboard.writeText(invite.code)}
                                  title="Copy code"
                                >
                                  Copy
                                </button>
                                <button
                                  className="db-revoke-btn"
                                  onClick={() => revokeInvite(invite.id)}
                                >
                                  Revoke
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                    <div className="db-section-divider">
                      <span className="db-section-divider-title">
                        All drivers
                      </span>
                      <span
                        className="db-section-divider-count"
                        style={{ color: "#6B7280" }}
                      >
                        {drivers.filter(d => !(d as any).profile?.deleted_at).length}
                      </span>
                    </div>
                    <input
                      className="db-driver-search"
                      placeholder="Search by name, phone, vehicle or plate…"
                      value={driverSearch}
                      onChange={e => setDriverSearch(e.target.value)}
                    />
                    {filteredDrivers.length === 0 && (
                      <div className="db-empty">{driverSearch.trim() ? "No drivers match your search" : "No drivers registered yet"}</div>
                    )}
                    {filteredDrivers.map((driver) => {
                      const driverActiveRide = rides.find(
                        (r) =>
                          r.driver_id === driver.id &&
                          [
                            "offered",
                            "assigned",
                            "driver_arriving",
                            "in_progress",
                          ].includes(r.status),
                      );
                      const avatarUrl = (driver as any).profile?.avatar_url;
                      const isAccountActive: boolean = (driver as any).profile?.is_active ?? true;
                      const isDeactivationPending: boolean = (driver as any).profile?.deactivation_pending ?? false;
                      return (
                        <div
                          key={driver.id}
                          className="db-driver-card"
                          style={!isAccountActive ? { opacity: 0.65 } : undefined}
                          onClick={() => setSelectedDriver(driver)}
                        >
                          <div className="db-driver-card-top">
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt=""
                                className="db-driver-avatar-photo"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display =
                                    "none";
                                }}
                              />
                            ) : (
                              <div className="db-driver-avatar">
                                {((driver as any).profile?.name ?? "D")
                                  .split(" ")
                                  .map((n: string) => n[0])
                                  .join("")
                                  .slice(0, 2)}
                              </div>
                            )}
                            <div style={{ flex: 1 }}>
                              <div className="db-driver-name">
                                {(driver as any).profile?.name ?? "Unknown"}
                              </div>
                              <div className="db-driver-sub">
                                {driver.vehicle_make} {driver.vehicle_model} ·{" "}
                                {driver.plate_number}
                                {(driver as any).vehicle_class_name ? ` · ${(driver as any).vehicle_class_name}` : ""}
                              </div>
                              {!isAccountActive ? (
                                <div style={{ fontSize: 11, color: "#F87171", marginTop: 3, fontWeight: 500 }}>
                                  Deactivated
                                </div>
                              ) : isDeactivationPending ? (
                                <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 3, fontWeight: 500 }}>
                                  ⏳ Deactivation pending
                                </div>
                              ) : driver.is_active ? (
                                driverActiveRide ? (
                                  <div className="db-driver-status-on-ride">
                                    ● On a ride
                                  </div>
                                ) : (
                                  <div className="db-driver-status-available">
                                    ● Available
                                  </div>
                                )
                              ) : null}
                            </div>
                            <div
                              className="db-online-dot"
                              style={{
                                background: !isAccountActive
                                  ? "#E24B4A"
                                  : driver.is_active
                                  ? "#1D9E75"
                                  : "#374151",
                              }}
                            />
                          </div>
                          <div className="db-driver-phone">
                            {(driver as any).profile?.phone ?? ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="db-map-wrap">
              {alertsOpen && (
                <div className="db-alerts">
                  <div className="db-alerts-head">
                    <span className="db-alerts-title">Needs attention</span>
                    {alerts.length > 0 && (
                      <span className="db-alerts-count">{alerts.length}</span>
                    )}
                    <button
                      className="db-alerts-close"
                      style={{ marginLeft: "auto" }}
                      onClick={() => {
                        const next = !alertSound;
                        setAlertSound(next);
                        localStorage.setItem(
                          "db-alert-sound",
                          next ? "on" : "off",
                        );
                        if (next) playAlertChime(); // confirm what you enabled
                      }}
                      title={
                        alertSound
                          ? "Sound on — click to mute"
                          : "Sound muted — click to unmute"
                      }
                    >
                      {alertSound ? "🔔" : "🔕"}
                    </button>
                    <button
                      className="db-alerts-close"
                      style={{ marginLeft: 0 }}
                      onClick={() => setAlertsOpen(false)}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                  {alerts.length === 0 ? (
                    <div className="db-alerts-empty">Nothing needs attention.</div>
                  ) : (
                    <div className="db-alerts-scroll">
                      {alerts.map((a) => {
                        const ride = rides.find((r) => r.id === a.rideId);
                        return (
                          <button
                            key={a.key}
                            className={
                              "db-alert-row" +
                              (a.source === "passenger_flag" ? " flag" : "")
                            }
                            onClick={() => {
                              // Into the board, not an action in isolation.
                              // focusRideOnMap, not a bare setRideDetail: it
                              // also sets selectedRide and frames the map with
                              // the route, which is what the ride card does and
                              // what makes the click land somewhere useful.
                              if (ride) focusRideOnMap(ride);
                            }}
                          >
                            <span className="db-alert-glyph">
                              {a.source === "passenger_flag" ? "⚑" : "⌛"}
                            </span>
                            <span className="db-alert-body">
                              <span className="db-alert-title">{a.title}</span>
                              {a.detail && (
                                <span className="db-alert-detail">{a.detail}</span>
                              )}
                              <span className="db-alert-meta">
                                {(ride as any)?.passenger?.name ?? "Passenger"}
                                {" · "}
                                {new Date(a.at).toLocaleTimeString("en-CA", {
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {selectedDriver && (
                <DriverDetailPanel
                  driver={selectedDriver}
                  rides={rides}
                  companyId={profile.company_id!}
                  dispatcherId={profile.id}
                  onClose={() => { setSelectedDriver(null); setDetailOverlayActive(false); }}
                  onDeactivate={(hasActiveRide) => deactivateDriver(selectedDriver.id, hasActiveRide)}
                  onActivate={() => activateDriver(selectedDriver.id)}
                  onDelete={() => deleteDriver(selectedDriver.id)}
                  onVehicleUpdated={(updates) => { setSelectedDriver((prev: any) => ({ ...prev, ...updates })); fetchDrivers(); }}
                  onOverlayChange={setDetailOverlayActive}
                />
              )}
              <div
                ref={mapRef}
                className="db-map"
                style={{ visibility: selectedDriver ? "hidden" : "visible" }}
              />

              {rideDetail && !editingRide && !selectedDriver && LIVE_STATUSES.has(rideDetail.status) && (() => {
                const rd = rideDetail;
                const pax = (rd as any).passenger;
                const drvProfile = (rd as any).driver?.profile;
                const drvRow = rd.driver_id ? drivers.find((d) => d.id === rd.driver_id) : null;
                const tracking = !!(drvRow && (drvRow as any).current_lat && (drvRow as any).current_lng);
                const vehicle = drvRow
                  ? [drvRow.vehicle_make, drvRow.vehicle_model].filter(Boolean).join(" ")
                  : "";
                const color = rideStatusColor(rd);
                return (
                  <div className="db-ride-float">
                    <div className="db-ride-float-head">
                      <span
                        className="db-status-badge"
                        style={{ background: color + "18", color, border: `1px solid ${color}30` }}
                      >
                        {rideStatusLabel(rd)}
                      </span>
                      <span className="db-ride-float-time">
                        {new Date(rd.created_at).toLocaleTimeString("en-CA", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                      <button
                        className="db-ride-float-close"
                        onClick={() => setRideDetail(null)}
                        title="Close"
                      >
                        ×
                      </button>
                    </div>

                    <div className="db-ride-float-pax">{pax?.name ?? "Unknown passenger"}</div>

                    {/* Driver */}
                    <div className="db-live-driver">
                      <div>
                        <div className="db-live-driver-name">
                          {rd.driver_id ? (drvProfile?.name ?? "Driver") : "Unassigned"}
                        </div>
                        {vehicle && <div className="db-live-driver-veh">{vehicle}</div>}
                      </div>
                      {rd.driver_id && (
                        <span className="db-live-track" style={{ color: tracking ? "#1D9E75" : "#6B7280" }}>
                          <span className="db-live-dot" style={{ background: tracking ? "#1D9E75" : "#6B7280" }} />
                          {tracking ? "Live" : "No signal"}
                        </span>
                      )}
                    </div>

                    {/* Route */}
                    <div className="db-live-route">
                      <div className="db-live-stop">
                        <span className="db-live-stop-dot" style={{ background: "#4a9eff" }} />
                        <div>
                          <div className="db-live-stop-label">Pickup</div>
                          <div className="db-live-stop-addr">{rd.pickup_address}</div>
                        </div>
                      </div>
                      <div className="db-live-stop">
                        <span className="db-live-stop-dot" style={{ background: "#E8500A" }} />
                        <div>
                          <div className="db-live-stop-label">Drop-off</div>
                          <div className="db-live-stop-addr">{rd.dropoff_address}</div>
                        </div>
                      </div>
                    </div>

                    {/* Fare / payment */}
                    <div className="db-live-chips">
                      <span className="db-live-chip">
                        {rd.fare_estimate ? `$${rd.fare_estimate.toFixed(2)}` : "—"}
                      </span>
                      <span className="db-live-chip" style={{ textTransform: "capitalize" }}>
                        {rd.payment_method}
                      </span>
                    </div>

                    {/* Contact — copy number, no link launch */}
                    {(pax?.phone || drvProfile?.phone) && (
                      <div className="db-ride-float-contacts">
                        {pax?.phone && (
                          <div className="db-phone-row">
                            <span className="db-phone-role">Passenger</span>
                            <span className="db-phone-num">{pax.phone}</span>
                            <button className="db-phone-copy" onClick={() => copyPhone(pax.phone)}>
                              {copiedPhone === pax.phone ? "Copied" : "Copy"}
                            </button>
                          </div>
                        )}
                        {drvProfile?.phone && (
                          <div className="db-phone-row">
                            <span className="db-phone-role">Driver</span>
                            <span className="db-phone-num">{drvProfile.phone}</span>
                            <button className="db-phone-copy" onClick={() => copyPhone(drvProfile.phone)}>
                              {copiedPhone === drvProfile.phone ? "Copied" : "Copy"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {bookingOpen && (
        <div className="db-modal-overlay">
          <div className="db-modal">
            <div className="db-modal-title">New ride</div>
            <form
              onSubmit={createManualBooking}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div>
                <label className="db-modal-label">Passenger phone *</label>
                <input
                  autoFocus
                  className="db-modal-input"
                  placeholder="+1 (902) 555-1234"
                  value={bookPassenger}
                  onChange={(e) => {
                    setBookPassenger(formatBookingPhone(e.target.value));
                    setBookPassengerRegistered(false);
                  }}
                  onBlur={async () => {
                    const phone = toE164(bookPassenger);
                    if (phone.replace(/\D/g, "").length < 11) return;
                    const { data } = await supabase
                      .from("profiles")
                      .select("name")
                      .eq("phone", phone)
                      .maybeSingle();
                    if (data?.name) {
                      setBookPassengerName(data.name);
                      setBookPassengerRegistered(true);
                    } else {
                      setBookPassengerRegistered(false);
                    }
                  }}
                  required
                />
              </div>
              <div>
                <label className="db-modal-label">
                  Passenger name{" "}
                  {bookPassengerRegistered ? (
                    <span
                      style={{
                        fontSize: 10,
                        color: "#1D9E75",
                        fontWeight: 400,
                        marginLeft: 6,
                        textTransform: "none",
                        letterSpacing: 0,
                      }}
                    >
                      Registered
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 10,
                        color: "#6B7280",
                        fontWeight: 400,
                        marginLeft: 6,
                        textTransform: "none",
                        letterSpacing: 0,
                      }}
                    >
                      (if not registered)
                    </span>
                  )}
                </label>
                <input
                  className="db-modal-input"
                  placeholder="Guest name"
                  value={bookPassengerName}
                  onChange={(e) => setBookPassengerName(e.target.value)}
                  readOnly={bookPassengerRegistered}
                  style={bookPassengerRegistered ? { opacity: 0.5, cursor: "default" } : undefined}
                />
              </div>
              <div style={{ position: "relative" }}>
                <label className="db-modal-label">Pickup address *</label>
                <input
                  ref={pickupInputRef}
                  className="db-modal-input"
                  placeholder="Start typing an address…"
                  value={bookPickup}
                  onChange={(e) => {
                    setBookPickup(e.target.value);
                    setBookPickupCoords(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  required
                />
                {bookPickupCoords && (
                  <span
                    style={{
                      position: "absolute",
                      right: 10,
                      top: 34,
                      fontSize: 11,
                      color: "#1D9E75",
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
              <div style={{ position: "relative" }}>
                <label className="db-modal-label">Drop-off address *</label>
                <input
                  ref={dropoffInputRef}
                  className="db-modal-input"
                  placeholder="Start typing an address…"
                  value={bookDropoff}
                  onChange={(e) => {
                    setBookDropoff(e.target.value);
                    setBookDropoffCoords(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  required
                />
                {bookDropoffCoords && (
                  <span
                    style={{
                      position: "absolute",
                      right: 10,
                      top: 34,
                      fontSize: 11,
                      color: "#1D9E75",
                    }}
                  >
                    ✓
                  </span>
                )}
              </div>
              <div>
                <label className="db-modal-label">
                  Estimated fare
                  {bookFareLoading && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "#6B7280",
                        fontWeight: 400,
                        marginLeft: 6,
                      }}
                    >
                      Calculating…
                    </span>
                  )}
                  {!bookFareLoading &&
                    bookFare &&
                    bookPickupCoords &&
                    bookDropoffCoords && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#1D9E75",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        {bookDiscountCode ? "Auto-calculated · discount applied" : "Auto-calculated"}
                      </span>
                    )}
                </label>
                <input
                  className="db-modal-input"
                  placeholder="0.00"
                  type="number"
                  step="0.01"
                  value={bookFare}
                  onChange={(e) => setBookFare(e.target.value)}
                />
                {bookFareError && (
                  <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>
                    Could not auto-calculate — enter a fare manually.
                  </div>
                )}
              </div>
              {vehicleClasses.length > 1 && (
                <div>
                  <label className="db-modal-label">Vehicle class</label>
                  <select
                    className="db-modal-select"
                    value={bookVehicleClassId}
                    onChange={(e) => setBookVehicleClassId(e.target.value)}
                  >
                    <option value="">— Any vehicle —</option>
                    {vehicleClasses.map((vc) => (
                      <option key={vc.id} value={vc.id}>
                        {vc.name}
                        {vc.capacity ? ` · seats ${vc.capacity}` : ""}
                        {vc.surcharge_percent ? ` · +${vc.surcharge_percent}%` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="db-modal-label">
                  Discount code{" "}
                  <span
                    style={{
                      fontSize: 10,
                      color: "#6B7280",
                      fontWeight: 400,
                      marginLeft: 6,
                      textTransform: "none",
                      letterSpacing: 0,
                    }}
                  >
                    (optional — overridden by a verified student discount)
                  </span>
                </label>
                <select
                  className="db-modal-select"
                  value={bookDiscountCode}
                  onChange={(e) => setBookDiscountCode(e.target.value)}
                >
                  <option value="">— No discount —</option>
                  {availableDiscountCodes.map((c) => (
                    <option key={c.id} value={c.code}>
                      {c.code}
                      {c.label ? ` — ${c.label}` : ""} ·{" "}
                      {c.amount_type === "percent"
                        ? `${c.amount}% off`
                        : `$${c.amount.toFixed(2)} off`}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="db-modal-label">Assign driver</label>
                <select
                  className="db-modal-select"
                  value={bookDriver}
                  onChange={(e) => {
                    setBookDriver(e.target.value);
                    if (e.target.value) {
                      setBookPreferredDriver("");
                      setBookPreferredExclusive(false);
                    }
                  }}
                >
                  <option value="">— No driver yet —</option>
                  {onlineDrivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {(d as any).profile?.name ?? "Driver"} · {d.vehicle_make}{" "}
                      {d.vehicle_model}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="db-modal-label">Schedule for</label>
                <input
                  className="db-modal-input"
                  type="datetime-local"
                  value={bookScheduled}
                  onChange={(e) => setBookScheduled(e.target.value)}
                />
              </div>
              {bookScheduled && !bookDriver && (
                <div>
                  <label className="db-modal-label">
                    Preferred driver{" "}
                    <span
                      style={{
                        fontSize: 10,
                        color: "#6B7280",
                        fontWeight: 400,
                        marginLeft: 6,
                        textTransform: "none",
                        letterSpacing: 0,
                      }}
                    >
                      (optional — release stays automatic, this just biases who it goes to)
                    </span>
                  </label>
                  <select
                    className="db-modal-select"
                    value={bookPreferredDriver}
                    onChange={(e) => setBookPreferredDriver(e.target.value)}
                  >
                    <option value="">— No preference —</option>
                    {drivers
                      .filter(
                        (d) =>
                          d.is_active &&
                          (!bookVehicleClassId ||
                            !d.vehicle_class_id ||
                            d.vehicle_class_id === bookVehicleClassId),
                      )
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {(d as any).profile?.name ?? "Driver"} · {d.vehicle_make}{" "}
                          {d.vehicle_model}
                        </option>
                      ))}
                  </select>
                  {bookPreferredDriver && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginTop: 8,
                        fontSize: 12,
                        color: "#9CA3AF",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={bookPreferredExclusive}
                        onChange={(e) => setBookPreferredExclusive(e.target.checked)}
                      />
                      Exclusive — only offer to this driver, never substitute
                    </label>
                  )}
                </div>
              )}
              {bookError && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#F87171",
                    background: "rgba(248,113,113,0.08)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    border: "1px solid rgba(248,113,113,0.2)",
                  }}
                >
                  {bookError}
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button
                  className="db-modal-cancel-btn"
                  type="button"
                  onClick={() => {
                    setBookingOpen(false);
                    setBookError(null);
                    setBookFareError(false);
                    setBookPassenger("+1 ");
                    setBookPassengerRegistered(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="db-modal-submit-btn"
                  type="submit"
                  disabled={bookLoading}
                >
                  {bookLoading ? "Creating…" : "Create ride"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rideDetail && (editingRide || !LIVE_STATUSES.has(rideDetail.status)) && (
        <div
          className="db-modal-overlay"
          onClick={() => {
            setRideDetail(null);
            setEditingRide(false);
          }}
        >
          <div
            className="db-modal"
            style={{ maxWidth: 480 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <div className="db-modal-title" style={{ marginBottom: 0 }}>
                {editingRide ? "Edit ride" : "Ride details"}
              </div>
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: "#6B7280",
                  cursor: "pointer",
                  fontSize: 20,
                }}
                onClick={() => {
                  setRideDetail(null);
                  setEditingRide(false);
                }}
              >
                ×
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 16,
                flexWrap: "wrap",
              }}
            >
              <span
                className="db-status-badge"
                style={{
                  background: rideStatusColor(rideDetail) + "18",
                  color: rideStatusColor(rideDetail),
                  border: `1px solid ${rideStatusColor(rideDetail)}30`,
                }}
              >
                {rideStatusLabel(rideDetail)}
              </span>
              <span style={{ fontSize: 12, color: "#6B7280" }}>
                {new Date(rideDetail.created_at).toLocaleString("en-CA", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </div>

            {editingRide ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {/* Pickup is history once the passenger is aboard, and
                    edit-ride's PICKUP_EDITABLE_ADMIN stops before in_progress —
                    so lock the field rather than let dispatch type an edit the
                    server will reject. */}
                <div style={{ position: "relative" }}>
                  <label className="db-modal-label">Pickup address</label>
                  <input
                    ref={editPickupInputRef}
                    className="db-modal-input"
                    placeholder="Start typing an address…"
                    value={editPickup}
                    disabled={rideDetail.status === "in_progress"}
                    title={
                      rideDetail.status === "in_progress"
                        ? "The passenger is already aboard — pickup can't be changed."
                        : undefined
                    }
                    onChange={(e) => {
                      setEditPickup(e.target.value);
                      setEditPickupCoords(null);
                    }}
                    required
                  />
                  {rideDetail.status === "in_progress" && (
                    <div className="db-modal-hint">
                      Passenger is aboard — pickup can't be changed.
                    </div>
                  )}
                  {editPickupCoords && (
                    <span
                      style={{
                        position: "absolute",
                        right: 10,
                        top: 34,
                        fontSize: 11,
                        color: "#1D9E75",
                      }}
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div style={{ position: "relative" }}>
                  <label className="db-modal-label">Drop-off address</label>
                  <input
                    ref={editDropoffInputRef}
                    className="db-modal-input"
                    placeholder="Start typing an address…"
                    value={editDropoff}
                    onChange={(e) => {
                      setEditDropoff(e.target.value);
                      setEditDropoffCoords(null);
                    }}
                    required
                  />
                  {editDropoffCoords && (
                    <span
                      style={{
                        position: "absolute",
                        right: 10,
                        top: 34,
                        fontSize: 11,
                        color: "#1D9E75",
                      }}
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div>
                  <label className="db-modal-label">
                    Fare estimate
                    {editFareLoading && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#6B7280",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        Calculating…
                      </span>
                    )}
                    {!editFareLoading && editAddressChanged && !editFareTouched && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#1D9E75",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        Preview — confirmed on save
                      </span>
                    )}
                    {editFareTouched && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#E8500A",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        Manual — overrides the calculated fare
                      </span>
                    )}
                  </label>
                  <input
                    className="db-modal-input"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={editFare}
                    onChange={(e) => {
                      setEditFare(e.target.value);
                      setEditFareTouched(true);
                    }}
                  />
                  {rideDetail.status === "in_progress" && !editFareTouched && (
                    <div className="db-modal-hint">
                      Ride under way — the fare is recalculated on save as the
                      distance already driven plus the distance still to drive,
                      so it won't match this preview.
                    </div>
                  )}
                </div>
                {/* Hidden mid-ride: the passenger is in whatever car turned
                    up, so a class change here would only move the surcharge.
                    Dispatch corrects the money with the fare box instead. */}
                {vehicleClasses.length > 1 && rideDetail.status !== "in_progress" && (
                  <div>
                    <label className="db-modal-label">Vehicle class</label>
                    <select
                      className="db-modal-select"
                      value={editVehicleClassId}
                      onChange={(e) => {
                        setEditVehicleClassId(e.target.value);
                        setEditVehicleClassTouched(true);
                      }}
                    >
                      <option value="">— Any vehicle —</option>
                      {vehicleClasses.map((vc) => (
                        <option key={vc.id} value={vc.id}>
                          {vc.name}
                          {vc.capacity ? ` · seats ${vc.capacity}` : ""}
                          {vc.surcharge_percent ? ` · +${vc.surcharge_percent}%` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="db-modal-label">Payment method</label>
                  <select
                    className="db-modal-select"
                    value={editPayment}
                    disabled
                    title="Payment method is fixed at booking and can't be changed here."
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                  </select>
                  <div className="db-modal-hint">Set at booking — can't be changed here.</div>
                </div>
                {/* A booked time can move until the pickup actually happens —
                    edit-ride allows it through `assigned`, and dispatch moving
                    a confirmed driver's ride is a real job. Doing so clears the
                    driver's confirmation and asks them to re-accept. */}
                {!!rideDetail.scheduled_at &&
                  ["scheduled", "pending", "offered", "assigned"].includes(
                    rideDetail.status,
                  ) && (
                  <div>
                    <label className="db-modal-label">Scheduled for</label>
                    <input
                      className="db-modal-input"
                      type="datetime-local"
                      value={editScheduled}
                      onChange={(e) => setEditScheduled(e.target.value)}
                    />
                  </div>
                )}
                {rideDetail.status === "scheduled" && !rideDetail.driver_id && (
                  <div>
                    <label className="db-modal-label">
                      Preferred driver{" "}
                      <span
                        style={{
                          fontSize: 10,
                          color: "#6B7280",
                          fontWeight: 400,
                          marginLeft: 6,
                          textTransform: "none",
                          letterSpacing: 0,
                        }}
                      >
                        (optional — release stays automatic, this just biases who it goes to)
                      </span>
                    </label>
                    <select
                      className="db-modal-select"
                      value={editPreferredDriver}
                      onChange={(e) => setEditPreferredDriver(e.target.value)}
                    >
                      <option value="">— No preference —</option>
                      {drivers
                        .filter(
                          (d) =>
                            d.is_active &&
                            (!editVehicleClassId ||
                              !d.vehicle_class_id ||
                              d.vehicle_class_id === editVehicleClassId),
                        )
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {(d as any).profile?.name ?? "Driver"} · {d.vehicle_make}{" "}
                            {d.vehicle_model}
                          </option>
                        ))}
                    </select>
                    {editPreferredDriver && (
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginTop: 8,
                          fontSize: 12,
                          color: "#9CA3AF",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={editPreferredExclusive}
                          onChange={(e) => setEditPreferredExclusive(e.target.checked)}
                        />
                        Exclusive — only offer to this driver, never substitute
                      </label>
                    )}
                  </div>
                )}
                {editError && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "#F87171",
                      background: "rgba(248,113,113,0.08)",
                      borderRadius: 8,
                      padding: "8px 12px",
                      border: "1px solid rgba(248,113,113,0.2)",
                    }}
                  >
                    {editError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                  <button
                    className="db-modal-cancel-btn"
                    type="button"
                    onClick={() => {
                      setEditingRide(false);
                      setEditError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="db-modal-submit-btn"
                    type="button"
                    disabled={editSaving}
                    onClick={() => saveRideEdits(rideDetail.id)}
                  >
                    {editSaving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {(
                  [
                    [
                      "Passenger",
                      (rideDetail as any).passenger?.name ?? "Unknown",
                    ],
                    ["Phone", (rideDetail as any).passenger?.phone ?? "—"],
                    [
                      "Driver",
                      rideDetail.driver_id
                        ? `${(rideDetail as any).driver?.profile?.name ?? "Driver"}${
                            rideDetail.status === "scheduled" &&
                            !(rideDetail as any).confirmed_by_driver
                              ? " (pending confirmation)"
                              : ""
                          }`
                        : "Unassigned",
                    ],
                    ["Pickup", rideDetail.pickup_address],
                    ["Drop-off", rideDetail.dropoff_address],
                    [
                      "Fare estimate",
                      rideDetail.fare_estimate
                        ? `$${rideDetail.fare_estimate.toFixed(2)}`
                        : "—",
                    ],
                    [
                      "Fare final",
                      rideDetail.fare_final
                        ? `$${rideDetail.fare_final.toFixed(2)}`
                        : "—",
                    ],
                    ["Payment", rideDetail.payment_method],
                    ...(rideDetail.payment_method === "card" && rideDetail.settlement_route
                      ? ([
                          [
                            "Vellon fee",
                            rideDetail.fare_final != null &&
                            rideDetail.platform_fee_percent_at_completion != null
                              ? `$${(
                                  rideDetail.fare_final *
                                  (rideDetail.platform_fee_percent_at_completion / 100)
                                ).toFixed(2)} (${rideDetail.platform_fee_percent_at_completion}%)`
                              : "—",
                          ],
                          [
                            "Card processing fee",
                            rideDetail.stripe_fee != null
                              ? `$${rideDetail.stripe_fee.toFixed(2)}`
                              : "Pending",
                          ],
                          [
                            "Net settled",
                            rideDetail.fare_final != null &&
                            rideDetail.platform_fee_percent_at_completion != null &&
                            rideDetail.stripe_fee != null
                              ? `$${(
                                  rideDetail.fare_final -
                                  rideDetail.fare_final *
                                    (rideDetail.platform_fee_percent_at_completion / 100) -
                                  rideDetail.stripe_fee
                                ).toFixed(2)}`
                              : "—",
                          ],
                          [
                            "Settlement",
                            SETTLEMENT_ROUTE_LABELS[rideDetail.settlement_route] ??
                              rideDetail.settlement_route,
                          ],
                          ...(rideDetail.refunded_amount_cents &&
                          rideDetail.refunded_amount_cents > 0
                            ? ([
                                [
                                  "Refunded to passenger",
                                  `$${(rideDetail.refunded_amount_cents / 100).toFixed(2)}` +
                                    (rideDetail.refund_reason
                                      ? ` (${REFUND_REASON_LABELS[rideDetail.refund_reason] ?? rideDetail.refund_reason})`
                                      : ""),
                                ],
                                ...(rideDetail.transfer_reversed_cents &&
                                rideDetail.transfer_reversed_cents > 0
                                  ? ([
                                      [
                                        "Clawed back from payout",
                                        `$${(rideDetail.transfer_reversed_cents / 100).toFixed(2)}`,
                                      ],
                                    ] as [string, string][])
                                  : []),
                              ] as [string, string][])
                            : []),
                        ] as [string, string][])
                      : []),
                    [
                      "Scheduled",
                      rideDetail.scheduled_at
                        ? new Date(rideDetail.scheduled_at).toLocaleString(
                            "en-CA",
                          )
                        : "Immediate",
                    ],
                    ...(rideDetail.status === "cancelled" && rideDetail.cancelled_reason
                      ? ([[
                          "Cancelled reason",
                          CANCEL_REASON_LABELS[rideDetail.cancelled_reason] ?? rideDetail.cancelled_reason,
                        ]] as [string, string][])
                      : []),
                    ...(rideDetail.declined_by && rideDetail.declined_by.length > 0
                      ? ([[
                          "Declined by",
                          [...new Set(rideDetail.declined_by)]
                            .map((id) => drivers.find((d) => d.id === id)?.profile?.name ?? "Unknown driver")
                            .join(", "),
                        ]] as [string, string][])
                      : []),
                  ] as [string, string][]
                ).map(([label, value]) => {
                  const isSettlementWarning =
                    label === "Settlement" &&
                    ["transfer_failed", "transfer_reversed", "refund_reversed", "refund_review", "reversal_failed", "retransfer_failed"].includes(
                      rideDetail.settlement_route ?? "",
                    );
                  return (
                    <div
                      key={label}
                      className={`db-detail-row${isSettlementWarning ? " db-detail-row-warning" : ""}`}
                    >
                      <span className="db-detail-label">{label}</span>
                      <span
                        className={`db-detail-value${isSettlementWarning ? " db-detail-value-warning" : ""}`}
                      >
                        {value}
                      </span>
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button
                    className="db-modal-cancel-btn"
                    style={{ flex: 1 }}
                    onClick={() => setRideDetail(null)}
                  >
                    Close
                  </button>
                  {!NON_EDITABLE_STATUSES.has(rideDetail.status) && (
                    <button
                      className="db-modal-submit-btn"
                      style={{ flex: 1 }}
                      onClick={() => startEditRide(rideDetail)}
                    >
                      Edit
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {coverageToast && (
        <div className="db-cov-toast">
          <span className="db-cov-toast-icon">⚠</span>
          <span>{coverageToast}</span>
          <button className="db-cov-toast-close" onClick={() => setCoverageToast(null)}>✕</button>
        </div>
      )}
    </>
  );
}

const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#1d2c3f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8ec3b9" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a3646" }] },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#253d56" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#2c6675" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#0e1626" }],
  },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
