import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import type { Ride, Driver, Profile, DriverInvite } from "../types";
import AnalyticsPage from "./AnalyticsPage";

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;

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
interface Review {
  id: string;
  ride_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  driver_id: string;
  driver_name: string | null;
  passenger_name: string | null;
  pickup_address: string;
  dropoff_address: string;
}
interface DriverRatingSummary {
  driver_id: string;
  driver_name: string | null;
  average: number;
  count: number;
  flagged: number;
}

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
  const [usedInvites, setUsedInvites] = useState<DriverInvite[]>([]);
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
  const [selectedRide, setSelectedRide] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteName, setInviteName] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [bookingOpen, setBookingOpen] = useState(false);
  const [bookPassenger, setBookPassenger] = useState("");
  const [bookPickup, setBookPickup] = useState("");
  const [bookDropoff, setBookDropoff] = useState("");
  const [bookFare, setBookFare] = useState("");
  const [bookDriver, setBookDriver] = useState("");
  const [bookScheduled, setBookScheduled] = useState("");
  const [bookLoading, setBookLoading] = useState(false);
  const [assigningRide, setAssigningRide] = useState<string | null>(null);
  const [rideDetail, setRideDetail] = useState<Ride | null>(null);
  const [flaggedReviews, setFlaggedReviews] = useState(0);
  const [navExpanded, setNavExpanded] = useState(false);

  // ── Map init ──────────────────────────────────────────────────────────
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
          s.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}`;
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
    if (!showAnalytics && googleMapRef.current) {
      setTimeout(() => {
        if (googleMapRef.current)
          google.maps.event.trigger(googleMapRef.current, "resize");
      }, 50);
    }
  }, [showAnalytics]);

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
    ]);
    setLoading(false);
  }

  async function fetchRides() {
    const { data } = await supabase
      .from("rides")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(150);
    if (!data) return;
    const enriched = await Promise.all(
      data.map(async (ride) => {
        const [{ data: passenger }, { data: driver }] = await Promise.all([
          supabase
            .from("profiles")
            .select("name, phone")
            .eq("id", ride.passenger_id)
            .single(),
          ride.driver_id
            ? supabase
                .from("profiles")
                .select("name, phone")
                .eq("id", ride.driver_id)
                .single()
            : Promise.resolve({ data: null }),
        ]);
        return {
          ...ride,
          passenger,
          driver: driver ? { profile: driver } : null,
        };
      }),
    );
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
    const enriched = await Promise.all(
      data.map(async (d) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name, phone")
          .eq("id", d.id)
          .single();
        return { ...d, profile: p };
      }),
    );
    setDrivers(enriched);
    setStats((s) => ({
      ...s,
      driversOnline: enriched.filter((d) => d.is_active).length,
    }));
    if (!googleMapRef.current) return;
    enriched
      .filter((d) => d.is_active && d.current_lat && d.current_lng)
      .forEach((d) => {
        const key = `driver-${d.id}`;
        const pos = { lat: d.current_lat!, lng: d.current_lng! };
        if (markersRef.current.has(key)) {
          markersRef.current.get(key)!.setPosition(pos);
        } else {
          const m = new google.maps.Marker({
            position: pos,
            map: googleMapRef.current!,
            title: (d as any).profile?.name ?? "Driver",
            label: { text: "🚗", fontSize: "18px" },
          });
          markersRef.current.set(key, m);
        }
      });
  }

  async function fetchInvites() {
    const [{ data: pending }, { data: used }] = await Promise.all([
      supabase
        .from("driver_invites")
        .select("*")
        .eq("used", false)
        .order("created_at", { ascending: false }),
      supabase
        .from("driver_invites")
        .select("*")
        .eq("used", true)
        .order("created_at", { ascending: false }),
    ]);
    if (pending) setPendingInvites(pending);
    if (used) setUsedInvites(used);
  }

  async function fetchReviewsBadge() {
    const { data } = await supabase
      .from("ride_reviews")
      .select("rating")
      .lte("rating", 2);
    setFlaggedReviews(data?.length ?? 0);
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
      ["pending", "assigned", "driver_arriving", "in_progress"].includes(
        r.status,
      ),
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
        ["pending", "assigned", "driver_arriving", "in_progress"].includes(
          r.status,
        ),
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
    const { error } = await supabase
      .from("driver_invites")
      .insert({
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

  async function createManualBooking(e: React.FormEvent) {
    e.preventDefault();
    setBookLoading(true);
    const { data: passengerProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("phone", bookPassenger.trim())
      .single();
    if (!passengerProfile) {
      alert("No passenger found with that phone number.");
      setBookLoading(false);
      return;
    }
    const rideData: any = {
      passenger_id: passengerProfile.id,
      status: "pending",
      pickup_address: bookPickup.trim(),
      pickup_lat: 45.0773,
      pickup_lng: -64.3601,
      dropoff_address: bookDropoff.trim(),
      dropoff_lat: 45.0773,
      dropoff_lng: -64.3601,
      fare_estimate: parseFloat(bookFare) || null,
      payment_method: "cash",
    };
    if (bookScheduled) {
      rideData.status = "scheduled";
      rideData.scheduled_at = new Date(bookScheduled).toISOString();
    }
    if (bookDriver) {
      rideData.driver_id = bookDriver;
      rideData.status = bookScheduled ? "scheduled" : "assigned";
    }
    const { error } = await supabase.from("rides").insert(rideData);
    setBookLoading(false);
    if (error) {
      alert(error.message);
      return;
    }
    setBookingOpen(false);
    setBookPassenger("");
    setBookPickup("");
    setBookDropoff("");
    setBookFare("");
    setBookDriver("");
    setBookScheduled("");
    fetchRides();
  }

  async function assignDriver(rideId: string, driverId: string) {
    await supabase
      .from("rides")
      .update({ driver_id: driverId, status: "assigned" })
      .eq("id", rideId);
    setAssigningRide(null);
    fetchRides();
  }

  const activeRides = rides.filter((r) =>
    ["pending", "assigned", "driver_arriving", "in_progress"].includes(
      r.status,
    ),
  );
  const scheduledRides = rides.filter((r) => r.status === "scheduled");
  const recentRides = rides
    .filter((r) => ["completed", "cancelled"].includes(r.status))
    .slice(0, 30);
  const onlineDrivers = drivers.filter((d) => d.is_active);

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

        .db-page {
          display: flex; height: 100vh;
          background: #111827; font-family: system-ui, -apple-system, sans-serif;
          overflow: hidden; position: relative;
        }

        /* ── NAV RAIL ── */
        .db-nav {
          width: 56px; background: #0F1723;
          border-right: 1px solid rgba(255,255,255,0.06);
          display: flex; flex-direction: column; align-items: center;
          padding: 0; flex-shrink: 0; z-index: 30;
          transition: width 0.18s cubic-bezier(0.4,0,0.2,1); overflow: hidden;
        }
        .db-nav.expanded { width: 196px; }

        .db-nav-logo {
          width: 100%; height: 54px; display: flex; align-items: center;
          padding: 0 18px; flex-shrink: 0;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .db-nav-logo-text { font-size: 14px; font-weight: 700; color: #E8500A; letter-spacing: -0.3px; white-space: nowrap; }

        .db-nav-items { flex: 1; display: flex; flex-direction: column; padding: 8px 0; width: 100%; }

        .db-nav-item {
          display: flex; align-items: center; gap: 11px;
          width: 100%; height: 40px; padding: 0 19px;
          background: none; border: none; cursor: pointer;
          border-left: 2px solid transparent;
          transition: background 0.12s, border-color 0.12s; white-space: nowrap;
        }
        .db-nav-item:hover { background: rgba(255,255,255,0.05); }
        .db-nav-item.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); }

        .db-nav-icon { color: #4B5563; flex-shrink: 0; transition: color 0.12s; display: flex; align-items: center; position: relative; }
        .db-nav-item:hover .db-nav-icon { color: #9CA3AF; }
        .db-nav-item.active .db-nav-icon { color: #E8500A; }

        .db-nav-label { font-size: 13px; font-weight: 500; color: #4B5563; transition: color 0.12s; }
        .db-nav-item:hover .db-nav-label { color: #9CA3AF; }
        .db-nav-item.active .db-nav-label { color: #E8500A; }

        .db-nav-bottom {
          padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.06);
          width: 100%; display: flex; flex-direction: column;
        }
        .db-nav-utility {
          display: flex; align-items: center; gap: 11px;
          width: 100%; height: 40px; padding: 0 19px;
          background: none; border: none; cursor: pointer; white-space: nowrap;
          transition: background 0.12s;
        }
        .db-nav-utility:hover { background: rgba(255,255,255,0.05); }
        .db-nav-utility .db-nav-icon { color: #374151; }
        .db-nav-utility:hover .db-nav-icon { color: #9CA3AF; }
        .db-nav-utility .db-nav-label { color: #374151; }
        .db-nav-utility:hover .db-nav-label { color: #9CA3AF; }
        .db-nav-analytics .db-nav-icon { color: #6B7280; }
        .db-nav-analytics:hover .db-nav-icon { color: #A855F7; }
        .db-nav-analytics .db-nav-label { color: #6B7280; }
        .db-nav-analytics:hover .db-nav-label { color: #A855F7; }
        .db-nav-signout:hover .db-nav-icon { color: #E24B4A; }
        .db-nav-signout:hover .db-nav-label { color: #E24B4A; }

        .db-badge-dot {
          position: absolute; top: -3px; right: -4px;
          width: 7px; height: 7px; border-radius: 50%;
          background: #E24B4A; border: 1.5px solid #0F1723;
        }
        .db-badge-count {
          margin-left: auto; font-size: 10px; font-weight: 700;
          background: rgba(226,75,74,0.15); color: #F87171;
          border-radius: 10px; padding: 1px 6px;
        }

        /* ── MAIN ── */
        .db-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

        .db-topbar {
          height: 54px; background: #0F1723;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          display: flex; align-items: center; padding: 0 20px; gap: 20px;
          flex-shrink: 0; z-index: 20;
        }
        .db-topbar-title { font-size: 14px; font-weight: 600; color: #F1F5F9; margin-right: auto; }

        .db-stat-row { display: flex; align-items: center; gap: 28px; margin-right: 20px; }
        .db-stat { display: flex; flex-direction: column; align-items: flex-end; }
        .db-stat-value { font-size: 15px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .db-stat-label { font-size: 10px; color: #4B5563; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 2px; }
        .db-stat-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: middle; position: relative; top: -1px; }

        .db-new-ride-btn {
          background: #E8500A; color: #fff; border: none; border-radius: 7px;
          padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
          font-family: system-ui, sans-serif; transition: opacity 0.15s; white-space: nowrap;
        }
        .db-new-ride-btn:hover { opacity: 0.88; }

        .db-back-btn {
          background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08);
          border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer;
          font-family: system-ui, sans-serif; transition: color 0.12s, border-color 0.12s;
        }
        .db-back-btn:hover { color: #9CA3AF; border-color: rgba(255,255,255,0.15); }

        /* ── BODY ── */
        .db-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }

        /* ── PANEL ── */
        .db-panel {
          width: 336px; background: #111827;
          border-right: 1px solid rgba(255,255,255,0.06);
          display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden;
        }
        .db-panel-header { padding: 14px 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .db-panel-title { font-size: 11px; font-weight: 600; color: #4B5563; letter-spacing: 0.07em; text-transform: uppercase; }
        .db-panel-count { font-size: 22px; font-weight: 700; color: #F1F5F9; margin-top: 2px; line-height: 1; }
        .db-panel-scroll { flex: 1; overflow-y: auto; padding: 10px; }
        .db-panel-scroll::-webkit-scrollbar { width: 3px; }
        .db-panel-scroll::-webkit-scrollbar-track { background: transparent; }
        .db-panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .db-section-label { font-size: 10px; font-weight: 600; color: #374151; letter-spacing: 0.09em; text-transform: uppercase; padding: 12px 2px 6px; }
        .db-empty { font-size: 13px; color: #374151; text-align: center; padding: 24px 0; }

        /* ── RIDE CARD ── */
        .db-ride-card {
          background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px;
          border: 1px solid rgba(255,255,255,0.05); cursor: pointer;
          transition: border-color 0.12s, background 0.12s;
        }
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

        .db-assign-btn {
          width: 100%; background: rgba(74,158,255,0.07); color: #4a9eff;
          border: 1px solid rgba(74,158,255,0.2); border-radius: 7px;
          padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer;
          font-family: system-ui, sans-serif; margin-top: 8px; transition: background 0.12s;
        }
        .db-assign-btn:hover { background: rgba(74,158,255,0.13); }
        .db-assign-label { font-size: 11px; color: #4B5563; margin: 8px 0 4px; }
        .db-assign-driver-btn {
          width: 100%; background: rgba(29,158,117,0.07); color: #1D9E75;
          border: 1px solid rgba(29,158,117,0.2); border-radius: 7px;
          padding: 6px 0; font-size: 12px; font-weight: 500; cursor: pointer;
          font-family: system-ui, sans-serif; margin-bottom: 4px; transition: background 0.12s;
        }
        .db-assign-driver-btn:hover { background: rgba(29,158,117,0.13); }
        .db-cancel-assign-btn { background: transparent; color: #4B5563; border: none; font-size: 11px; cursor: pointer; padding: 4px 0; font-family: system-ui, sans-serif; transition: color 0.12s; }
        .db-cancel-assign-btn:hover { color: #9CA3AF; }

        /* ── DRIVER CARD ── */
        .db-driver-card { background: #1E2A3A; border-radius: 10px; padding: 12px; margin-bottom: 6px; border: 1px solid rgba(255,255,255,0.05); }
        .db-driver-card-top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
        .db-driver-avatar { width: 34px; height: 34px; border-radius: 17px; background: #1E3A5F; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #4a9eff; flex-shrink: 0; border: 1px solid rgba(74,158,255,0.12); }
        .db-driver-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .db-driver-sub { font-size: 11px; color: #6B7280; margin-top: 1px; }
        .db-driver-phone { font-size: 11px; color: #4B5563; margin-top: 3px; }
        .db-online-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-left: auto; }

        /* ── INVITES ── */
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

        /* ── MAP ── */
        .db-map-wrap { flex: 1; position: relative; min-height: 0; overflow: hidden; }
        .db-map { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }

        /* ── ANALYTICS ── */
        .db-analytics-overlay { flex: 1; overflow-y: auto; background: #111827; }

        /* ── MODAL ── */
        .db-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .db-modal { background: #1E2A3A; border-radius: 14px; padding: 26px; width: 100%; max-width: 440px; border: 1px solid rgba(255,255,255,0.08); max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .db-modal-title { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-bottom: 20px; }
        .db-modal-label { font-size: 11px; color: #6B7280; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; display: block; margin-bottom: 6px; }
        .db-modal-input { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #F1F5F9; outline: none; width: 100%; font-family: system-ui, sans-serif; transition: border-color 0.15s; }
        .db-modal-input:focus { border-color: rgba(232,80,10,0.4); }
        .db-modal-input::placeholder { color: #374151; }
        .db-modal-select { background: #111827; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: #F1F5F9; outline: none; width: 100%; cursor: pointer; font-family: system-ui, sans-serif; }
        .db-modal-cancel-btn { flex: 1; background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px; font-size: 14px; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .db-modal-cancel-btn:hover { background: rgba(255,255,255,0.04); }
        .db-modal-submit-btn { flex: 2; background: #E8500A; color: #fff; border: none; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: opacity 0.15s; }
        .db-modal-submit-btn:hover { opacity: 0.88; }
        .db-modal-submit-btn:disabled { opacity: 0.5; }
        .db-detail-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .db-detail-label { font-size: 12px; color: #6B7280; font-weight: 500; }
        .db-detail-value { font-size: 13px; color: #E2E8F0; font-weight: 500; max-width: 60%; text-align: right; }
      `}</style>

      <div className="db-page">
        {/* NAV RAIL */}
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
                className={`db-nav-item${tab === t && !showAnalytics ? " active" : ""}`}
                onClick={() => {
                  setTab(t);
                  setShowAnalytics(false);
                }}
              >
                <span className="db-nav-icon">{NAV_ICONS[t]}</span>
                {navExpanded && <span className="db-nav-label">{label}</span>}
              </button>
            ))}
          </div>
          <div className="db-nav-bottom">
            <button
              className="db-nav-utility db-nav-analytics"
              onClick={() => setShowAnalytics(true)}
            >
              <span className="db-nav-icon">
                <IconAnalytics />
                {flaggedReviews > 0 && <span className="db-badge-dot" />}
              </span>
              {navExpanded && <span className="db-nav-label">Analytics</span>}
              {navExpanded && flaggedReviews > 0 && (
                <span className="db-badge-count">{flaggedReviews}</span>
              )}
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

        {/* MAIN */}
        <div className="db-main">
          {/* TOP BAR */}
          <div className="db-topbar">
            <span className="db-topbar-title">
              {showAnalytics
                ? "Analytics"
                : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </span>
            {!showAnalytics && (
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
            {!showAnalytics ? (
              <button
                className="db-new-ride-btn"
                onClick={() => setBookingOpen(true)}
              >
                + New ride
              </button>
            ) : (
              <button
                className="db-back-btn"
                onClick={() => setShowAnalytics(false)}
              >
                ← Back
              </button>
            )}
          </div>

          {/* ANALYTICS */}
          {showAnalytics && (
            <div className="db-analytics-overlay">
              <AnalyticsPage />
            </div>
          )}

          {/* BODY */}
          <div
            className="db-body"
            style={{ display: showAnalytics ? "none" : "flex" }}
          >
            <div className="db-panel">
              {/* ── RIDES ── */}
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
                              <button
                                className="db-assign-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAssigningRide(ride.id);
                                }}
                              >
                                {ride.driver_id
                                  ? "Reassign driver"
                                  : "Assign driver"}
                              </button>
                            )}
                          </div>
                        )}
                        {ride.status === "assigned" && (
                          <div className="db-pending-badge">
                            ⏳ Awaiting driver confirmation
                          </div>
                        )}
                      </div>
                    ))}

                    {scheduledRides.length > 0 && (
                      <>
                        <div className="db-section-label">
                          Scheduled ({scheduledRides.length})
                        </div>
                        {scheduledRides.map((ride) => (
                          <div
                            key={ride.id}
                            className="db-ride-card"
                            onClick={() => setRideDetail(ride)}
                          >
                            <div className="db-ride-card-top">
                              <span
                                className="db-status-badge"
                                style={{
                                  background: "#A855F718",
                                  color: "#A855F7",
                                  border: "1px solid #A855F730",
                                }}
                              >
                                Scheduled
                              </span>
                              <span className="db-ride-time">
                                {ride.scheduled_at
                                  ? new Date(ride.scheduled_at).toLocaleString(
                                      "en-CA",
                                      {
                                        month: "short",
                                        day: "numeric",
                                        hour: "numeric",
                                        minute: "2-digit",
                                      } as any,
                                    )
                                  : ""}
                              </span>
                            </div>
                            <div className="db-ride-name">
                              {(ride as any).passenger?.name ?? "Unknown"}
                            </div>
                            <div className="db-ride-addr">
                              {ride.pickup_address} → {ride.dropoff_address}
                            </div>
                            {ride.fare_estimate && (
                              <div className="db-ride-fare">
                                ${ride.fare_estimate.toFixed(2)}
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    )}

                    <div className="db-section-label">
                      Recent ({recentRides.length})
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

              {/* ── DRIVERS ── */}
              {tab === "drivers" && (
                <>
                  <div className="db-panel-header">
                    <div className="db-panel-title">Drivers</div>
                    <div className="db-panel-count">{drivers.length}</div>
                  </div>
                  <div className="db-panel-scroll">
                    {/* Add driver */}
                    <div className="db-section-label">Add driver</div>
                    <form onSubmit={createInvite} className="db-invite-form">
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

                    {/* Pending invites — only shown when there are some */}
                    {pendingInvites.length > 0 && (
                      <>
                        <div className="db-section-label">
                          Pending invites ({pendingInvites.length})
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

                    {/* Driver list */}
                    <div className="db-section-label">
                      All drivers ({drivers.length})
                    </div>
                    {drivers.length === 0 && (
                      <div className="db-empty">No drivers registered yet</div>
                    )}
                    {drivers.map((driver) => (
                      <div key={driver.id} className="db-driver-card">
                        <div className="db-driver-card-top">
                          <div className="db-driver-avatar">
                            {((driver as any).profile?.name ?? "D")
                              .split(" ")
                              .map((n: string) => n[0])
                              .join("")
                              .slice(0, 2)}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div className="db-driver-name">
                              {(driver as any).profile?.name ?? "Unknown"}
                            </div>
                            <div className="db-driver-sub">
                              {driver.vehicle_make} {driver.vehicle_model} ·{" "}
                              {driver.plate_number}
                            </div>
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
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* MAP */}
            <div className="db-map-wrap">
              <div ref={mapRef} className="db-map" />
            </div>
          </div>
        </div>
      </div>

      {/* NEW RIDE MODAL */}
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
                <label className="db-modal-label">Pickup address *</label>
                <input
                  className="db-modal-input"
                  placeholder="123 Main St, Kentville"
                  value={bookPickup}
                  onChange={(e) => setBookPickup(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="db-modal-label">Drop-off address *</label>
                <input
                  className="db-modal-input"
                  placeholder="456 Elm St, Wolfville"
                  value={bookDropoff}
                  onChange={(e) => setBookDropoff(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="db-modal-label">Estimated fare</label>
                <input
                  className="db-modal-input"
                  placeholder="12.50"
                  type="number"
                  step="0.01"
                  value={bookFare}
                  onChange={(e) => setBookFare(e.target.value)}
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
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button
                  className="db-modal-cancel-btn"
                  type="button"
                  onClick={() => setBookingOpen(false)}
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

      {/* RIDE DETAIL */}
      {rideDetail && (
        <div className="db-modal-overlay" onClick={() => setRideDetail(null)}>
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
                Ride details
              </div>
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: "#4B5563",
                  cursor: "pointer",
                  fontSize: 20,
                }}
                onClick={() => setRideDetail(null)}
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
            {(
              [
                ["Passenger", (rideDetail as any).passenger?.name ?? "Unknown"],
                ["Phone", (rideDetail as any).passenger?.phone ?? "—"],
                [
                  "Driver",
                  (rideDetail as any).driver?.profile?.name ?? "Unassigned",
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
                    ? new Date(rideDetail.scheduled_at).toLocaleString("en-CA")
                    : "Immediate",
                ],
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="db-detail-row">
                <span className="db-detail-label">{label}</span>
                <span className="db-detail-value">{value}</span>
              </div>
            ))}
            <button
              className="db-modal-cancel-btn"
              style={{ width: "100%", marginTop: 16 }}
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
