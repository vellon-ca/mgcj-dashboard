import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import type { Ride, Driver, Profile, DriverInvite } from "../types";
import AnalyticsPage from "./AnalyticsPage";
import ReportsPage from "./ReportsPage";
import DiscountsPage from "./DiscountsPage";

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
const NON_EDITABLE_STATUSES = new Set(["in_progress", "completed", "cancelled"]);

type Tab = "rides" | "drivers";

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
function DriverDetailPanel({
  driver,
  rides,
  onClose,
}: {
  driver: any;
  rides: Ride[];
  onClose: () => void;
}) {
  const [history, setHistory] = useState<any[]>([]);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalRides, setTotalRides] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDriverDetail();
  }, [driver.id]);

  async function fetchDriverDetail() {
    setLoading(true);
    const [ridesRes, reviewsRes, reportsRes] = await Promise.all([
      supabase
        .from("rides")
        .select(
          "id, status, pickup_address, dropoff_address, fare_final, fare_estimate, created_at, passenger_id",
        )
        .eq("driver_id", driver.id)
        .order("created_at", { ascending: false })
        .limit(30),
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
    setTotalRides(rideRows.filter((r: any) => r.status === "completed").length);
    setAvgRating(avg);
    setOpenReports(reportsRes.data?.length ?? 0);
    setLoading(false);
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
            <div className="dd-profile-name">{name}</div>
            <div className="dd-profile-sub">
              {driver.vehicle_make} {driver.vehicle_model} ·{" "}
              {driver.plate_number ?? "—"}
            </div>
            <div className="dd-profile-phone">
              {driver.profile?.phone ?? "—"}
            </div>
          </div>
          <div
            className="dd-status-dot"
            style={{ background: driver.is_active ? "#1D9E75" : "#374151" }}
          />
        </div>
        <div className="dd-status-row">
          {driver.is_active ? (
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
                    : "#4B5563",
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
                    background: STATUS_COLORS[ride.status] + "18",
                    color: STATUS_COLORS[ride.status],
                    border: `1px solid ${STATUS_COLORS[ride.status]}30`,
                    fontSize: 10,
                  }}
                >
                  {STATUS_LABELS[ride.status]}
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

// Scheduled Ride Card
function ScheduledRideCard({
  ride,
  assigningRide,
  onlineDrivers,
  onCardClick,
  onAssign,
  onCancelAssign,
  onAssignDriver,
  onCancel,
}: {
  ride: any;
  assigningRide: string | null;
  onlineDrivers: any[];
  onCardClick: () => void;
  onAssign: () => void;
  onCancelAssign: () => void;
  onAssignDriver: (driverId: string) => void;
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
      {ride.driver_id && (
        <div className="db-sched-driver-row">
          <div className="db-sched-driver-dot" />
          <span className="db-sched-driver-name">
            {(ride as any).driver?.profile?.name ?? "Driver assigned"}
          </span>
        </div>
      )}
      {ride.status === "offered" && (
        <div className="db-pending-badge" style={{ margin: "8px 12px 0" }}>
          ⏳ Awaiting driver confirmation
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
  onSignOut,
}: {
  profile: Profile;
  onSignOut: () => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const mapInitialized = useRef(false);

  const [rides, setRides] = useState<Ride[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
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
  const [tab, setTab] = useState<Tab>("rides");
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showDiscounts, setShowDiscounts] = useState(false);
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteName, setInviteName] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookPassenger, setBookPassenger] = useState("");
  const [bookPassengerName, setBookPassengerName] = useState("");
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
  const [bookDiscountCode, setBookDiscountCode] = useState("");
  const [bookDriver, setBookDriver] = useState("");
  const [bookScheduled, setBookScheduled] = useState("");
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const pickupInputRef = useRef<HTMLInputElement>(null);
  const dropoffInputRef = useRef<HTMLInputElement>(null);
  const pickupAutocompleteRef = useRef<any>(null);
  const dropoffAutocompleteRef = useRef<any>(null);
  const [assigningRide, setAssigningRide] = useState<string | null>(null);
  const [rideDetail, setRideDetail] = useState<Ride | null>(null);
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
  const [editPayment, setEditPayment] = useState("");
  const [editScheduled, setEditScheduled] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editPickupInputRef = useRef<HTMLInputElement>(null);
  const editDropoffInputRef = useRef<HTMLInputElement>(null);
  const editPickupAutocompleteRef = useRef<any>(null);
  const editDropoffAutocompleteRef = useRef<any>(null);
  const [flaggedReviews, setFlaggedReviews] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [navExpanded, setNavExpanded] = useState(false);

  useEffect(() => {
    const tryInit = () => {
      if (mapInitialized.current) return;
      if (!mapRef.current || mapRef.current.offsetHeight === 0) {
        setTimeout(tryInit, 150);
        return;
      }
      if (!(window as any).google?.maps) {
        if (!document.getElementById("gmaps")) {
          const s = document.createElement("script");
          s.id = "gmaps";
          s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&libraries=places`;
          s.async = true;
          s.onload = () => initMap();
          document.head.appendChild(s);
        }
        return;
      }
      initMap();
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
    }
    tryInit();
  }, []);

  useEffect(() => {
    if (
      !showAnalytics &&
      !showReports &&
      !showDiscounts &&
      !selectedDriver &&
      googleMapRef.current
    ) {
      setTimeout(() => {
        if (googleMapRef.current)
          google.maps.event.trigger(googleMapRef.current, "resize");
      }, 50);
    }
  }, [showAnalytics, showReports, showDiscounts, selectedDriver]);

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
        { event: "*", schema: "public", table: "rides" },
        fetchAll,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "drivers" },
        fetchDrivers,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  async function fetchAll() {
    await Promise.all([
      fetchRides(),
      fetchDrivers(),
      fetchInvites(),
      fetchReviewsBadge(),
      fetchReportsBadge(),
    ]);
    setLoading(false);
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
    const profileMap = await batchProfiles(data.map((d: any) => d.id));
    const enriched = data.map((d: any) => ({
      ...d,
      profile: profileMap.get(d.id) ?? null,
    }));
    setDrivers(enriched);
    setStats((s) => ({
      ...s,
      driversOnline: enriched.filter((d: any) => d.is_active).length,
    }));
    setSelectedDriver((prev: any) => {
      if (!prev) return null;
      return enriched.find((d: any) => d.id === prev.id) ?? prev;
    });
    if (!googleMapRef.current) return;
    enriched
      .filter((d: any) => d.is_active && d.current_lat && d.current_lng)
      .forEach((d: any) => {
        const key = `driver-${d.id}`;
        const pos = { lat: d.current_lat!, lng: d.current_lng! };
        if (markersRef.current.has(key)) {
          markersRef.current.get(key)!.setPosition(pos);
        } else {
          const m = new google.maps.Marker({
            position: pos,
            map: googleMapRef.current!,
            title: d.profile?.name ?? "Driver",
            label: { text: "🚗", fontSize: "18px" },
          });
          markersRef.current.set(key, m);
        }
      });
  }

  async function fetchInvites() {
    const { data: pending } = await supabase
      .from("driver_invites")
      .select("*")
      .eq("used", false)
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
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const active = rideData.filter((r) =>
      [
        "pending",
        "offered",
        "assigned",
        "driver_arriving",
        "in_progress",
      ].includes(r.status),
    );
    const completedToday = rideData.filter(
      (r) => r.status === "completed" && new Date(r.created_at) >= todayStart,
    );
    const completedWeek = rideData.filter(
      (r) => r.status === "completed" && new Date(r.created_at) >= weekStart,
    );
    const completedMonth = rideData.filter(
      (r) => r.status === "completed" && new Date(r.created_at) >= monthStart,
    );
    const sum = (arr: Ride[]) =>
      arr.reduce((s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0), 0);
    const total = rideData.filter((r) =>
      ["completed", "cancelled"].includes(r.status),
    );
    const cancelled = rideData.filter((r) => r.status === "cancelled");
    setStats((prev) => ({
      ...prev,
      activeRides: active.length,
      completedToday: completedToday.length,
      revenueToday: sum(completedToday),
      revenueWeek: sum(completedWeek),
      revenueMonth: sum(completedMonth),
      avgFare: completedMonth.length
        ? sum(completedMonth) / completedMonth.length
        : 0,
      cancelRate: total.length ? (cancelled.length / total.length) * 100 : 0,
    }));
  }

  function updateMapMarkers(rideData: Ride[]) {
    if (!googleMapRef.current) return;
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

  function focusRideOnMap(ride: Ride) {
    if (!googleMapRef.current) return;
    setSelectedRide(ride.id);
    googleMapRef.current.panTo({ lat: ride.pickup_lat, lng: ride.pickup_lng });
    googleMapRef.current.setZoom(14);
  }

  async function createInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteName.trim() || !invitePhone.trim()) return;
    setInviteLoading(true);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    const { error } = await supabase.from("driver_invites").insert({
      name: inviteName.trim(),
      phone: invitePhone.trim(),
      code,
      used: false,
      created_by: profile.id,
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
  }

  async function revokeInvite(id: string) {
    await supabase.from("driver_invites").delete().eq("id", id);
    fetchInvites();
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
        if (status === "OK" && response) {
          const metres = response.rows[0]?.elements[0]?.distance?.value ?? 0;
          // Manual bookings are always cash; round up to the nearest dollar
          // so the displayed estimate matches the fare that gets saved.
          setBookFare(Math.ceil(4 + (metres / 1000) * 1.8).toFixed(2));
        }
      },
    );
  }, [bookPickupCoords, bookDropoffCoords]);

  useEffect(() => {
    if (!editAddressChanged) return;
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
        if (status === "OK" && response) {
          const metres = response.rows[0]?.elements[0]?.distance?.value ?? 0;
          const rawFare = 4 + (metres / 1000) * 1.8;
          setEditFare(
            (editPayment === "cash"
              ? Math.ceil(rawFare)
              : Math.round(rawFare * 100) / 100
            ).toFixed(2),
          );
        }
      },
    );
  }, [editAddressChanged, editPickupCoords, editDropoffCoords, editPayment]);

  async function createManualBooking(e: React.FormEvent) {
    e.preventDefault();
    setBookLoading(true);
    setBookError(null);
    try {
      const phone = bookPassenger.trim();
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
        const { data: restoreData, error: restoreError } =
          await supabase.auth.setSession({
            access_token: savedAccessToken,
            refresh_token: savedRefreshToken,
          });
        console.log(
          "Session restore:",
          restoreData?.user?.id,
          "error:",
          restoreError,
        );
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
        pickup_lat: bookPickupCoords?.lat ?? 45.0773,
        pickup_lng: bookPickupCoords?.lng ?? -64.3601,
        dropoff_address: bookDropoff.trim(),
        dropoff_lat: bookDropoffCoords?.lat ?? 45.0773,
        dropoff_lng: bookDropoffCoords?.lng ?? -64.3601,
        fare_estimate: finalFare,
        pre_discount_fare: preDiscountFare,
        discount_amount: discountAmount,
        discount_type: discountType,
        discount_code_id: discountCodeId,
        payment_method: "cash",
      };
      if (bookScheduled) {
        rideData.status = "scheduled";
        rideData.scheduled_at = new Date(bookScheduled).toISOString();
      }
      if (bookDriver) {
        rideData.driver_id = bookDriver;
        rideData.status = bookScheduled ? "scheduled" : "offered";
        if (bookScheduled) rideData.confirmed_by_driver = true;
      }
      const { error } = await supabase.from("rides").insert(rideData);
      if (error) {
        setBookError(error.message);
        setBookLoading(false);
        return;
      }
      setBookingOpen(false);
      setBookPassenger("");
      setBookPassengerName("");
      setBookPickup("");
      setBookPickupCoords(null);
      setBookDropoff("");
      setBookDropoffCoords(null);
      setBookFare("");
      setBookDiscountCode("");
      setBookDriver("");
      setBookScheduled("");
      fetchRides();
    } catch (e: any) {
      setBookError(e.message);
    } finally {
      setBookLoading(false);
    }
  }

  async function assignDriver(rideId: string, driverId: string) {
    const ride = rides.find((r) => r.id === rideId);
    const isFutureScheduled =
      (ride as any)?.scheduled_at &&
      new Date((ride as any).scheduled_at) > new Date();
    await supabase
      .from("rides")
      .update(
        isFutureScheduled
          ? {
              driver_id: driverId,
              status: "scheduled",
              confirmed_by_driver: true,
            }
          : { driver_id: driverId, status: "offered" },
      )
      .eq("id", rideId);
    setAssigningRide(null);
    fetchRides();
  }

  async function cancelRide(rideId: string) {
    if (!confirm("Cancel this ride?")) return;
    await supabase
      .from("rides")
      .update({ status: "cancelled" })
      .eq("id", rideId);
    fetchRides();
  }

  function startEditRide(ride: Ride) {
    setEditPickup(ride.pickup_address);
    setEditPickupCoords({ lat: ride.pickup_lat, lng: ride.pickup_lng });
    setEditDropoff(ride.dropoff_address);
    setEditDropoffCoords({ lat: ride.dropoff_lat, lng: ride.dropoff_lng });
    setEditFare(ride.fare_estimate != null ? String(ride.fare_estimate) : "");
    setEditPayment(ride.payment_method);
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
    setEditError(null);
    setEditingRide(true);
  }

  async function saveRideEdits(rideId: string) {
    setEditSaving(true);
    setEditError(null);
    const updates: any = {
      pickup_address: editPickup.trim(),
      pickup_lat: editPickupCoords?.lat,
      pickup_lng: editPickupCoords?.lng,
      dropoff_address: editDropoff.trim(),
      dropoff_lat: editDropoffCoords?.lat,
      dropoff_lng: editDropoffCoords?.lng,
      fare_estimate: editFare
        ? editPayment === "cash"
          ? Math.ceil(parseFloat(editFare))
          : parseFloat(editFare)
        : null,
      payment_method: editPayment,
      scheduled_at: editScheduled ? new Date(editScheduled).toISOString() : null,
    };
    const { error } = await supabase
      .from("rides")
      .update(updates)
      .eq("id", rideId);
    setEditSaving(false);
    if (error) {
      setEditError(error.message);
      return;
    }
    setEditingRide(false);
    setRideDetail(null);
    fetchRides();
  }

  function navigateTo(dest: "analytics" | "reports" | "discounts" | "main") {
    setShowAnalytics(dest === "analytics");
    setShowReports(dest === "reports");
    setShowDiscounts(dest === "discounts");
  }

  const activeRides = rides.filter(
    (r) =>
      [
        "pending",
        "offered",
        "assigned",
        "driver_arriving",
        "in_progress",
      ].includes(r.status) &&
      !(
        (r as any).scheduled_at &&
        new Date((r as any).scheduled_at) > new Date()
      ),
  );
  const scheduledRides = rides
    .filter(
      (r) =>
        (r as any).scheduled_at &&
        new Date((r as any).scheduled_at) > new Date() &&
        !["completed", "cancelled", "in_progress", "driver_arriving"].includes(
          r.status,
        ),
    )
    .sort(
      (a, b) =>
        new Date((a as any).scheduled_at).getTime() -
        new Date((b as any).scheduled_at).getTime(),
    );
  const recentRides = rides
    .filter((r) => ["completed", "cancelled"].includes(r.status))
    .slice(0, 30);
  const onlineDrivers = drivers.filter((d) => d.is_active);
  const topbarTitle = showAnalytics
    ? "Analytics"
    : showReports
      ? "Reports"
      : showDiscounts
        ? "Discounts"
        : tab.charAt(0).toUpperCase() + tab.slice(1);

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
        .db-nav-icon { color: #4B5563; flex-shrink: 0; transition: color 0.12s; display: flex; align-items: center; position: relative; }
        .db-nav-item:hover .db-nav-icon, .db-nav-item.active .db-nav-icon { color: #E8500A; }
        .db-nav-label { font-size: 13px; font-weight: 500; color: #4B5563; transition: color 0.12s; }
        .db-nav-item:hover .db-nav-label, .db-nav-item.active .db-nav-label { color: #E8500A; }
        .db-nav-bottom { padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.06); width: 100%; display: flex; flex-direction: column; }
        .db-nav-utility { display: flex; align-items: center; gap: 11px; width: 100%; height: 40px; padding: 0 19px; background: none; border: none; cursor: pointer; white-space: nowrap; transition: background 0.12s; }
        .db-nav-utility:hover { background: rgba(255,255,255,0.05); }
        .db-nav-utility .db-nav-icon { color: #374151; }
        .db-nav-utility:hover .db-nav-icon { color: #9CA3AF; }
        .db-nav-utility .db-nav-label { color: #374151; }
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
        .db-badge-dot { position: absolute; top: -3px; right: -4px; width: 7px; height: 7px; border-radius: 50%; background: #E24B4A; border: 1.5px solid #0F1723; }
        .db-badge-count { margin-left: auto; font-size: 10px; font-weight: 700; background: rgba(226,75,74,0.15); color: #F87171; border-radius: 10px; padding: 1px 6px; }
        .db-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
        .db-topbar { height: 54px; background: #0F1723; border-bottom: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; padding: 0 20px; gap: 20px; flex-shrink: 0; z-index: 20; }
        .db-topbar-title { font-size: 14px; font-weight: 600; color: #F1F5F9; margin-right: auto; }
        .db-stat-row { display: flex; align-items: center; gap: 28px; margin-right: 20px; }
        .db-stat { display: flex; flex-direction: column; align-items: flex-end; }
        .db-stat-value { font-size: 15px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .db-stat-label { font-size: 10px; color: #4B5563; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 2px; }
        .db-stat-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: middle; position: relative; top: -1px; }
        .db-new-ride-btn { background: #E8500A; color: #fff; border: none; border-radius: 7px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: opacity 0.15s; white-space: nowrap; }
        .db-new-ride-btn:hover { opacity: 0.88; }
        .db-back-btn { background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; transition: color 0.12s, border-color 0.12s; }
        .db-back-btn:hover { color: #9CA3AF; border-color: rgba(255,255,255,0.15); }
        .db-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }
        .db-panel { width: 336px; background: #111827; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
        .db-panel-header { padding: 14px 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .db-panel-title { font-size: 11px; font-weight: 600; color: #4B5563; letter-spacing: 0.07em; text-transform: uppercase; }
        .db-panel-count { font-size: 22px; font-weight: 700; color: #F1F5F9; margin-top: 2px; line-height: 1; }
        .db-panel-scroll { flex: 1; overflow-y: auto; padding: 10px; }
        .db-panel-scroll::-webkit-scrollbar { width: 3px; }
        .db-panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .db-section-divider { margin: 10px 0 8px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; display: flex; justify-content: space-between; align-items: baseline; }
        .db-section-divider-title { font-size: 11px; font-weight: 600; color: #4B5563; letter-spacing: 0.07em; text-transform: uppercase; padding: 0 2px; }
        .db-section-divider-count { font-size: 13px; font-weight: 700; padding-right: 2px; }
        .db-empty { font-size: 13px; color: #374151; text-align: center; padding: 24px 0; }
        .db-ride-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: border-color 0.12s, background 0.12s; }
        .db-ride-card:hover { background: #213040; border-color: rgba(255,255,255,0.1); }
        .db-ride-card.selected { border-color: rgba(232,80,10,0.45); }
        .db-ride-card.dimmed { opacity: 0.7; }
        .db-ride-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 7px; }
        .db-status-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 20px; letter-spacing: 0.02em; }
        .db-ride-time { font-size: 11px; color: #4B5563; }
        .db-ride-name { font-size: 13px; font-weight: 600; color: #E2E8F0; margin-bottom: 3px; }
        .db-ride-addr { font-size: 11px; color: #6B7280; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .db-ride-addr.dest { color: rgba(232,80,10,0.8); }
        .db-ride-fare { font-size: 12px; font-weight: 600; color: #6B7280; margin-top: 4px; }
        .db-pending-badge { font-size: 11px; color: #F59E0B; background: rgba(245,158,11,0.08); border-radius: 6px; padding: 4px 8px; margin-top: 6px; border: 1px solid rgba(245,158,11,0.15); }
        .db-assign-btn { width: 100%; background: rgba(74,158,255,0.07); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 7px; padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; margin-top: 8px; transition: background 0.12s; }
        .db-assign-btn:hover { background: rgba(74,158,255,0.13); }
        .db-assign-label { font-size: 11px; color: #4B5563; margin: 8px 0 4px; }
        .db-assign-driver-btn { width: 100%; background: rgba(29,158,117,0.07); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 7px; padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; margin-bottom: 4px; transition: background 0.12s; }
        .db-assign-driver-btn:hover { background: rgba(29,158,117,0.13); }
        .db-cancel-assign-btn { background: transparent; color: #4B5563; border: none; font-size: 11px; cursor: pointer; padding: 4px 0; font-family: system-ui, sans-serif; transition: color 0.12s; }
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
        .db-driver-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: border-color 0.12s, background 0.12s; }
        .db-driver-card:hover { background: #213040; border-color: rgba(255,255,255,0.1); }
        .db-driver-card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
        .db-driver-avatar { width: 34px; height: 34px; border-radius: 17px; background: #1E3A5F; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #4a9eff; flex-shrink: 0; border: 1px solid rgba(74,158,255,0.12); }
        .db-driver-avatar-photo { width: 34px; height: 34px; border-radius: 17px; object-fit: cover; flex-shrink: 0; border: 1px solid rgba(74,158,255,0.18); }
        .db-driver-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .db-driver-sub { font-size: 11px; color: #6B7280; margin-top: 1px; }
        .db-driver-phone { font-size: 11px; color: #4B5563; margin-top: 3px; }
        .db-online-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-left: auto; }
        .db-driver-status-on-ride { font-size: 11px; color: #E8500A; margin-top: 3px; font-weight: 500; }
        .db-driver-status-available { font-size: 11px; color: #1D9E75; margin-top: 3px; font-weight: 500; }
        .db-invite-form { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
        .db-invite-input { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #F1F5F9; outline: none; font-family: system-ui, sans-serif; transition: border-color 0.15s; }
        .db-invite-input:focus { border-color: rgba(232,80,10,0.35); }
        .db-invite-input::placeholder { color: #374151; }
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
        .db-modal { background: #1E2A3A; border-radius: 14px; padding: 26px; width: 100%; max-width: 440px; border: 1px solid rgba(255,255,255,0.08); max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .db-modal-title { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-bottom: 20px; }
        .db-modal-label { font-size: 11px; color: #6B7280; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; display: block; margin-bottom: 6px; }
        .db-modal-input { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #E2E8F0; outline: none; width: 100%; font-family: system-ui, -apple-system, sans-serif; transition: border-color 0.15s; }
        .db-modal-input:focus { border-color: rgba(232,80,10,0.4); }
        .db-modal-input::placeholder { color: #374151; }
        .db-modal-select { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #E2E8F0; outline: none; width: 100%; cursor: pointer; font-family: system-ui, -apple-system, sans-serif; }
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
        .db-detail-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .db-detail-label { font-size: 12px; color: #6B7280; font-weight: 500; }
        .db-detail-value { font-size: 13px; color: #E2E8F0; font-weight: 500; max-width: 60%; text-align: right; }
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
        .dd-profile-name { font-size: 16px; font-weight: 700; color: #F1F5F9; }
        .dd-profile-sub { font-size: 12px; color: #6B7280; margin-top: 2px; }
        .dd-profile-phone { font-size: 12px; color: #4B5563; margin-top: 2px; }
        .dd-status-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
        .dd-status-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
        .dd-pill { font-size: 11px; font-weight: 600; border-radius: 20px; padding: 3px 10px; }
        .dd-pill-green { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); }
        .dd-pill-orange { background: rgba(232,80,10,0.1); color: #E8500A; border: 1px solid rgba(232,80,10,0.2); }
        .dd-pill-gray { background: rgba(107,114,128,0.1); color: #6B7280; border: 1px solid rgba(107,114,128,0.2); }
        .dd-pill-red { background: rgba(226,75,74,0.1); color: #F87171; border: 1px solid rgba(226,75,74,0.2); }
        .dd-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 18px; }
        .dd-stat-box { background: #1E2A3A; border-radius: 10px; padding: 12px; text-align: center; border: 1px solid rgba(255,255,255,0.05); }
        .dd-stat-val { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .dd-stat-lbl { font-size: 10px; color: #4B5563; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 3px; }
        .dd-section-label { font-size: 10px; font-weight: 600; color: #374151; letter-spacing: 0.09em; text-transform: uppercase; margin-bottom: 8px; }
        .dd-empty { font-size: 13px; color: #374151; text-align: center; padding: 24px 0; }
        .dd-ride-row { background: #1E2A3A; border-radius: 10px; padding: 11px 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
        .dd-ride-row-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .dd-ride-passenger { font-size: 12px; font-weight: 600; color: #E2E8F0; margin-top: 4px; }
        .dd-ride-addr { font-size: 11px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dd-ride-time { font-size: 10px; color: #374151; }
        .dd-ride-fare { font-size: 13px; font-weight: 600; color: #6B7280; white-space: nowrap; padding-top: 2px; }
      `}</style>

      <div className="db-page">
        <nav
          className={`db-nav${navExpanded ? " expanded" : ""}`}
          onMouseEnter={() => setNavExpanded(true)}
          onMouseLeave={() => setNavExpanded(false)}
        >
          <div className="db-nav-logo">
            {navExpanded ? (
              <span className="db-nav-logo-text">M&amp;G C&amp;J</span>
            ) : (
              <IconMenu />
            )}
          </div>
          <div className="db-nav-items">
            {NAV_ITEMS.map(({ tab: t, label }) => (
              <button
                key={t}
                className={`db-nav-item${tab === t && !showAnalytics && !showReports && !showDiscounts ? " active" : ""}`}
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
          </div>
          <div className="db-nav-bottom">
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
            {!showAnalytics && !showReports && !showDiscounts && !selectedDriver && (
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
            {!showAnalytics && !showReports && !showDiscounts && !selectedDriver ? (
              <button
                className="db-new-ride-btn"
                onClick={() => setBookingOpen(true)}
              >
                + New ride
              </button>
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
            <AnalyticsPage />
          </div>
          <div
            className="db-overlay"
            style={{ display: showReports ? "flex" : "none" }}
          >
            <ReportsPage onBadgeChange={setOpenReports} />
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
            className="db-body"
            style={{
              display:
                showAnalytics || showReports || showDiscounts ? "none" : "flex",
            }}
          >
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
                        onClick={() => focusRideOnMap(ride)}
                      >
                        <div className="db-ride-card-top">
                          <span
                            className="db-status-badge"
                            style={{
                              background: STATUS_COLORS[ride.status] + "18",
                              color: STATUS_COLORS[ride.status],
                              border: `1px solid ${STATUS_COLORS[ride.status]}30`,
                            }}
                          >
                            {STATUS_LABELS[ride.status]}
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
                        {(ride.status === "pending" ||
                          ride.status === "offered" ||
                          ride.status === "assigned") && (
                          <div style={{ marginTop: 8 }}>
                            {assigningRide === ride.id ? (
                              <>
                                <div className="db-assign-label">
                                  Assign driver:
                                </div>
                                {onlineDrivers.map((d) => (
                                  <button
                                    key={d.id}
                                    className="db-assign-driver-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      assignDriver(ride.id, d.id);
                                    }}
                                  >
                                    {(d as any).profile?.name ?? "Driver"}
                                  </button>
                                ))}
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
                                    cancelRide(ride.id);
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
                                cancelRide(ride.id);
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
                            onCancel={() => cancelRide(ride.id)}
                          />
                        ))}
                      </>
                    )}

                    <div className="db-section-divider">
                      <span className="db-section-divider-title">Recent</span>
                      <span
                        className="db-section-divider-count"
                        style={{ color: "#4B5563" }}
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
                              background: STATUS_COLORS[ride.status] + "18",
                              color: STATUS_COLORS[ride.status],
                              border: `1px solid ${STATUS_COLORS[ride.status]}30`,
                            }}
                          >
                            {STATUS_LABELS[ride.status]}
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
                        <div className="db-ride-name">
                          {(ride as any).passenger?.name ?? "Unknown"}
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
                    <div className="db-panel-count">{drivers.length}</div>
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
                      <input
                        className="db-invite-input"
                        placeholder="Phone e.g. +19021234567"
                        value={invitePhone}
                        onChange={(e) => setInvitePhone(e.target.value)}
                      />
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
                            color: "#4B5563",
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
                              <button
                                className="db-revoke-btn"
                                onClick={() => revokeInvite(invite.id)}
                              >
                                Revoke
                              </button>
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
                        style={{ color: "#4B5563" }}
                      >
                        {drivers.length}
                      </span>
                    </div>
                    {drivers.length === 0 && (
                      <div className="db-empty">No drivers registered yet</div>
                    )}
                    {drivers.map((driver) => {
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
                      return (
                        <div
                          key={driver.id}
                          className="db-driver-card"
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
                              </div>
                              {driver.is_active &&
                                (driverActiveRide ? (
                                  <div className="db-driver-status-on-ride">
                                    ● On a ride
                                  </div>
                                ) : (
                                  <div className="db-driver-status-available">
                                    ● Available
                                  </div>
                                ))}
                            </div>
                            <div
                              className="db-online-dot"
                              style={{
                                background: driver.is_active
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
              {selectedDriver && (
                <DriverDetailPanel
                  driver={selectedDriver}
                  rides={rides}
                  onClose={() => setSelectedDriver(null)}
                />
              )}
              <div
                ref={mapRef}
                className="db-map"
                style={{ visibility: selectedDriver ? "hidden" : "visible" }}
              />
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
                  className="db-modal-input"
                  placeholder="+19021234567"
                  value={bookPassenger}
                  onChange={(e) => setBookPassenger(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="db-modal-label">
                  Passenger name{" "}
                  <span
                    style={{
                      fontSize: 10,
                      color: "#374151",
                      fontWeight: 400,
                      marginLeft: 6,
                      textTransform: "none",
                      letterSpacing: 0,
                    }}
                  >
                    (if not registered)
                  </span>
                </label>
                <input
                  className="db-modal-input"
                  placeholder="Guest name"
                  value={bookPassengerName}
                  onChange={(e) => setBookPassengerName(e.target.value)}
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
                        color: "#4B5563",
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
                        Auto-calculated
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
              </div>
              <div>
                <label className="db-modal-label">
                  Discount code{" "}
                  <span
                    style={{
                      fontSize: 10,
                      color: "#374151",
                      fontWeight: 400,
                      marginLeft: 6,
                      textTransform: "none",
                      letterSpacing: 0,
                    }}
                  >
                    (optional — overridden by a verified student discount)
                  </span>
                </label>
                <input
                  className="db-modal-input"
                  placeholder="CHURCH25"
                  value={bookDiscountCode}
                  onChange={(e) => setBookDiscountCode(e.target.value)}
                  style={{ textTransform: "uppercase" }}
                />
              </div>
              <div>
                <label className="db-modal-label">Assign driver</label>
                <select
                  className="db-modal-select"
                  value={bookDriver}
                  onChange={(e) => setBookDriver(e.target.value)}
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

      {rideDetail && (
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
                  color: "#4B5563",
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
                  background: STATUS_COLORS[rideDetail.status] + "18",
                  color: STATUS_COLORS[rideDetail.status],
                  border: `1px solid ${STATUS_COLORS[rideDetail.status]}30`,
                }}
              >
                {STATUS_LABELS[rideDetail.status]}
              </span>
              <span style={{ fontSize: 12, color: "#4B5563" }}>
                {new Date(rideDetail.created_at).toLocaleString("en-CA", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </div>

            {editingRide ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ position: "relative" }}>
                  <label className="db-modal-label">Pickup address</label>
                  <input
                    ref={editPickupInputRef}
                    className="db-modal-input"
                    placeholder="Start typing an address…"
                    value={editPickup}
                    onChange={(e) => {
                      setEditPickup(e.target.value);
                      setEditPickupCoords(null);
                    }}
                    required
                  />
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
                          color: "#4B5563",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        Calculating…
                      </span>
                    )}
                    {!editFareLoading && editAddressChanged && (
                      <span
                        style={{
                          fontSize: 10,
                          color: "#1D9E75",
                          fontWeight: 400,
                          marginLeft: 6,
                        }}
                      >
                        Auto-recalculated
                      </span>
                    )}
                  </label>
                  <input
                    className="db-modal-input"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={editFare}
                    onChange={(e) => setEditFare(e.target.value)}
                  />
                </div>
                <div>
                  <label className="db-modal-label">Payment method</label>
                  <select
                    className="db-modal-select"
                    value={editPayment}
                    onChange={(e) => setEditPayment(e.target.value)}
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                  </select>
                </div>
                {rideDetail.status === "scheduled" && (
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
                      (rideDetail as any).driver?.profile?.name ??
                        "Unassigned",
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
                    [
                      "Scheduled",
                      rideDetail.scheduled_at
                        ? new Date(rideDetail.scheduled_at).toLocaleString(
                            "en-CA",
                          )
                        : "Immediate",
                    ],
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <div key={label} className="db-detail-row">
                    <span className="db-detail-label">{label}</span>
                    <span className="db-detail-value">{value}</span>
                  </div>
                ))}
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
