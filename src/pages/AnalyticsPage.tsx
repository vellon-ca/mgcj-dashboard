import { useState, useEffect, useRef } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";

// ── Types ─────────────────────────────────────────────────────────────
interface DayRevenue {
  day: string;
  revenue: number;
  rides: number;
}
interface HourRevenue {
  label: string;
  revenue: number;
  rides: number;
}
interface DriverStat {
  id: string;
  name: string;
  rides: number;
  ridesTotal: number;
  earnings: number;
  cashEarnings: number;
  cardEarnings: number;
  cancelRate: number;
  avgFare: number;
  avgRating: number | null;
  ratingCount: number;
}
interface HourStat {
  hour: number;
  rides: number;
}
interface DayStat {
  day: string;
  rides: number;
}
interface RideRow {
  id: string;
  created_at: string;
  status: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  fare_final: number | null;
  payment_method: string;
  passenger_name: string;
  driver_name: string;
  passenger_id: string;
  driver_id: string | null;
  invoice_number: string | null;
}
interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  driver_name: string | null;
  passenger_name: string | null;
  pickup_address: string;
  dropoff_address: string;
  driver_id: string;
  reviewed_by_dispatch: boolean;
}
interface MonthGroup {
  key: string;
  label: string;
  rides: RideRow[];
  totalRevenue: number;
}
interface RideDetailModal {
  ride: RideRow;
  review: ReviewRow | null;
}
interface EventRow {
  id: string;
  created_at: string;
  event_type: string;
  ride_id: string | null;
  details: Record<string, any>;
  dispatcher_name: string | null;
}
interface InvoiceRow {
  id: string;
  invoice_number: string;
  ride_id: string | null;
  passenger_name: string | null;
  driver_name: string | null;
  company_name: string | null;
  hst_number: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  fare: number;
  payment_method: string | null;
  sent_at: string;
}

const REASON_LABELS: Record<string, string> = {
  unsafe_driving: "Unsafe driving",
  rude_behavior: "Rude or unprofessional behavior",
  wrong_vehicle: "Different vehicle than expected",
  wrong_driver: "Different driver than expected",
  vehicle_condition: "Vehicle condition / cleanliness",
  cash_request: "Asked for cash to bypass the app",
  harassment: "Felt unsafe / harassed",
  smoking: "Smoking in vehicle",
  other: "Other",
};

const EVENT_LABELS: Record<string, string> = {
  "ride.created": "Created ride",
  "ride.cancelled": "Cancelled ride",
  "ride.assigned": "Assigned ride",
  "ride.reassigned": "Reassigned ride",
  "ride.scheduled_modified": "Edited ride",
  "ride.notes_added": "Added ride notes",
  "ride.fare_changed": "Changed fare",
  "driver.suspended": "Suspended driver",
  "driver.reactivated": "Reactivated driver",
  "driver.deleted": "Deleted driver",
  "invite.created": "Created invite",
  "invite.revoked": "Revoked invite",
  "discount.created": "Created discount",
  "discount.deactivated": "Deactivated discount",
  "discount.deleted": "Deleted discount",
  "report.reviewed": "Reviewed report",
  "report.dismissed": "Dismissed report",
  "report.printed": "Printed report",
  "announcement.drivers": "Driver announcement",
  "announcement.passengers": "Passenger announcement",
  "escalation.acknowledged": "Escalation acknowledged",
  "export.csv": "Exported CSV",
  "export.pdf": "Exported PDF",
  "invoice.printed": "Printed receipt",
  "settings.pricing_updated": "Updated pricing",
};
const EVENT_COLORS: Record<string, string> = {
  "ride.created": "#1D9E75",
  "ride.cancelled": "#E24B4A",
  "ride.assigned": "#4a9eff",
  "ride.reassigned": "#60A5FA",
  "ride.scheduled_modified": "#A855F7",
  "ride.notes_added": "#6B7280",
  "ride.fare_changed": "#F59E0B",
  "driver.suspended": "#F59E0B",
  "driver.reactivated": "#1D9E75",
  "driver.deleted": "#E24B4A",
  "invite.created": "#1D9E75",
  "invite.revoked": "#E24B4A",
  "discount.created": "#E8500A",
  "discount.deactivated": "#6B7280",
  "discount.deleted": "#E24B4A",
  "report.reviewed": "#60A5FA",
  "report.dismissed": "#6B7280",
  "report.printed": "#A855F7",
  "announcement.drivers": "#60A5FA",
  "announcement.passengers": "#60A5FA",
  "escalation.acknowledged": "#F59E0B",
  "export.csv": "#6B7280",
  "export.pdf": "#6B7280",
  "invoice.printed": "#A855F7",
  "settings.pricing_updated": "#F59E0B",
};

function formatEventDetails(type: string, details: any): string {
  if (!details) return "—";
  switch (type) {
    case "ride.created":
      return [
        details.passenger_name,
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "ride.cancelled":
      return [
        details.passenger_name,
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "ride.assigned":
      return details.driver_name ?? "—";
    case "ride.reassigned":
      return `${details.from_driver_name ?? "?"} → ${details.to_driver_name ?? "?"}`;
    case "ride.fare_changed":
      return `$${Number(details.original_fare ?? 0).toFixed(2)} → $${Number(details.new_fare ?? 0).toFixed(2)}`;
    case "ride.scheduled_modified":
      return [
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "driver.suspended":
    case "driver.reactivated":
    case "driver.deleted":
      return details.driver_name ?? "—";
    case "invite.created":
      return `Code: ${details.code}${details.name ? ` · ${details.name}` : ""}`;
    case "invite.revoked":
      return `Code: ${details.code}${details.name ? ` (${details.name})` : ""}`;
    case "discount.created":
      return `${details.code}${details.label ? ` — ${details.label}` : ""} · ${details.amount_type === "percent" ? `${details.amount}%` : `$${details.amount}`} off`;
    case "discount.deactivated":
    case "discount.deleted":
      return `${details.code}${details.label ? ` — ${details.label}` : ""}`;
    case "report.reviewed":
    case "report.dismissed":
    case "report.printed":
      return [
        details.driver_name,
        details.reason ? (REASON_LABELS[details.reason as string] ?? details.reason) : null,
      ].filter(Boolean).join(" · ");
    case "announcement.drivers":
    case "announcement.passengers":
      return details.title ?? "—";
    case "invoice.printed":
      return [
        details.invoice_number,
        details.passenger_name,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ].filter(Boolean).join(" · ");
    case "settings.pricing_updated":
      return [
        details.base_fare_from != null && details.base_fare_to != null
          ? `Base $${Number(details.base_fare_from).toFixed(2)} → $${Number(details.base_fare_to).toFixed(2)}`
          : null,
        details.rate_per_km_from != null && details.rate_per_km_to != null
          ? `Rate $${Number(details.rate_per_km_from).toFixed(2)} → $${Number(details.rate_per_km_to).toFixed(2)}/km`
          : null,
      ].filter(Boolean).join(" · ");
    case "export.csv":
    case "export.pdf": {
      const sectionLabels: Record<string, string> = {
        revenue: "Revenue",
        ride_history: "Ride History",
        drivers: "Drivers",
        reviews: "Reviews",
        activity_log: "Activity Log",
      };
      const sectionLabel = sectionLabels[details.section as string] ?? details.section ?? "";
      const parts = [sectionLabel];
      if (details.period) parts.push(String(details.period));
      if (details.row_count != null) parts.push(`${details.row_count} rows`);
      return parts.filter(Boolean).join(" · ");
    }
    default:
      return "—";
  }
}

type Section = "revenue" | "rides" | "reviews" | "drivers" | "activity" | "invoices";
const SECTION_ITEMS: { id: Section; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "rides", label: "Ride History" },
  { id: "reviews", label: "Reviews" },
  { id: "drivers", label: "Drivers" },
  { id: "activity", label: "Activity Log" },
  { id: "invoices", label: "Invoices" },
];
const STATUS_COLORS: Record<string, string> = {
  pending: "#F59E0B",
  assigned: "#4a9eff",
  driver_arriving: "#4a9eff",
  in_progress: "#E8500A",
  completed: "#1D9E75",
  cancelled: "#E24B4A",
  scheduled: "#A855F7",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  assigned: "Assigned",
  driver_arriving: "Arriving",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  scheduled: "Scheduled",
};

// ── PDF / CSV helpers ─────────────────────────────────────────────────
const APPROVAL_BLOCK = `
  <div style="margin-top:36px;padding-top:18px;border-top:1px solid #e5e7eb;">
    <div style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:18px;">Authorization</div>
    <div style="display:flex;gap:40px;">
      <div>
        <div style="width:210px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">Authorized by (print name)</div>
      </div>
      <div>
        <div style="width:160px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">Signature</div>
      </div>
      <div>
        <div style="width:110px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">Date</div>
      </div>
    </div>
  </div>`;

function printReport(title: string, html: string, companyLabel = "M&G C&J") {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head>
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, system-ui, sans-serif; color: #111; padding: 40px; font-size: 13px; }
      h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
      .sub { color: #666; font-size: 12px; margin-bottom: 28px; }
      .kpi-row { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
      .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 18px; min-width: 120px; }
      .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 4px; }
      .kpi-value { font-size: 22px; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
      td { font-size: 13px; padding: 9px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
      tr:last-child td { border-bottom: none; }
      .section-title { font-size: 14px; font-weight: 600; margin: 24px 0 12px; color: #111; }
      .footer { margin-top: 40px; font-size: 11px; color: #9ca3af; border-top: 1px solid #f3f4f6; padding-top: 12px; }
      .month-section + .month-section { break-before: page; padding-top: 48px; }
      .month-heading-row { font-size: 14px; font-weight: 600; color: #111; margin-bottom: 10px; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
      .pg-spacer td, .pg-spacer-sm td, .pg-spacer-foot td { border: none !important; padding: 0 !important; height: 0; }
      @page { margin: 0; }
      @media print {
        body { padding: 48px 56px; }
        .pg-spacer td, .pg-spacer-foot td { height: 48px; }
        .pg-spacer-sm td { height: 36px; }
      }
    </style>
  </head><body>${html}<div class="footer">Generated by ${companyLabel} Dispatch · ${new Date().toLocaleString("en-CA")}</div></body></html>`);
  win.document.close();
  setTimeout(() => {
    win.print();
  }, 400);
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Date helpers ──────────────────────────────────────────────────────
function getMonthKey(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function getMonthLabel(key: string) {
  const [year, month] = key.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(
    "en-CA",
    { month: "long", year: "numeric" },
  );
}
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── Main component ────────────────────────────────────────────────────
export default function AnalyticsPage({
  companyName,
  companyId,
  dispatcherId,
}: {
  companyName?: string | null;
  companyId: string;
  dispatcherId: string;
}) {
  const label = companyName ?? "M&G C&J";
  const [section, setSection] = useState<Section>("revenue");
  const [period, setPeriod] = useState<"today" | "week" | "month" | "year">(
    "month",
  );

  // Revenue
  const [dailyData, setDailyData] = useState<DayRevenue[]>([]);
  const [hourlyData, setHourlyData] = useState<HourRevenue[]>([]);
  const [driverStats, setDriverStats] = useState<DriverStat[]>([]);
  const [totals, setTotals] = useState({
    revenue: 0,
    rides: 0,
    avgFare: 0,
    cancelRate: 0,
    cashRevenue: 0,
    cardRevenue: 0,
    cashRides: 0,
    cardRides: 0,
    revenueToday: 0,
    revenueWeek: 0,
    revenueMonth: 0,
    revenueYear: 0,
  });
  const [revenueLoading, setRevenueLoading] = useState(true);

  // Ride history
  const [allRides, setAllRides] = useState<RideRow[]>([]);
  const [rideFilter, setRideFilter] = useState<string>("all");
  const [ridesLoading, setRidesLoading] = useState(true);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(
    new Set([getCurrentMonthKey()]),
  );
  const [selectedYear, setSelectedYear] = useState<number>(
    new Date().getFullYear(),
  );
  const [rideDetail, setRideDetail] = useState<RideDetailModal | null>(null);

  // Reviews
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewDriverFilter, setReviewDriverFilter] = useState<string>("all");
  const [reviewStarFilter, setReviewStarFilter] = useState<number | null>(null);
  const [markingReviewed, setMarkingReviewed] = useState<string | null>(null);

  // Activity log
  const [activityEvents, setActivityEvents] = useState<EventRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDateFrom, setActivityDateFrom] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const [activityDateTo, setActivityDateTo] = useState<string>(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>("all");
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityFetchId = useRef(0);
  const fetchActivityLogRef = useRef<() => void>(() => {});
  const ridesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Invoices
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceRow | null>(null);
  const invoicesFetchId = useRef(0);

  // Peak
  const [hourStats, setHourStats] = useState<HourStat[]>([]);
  const [dayStats, setDayStats] = useState<DayStat[]>([]);
  const [peakLoading, setPeakLoading] = useState(true);

  const revenueFetchId = useRef(0);
  const historyFetchId = useRef(0);
  const reviewsFetchId = useRef(0);
  const peakFetchId = useRef(0);

  useEffect(() => {
    fetchRevenue();
  }, [period]);

  useEffect(() => {
    fetchRideHistory();
    fetchReviews();
    fetchPeak();
  }, []);

  useEffect(() => {
    if (section === "activity") fetchActivityLog();
  }, [section, activityDateFrom, activityDateTo]);

  useEffect(() => {
    if (section === "invoices") fetchInvoices();
  }, [section]);

  useEffect(() => {
    if (!companyId) return;

    function scheduleRidesRefresh() {
      if (ridesDebounceRef.current) clearTimeout(ridesDebounceRef.current);
      ridesDebounceRef.current = setTimeout(() => {
        fetchRevenue();
        fetchRideHistory();
        fetchPeak();
      }, 1200);
    }

    const ch = supabase
      .channel(`analytics_rt_${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides", filter: `company_id=eq.${companyId}` },
        scheduleRidesRefresh,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "invoices", filter: `company_id=eq.${companyId}` },
        () => {
          fetchRideHistory(); // refreshes the invoice # column in ride history
          if (section === "invoices") fetchInvoices();
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [companyId]);

  // Keep ref current so the realtime callback always calls the latest version
  useEffect(() => { fetchActivityLogRef.current = fetchActivityLog; });

  useEffect(() => {
    if (section !== "activity" || !companyId) return;
    const channel = supabase
      .channel(`dispatch_events_live_${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "dispatch_events",
          filter: `company_id=eq.${companyId}`,
        },
        () => fetchActivityLogRef.current(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [section, companyId]);

  // ── Helpers ───────────────────────────────────────────────────────
  async function batchProfiles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", unique);
    const map = new Map<string, string>();
    data?.forEach((p: any) => map.set(p.id, p.name ?? "—"));
    return map;
  }

  // ── Fetchers ──────────────────────────────────────────────────────
  async function fetchRevenue() {
    const fetchId = ++revenueFetchId.current;
    setRevenueLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const yearStart = new Date(now.getFullYear(), 0, 1);

      const [
        { data: allRidesData },
        { data: periodRides },
        { data: allReviews },
        { data: drivers },
      ] = await Promise.all([
        supabase
          .from("rides")
          .select("*")
          .gte("created_at", yearStart.toISOString()),
        supabase
          .from("rides")
          .select("*")
          .gte("created_at", startDate.toISOString())
          .order("created_at", { ascending: true }),
        supabase.from("ride_reviews").select("driver_id, rating"),
        supabase.from("drivers").select("id"),
      ]);

      if (fetchId !== revenueFetchId.current) return;
      if (!allRidesData || !periodRides) return;

      const completed = (arr: any[]) =>
        arr.filter((r) => r.status === "completed");
      const sum = (arr: any[]) =>
        completed(arr).reduce(
          (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
          0,
        );
      const completedPeriod = completed(periodRides);

      setTotals({
        revenue: sum(periodRides),
        rides: completedPeriod.length,
        avgFare: completedPeriod.length
          ? sum(periodRides) / completedPeriod.length
          : 0,
        cancelRate: periodRides.length
          ? (periodRides.filter((r: any) => r.status === "cancelled").length /
              periodRides.length) *
            100
          : 0,
        cashRevenue: completed(periodRides)
          .filter((r: any) => r.payment_method === "cash")
          .reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          ),
        cardRevenue: completed(periodRides)
          .filter((r: any) => r.payment_method !== "cash")
          .reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          ),
        cashRides: completedPeriod.filter(
          (r: any) => r.payment_method === "cash",
        ).length,
        cardRides: completedPeriod.filter(
          (r: any) => r.payment_method !== "cash",
        ).length,
        revenueToday: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= todayStart),
        ),
        revenueWeek: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= weekStart),
        ),
        revenueMonth: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= monthStart),
        ),
        revenueYear: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= yearStart),
        ),
      });

      const dayMap = new Map<string, { revenue: number; rides: number }>();
      completedPeriod.forEach((r: any) => {
        const day = new Date(r.created_at).toLocaleDateString("en-CA", {
          month: "short",
          day: "numeric",
        });
        const ex = dayMap.get(day) ?? { revenue: 0, rides: 0 };
        dayMap.set(day, {
          revenue: ex.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
          rides: ex.rides + 1,
        });
      });
      if (fetchId === revenueFetchId.current)
        setDailyData(
          Array.from(dayMap.entries()).map(([day, v]) => ({ day, ...v })),
        );

      if (period === "today") {
        const hourMap = new Map<number, { revenue: number; rides: number }>();
        completedPeriod.forEach((r: any) => {
          const h = new Date(r.created_at).getHours();
          const ex = hourMap.get(h) ?? { revenue: 0, rides: 0 };
          hourMap.set(h, {
            revenue: ex.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
            rides: ex.rides + 1,
          });
        });
        const currentHour = new Date().getHours();
        if (fetchId === revenueFetchId.current)
          setHourlyData(
            Array.from({ length: currentHour + 1 }, (_, h) => ({
              label: fmtHour(h),
              revenue: hourMap.get(h)?.revenue ?? 0,
              rides: hourMap.get(h)?.rides ?? 0,
            })),
          );
      }

      if (drivers) {
        const driverIds = drivers.map((d: any) => d.id);
        const profileMap = await batchProfiles(driverIds);
        if (fetchId !== revenueFetchId.current) return;

        const stats: DriverStat[] = drivers.map((d: any) => {
          const dr = periodRides.filter((r: any) => r.driver_id === d.id);
          const comp = completed(dr);
          const canc = dr.filter((r: any) => r.status === "cancelled");
          const earn = comp.reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          );
          const cashEarn = comp
            .filter((r: any) => r.payment_method === "cash")
            .reduce(
              (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
              0,
            );
          const cardEarn = comp
            .filter((r: any) => r.payment_method !== "cash")
            .reduce(
              (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
              0,
            );
          const driverReviews =
            allReviews?.filter((rv: any) => rv.driver_id === d.id) ?? [];
          const avgRating = driverReviews.length
            ? Math.round(
                (driverReviews.reduce(
                  (s: number, rv: any) => s + rv.rating,
                  0,
                ) /
                  driverReviews.length) *
                  10,
              ) / 10
            : null;
          return {
            id: d.id,
            name: profileMap.get(d.id) ?? "Unknown",
            rides: comp.length,
            ridesTotal: dr.length,
            earnings: earn,
            cashEarnings: cashEarn,
            cardEarnings: cardEarn,
            cancelRate: dr.length ? (canc.length / dr.length) * 100 : 0,
            avgFare: comp.length ? earn / comp.length : 0,
            avgRating,
            ratingCount: driverReviews.length,
          };
        });
        if (fetchId === revenueFetchId.current)
          setDriverStats(
            stats
              .filter((d) => d.ridesTotal > 0)
              .sort((a, b) => b.earnings - a.earnings),
          );
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === revenueFetchId.current) setRevenueLoading(false);
    }
  }

  async function fetchRideHistory() {
    const fetchId = ++historyFetchId.current;
    setRidesLoading(true);
    try {
      const { data: rides } = await supabase
        .from("rides")
        .select("*")
        .in("status", ["completed", "cancelled"])
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== historyFetchId.current || !rides) return;

      const passengerIds = rides.map((r: any) => r.passenger_id);
      const driverIds = rides.map((r: any) => r.driver_id).filter(Boolean);
      const rideIds = rides.map((r: any) => r.id);
      const [profileMap, invoiceResult] = await Promise.all([
        batchProfiles([...passengerIds, ...driverIds]),
        supabase.from("invoices").select("ride_id, invoice_number").in("ride_id", rideIds),
      ]);
      if (fetchId !== historyFetchId.current) return;

      const invoiceMap = new Map<string, string>();
      invoiceResult.data?.forEach((inv: any) => invoiceMap.set(inv.ride_id, inv.invoice_number));

      const enriched: RideRow[] = rides.map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        pickup_address: r.pickup_address,
        dropoff_address: r.dropoff_address,
        fare_estimate: r.fare_estimate,
        fare_final: r.fare_final,
        payment_method: r.payment_method,
        passenger_name: profileMap.get(r.passenger_id) ?? "—",
        driver_name: r.driver_id ? (profileMap.get(r.driver_id) ?? "—") : "—",
        passenger_id: r.passenger_id,
        driver_id: r.driver_id ?? null,
        invoice_number: invoiceMap.get(r.id) ?? null,
      }));

      if (fetchId === historyFetchId.current) setAllRides(enriched);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === historyFetchId.current) setRidesLoading(false);
    }
  }

  async function fetchReviews() {
    const fetchId = ++reviewsFetchId.current;
    setReviewsLoading(true);
    try {
      const { data: rows } = await supabase
        .from("ride_reviews")
        .select(
          "id, ride_id, rating, comment, created_at, driver_id, passenger_id, reviewed_by_dispatch",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== reviewsFetchId.current || !rows) return;

      const driverIds = rows.map((rv: any) => rv.driver_id);
      const passengerIds = rows.map((rv: any) => rv.passenger_id);
      const profileMap = await batchProfiles([...driverIds, ...passengerIds]);

      const rideIds = [
        ...new Set(rows.map((rv: any) => rv.ride_id).filter(Boolean)),
      ];
      const { data: ridesData } = rideIds.length
        ? await supabase
            .from("rides")
            .select("id, pickup_address, dropoff_address")
            .in("id", rideIds)
        : { data: [] };
      const rideMap = new Map<
        string,
        { pickup_address: string; dropoff_address: string }
      >();
      ridesData?.forEach((r: any) =>
        rideMap.set(r.id, {
          pickup_address: r.pickup_address,
          dropoff_address: r.dropoff_address,
        }),
      );

      if (fetchId !== reviewsFetchId.current) return;

      const enriched: ReviewRow[] = rows.map((rv: any) => ({
        id: rv.id,
        rating: rv.rating,
        comment: rv.comment,
        created_at: rv.created_at,
        driver_id: rv.driver_id,
        driver_name: profileMap.get(rv.driver_id) ?? null,
        passenger_name: profileMap.get(rv.passenger_id) ?? null,
        pickup_address: rideMap.get(rv.ride_id)?.pickup_address ?? "—",
        dropoff_address: rideMap.get(rv.ride_id)?.dropoff_address ?? "—",
        reviewed_by_dispatch: rv.reviewed_by_dispatch ?? false,
      }));

      if (fetchId === reviewsFetchId.current) setReviews(enriched);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === reviewsFetchId.current) setReviewsLoading(false);
    }
  }

  async function fetchPeak() {
    const fetchId = ++peakFetchId.current;
    setPeakLoading(true);
    try {
      const { data: rides } = await supabase
        .from("rides")
        .select("created_at")
        .gte(
          "created_at",
          new Date(new Date().getFullYear(), 0, 1).toISOString(),
        );
      if (fetchId !== peakFetchId.current || !rides) return;
      const hourMap = new Map<number, number>();
      const dayMap = new Map<string, number>();
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      rides.forEach((r: any) => {
        const d = new Date(r.created_at);
        hourMap.set(d.getHours(), (hourMap.get(d.getHours()) ?? 0) + 1);
        const dn = dayNames[d.getDay()];
        dayMap.set(dn, (dayMap.get(dn) ?? 0) + 1);
      });
      if (fetchId === peakFetchId.current) {
        setHourStats(
          Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            rides: hourMap.get(i) ?? 0,
          })),
        );
        setDayStats(
          dayNames.map((d) => ({ day: d, rides: dayMap.get(d) ?? 0 })),
        );
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === peakFetchId.current) setPeakLoading(false);
    }
  }

  async function fetchActivityLog() {
    const fetchId = ++activityFetchId.current;
    setActivityLoading(true);
    try {
      const { data, error } = await supabase
        .from("dispatch_events")
        .select("id, created_at, event_type, ride_id, details, dispatcher_id")
        .gte("created_at", activityDateFrom + "T00:00:00")
        .lte("created_at", activityDateTo + "T23:59:59")
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== activityFetchId.current) return;
      if (error) {
        console.error("[fetchActivityLog]", error.code, error.message);
        setActivityError(`Fetch error: ${error.message} (${error.code})`);
        return;
      }
      setActivityError(null);
      const dispatcherIds = [...new Set((data ?? []).map((r: any) => r.dispatcher_id).filter(Boolean))];
      const profileMap = dispatcherIds.length ? await batchProfiles(dispatcherIds) : new Map<string, string>();
      const rows: EventRow[] = (data ?? []).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        event_type: r.event_type,
        ride_id: r.ride_id ?? null,
        details: r.details ?? {},
        dispatcher_name: profileMap.get(r.dispatcher_id) ?? null,
      }));
      setActivityEvents(rows);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === activityFetchId.current) setActivityLoading(false);
    }
  }

  async function fetchInvoices() {
    const fetchId = ++invoicesFetchId.current;
    setInvoicesLoading(true);
    try {
      const { data } = await supabase
        .from("invoices")
        .select("*")
        .order("sent_at", { ascending: false })
        .limit(500);
      if (fetchId !== invoicesFetchId.current || !data) return;
      setInvoices(data as InvoiceRow[]);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === invoicesFetchId.current) setInvoicesLoading(false);
    }
  }

  function printInvoiceReceipt(inv: InvoiceRow) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "invoice.printed",
      details: {
        invoice_number: inv.invoice_number,
        passenger_name: inv.passenger_name,
        fare: inv.fare,
      },
    });
    const subtotal = inv.fare / 1.15;
    const hst = inv.fare - subtotal;
    const date = new Date(inv.sent_at).toLocaleString("en-CA", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const html = `
      <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <div style="text-align: center; padding: 24px 0;">
          <h1 style="font-size: 20px; margin: 0; color: #1a1a1a;">${inv.company_name ?? "Your Taxi"}</h1>
          <p style="color: #6B7280; font-size: 13px; margin-top: 4px;">Ride Receipt · ${inv.invoice_number}</p>
        </div>
        <div style="background: #f7f7f7; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
          <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">Total fare</p>
          <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a;">$${inv.fare.toFixed(2)}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: #6B7280; text-transform: capitalize;">Paid by ${inv.payment_method ?? "—"}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; width: 110px;">Date</td><td style="padding: 8px 0; font-size: 13px;">${date}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">Pickup</td><td style="padding: 8px 0; font-size: 13px;">${inv.pickup_address ?? "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">Drop-off</td><td style="padding: 8px 0; font-size: 13px;">${inv.dropoff_address ?? "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Passenger</td><td style="padding: 8px 0; font-size: 13px;">${inv.passenger_name ?? "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Driver</td><td style="padding: 8px 0; font-size: 13px;">${inv.driver_name ?? "—"}</td></tr>
          ${inv.hst_number ? `<tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">HST Reg</td><td style="padding: 8px 0; font-size: 13px;">${inv.hst_number}</td></tr>` : ""}
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Subtotal</td><td style="padding: 8px 0; font-size: 13px;">$${subtotal.toFixed(2)}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">HST (15%)</td><td style="padding: 8px 0; font-size: 13px;">$${hst.toFixed(2)}</td></tr>
        </table>
        <p style="font-size: 12px; color: #9CA3AF; text-align: center; margin-top: 24px; border-top: 1px solid #f3f4f6; padding-top: 16px;">
          ${inv.passenger_name ? `Thanks for riding with us, ${inv.passenger_name}!` : "Thank you for your business."}<br/>
          ${inv.company_name ?? "Your Taxi"}
        </p>
      </div>
    `;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head>
      <title>${inv.invoice_number}</title>
      <style>* { box-sizing: border-box; } body { margin: 0; padding: 40px; background: #fff; } @page { margin: 0; } @media print { body { padding: 60px 56px; } }</style>
    </head><body>${html}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 300);
  }

  async function openRideDetail(ride: RideRow) {
    // Fetch review for this ride if any
    const { data: rv } = await supabase
      .from("ride_reviews")
      .select(
        "id, rating, comment, created_at, driver_id, passenger_id, reviewed_by_dispatch",
      )
      .eq("ride_id", ride.id)
      .maybeSingle();
    let review: ReviewRow | null = null;
    if (rv) {
      const [{ data: driver }, { data: passenger }] = await Promise.all([
        supabase
          .from("profiles")
          .select("name")
          .eq("id", rv.driver_id)
          .maybeSingle(),
        supabase
          .from("profiles")
          .select("name")
          .eq("id", rv.passenger_id)
          .maybeSingle(),
      ]);
      review = {
        ...rv,
        driver_name: driver?.name ?? null,
        passenger_name: passenger?.name ?? null,
        pickup_address: ride.pickup_address,
        dropoff_address: ride.dropoff_address,
        reviewed_by_dispatch: rv.reviewed_by_dispatch ?? false,
      };
    }
    setRideDetail({ ride, review });
  }

  async function markReviewReviewed(reviewId: string) {
    setMarkingReviewed(reviewId);
    const { error } = await supabase
      .from("ride_reviews")
      .update({ reviewed_by_dispatch: true })
      .eq("id", reviewId);
    if (!error) {
      setReviews((prev) =>
        prev.map((rv) =>
          rv.id === reviewId ? { ...rv, reviewed_by_dispatch: true } : rv,
        ),
      );
      if (rideDetail?.review?.id === reviewId) {
        setRideDetail((prev) =>
          prev
            ? {
                ...prev,
                review: prev.review
                  ? { ...prev.review, reviewed_by_dispatch: true }
                  : null,
              }
            : null,
        );
      }
    }
    setMarkingReviewed(null);
  }

  // ── PDF generators ────────────────────────────────────────────────
  function buildRevenueSVG(): string {
    const isToday = period === "today";
    const data: { label?: string; day?: string; revenue: number }[] = isToday ? hourlyData : dailyData;
    if (data.length === 0) return "";

    const W = 560, H = 180;
    const PL = 52, PR = 12, PT = 12, PB = 28;
    const cW = W - PL - PR;
    const cH = H - PT - PB;
    const maxRev = Math.max(...data.map((d) => d.revenue), 1);

    // nice Y-axis ticks
    const rawStep = maxRev / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const niceStep = Math.ceil(rawStep / mag) * mag || 1;
    const yTicks = Array.from({ length: 5 }, (_, i) => i * niceStep).filter((v) => v <= maxRev * 1.15);
    const yMax = yTicks[yTicks.length - 1] || maxRev;
    const yPos = (v: number) => PT + cH - (v / yMax) * cH;

    let inner = "";

    // grid lines + Y labels
    yTicks.forEach((v) => {
      const y = yPos(v).toFixed(1);
      inner += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>`;
      inner += `<text x="${PL - 5}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#6b7280">$${v.toFixed(v < 1 ? 2 : 0)}</text>`;
    });

    if (isToday) {
      const n = data.length;
      const slotW = cW / Math.max(n, 1);
      const barW = Math.min(slotW * 0.65, 20);
      data.forEach((d, i) => {
        const x = PL + i * slotW + (slotW - barW) / 2;
        const barH = Math.max((d.revenue / yMax) * cH, 0);
        inner += `<rect x="${x.toFixed(1)}" y="${(yPos(d.revenue)).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="#E8500A" rx="2"/>`;
      });
      const interval = Math.max(1, Math.floor(n / 8));
      data.forEach((d, i) => {
        if (i % interval !== 0 && i !== n - 1) return;
        const x = PL + i * slotW + slotW / 2;
        inner += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${d.label ?? ""}</text>`;
      });
    } else {
      if (data.length === 1) {
        inner += `<circle cx="${(PL + cW / 2).toFixed(1)}" cy="${yPos(data[0].revenue).toFixed(1)}" r="4" fill="#E8500A"/>`;
      } else {
        const pts = data.map((d, i) => ({
          x: PL + (i / (data.length - 1)) * cW,
          y: yPos(d.revenue),
        }));
        const linePts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        const areaPts = [
          `${pts[0].x.toFixed(1)},${(PT + cH).toFixed(1)}`,
          ...pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
          `${pts[pts.length - 1].x.toFixed(1)},${(PT + cH).toFixed(1)}`,
        ].join(" ");
        inner += `<polyline fill="rgba(232,80,10,0.12)" stroke="none" points="${areaPts}"/>`;
        inner += `<polyline fill="none" stroke="#E8500A" stroke-width="1.75" stroke-linejoin="round" points="${linePts}"/>`;
        pts.forEach((p) => {
          inner += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#E8500A"/>`;
        });
        const interval = Math.max(1, Math.floor(data.length / 7));
        data.forEach((d, i) => {
          if (i % interval !== 0 && i !== data.length - 1) return;
          const x = PL + (i / (data.length - 1)) * cW;
          inner += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${d.day ?? ""}</text>`;
        });
      }
    }

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  }

  function downloadRevenueReport() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "revenue", period } });
    const rows = driverStats
      .map(
        (d) =>
          `<tr><td>${d.name}</td><td>${d.rides}</td><td>$${d.earnings.toFixed(2)}</td><td>$${d.cashEarnings.toFixed(2)}</td><td>$${d.cardEarnings.toFixed(2)}</td><td>$${d.avgFare.toFixed(2)}</td><td>${d.cancelRate.toFixed(1)}%</td><td>${d.avgRating?.toFixed(1) ?? "—"}</td></tr>`,
      )
      .join("");
    const periodLabel =
      period === "today"
        ? "Today"
        : period === "week"
          ? "Last 7 days"
          : period === "month"
            ? "This month"
            : "This year";
    const chartSVG = buildRevenueSVG();
    printReport(
      `Revenue Report — ${label}`,
      `
      <h1>${label} — Revenue Report</h1>
      <p class="sub">${periodLabel} · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Today</div><div class="kpi-value">$${totals.revenueToday.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">This week</div><div class="kpi-value">$${totals.revenueWeek.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">This month</div><div class="kpi-value">$${totals.revenueMonth.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">This year</div><div class="kpi-value">$${totals.revenueYear.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">Cash rides</div><div class="kpi-value">$${totals.cashRevenue.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">Card rides</div><div class="kpi-value">$${totals.cardRevenue.toFixed(2)}</div></div>
      </div>
      ${chartSVG ? `<div class="section-title">Revenue over time${period === "today" ? " · by hour" : ""}</div><div style="margin-bottom:24px">${chartSVG}</div>` : ""}
      <div class="section-title">Driver Earnings — ${periodLabel}</div>
      <table><thead><tr class="pg-spacer"><td colspan="8"></td></tr><tr><th>Driver</th><th>Rides</th><th>Earnings</th><th>Cash</th><th>Card</th><th>Avg Fare</th><th>Cancel Rate</th><th>Avg Rating</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='8' style='color:#9ca3af'>No data for this period</td></tr>"}</tbody>
      <tfoot><tr class="pg-spacer-foot"><td colspan="8"></td></tr></tfoot></table>
      ${APPROVAL_BLOCK}
    `,
      label,
    );
  }

  function downloadMonthReport(group: MonthGroup) {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "ride_history", period: group.label, row_count: group.rides.length } });
    const rows = group.rides
      .map(
        (r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</td>
        <td>${r.passenger_name}</td><td>${r.driver_name}</td>
        <td style="font-size:11px">${r.pickup_address}</td>
        <td style="font-size:11px">${r.dropoff_address}</td>
        <td>${r.fare_final ? `$${r.fare_final.toFixed(2)}` : r.fare_estimate ? `$${r.fare_estimate.toFixed(2)}` : "—"}</td>
        <td>${STATUS_LABELS[r.status] ?? r.status}</td>
        <td>${r.payment_method}</td>
        <td style="font-family:monospace;font-size:11px">${r.invoice_number ?? "—"}</td>
      </tr>`,
      )
      .join("");
    const completed = group.rides.filter((r) => r.status === "completed");
    printReport(
      `Ride History ${group.label} — ${label}`,
      `
      <h1>${label} — Ride History</h1>
      <p class="sub">${group.label} · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total rides</div><div class="kpi-value">${group.rides.length}</div></div>
        <div class="kpi"><div class="kpi-label">Completed</div><div class="kpi-value">${completed.length}</div></div>
        <div class="kpi"><div class="kpi-label">Revenue</div><div class="kpi-value">$${group.totalRevenue.toFixed(2)}</div></div>
      </div>
      <table><thead><tr class="pg-spacer"><td colspan="9"></td></tr><tr><th>Date</th><th>Passenger</th><th>Driver</th><th>Pickup</th><th>Drop-off</th><th>Fare</th><th>Status</th><th>Payment</th><th>Invoice #</th></tr></thead>
      <tbody>${rows || "<tr><td colspan='9' style='color:#9ca3af'>No rides</td></tr>"}</tbody>
      <tfoot><tr class="pg-spacer-foot"><td colspan="9"></td></tr></tfoot></table>
      ${APPROVAL_BLOCK}
    `,
      label,
    );
  }

  function downloadYearReport(year: number, groups: MonthGroup[]) {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "ride_history", period: String(year), row_count: groups.flatMap((g) => g.rides).length } });
    const allYearRides = groups.flatMap((g) => g.rides);
    const completed = allYearRides.filter((r) => r.status === "completed");
    const totalRevenue = completed.reduce(
      (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
      0,
    );
    const cancelled = allYearRides.filter((r) => r.status === "cancelled");
    const monthSections = groups
      .map((group) => {
        const rows = group.rides
          .map(
            (r) => `
        <tr>
          <td>${new Date(r.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</td>
          <td>${r.passenger_name}</td><td>${r.driver_name}</td>
          <td style="font-size:11px">${r.pickup_address}</td>
          <td style="font-size:11px">${r.dropoff_address}</td>
          <td>${r.fare_final ? `$${r.fare_final.toFixed(2)}` : r.fare_estimate ? `$${r.fare_estimate.toFixed(2)}` : "—"}</td>
          <td>${STATUS_LABELS[r.status] ?? r.status}</td>
          <td>${r.payment_method}</td>
          <td style="font-family:monospace;font-size:11px">${r.invoice_number ?? "—"}</td>
        </tr>`,
          )
          .join("");
        return `<div class="month-section">
        <div class="month-heading-row">${group.label} · ${group.rides.length} rides · $${group.totalRevenue.toFixed(2)}</div>
        <table><thead>
          <tr class="pg-spacer-sm"><td colspan="9"></td></tr>
          <tr><th>Date</th><th>Passenger</th><th>Driver</th><th>Pickup</th><th>Drop-off</th><th>Fare</th><th>Status</th><th>Payment</th><th>Invoice #</th></tr>
        </thead>
        <tbody>${rows || "<tr><td colspan='9' style='color:#9ca3af'>No rides</td></tr>"}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="9"></td></tr></tfoot>
        </table>
        ${APPROVAL_BLOCK}
        </div>`;
      })
      .join("");
    printReport(
      `Ride History ${year} — ${label}`,
      `
      <h1>${label} — Ride History ${year}</h1>
      <p class="sub">Full year · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total rides</div><div class="kpi-value">${allYearRides.length}</div></div>
        <div class="kpi"><div class="kpi-label">Completed</div><div class="kpi-value">${completed.length}</div></div>
        <div class="kpi"><div class="kpi-label">Cancelled</div><div class="kpi-value">${cancelled.length}</div></div>
        <div class="kpi"><div class="kpi-label">Revenue</div><div class="kpi-value">$${totalRevenue.toFixed(2)}</div></div>
      </div>
      ${monthSections}
    `,
      label,
    );
  }

  // ── CSV exporters ─────────────────────────────────────────────────
  function exportRidesCSV(rides: RideRow[], filename: string) {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "ride_history", row_count: rides.length } });
    downloadCSV(
      filename,
      [
        "Date",
        "Passenger",
        "Driver",
        "Pickup",
        "Drop-off",
        "Fare",
        "Status",
        "Payment",
        "Invoice #",
      ],
      rides.map((r) => [
        new Date(r.created_at).toLocaleDateString("en-CA"),
        r.passenger_name,
        r.driver_name,
        r.pickup_address,
        r.dropoff_address,
        r.fare_final
          ? `$${r.fare_final.toFixed(2)}`
          : r.fare_estimate
            ? `$${r.fare_estimate.toFixed(2)}`
            : "",
        STATUS_LABELS[r.status] ?? r.status,
        r.payment_method,
        r.invoice_number ?? "",
      ]),
    );
  }

  function exportDriverStatsCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "drivers", period, row_count: driverStats.length } });
    const periodLabel =
      period === "today"
        ? "today"
        : period === "week"
          ? "week"
          : period === "month"
            ? "month"
            : "year";
    downloadCSV(
      `driver-performance-${periodLabel}.csv`,
      [
        "Driver",
        "Rides",
        "Earnings",
        "Cash",
        "Card",
        "Avg Fare",
        "Cancel Rate",
        "Avg Rating",
        "Ratings Count",
      ],
      driverStats.map((d) => [
        d.name,
        String(d.rides),
        `$${d.earnings.toFixed(2)}`,
        `$${d.cashEarnings.toFixed(2)}`,
        `$${d.cardEarnings.toFixed(2)}`,
        `$${d.avgFare.toFixed(2)}`,
        `${d.cancelRate.toFixed(1)}%`,
        d.avgRating?.toFixed(1) ?? "",
        String(d.ratingCount),
      ]),
    );
  }

  function exportReviewsCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "reviews", row_count: filteredReviews.length } });
    downloadCSV(
      "reviews.csv",
      [
        "Date",
        "Driver",
        "Passenger",
        "Rating",
        "Comment",
        "Reviewed by dispatch",
      ],
      filteredReviews.map((rv) => [
        new Date(rv.created_at).toLocaleDateString("en-CA"),
        rv.driver_name ?? "",
        rv.passenger_name ?? "",
        String(rv.rating),
        rv.comment ?? "",
        rv.reviewed_by_dispatch ? "Yes" : "No",
      ]),
    );
  }

  function exportActivityCSV(rows: EventRow[]) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "export.csv",
      details: {
        section: "activity_log",
        date_from: activityDateFrom,
        date_to: activityDateTo,
        event_type_filter: activityTypeFilter,
        row_count: rows.length,
      },
    });
    downloadCSV(
      `activity-log-${activityDateFrom}-${activityDateTo}.csv`,
      ["Date/Time", "Dispatcher", "Event", "Details", "Ride ID"],
      rows.map((e) => [
        new Date(e.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" } as any),
        e.dispatcher_name ?? "—",
        EVENT_LABELS[e.event_type] ?? e.event_type,
        formatEventDetails(e.event_type, e.details),
        e.ride_id ?? "",
      ]),
    );
  }

  function exportActivityPDF(rows: EventRow[]) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "export.pdf",
      details: {
        section: "activity_log",
        date_from: activityDateFrom,
        date_to: activityDateTo,
        event_type_filter: activityTypeFilter,
        row_count: rows.length,
      },
    });
    let lastDateKey = "";
    const tableRows = rows.map((e) => {
      const dateKey = new Date(e.created_at).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" } as any);
      const timeStr = new Date(e.created_at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" } as any);
      let sep = "";
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        sep = `<tr><td colspan="4" style="background:#f3f4f6;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;padding:10px 10px 6px;border-bottom:1px solid #e5e7eb">${dateKey}</td></tr>`;
      }
      return sep + `<tr>
        <td style="white-space:nowrap;color:#6b7280">${timeStr}</td>
        <td>${e.dispatcher_name ?? "—"}</td>
        <td><span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${EVENT_COLORS[e.event_type] ?? "#6B7280"}22;color:${EVENT_COLORS[e.event_type] ?? "#6B7280"}">${EVENT_LABELS[e.event_type] ?? e.event_type}</span></td>
        <td>${formatEventDetails(e.event_type, e.details)}</td>
      </tr>`;
    }).join("");
    const cancels = rows.filter((e) => e.event_type === "ride.cancelled").length;
    const driverActions = rows.filter((e) => e.event_type.startsWith("driver.")).length;
    const announcements = rows.filter((e) => e.event_type.startsWith("announcement.")).length;
    printReport(
      `Activity Log — ${label}`,
      `
      <h1>${label} — Dispatcher Activity Log</h1>
      <p class="sub">${activityDateFrom} to ${activityDateTo} · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total events</div><div class="kpi-value">${rows.length}</div></div>
        <div class="kpi"><div class="kpi-label">Cancellations</div><div class="kpi-value">${cancels}</div></div>
        <div class="kpi"><div class="kpi-label">Driver actions</div><div class="kpi-value">${driverActions}</div></div>
        <div class="kpi"><div class="kpi-label">Announcements</div><div class="kpi-value">${announcements}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="4"></td></tr><tr><th>Time</th><th>Dispatcher</th><th>Event</th><th>Details</th></tr></thead>
        <tbody>${tableRows || "<tr><td colspan='4' style='color:#9ca3af'>No events in this period</td></tr>"}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="4"></td></tr></tfoot>
      </table>
      ${APPROVAL_BLOCK}
    `,
      label,
    );
  }

  function exportReviewsPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "reviews", row_count: filteredReviews.length } });
    const driverLabel = reviewDriverFilter === "all" ? "All Drivers" : (reviewDriverOptions.find((d) => d.id === reviewDriverFilter)?.name ?? "Unknown");
    const starLabel = reviewStarFilter !== null ? ` · ${reviewStarFilter}★` : "";
    const avg = filteredReviews.length
      ? (filteredReviews.reduce((s, rv) => s + rv.rating, 0) / filteredReviews.length).toFixed(1)
      : "—";
    const tableRows = filteredReviews.map((rv) => `
      <tr>
        <td style="white-space:nowrap">${new Date(rv.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}</td>
        <td>${rv.driver_name ?? "—"}</td>
        <td>${rv.passenger_name ?? "—"}</td>
        <td style="font-weight:700;letter-spacing:0.05em">${"★".repeat(rv.rating)}${"☆".repeat(5 - rv.rating)}</td>
        <td style="font-size:12px">${rv.comment ?? "—"}</td>
        <td>${rv.reviewed_by_dispatch ? "Yes" : "—"}</td>
      </tr>`).join("");
    printReport(`Reviews — ${label}`, `
      <h1>${label} — Ride Reviews</h1>
      <p class="sub">${driverLabel}${starLabel} · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Reviews</div><div class="kpi-value">${filteredReviews.length}</div></div>
        <div class="kpi"><div class="kpi-label">Avg rating</div><div class="kpi-value">${avg}</div></div>
        <div class="kpi"><div class="kpi-label">Flagged (≤2★)</div><div class="kpi-value">${filteredReviews.filter((rv) => rv.rating <= 2).length}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="6"></td></tr><tr><th>Date</th><th>Driver</th><th>Passenger</th><th>Rating</th><th>Comment</th><th>Reviewed</th></tr></thead>
        <tbody>${tableRows || "<tr><td colspan='6' style='color:#9ca3af'>No reviews</td></tr>"}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="6"></td></tr></tfoot>
      </table>
      ${APPROVAL_BLOCK}
    `, label);
  }

  function exportDriversPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "drivers", period, row_count: driverStats.length } });
    const pl = period === "today" ? "Today" : period === "week" ? "Last 7 days" : period === "month" ? "This month" : "This year";
    const totalEarnings = driverStats.reduce((s, d) => s + d.earnings, 0);
    const totalRides = driverStats.reduce((s, d) => s + d.rides, 0);
    const tableRows = driverStats.map((d) => `
      <tr>
        <td>${d.name}</td>
        <td>${d.rides}</td>
        <td style="color:#15803d;font-weight:600">$${d.earnings.toFixed(2)}</td>
        <td>$${d.cashEarnings.toFixed(2)}</td>
        <td>$${d.cardEarnings.toFixed(2)}</td>
        <td>$${d.avgFare.toFixed(2)}</td>
        <td>${d.cancelRate.toFixed(1)}%</td>
        <td>${d.avgRating?.toFixed(1) ?? "—"}</td>
      </tr>`).join("");
    printReport(`Driver Performance — ${label}`, `
      <h1>${label} — Driver Performance</h1>
      <p class="sub">${pl} · Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Drivers</div><div class="kpi-value">${driverStats.length}</div></div>
        <div class="kpi"><div class="kpi-label">Total rides</div><div class="kpi-value">${totalRides}</div></div>
        <div class="kpi"><div class="kpi-label">Total earnings</div><div class="kpi-value">$${totalEarnings.toFixed(2)}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="8"></td></tr><tr><th>Driver</th><th>Rides</th><th>Earnings</th><th>Cash</th><th>Card</th><th>Avg Fare</th><th>Cancel %</th><th>Avg Rating</th></tr></thead>
        <tbody>${tableRows || "<tr><td colspan='8' style='color:#9ca3af'>No data for this period</td></tr>"}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="8"></td></tr></tfoot>
      </table>
      ${APPROVAL_BLOCK}
    `, label);
  }

  function exportInvoicesPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "invoices", row_count: filteredInvoices.length } });
    const total = filteredInvoices.reduce((s, inv) => s + inv.fare, 0);
    const tableRows = filteredInvoices.map((inv) => `
      <tr>
        <td style="font-family:monospace;font-size:11px;font-weight:700">${inv.invoice_number}</td>
        <td style="white-space:nowrap">${new Date(inv.sent_at).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}</td>
        <td>${inv.passenger_name ?? "—"}</td>
        <td>${inv.driver_name ?? "—"}</td>
        <td style="font-size:11px">${inv.pickup_address && inv.dropoff_address ? `${inv.pickup_address} → ${inv.dropoff_address}` : inv.pickup_address ?? "—"}</td>
        <td style="color:#15803d;font-weight:600">$${inv.fare.toFixed(2)}</td>
        <td style="text-transform:capitalize">${inv.payment_method ?? "—"}</td>
      </tr>`).join("");
    printReport(`Invoices — ${label}`, `
      <h1>${label} — Invoices</h1>
      <p class="sub">Generated ${new Date().toLocaleDateString("en-CA", { dateStyle: "long" })}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Invoices</div><div class="kpi-value">${filteredInvoices.length}</div></div>
        <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">$${total.toFixed(2)}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="7"></td></tr><tr><th>Invoice #</th><th>Date</th><th>Passenger</th><th>Driver</th><th>Route</th><th>Amount</th><th>Payment</th></tr></thead>
        <tbody>${tableRows || "<tr><td colspan='7' style='color:#9ca3af'>No invoices</td></tr>"}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="7"></td></tr></tfoot>
      </table>
      ${APPROVAL_BLOCK}
    `, label);
  }

  function exportInvoicesCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "invoices", row_count: filteredInvoices.length } });
    downloadCSV(
      "invoices.csv",
      ["Invoice #", "Date", "Passenger", "Driver", "Pickup", "Drop-off", "Amount", "Payment"],
      filteredInvoices.map((inv) => [
        inv.invoice_number,
        new Date(inv.sent_at).toLocaleDateString("en-CA"),
        inv.passenger_name ?? "",
        inv.driver_name ?? "",
        inv.pickup_address ?? "",
        inv.dropoff_address ?? "",
        `$${inv.fare.toFixed(2)}`,
        inv.payment_method ?? "",
      ]),
    );
  }

  // ── Derived ───────────────────────────────────────────────────────
  const availableYears = Array.from(
    new Set(allRides.map((r) => new Date(r.created_at).getFullYear())),
  ).sort((a, b) => b - a);

  const filteredInvoices = invoiceSearch.trim()
    ? invoices.filter((inv) =>
        inv.invoice_number.toLowerCase().includes(invoiceSearch.toLowerCase()) ||
        (inv.passenger_name ?? "").toLowerCase().includes(invoiceSearch.toLowerCase()),
      )
    : invoices;
  const filteredRides =
    rideFilter === "all"
      ? allRides
      : allRides.filter((r) => r.status === rideFilter);

  const monthGroups: MonthGroup[] = (() => {
    const map = new Map<string, RideRow[]>();
    filteredRides
      .filter((r) => new Date(r.created_at).getFullYear() === selectedYear)
      .forEach((r) => {
        const key = getMonthKey(r.created_at);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(r);
      });
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, rides]) => ({
        key,
        label: getMonthLabel(key),
        rides,
        totalRevenue: rides
          .filter((r) => r.status === "completed")
          .reduce((s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0), 0),
      }));
  })();

  function toggleMonth(key: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const maxHour = Math.max(...hourStats.map((h) => h.rides), 1);
  const maxDay = Math.max(...dayStats.map((d) => d.rides), 1);
  const peakHour = hourStats.length
    ? hourStats.reduce((a, b) => (b.rides > a.rides ? b : a))
    : null;
  const peakDay = dayStats.length
    ? dayStats.reduce((a, b) => (b.rides > a.rides ? b : a))
    : null;
  function fmtHour(h: number) {
    if (h === 0) return "12am";
    if (h < 12) return `${h}am`;
    if (h === 12) return "12pm";
    return `${h - 12}pm`;
  }

  const reviewDriverOptions = Array.from(
    reviews
      .reduce((map, rv) => {
        if (!map.has(rv.driver_id))
          map.set(rv.driver_id, rv.driver_name ?? "Unknown");
        return map;
      }, new Map<string, string>())
      .entries(),
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filteredReviews = reviews.filter((rv) => {
    if (reviewDriverFilter !== "all" && rv.driver_id !== reviewDriverFilter)
      return false;
    if (reviewStarFilter !== null && rv.rating !== reviewStarFilter)
      return false;
    return true;
  });

  const selectedDriverReviews =
    reviewDriverFilter !== "all"
      ? reviews.filter((rv) => rv.driver_id === reviewDriverFilter)
      : [];
  const selectedDriverAvg = selectedDriverReviews.length
    ? Math.round(
        (selectedDriverReviews.reduce((s, rv) => s + rv.rating, 0) /
          selectedDriverReviews.length) *
          10,
      ) / 10
    : null;
  const selectedDriverFlagged = selectedDriverReviews.filter(
    (rv) => rv.rating <= 2,
  ).length;

  const periodLabel =
    period === "today"
      ? "Today"
      : period === "week"
        ? "Week"
        : period === "month"
          ? "Month"
          : "Year";

  function RevenueTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div style={{
        background: "#1E2A3A",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      }}>
        <div style={{ color: "#9CA3AF", marginBottom: 5 }}>{label}</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#E8500A" }}>
          ${payload[0].value.toFixed(2)}
        </div>
        <div style={{ color: "#6B7280", marginTop: 3 }}>
          {d.rides} ride{d.rides !== 1 ? "s" : ""}
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .an-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .an-panel { width: 200px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .an-panel-title { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .an-section-btn { display: flex; align-items: center; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #6B7280; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .an-section-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .an-section-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .an-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; }
        .an-content::-webkit-scrollbar { width: 4px; }
        .an-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .an-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
        .an-section-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .an-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .an-period-btns { display: flex; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 3px; gap: 2px; }
        .an-period-btn { background: transparent; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; color: #6B7280; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s; }
        .an-period-btn.active { background: #111827; color: #F1F5F9; }
        .an-download-btn { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.25); border-radius: 7px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-download-btn:hover { background: rgba(29,158,117,0.18); }
        .an-download-btn-sm { background: rgba(29,158,117,0.08); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-download-btn-sm:hover { background: rgba(29,158,117,0.15); }
        .an-csv-btn { background: rgba(74,158,255,0.08); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 7px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-csv-btn:hover { background: rgba(74,158,255,0.15); }
        .an-kpi-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-bottom: 20px; }
        .an-kpi-card { background: #1E2A3A; border-radius: 12px; padding: 16px; border: 1px solid rgba(255,255,255,0.05); }
        .an-kpi-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
        .an-kpi-value { font-size: 24px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .an-kpi-sub { font-size: 11px; color: #6B7280; margin-top: 4px; }
        .an-revenue-strip { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-bottom: 20px; }
        .an-revenue-mini { background: #1E2A3A; border-radius: 10px; padding: 12px 14px; border: 1px solid rgba(255,255,255,0.05); }
        .an-revenue-mini-label { font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 5px; }
        .an-revenue-mini-value { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .an-chart-card { background: #1E2A3A; border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 16px; }
        .an-chart-title { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 16px; }
        .an-no-data { color: #6B7280; font-size: 13px; text-align: center; padding: 24px 0; }
        .an-x-labels { display: flex; justify-content: space-between; margin-top: 8px; }
        .an-x-label { font-size: 10px; color: #6B7280; }
        .an-table { width: 100%; border-collapse: collapse; }
        .an-th { font-size: 10px; font-weight: 600; color: #6B7280; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); text-transform: uppercase; letter-spacing: 0.06em; }
        .an-td { font-size: 13px; color: #9CA3AF; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); vertical-align: middle; }
        .an-td.primary { color: #E2E8F0; font-weight: 500; }
        .an-td.addr { font-size: 11px; color: #6B7280; max-width: 160px; }
        .an-td.green { color: #1D9E75; font-weight: 600; }
        .an-td.red { color: #E24B4A; }
        .an-td.amber { color: #F59E0B; }
        .an-status { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
        .an-filter-row { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
        .an-filter-btn { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; padding: 5px 12px; font-size: 12px; color: #6B7280; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s; }
        .an-filter-btn.active { background: #E8500A; color: #fff; border-color: #E8500A; }
        .an-filter-count { font-size: 11px; color: #6B7280; margin-left: auto; }
        .an-month-group { margin-bottom: 8px; border-radius: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05); }
        .an-month-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1E2A3A; cursor: pointer; user-select: none; transition: background 0.12s; gap: 12px; }
        .an-month-header:hover { background: #213040; }
        .an-month-header-left { display: flex; align-items: center; gap: 10px; }
        .an-month-chevron { font-size: 11px; color: #6B7280; transition: transform 0.2s; display: inline-block; }
        .an-month-chevron.open { transform: rotate(90deg); }
        .an-month-name { font-size: 14px; font-weight: 600; color: #E2E8F0; }
        .an-month-meta { font-size: 12px; color: #6B7280; }
        .an-month-revenue { font-size: 14px; font-weight: 700; color: #1D9E75; }
        .an-month-body { background: #18222F; }
        .an-ride-row { cursor: pointer; transition: background 0.1s; }
        .an-ride-row:hover td { background: rgba(232,80,10,0.04); }
        .an-peak-row { display: flex; gap: 16px; }
        .an-bar-chart-wrap { flex: 1; background: #18222F; border-radius: 10px; padding: 16px; border: 1px solid rgba(255,255,255,0.04); }
        .an-bars { display: flex; align-items: flex-end; gap: 3px; height: 100px; padding-bottom: 20px; }
        .an-bar-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; justify-content: flex-end; }
        .an-bar-fill { width: 100%; border-radius: 2px 2px 0 0; min-height: 2px; }
        .an-bar-lbl { font-size: 8px; color: #6B7280; margin-top: 3px; }
        .an-peak-note { font-size: 11px; color: #6B7280; margin-top: 8px; }
        .an-review-card { background: #1E2A3A; border-radius: 10px; padding: 14px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); transition: border-color 0.12s; }
        .an-review-card.flagged { background: #1A0F0F; border-color: rgba(248,113,113,0.2); }
        .an-review-card.dispatch-reviewed { border-color: rgba(29,158,117,0.2); }
        .an-review-flag { font-size: 11px; color: #F87171; background: rgba(248,113,113,0.08); border-radius: 5px; padding: 4px 8px; margin-bottom: 8px; display: inline-block; }
        .an-reviewed-badge { font-size: 11px; color: #1D9E75; background: rgba(29,158,117,0.08); border-radius: 5px; padding: 4px 8px; margin-bottom: 8px; display: inline-block; border: 1px solid rgba(29,158,117,0.2); }
        .an-mark-reviewed-btn { background: rgba(29,158,117,0.08); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; margin-top: 10px; }
        .an-mark-reviewed-btn:hover { background: rgba(29,158,117,0.15); }
        .an-mark-reviewed-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .an-loading { color: #6B7280; text-align: center; padding: 48px; font-size: 14px; }
        .an-select { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 12px; font-size: 12px; color: #E2E8F0; cursor: pointer; font-family: system-ui, sans-serif; outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234B5563'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
        /* Ride detail modal */
        .an-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .an-modal { background: #1E2A3A; border-radius: 14px; padding: 26px; width: 100%; max-width: 480px; border: 1px solid rgba(255,255,255,0.08); max-height: 88vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .an-modal-title { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-bottom: 16px; }
        .an-detail-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .an-detail-label { font-size: 12px; color: #9CA3AF; font-weight: 500; }
        .an-detail-value { font-size: 13px; color: #E2E8F0; font-weight: 500; max-width: 60%; text-align: right; }
        .an-modal-close { background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #6B7280; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; width: 100%; margin-top: 16px; transition: background 0.12s; }
        .an-modal-close:hover { background: rgba(255,255,255,0.04); }
        .an-modal-section { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 8px; }
        /* Activity log */
        .an-date-input { background: #111E2E; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 10px; font-size: 12px; color: #E2E8F0; font-family: system-ui, sans-serif; outline: none; }
        .an-date-input:focus { border-color: rgba(232,80,10,0.4); }
        /* Invoices */
        .inv-search-row { margin-bottom: 16px; }
        .inv-search { width: 100%; max-width: 380px; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 8px 14px; font-size: 13px; color: #E2E8F0; font-family: system-ui, sans-serif; outline: none; }
        .inv-search:focus { border-color: rgba(232,80,10,0.4); }
        .inv-search::placeholder { color: #6B7280; }
        .inv-tag { font-family: monospace; font-size: 11px; font-weight: 700; color: #E8500A; background: rgba(232,80,10,0.08); border: 1px solid rgba(232,80,10,0.2); border-radius: 5px; padding: 2px 7px; white-space: nowrap; }
        .an-type-select { background: #111E2E; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 28px 5px 10px; font-size: 12px; color: #E2E8F0; cursor: pointer; font-family: system-ui, sans-serif; outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234B5563'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
        .al-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; background: #111E2E; border-radius: 10px; border: 1px solid rgba(255,255,255,0.04); margin-bottom: 16px; }
        .al-toolbar-sep { width: 1px; height: 16px; background: rgba(255,255,255,0.07); margin: 0 2px; }
        .al-toolbar-label { font-size: 11px; color: #6B7280; white-space: nowrap; }
        .al-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 20px; }
        .al-stat { background: #111E2E; border-radius: 10px; padding: 14px 16px; border: 1px solid rgba(255,255,255,0.04); }
        .al-stat-val { font-size: 28px; font-weight: 700; color: #F1F5F9; line-height: 1; display: block; }
        .al-stat-lbl { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin-top: 5px; display: block; }
        .al-table { width: 100%; border-collapse: collapse; }
        .al-th { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; padding: 10px 16px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .al-tr { border-bottom: 1px solid rgba(255,255,255,0.035); }
        .al-tr:last-child { border-bottom: none; }
        .al-tr:hover td { background: rgba(255,255,255,0.015); }
        .al-td { padding: 11px 16px; vertical-align: middle; }
        .al-td-time { font-size: 12px; color: #9CA3AF; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .al-td-dispatcher { font-size: 12px; color: #9CA3AF; white-space: nowrap; font-weight: 500; }
        .al-td-event { font-size: 12px; font-weight: 600; white-space: nowrap; }
        .al-td-detail { font-size: 12px; color: #9CA3AF; }
      `}</style>

      <div className="an-wrap">
        {/* LEFT PANEL */}
        <div className="an-panel">
          <div className="an-panel-title">Analytics</div>
          {SECTION_ITEMS.map((s) => {
            const unreviewedLow =
              s.id === "reviews"
                ? reviews.filter(
                    (rv) => rv.rating <= 2 && !rv.reviewed_by_dispatch,
                  ).length
                : 0;
            return (
              <button
                key={s.id}
                className={`an-section-btn${section === s.id ? " active" : ""}`}
                onClick={() => setSection(s.id)}
                style={{ position: "relative" }}
              >
                {s.label}
                {unreviewedLow > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      fontWeight: 700,
                      background: "rgba(248,113,113,0.15)",
                      color: "#F87171",
                      borderRadius: 8,
                      padding: "1px 6px",
                      border: "1px solid rgba(248,113,113,0.25)",
                    }}
                  >
                    {unreviewedLow}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="an-content">
          {/* ── REVENUE ── */}
          {section === "revenue" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">Revenue</div>
                <div className="an-controls">
                  <div className="an-period-btns">
                    {(["today", "week", "month", "year"] as const).map((p) => (
                      <button
                        key={p}
                        className={`an-period-btn${period === p ? " active" : ""}`}
                        onClick={() => setPeriod(p)}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                  <button
                    className="an-download-btn"
                    onClick={downloadRevenueReport}
                  >
                    ↓ PDF
                  </button>
                  <button className="an-csv-btn" onClick={exportDriverStatsCSV}>
                    ↓ CSV
                  </button>
                </div>
              </div>

              {revenueLoading ? (
                <div className="an-loading">Loading…</div>
              ) : (
                <>
                  {/* Always-visible strip */}
                  <div className="an-revenue-strip">
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">Today</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "today" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueToday.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">This week</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "week" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueWeek.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">This month</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "month" ? "#1D9E75" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueMonth.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">This year</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "year" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueYear.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {/* Period KPIs */}
                  <div className="an-kpi-grid">
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">Revenue</div>
                      <div
                        className="an-kpi-value"
                        style={{ color: "#1D9E75" }}
                      >
                        ${totals.revenue.toFixed(2)}
                      </div>
                      <div className="an-kpi-sub">
                        {periodLabel.toLowerCase()}
                      </div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">Completed</div>
                      <div className="an-kpi-value">{totals.rides}</div>
                      <div className="an-kpi-sub">rides</div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">Avg fare</div>
                      <div className="an-kpi-value">
                        ${totals.avgFare.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">Cancel rate</div>
                      <div
                        className="an-kpi-value"
                        style={{
                          color: totals.cancelRate > 20 ? "#E24B4A" : "#F1F5F9",
                        }}
                      >
                        {totals.cancelRate.toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  {/* Cash vs card split */}
                  <div className="an-chart-card" style={{ marginBottom: 16 }}>
                    <div className="an-chart-title">
                      Cash vs card · {periodLabel.toLowerCase()}
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          background: "#18222F",
                          borderRadius: 10,
                          padding: "14px 16px",
                          border: "1px solid rgba(255,255,255,0.04)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6B7280",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginBottom: 6,
                          }}
                        >
                          Cash
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            color: "#F59E0B",
                          }}
                        >
                          ${totals.cashRevenue.toFixed(2)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            marginTop: 4,
                          }}
                        >
                          {totals.cashRides} ride
                          {totals.cashRides !== 1 ? "s" : ""}
                        </div>
                        {totals.cashRevenue > 0 && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "#F59E0B",
                              marginTop: 6,
                              fontWeight: 600,
                            }}
                          >
                            ⚠ Collect from drivers
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          background: "#18222F",
                          borderRadius: 10,
                          padding: "14px 16px",
                          border: "1px solid rgba(255,255,255,0.04)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6B7280",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginBottom: 6,
                          }}
                        >
                          Card (Stripe)
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            color: "#1D9E75",
                          }}
                        >
                          ${totals.cardRevenue.toFixed(2)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            marginTop: 4,
                          }}
                        >
                          {totals.cardRides} ride
                          {totals.cardRides !== 1 ? "s" : ""}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#1D9E75",
                            marginTop: 6,
                          }}
                        >
                          Processed via Stripe
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Revenue chart */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">
                      Revenue over time{period === "today" ? " · by hour" : ""}
                    </div>
                    {(period === "today" ? hourlyData : dailyData).length === 0 ? (
                      <div className="an-no-data">
                        No completed rides in this period
                      </div>
                    ) : period === "today" ? (
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={hourlyData} margin={{ top: 4, right: 4, left: 8, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis
                            dataKey="label"
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            interval={2}
                          />
                          <YAxis
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `$${v}`}
                            width={40}
                          />
                          <Tooltip content={<RevenueTooltip />} cursor={{ fill: "rgba(232,80,10,0.06)" }} />
                          <Bar dataKey="revenue" fill="#E8500A" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={dailyData} margin={{ top: 4, right: 4, left: 8, bottom: 0 }}>
                          <defs>
                            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#E8500A" stopOpacity={0.22} />
                              <stop offset="100%" stopColor="#E8500A" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis
                            dataKey="day"
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `$${v}`}
                            width={40}
                          />
                          <Tooltip content={<RevenueTooltip />} />
                          <Area
                            type="monotone"
                            dataKey="revenue"
                            stroke="#E8500A"
                            strokeWidth={2}
                            fill="url(#revenueGrad)"
                            dot={{ fill: "#E8500A", strokeWidth: 0, r: 3 }}
                            activeDot={{ r: 5, fill: "#E8500A", stroke: "#1E2A3A", strokeWidth: 2 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>

                  {/* Driver earnings */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">Driver earnings</div>
                    {driverStats.length === 0 ? (
                      <div className="an-no-data">
                        No driver data for this period
                      </div>
                    ) : (
                      <table className="an-table">
                        <thead>
                          <tr>
                            {[
                              "Driver",
                              "Rides",
                              "Earnings",
                              "Cash",
                              "Card",
                              "Avg Fare",
                              "Cancel Rate",
                            ].map((h) => (
                              <th key={h} className="an-th">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {driverStats.map((d, i) => (
                            <tr
                              key={i}
                              style={{
                                background:
                                  i % 2 === 0
                                    ? "transparent"
                                    : "rgba(255,255,255,0.015)",
                              }}
                            >
                              <td className="an-td primary">{d.name}</td>
                              <td className="an-td">{d.rides}</td>
                              <td className="an-td green">
                                ${d.earnings.toFixed(2)}
                              </td>
                              <td className="an-td amber">
                                ${d.cashEarnings.toFixed(2)}
                              </td>
                              <td
                                className="an-td"
                                style={{ color: "#1D9E75" }}
                              >
                                ${d.cardEarnings.toFixed(2)}
                              </td>
                              <td className="an-td">${d.avgFare.toFixed(2)}</td>
                              <td
                                className={`an-td${d.cancelRate > 20 ? " red" : ""}`}
                              >
                                {d.cancelRate.toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Peak activity */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">
                      Peak activity · this year
                    </div>
                    {peakLoading ? (
                      <div className="an-no-data">Loading…</div>
                    ) : (
                      <div className="an-peak-row">
                        <div className="an-bar-chart-wrap" style={{ flex: 2 }}>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#6B7280",
                              marginBottom: 10,
                              fontWeight: 500,
                            }}
                          >
                            By hour of day
                          </div>
                          <div className="an-bars">
                            {hourStats.map((h) => (
                              <div key={h.hour} className="an-bar-col">
                                <div
                                  className="an-bar-fill"
                                  style={{
                                    height: `${Math.max(2, (h.rides / maxHour) * 100)}%`,
                                    background:
                                      peakHour && h.hour === peakHour.hour
                                        ? "#E8500A"
                                        : "#1E3A5F",
                                  }}
                                />
                                <div className="an-bar-lbl">
                                  {h.hour % 3 === 0 ? fmtHour(h.hour) : ""}
                                </div>
                              </div>
                            ))}
                          </div>
                          {peakHour && peakHour.rides > 0 && (
                            <div className="an-peak-note">
                              Peak: {fmtHour(peakHour.hour)} · {peakHour.rides}{" "}
                              rides
                            </div>
                          )}
                        </div>
                        <div className="an-bar-chart-wrap" style={{ flex: 1 }}>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#6B7280",
                              marginBottom: 10,
                              fontWeight: 500,
                            }}
                          >
                            By day of week
                          </div>
                          <div className="an-bars">
                            {dayStats.map((d) => (
                              <div key={d.day} className="an-bar-col">
                                <div
                                  className="an-bar-fill"
                                  style={{
                                    height: `${Math.max(2, (d.rides / maxDay) * 100)}%`,
                                    background:
                                      peakDay && d.day === peakDay.day
                                        ? "#E8500A"
                                        : "#1E3A5F",
                                  }}
                                />
                                <div className="an-bar-lbl">{d.day}</div>
                              </div>
                            ))}
                          </div>
                          {peakDay && peakDay.rides > 0 && (
                            <div className="an-peak-note">
                              Busiest: {peakDay.day} · {peakDay.rides} rides
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── RIDE HISTORY ── */}
          {section === "rides" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">Ride History</div>
                <div className="an-controls">
                  {availableYears.length > 0 && (
                    <select
                      className="an-select"
                      value={selectedYear}
                      onChange={(e) => setSelectedYear(Number(e.target.value))}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="an-download-btn"
                    onClick={() =>
                      downloadYearReport(selectedYear, monthGroups)
                    }
                  >
                    ↓ PDF {selectedYear}
                  </button>
                  <button
                    className="an-csv-btn"
                    onClick={() =>
                      exportRidesCSV(
                        filteredRides.filter(
                          (r) =>
                            new Date(r.created_at).getFullYear() ===
                            selectedYear,
                        ),
                        `rides-${selectedYear}.csv`,
                      )
                    }
                  >
                    ↓ CSV
                  </button>
                </div>
              </div>
              {ridesLoading ? (
                <div className="an-loading">Loading…</div>
              ) : (
                <>
                  <div className="an-filter-row">
                    {["all", "completed", "cancelled"].map((s) => (
                      <button
                        key={s}
                        className={`an-filter-btn${rideFilter === s ? " active" : ""}`}
                        onClick={() => setRideFilter(s)}
                      >
                        {s === "all" ? "All" : STATUS_LABELS[s]}
                      </button>
                    ))}
                    <span className="an-filter-count">
                      {filteredRides.length} rides
                    </span>
                  </div>
                  {monthGroups.length === 0 ? (
                    <div className="an-no-data" style={{ padding: "48px 0" }}>
                      No rides found
                    </div>
                  ) : (
                    monthGroups.map((group) => {
                      const isOpen = expandedMonths.has(group.key);
                      return (
                        <div key={group.key} className="an-month-group">
                          <div
                            className="an-month-header"
                            onClick={() => toggleMonth(group.key)}
                          >
                            <div className="an-month-header-left">
                              <span
                                className={`an-month-chevron${isOpen ? " open" : ""}`}
                              >
                                ▶
                              </span>
                              <span className="an-month-name">
                                {group.label}
                              </span>
                              <span className="an-month-meta">
                                {group.rides.length} ride
                                {group.rides.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                              }}
                            >
                              <span className="an-month-revenue">
                                ${group.totalRevenue.toFixed(2)}
                              </span>
                              <button
                                className="an-download-btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadMonthReport(group);
                                }}
                              >
                                ↓ PDF
                              </button>
                              <button
                                className="an-csv-btn"
                                style={{
                                  fontSize: 11,
                                  padding: "4px 10px",
                                  borderRadius: 6,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  exportRidesCSV(
                                    group.rides,
                                    `rides-${group.key}.csv`,
                                  );
                                }}
                              >
                                ↓ CSV
                              </button>
                            </div>
                          </div>
                          {isOpen && (
                            <div className="an-month-body">
                              <table className="an-table">
                                <thead>
                                  <tr>
                                    {[
                                      "Date",
                                      "Passenger",
                                      "Driver",
                                      "Pickup",
                                      "Drop-off",
                                      "Fare",
                                      "Status",
                                      "Payment",
                                      "Invoice",
                                    ].map((h) => (
                                      <th
                                        key={h}
                                        className="an-th"
                                        style={{ padding: "10px 14px" }}
                                      >
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.rides.map((r, i) => (
                                    <tr
                                      key={r.id}
                                      className="an-ride-row"
                                      style={{
                                        background:
                                          i % 2 === 0
                                            ? "transparent"
                                            : "rgba(255,255,255,0.015)",
                                      }}
                                      onClick={() => openRideDetail(r)}
                                    >
                                      <td
                                        className="an-td"
                                        style={{ whiteSpace: "nowrap" }}
                                      >
                                        {new Date(
                                          r.created_at,
                                        ).toLocaleDateString("en-CA", {
                                          month: "short",
                                          day: "numeric",
                                        })}
                                      </td>
                                      <td className="an-td primary">
                                        {r.passenger_name}
                                      </td>
                                      <td className="an-td">{r.driver_name}</td>
                                      <td className="an-td addr">
                                        {r.pickup_address}
                                      </td>
                                      <td className="an-td addr">
                                        {r.dropoff_address}
                                      </td>
                                      <td
                                        className="an-td"
                                        style={{
                                          fontWeight: 600,
                                          color: "#9CA3AF",
                                        }}
                                      >
                                        {r.fare_final
                                          ? `$${r.fare_final.toFixed(2)}`
                                          : r.fare_estimate
                                            ? `$${r.fare_estimate.toFixed(2)}`
                                            : "—"}
                                      </td>
                                      <td className="an-td">
                                        <span
                                          className="an-status"
                                          style={{
                                            background:
                                              STATUS_COLORS[r.status] + "18",
                                            color: STATUS_COLORS[r.status],
                                            border: `1px solid ${STATUS_COLORS[r.status]}30`,
                                          }}
                                        >
                                          {STATUS_LABELS[r.status] ?? r.status}
                                        </span>
                                      </td>
                                      <td
                                        className="an-td"
                                        style={{ textTransform: "capitalize" }}
                                      >
                                        {r.payment_method}
                                      </td>
                                      <td className="an-td">
                                        {r.invoice_number ? (
                                          <span className="inv-tag">{r.invoice_number}</span>
                                        ) : (
                                          <span style={{ color: "#6B7280" }}>—</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </>
              )}
            </>
          )}

          {/* ── REVIEWS ── */}
          {section === "reviews" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">Reviews</div>
                <div className="an-controls">
                  <button className="an-download-btn" onClick={exportReviewsPDF}>↓ PDF</button>
                  <button className="an-csv-btn" onClick={exportReviewsCSV}>↓ CSV</button>
                </div>
              </div>
              {reviewsLoading ? (
                <div className="an-loading">Loading…</div>
              ) : (
                <>
                  <div
                    className="an-filter-row"
                    style={{ gap: 10, marginBottom: 16 }}
                  >
                    <select
                      className="an-select"
                      value={reviewDriverFilter}
                      onChange={(e) => setReviewDriverFilter(e.target.value)}
                    >
                      <option value="all">All drivers</option>
                      {reviewDriverOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[null, 1, 2, 3, 4, 5].map((s) => (
                        <button
                          key={s ?? "all"}
                          className={`an-filter-btn${reviewStarFilter === s ? " active" : ""}`}
                          onClick={() => setReviewStarFilter(s)}
                          style={{ padding: "5px 10px" }}
                        >
                          {s === null ? "All" : "★".repeat(s)}
                        </button>
                      ))}
                    </div>
                    <span className="an-filter-count">
                      {filteredReviews.length} review
                      {filteredReviews.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {reviewDriverFilter !== "all" &&
                    selectedDriverAvg !== null && (
                      <div
                        className="an-revenue-strip"
                        style={{
                          marginBottom: 16,
                          gridTemplateColumns: "repeat(3, 1fr)",
                        }}
                      >
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">Reviews</div>
                          <div className="an-revenue-mini-value">
                            {selectedDriverReviews.length}
                          </div>
                        </div>
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">
                            Avg rating
                          </div>
                          <div
                            className="an-revenue-mini-value"
                            style={{
                              color:
                                selectedDriverAvg >= 4
                                  ? "#1D9E75"
                                  : selectedDriverAvg <= 2
                                    ? "#E24B4A"
                                    : "#F59E0B",
                            }}
                          >
                            {selectedDriverAvg.toFixed(1)} ★
                          </div>
                        </div>
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">
                            Low ratings (≤2)
                          </div>
                          <div
                            className="an-revenue-mini-value"
                            style={{
                              color:
                                selectedDriverFlagged > 0
                                  ? "#E24B4A"
                                  : "#F1F5F9",
                            }}
                          >
                            {selectedDriverFlagged > 0
                              ? `⚠ ${selectedDriverFlagged}`
                              : "—"}
                          </div>
                        </div>
                      </div>
                    )}

                  {filteredReviews.length === 0 ? (
                    <div className="an-no-data" style={{ padding: "48px 0" }}>
                      No reviews match these filters
                    </div>
                  ) : (
                    filteredReviews.map((rv) => (
                      <div
                        key={rv.id}
                        className={`an-review-card${rv.rating <= 2 ? " flagged" : ""}${rv.reviewed_by_dispatch ? " dispatch-reviewed" : ""}`}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginBottom:
                              rv.rating <= 2 || rv.reviewed_by_dispatch ? 8 : 0,
                            flexWrap: "wrap",
                          }}
                        >
                          {rv.rating <= 2 && (
                            <span className="an-review-flag">⚠ Low rating</span>
                          )}
                          {rv.reviewed_by_dispatch && (
                            <span className="an-reviewed-badge">
                              ✓ Reviewed by dispatch
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 8,
                          }}
                        >
                          <div>
                            <span
                              style={{
                                color: "#F59E0B",
                                fontSize: 14,
                                letterSpacing: 1,
                              }}
                            >
                              {"★".repeat(rv.rating)}
                              {"☆".repeat(5 - rv.rating)}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "#9CA3AF",
                                marginLeft: 6,
                              }}
                            >
                              {rv.rating}/5
                            </span>
                          </div>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>
                            {new Date(rv.created_at).toLocaleDateString(
                              "en-CA",
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </span>
                        </div>
                        <div
                          style={{ display: "flex", gap: 20, marginBottom: 6 }}
                        >
                          <div style={{ fontSize: 12, color: "#9CA3AF" }}>
                            <span style={{ color: "#6B7280" }}>Driver: </span>
                            {rv.driver_name ?? "—"}
                          </div>
                          <div style={{ fontSize: 12, color: "#9CA3AF" }}>
                            <span style={{ color: "#6B7280" }}>
                              Passenger:{" "}
                            </span>
                            {rv.passenger_name ?? "—"}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#9CA3AF",
                            marginBottom: rv.comment ? 8 : 0,
                          }}
                        >
                          {rv.pickup_address} → {rv.dropoff_address}
                        </div>
                        {rv.comment && (
                          <div
                            style={{
                              background: "rgba(255,255,255,0.03)",
                              borderRadius: 6,
                              padding: "8px 12px",
                              borderLeft: "2px solid #2D3F52",
                              fontSize: 13,
                              color: "#9CA3AF",
                              fontStyle: "italic",
                            }}
                          >
                            "{rv.comment}"
                          </div>
                        )}
                        {rv.rating <= 2 && !rv.reviewed_by_dispatch && (
                          <button
                            className="an-mark-reviewed-btn"
                            disabled={markingReviewed === rv.id}
                            onClick={() => markReviewReviewed(rv.id)}
                          >
                            {markingReviewed === rv.id
                              ? "Saving…"
                              : "✓ Mark as reviewed"}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
            </>
          )}

          {/* ── DRIVERS ── */}
          {section === "drivers" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">Driver Performance</div>
                <div className="an-controls">
                  <div className="an-period-btns">
                    {(["today", "week", "month", "year"] as const).map((p) => (
                      <button
                        key={p}
                        className={`an-period-btn${period === p ? " active" : ""}`}
                        onClick={() => setPeriod(p)}
                      >
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                  <button className="an-download-btn" onClick={exportDriversPDF}>↓ PDF</button>
                  <button className="an-csv-btn" onClick={exportDriverStatsCSV}>↓ CSV</button>
                </div>
              </div>
              {revenueLoading ? (
                <div className="an-loading">Loading…</div>
              ) : driverStats.length === 0 ? (
                <div className="an-no-data">No driver data for this period</div>
              ) : (
                <div
                  className="an-chart-card"
                  style={{ padding: 0, overflow: "hidden" }}
                >
                  <table className="an-table">
                    <thead>
                      <tr>
                        {[
                          "Driver",
                          "Rides",
                          "Earnings",
                          "Cash",
                          "Card",
                          "Avg Fare",
                          "Cancel %",
                          "Avg Rating",
                        ].map((h) => (
                          <th
                            key={h}
                            className="an-th"
                            style={{ padding: "12px 14px" }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {driverStats.map((d, i) => (
                        <tr
                          key={d.id}
                          style={{
                            background:
                              i % 2 === 0
                                ? "transparent"
                                : "rgba(255,255,255,0.015)",
                          }}
                        >
                          <td className="an-td primary">{d.name}</td>
                          <td className="an-td">{d.rides}</td>
                          <td className="an-td green">
                            ${d.earnings.toFixed(2)}
                          </td>
                          <td className="an-td amber">
                            ${d.cashEarnings.toFixed(2)}
                          </td>
                          <td className="an-td" style={{ color: "#1D9E75" }}>
                            ${d.cardEarnings.toFixed(2)}
                          </td>
                          <td className="an-td">${d.avgFare.toFixed(2)}</td>
                          <td
                            className={`an-td${d.cancelRate > 20 ? " red" : ""}`}
                          >
                            {d.cancelRate.toFixed(1)}%
                          </td>
                          <td className="an-td">
                            {d.avgRating !== null ? (
                              <span
                                style={{
                                  color:
                                    d.avgRating >= 4
                                      ? "#1D9E75"
                                      : d.avgRating <= 2
                                        ? "#E24B4A"
                                        : "#F59E0B",
                                  fontWeight: 600,
                                }}
                              >
                                {d.avgRating.toFixed(1)} ★
                                <span
                                  style={{
                                    fontSize: 10,
                                    color: "#6B7280",
                                    fontWeight: 400,
                                    marginLeft: 4,
                                  }}
                                >
                                  ({d.ratingCount})
                                </span>
                              </span>
                            ) : (
                              <span style={{ color: "#6B7280" }}>—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {/* ── ACTIVITY LOG ── */}
          {section === "activity" && (() => {
            const filtered = activityTypeFilter === "all"
              ? activityEvents
              : activityEvents.filter((e) => e.event_type === activityTypeFilter);
            const cancels = filtered.filter((e) => e.event_type === "ride.cancelled").length;
            const driverActions = filtered.filter((e) => e.event_type.startsWith("driver.") || e.event_type.startsWith("invite.")).length;
            const announcements = filtered.filter((e) => e.event_type.startsWith("announcement.")).length;

            return (
              <>
                {/* Header row */}
                <div className="an-section-header" style={{ marginBottom: 12 }}>
                  <div>
                    <div className="an-section-title">Activity Log</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
                      {activityDateFrom} → {activityDateTo}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="an-download-btn"
                      onClick={() => exportActivityPDF(filtered)}
                      disabled={filtered.length === 0}
                    >
                      ↓ PDF
                    </button>
                    <button
                      className="an-csv-btn"
                      onClick={() => exportActivityCSV(filtered)}
                      disabled={filtered.length === 0}
                    >
                      ↓ CSV
                    </button>
                  </div>
                </div>

                {/* Filter toolbar */}
                <div className="al-toolbar">
                  <span className="al-toolbar-label">From</span>
                  <input
                    type="date"
                    className="an-date-input"
                    value={activityDateFrom}
                    onChange={(e) => setActivityDateFrom(e.target.value)}
                  />
                  <span className="al-toolbar-label">to</span>
                  <input
                    type="date"
                    className="an-date-input"
                    value={activityDateTo}
                    onChange={(e) => setActivityDateTo(e.target.value)}
                  />
                  <div className="al-toolbar-sep" />
                  <select
                    className="an-type-select"
                    value={activityTypeFilter}
                    onChange={(e) => setActivityTypeFilter(e.target.value)}
                  >
                    <option value="all">All event types</option>
                    <optgroup label="Rides">
                      <option value="ride.created">Created ride</option>
                      <option value="ride.cancelled">Cancelled ride</option>
                      <option value="ride.assigned">Assigned ride</option>
                      <option value="ride.reassigned">Reassigned ride</option>
                      <option value="ride.fare_changed">Changed fare</option>
                      <option value="ride.scheduled_modified">Edited ride</option>
                    </optgroup>
                    <optgroup label="Drivers">
                      <option value="driver.suspended">Suspended driver</option>
                      <option value="driver.reactivated">Reactivated driver</option>
                      <option value="driver.deleted">Deleted driver</option>
                      <option value="invite.created">Created invite</option>
                      <option value="invite.revoked">Revoked invite</option>
                    </optgroup>
                    <optgroup label="Discounts">
                      <option value="discount.created">Created discount</option>
                      <option value="discount.deactivated">Deactivated discount</option>
                      <option value="discount.deleted">Deleted discount</option>
                    </optgroup>
                    <optgroup label="Announcements">
                      <option value="announcement.drivers">Driver announcement</option>
                      <option value="announcement.passengers">Passenger announcement</option>
                    </optgroup>
                    <optgroup label="Exports">
                      <option value="export.csv">CSV export</option>
                      <option value="export.pdf">PDF export</option>
                      <option value="invoice.printed">Printed receipt</option>
                    </optgroup>
                  </select>
                  {activityLoading && (
                    <span style={{ fontSize: 11, color: "#6B7280", marginLeft: 4 }}>Loading…</span>
                  )}
                </div>

                {/* Stats strip */}
                <div className="al-stats">
                  <div className="al-stat">
                    <span className="al-stat-val">{filtered.length}</span>
                    <span className="al-stat-lbl">Total events</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val" style={{ color: cancels > 0 ? "#E24B4A" : "#F1F5F9" }}>{cancels}</span>
                    <span className="al-stat-lbl">Cancellations</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val">{driverActions}</span>
                    <span className="al-stat-lbl">Driver actions</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val">{announcements}</span>
                    <span className="al-stat-lbl">Announcements</span>
                  </div>
                </div>

                {/* Debug error */}
                {activityError && (
                  <div style={{ background: "#2D1515", border: "1px solid #E24B4A44", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#E24B4A", fontFamily: "monospace" }}>
                    {activityError}
                  </div>
                )}

                {/* Table */}
                {!activityLoading && filtered.length === 0 ? (
                  <div className="an-no-data" style={{ padding: "48px 0" }}>
                    {activityError ? "Could not load events — see error above" : "No events in this period"}
                  </div>
                ) : (
                  <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                    <table className="al-table">
                      <thead>
                        <tr>
                          <th className="al-th">Date / Time</th>
                          <th className="al-th">Dispatcher</th>
                          <th className="al-th">Event</th>
                          <th className="al-th">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((e) => {
                          const color = EVENT_COLORS[e.event_type] ?? "#6B7280";
                          const detail = formatEventDetails(e.event_type, e.details);
                          return (
                            <tr key={e.id} className="al-tr">
                              <td className="al-td al-td-time">
                                {new Date(e.created_at).toLocaleString("en-CA", {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                } as any)}
                              </td>
                              <td className="al-td al-td-dispatcher">{e.dispatcher_name ?? "—"}</td>
                              <td className="al-td al-td-event" style={{ color }}>
                                {EVENT_LABELS[e.event_type] ?? e.event_type}
                              </td>
                              <td className="al-td al-td-detail">{detail || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}

          {/* ── INVOICES ── */}
          {section === "invoices" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">Invoices</div>
                <div className="an-controls">
                  <span className="an-filter-count">
                    {filteredInvoices.length} invoice{filteredInvoices.length !== 1 ? "s" : ""}
                  </span>
                  <button className="an-download-btn" onClick={exportInvoicesPDF} disabled={filteredInvoices.length === 0}>↓ PDF</button>
                  <button className="an-csv-btn" onClick={exportInvoicesCSV} disabled={filteredInvoices.length === 0}>↓ CSV</button>
                </div>
              </div>
              <div className="inv-search-row">
                <input
                  className="inv-search"
                  placeholder="Search by invoice # or passenger name…"
                  value={invoiceSearch}
                  onChange={(e) => setInvoiceSearch(e.target.value)}
                />
              </div>
              {invoicesLoading ? (
                <div className="an-loading">Loading…</div>
              ) : filteredInvoices.length === 0 ? (
                <div className="an-no-data" style={{ padding: "48px 0" }}>
                  {invoiceSearch ? "No invoices match your search" : "No invoices yet — receipts will appear here after rides complete"}
                </div>
              ) : (
                <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                  <table className="an-table">
                    <thead>
                      <tr>
                        {["Invoice #", "Date", "Passenger", "Driver", "Route", "Amount", "Payment"].map((h) => (
                          <th key={h} className="an-th" style={{ padding: "12px 14px" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInvoices.map((inv, i) => (
                        <tr
                          key={inv.id}
                          className="an-ride-row"
                          style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}
                          onClick={() => setSelectedInvoice(inv)}
                        >
                          <td className="an-td">
                            <span className="inv-tag">{inv.invoice_number}</span>
                          </td>
                          <td className="an-td" style={{ whiteSpace: "nowrap" }}>
                            {new Date(inv.sent_at).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}
                          </td>
                          <td className="an-td primary">{inv.passenger_name ?? "—"}</td>
                          <td className="an-td">{inv.driver_name ?? "—"}</td>
                          <td className="an-td addr">
                            {inv.pickup_address && inv.dropoff_address
                              ? `${inv.pickup_address} → ${inv.dropoff_address}`
                              : inv.pickup_address ?? "—"}
                          </td>
                          <td className="an-td green">${inv.fare.toFixed(2)}</td>
                          <td className="an-td" style={{ textTransform: "capitalize" }}>{inv.payment_method ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedInvoice && (
                <div className="an-modal-overlay" onClick={() => setSelectedInvoice(null)}>
                  <div className="an-modal" onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div className="an-modal-title" style={{ marginBottom: 0 }}>Invoice</div>
                      <span className="inv-tag" style={{ fontSize: 13, padding: "4px 10px" }}>
                        {selectedInvoice.invoice_number}
                      </span>
                    </div>
                    {(
                      [
                        ["Date", new Date(selectedInvoice.sent_at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })],
                        ["Company", selectedInvoice.company_name ?? "—"],
                        ...(selectedInvoice.hst_number ? [["HST Reg", selectedInvoice.hst_number]] : []),
                        ["Passenger", selectedInvoice.passenger_name ?? "—"],
                        ["Driver", selectedInvoice.driver_name ?? "—"],
                        ["Pickup", selectedInvoice.pickup_address ?? "—"],
                        ["Drop-off", selectedInvoice.dropoff_address ?? "—"],
                        ["Payment", selectedInvoice.payment_method ?? "—"],
                        ["Subtotal", `$${(selectedInvoice.fare / 1.15).toFixed(2)}`],
                        ["HST (15%)", `$${(selectedInvoice.fare - selectedInvoice.fare / 1.15).toFixed(2)}`],
                        ["Total", `$${selectedInvoice.fare.toFixed(2)}`],
                      ] as [string, string][]
                    ).map(([lbl, val]) => (
                      <div
                        key={lbl}
                        className="an-detail-row"
                        style={lbl === "Total" ? { borderTop: "1px solid rgba(255,255,255,0.12)", marginTop: 4, paddingTop: 12 } : {}}
                      >
                        <span className="an-detail-label">{lbl}</span>
                        <span
                          className="an-detail-value"
                          style={lbl === "Total" ? { color: "#1D9E75", fontWeight: 700, fontSize: 16 } : {}}
                        >
                          {val}
                        </span>
                      </div>
                    ))}
                    <button
                      className="an-download-btn"
                      style={{ width: "100%", marginTop: 16, textAlign: "center" }}
                      onClick={() => printInvoiceReceipt(selectedInvoice)}
                    >
                      Print Receipt
                    </button>
                    <button className="an-modal-close" onClick={() => setSelectedInvoice(null)}>
                      Close
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── RIDE DETAIL MODAL ── */}
      {rideDetail && (
        <div className="an-modal-overlay" onClick={() => setRideDetail(null)}>
          <div className="an-modal" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <div className="an-modal-title" style={{ marginBottom: 0 }}>
                Ride details
              </div>
              <span
                className="an-status"
                style={{
                  background: STATUS_COLORS[rideDetail.ride.status] + "18",
                  color: STATUS_COLORS[rideDetail.ride.status],
                  border: `1px solid ${STATUS_COLORS[rideDetail.ride.status]}30`,
                }}
              >
                {STATUS_LABELS[rideDetail.ride.status] ??
                  rideDetail.ride.status}
              </span>
            </div>
            {(
              [
                [
                  "Date",
                  new Date(rideDetail.ride.created_at).toLocaleString("en-CA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                ],
                ["Passenger", rideDetail.ride.passenger_name],
                ["Driver", rideDetail.ride.driver_name],
                ["Pickup", rideDetail.ride.pickup_address],
                ["Drop-off", rideDetail.ride.dropoff_address],
                [
                  "Fare estimate",
                  rideDetail.ride.fare_estimate
                    ? `$${rideDetail.ride.fare_estimate.toFixed(2)}`
                    : "—",
                ],
                [
                  "Fare final",
                  rideDetail.ride.fare_final
                    ? `$${rideDetail.ride.fare_final.toFixed(2)}`
                    : "—",
                ],
                ["Payment", rideDetail.ride.payment_method],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="an-detail-row">
                <span className="an-detail-label">{label}</span>
                <span className="an-detail-value">{value}</span>
              </div>
            ))}

            {rideDetail.review && (
              <>
                <div className="an-modal-section">Review</div>
                <div
                  style={{
                    background: "#18222F",
                    borderRadius: 10,
                    padding: 14,
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  {rideDetail.review.rating <= 2 && (
                    <span
                      className="an-review-flag"
                      style={{ marginBottom: 10, display: "inline-block" }}
                    >
                      ⚠ Low rating
                    </span>
                  )}
                  {rideDetail.review.reviewed_by_dispatch && (
                    <span
                      className="an-reviewed-badge"
                      style={{
                        marginBottom: 10,
                        marginLeft: rideDetail.review.rating <= 2 ? 8 : 0,
                        display: "inline-block",
                      }}
                    >
                      ✓ Reviewed
                    </span>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: rideDetail.review.comment ? 8 : 0,
                    }}
                  >
                    <span
                      style={{
                        color: "#F59E0B",
                        fontSize: 15,
                        letterSpacing: 1,
                      }}
                    >
                      {"★".repeat(rideDetail.review.rating)}
                      {"☆".repeat(5 - rideDetail.review.rating)}
                    </span>
                    <span style={{ fontSize: 12, color: "#6B7280" }}>
                      {rideDetail.review.rating}/5
                    </span>
                  </div>
                  {rideDetail.review.comment && (
                    <div
                      style={{
                        background: "rgba(255,255,255,0.03)",
                        borderRadius: 6,
                        padding: "8px 12px",
                        borderLeft: "2px solid #2D3F52",
                        fontSize: 13,
                        color: "#6B7280",
                        fontStyle: "italic",
                      }}
                    >
                      "{rideDetail.review.comment}"
                    </div>
                  )}
                  {!rideDetail.review.reviewed_by_dispatch && (
                    <button
                      className="an-mark-reviewed-btn"
                      style={{ display: "block", marginTop: 10 }}
                      disabled={markingReviewed === rideDetail.review.id}
                      onClick={() => markReviewReviewed(rideDetail.review!.id)}
                    >
                      {markingReviewed === rideDetail.review.id
                        ? "Saving…"
                        : "✓ Mark as reviewed"}
                    </button>
                  )}
                </div>
              </>
            )}
            {!rideDetail.review && rideDetail.ride.status === "completed" && (
              <div
                style={{
                  fontSize: 12,
                  color: "#6B7280",
                  textAlign: "center",
                  padding: "12px 0",
                }}
              >
                No review left for this ride
              </div>
            )}

            <button
              className="an-modal-close"
              onClick={() => setRideDetail(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
