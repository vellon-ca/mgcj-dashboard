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

type Tab = "rides" | "drivers" | "revenue" | "invites";

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

  // ── Map init ─────────────────────────────────────────────────
  // The map container stays in the DOM always via CSS visibility
  // We only ever initialize the map once
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

  // When returning from analytics, trigger a resize so map redraws correctly
  useEffect(() => {
    if (!showAnalytics && googleMapRef.current) {
      setTimeout(() => {
        if (googleMapRef.current) {
          google.maps.event.trigger(googleMapRef.current, "resize");
        }
      }, 50);
    }
  }, [showAnalytics]);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const channel = supabase
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
      supabase.removeChannel(channel);
    };
  }, []);

  async function fetchAll() {
    await Promise.all([fetchRides(), fetchDrivers(), fetchInvites()]);
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
    <div style={s.page}>
      {/* ── TOP BAR ── */}
      <div style={s.topBar}>
        {showAnalytics ? (
          <>
            <button style={s.backBtn} onClick={() => setShowAnalytics(false)}>
              ← Back to dashboard
            </button>
            <div style={s.logo}>M&G C&J · Analytics</div>
            <div style={{ width: 160 }} />
          </>
        ) : (
          <>
            <div style={s.topLeft}>
              <span style={s.logo}>M&G C&J</span>
              <span style={s.topLabel}>Dispatch Dashboard</span>
            </div>
            <div style={s.statPills}>
              <div style={s.statPill}>
                <span style={{ color: "#F59E0B" }}>●</span>
                <span>{stats.activeRides} active</span>
              </div>
              <div style={s.statPill}>
                <span style={{ color: "#1D9E75" }}>●</span>
                <span>{stats.driversOnline} online</span>
              </div>
              <div style={s.statPill}>
                <span style={{ color: "#9CA3AF" }}>✓</span>
                <span>{stats.completedToday} today</span>
              </div>
              <div style={s.statPill}>
                <span style={{ color: "#1D9E75" }}>$</span>
                <span>${stats.revenueToday.toFixed(2)} today</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                style={s.analyticsBtn}
                onClick={() => setShowAnalytics(true)}
              >
                📊 Analytics
              </button>
              <button style={s.newRideBtn} onClick={() => setBookingOpen(true)}>
                + New ride
              </button>
              <button style={s.signOutBtn} onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── ANALYTICS OVERLAY — floats above dashboard, map stays mounted ── */}
      <div
        style={{
          position: "absolute",
          top: 53,
          left: 0,
          right: 0,
          bottom: 0,
          background: "#111827",
          zIndex: 10,
          overflowY: "auto",
          display: showAnalytics ? "block" : "none",
        }}
      >
        <AnalyticsPage />
      </div>

      {/* ── DASHBOARD BODY — always in DOM, map never unmounts ── */}
      <div
        style={{ ...s.body, visibility: showAnalytics ? "hidden" : "visible" }}
      >
        {/* SIDEBAR */}
        <div style={s.sidebar}>
          <div style={s.tabs}>
            {(["rides", "drivers", "revenue", "invites"] as Tab[]).map((t) => (
              <button
                key={t}
                style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
                onClick={() => setTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          <div style={s.sidebarContent}>
            {tab === "rides" && (
              <>
                <div style={s.sectionTitle}>
                  Active rides ({activeRides.length})
                </div>
                {activeRides.length === 0 && (
                  <div style={s.empty}>No active rides</div>
                )}
                {activeRides.map((ride) => (
                  <div
                    key={ride.id}
                    style={{
                      ...s.rideCard,
                      ...(selectedRide === ride.id ? s.rideCardSelected : {}),
                    }}
                    onClick={() => focusRideOnMap(ride)}
                  >
                    <div style={s.rideCardTop}>
                      <span
                        style={{
                          ...s.statusBadge,
                          background: STATUS_COLORS[ride.status] + "22",
                          color: STATUS_COLORS[ride.status],
                          border: `0.5px solid ${STATUS_COLORS[ride.status]}44`,
                        }}
                      >
                        {STATUS_LABELS[ride.status]}
                      </span>
                      <span style={s.rideTime}>
                        {new Date(ride.created_at).toLocaleTimeString("en-CA", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div style={s.rideName}>
                      {(ride as any).passenger?.name ?? "Unknown passenger"}
                    </div>
                    <div style={s.rideAddr}>{ride.pickup_address}</div>
                    <div style={{ ...s.rideAddr, color: "#E8500A" }}>
                      {ride.dropoff_address}
                    </div>
                    {ride.fare_estimate && (
                      <div style={s.rideFare}>
                        ${ride.fare_estimate.toFixed(2)}
                      </div>
                    )}
                    {(ride.status === "pending" ||
                      ride.status === "assigned") && (
                      <div style={{ marginTop: 8 }}>
                        {assigningRide === ride.id ? (
                          <div>
                            <div style={s.assignLabel}>Assign driver:</div>
                            {onlineDrivers.map((d) => (
                              <button
                                key={d.id}
                                style={s.assignDriverBtn}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  assignDriver(ride.id, d.id);
                                }}
                              >
                                {(d as any).profile?.name ?? "Driver"}
                              </button>
                            ))}
                            <button
                              style={s.cancelAssignBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                setAssigningRide(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            style={s.assignBtn}
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
                      <div style={s.pendingConfirmBadge}>
                        ⏳ Awaiting driver confirmation
                      </div>
                    )}
                  </div>
                ))}

                {scheduledRides.length > 0 && (
                  <>
                    <div style={{ ...s.sectionTitle, marginTop: 16 }}>
                      Scheduled ({scheduledRides.length})
                    </div>
                    {scheduledRides.map((ride) => (
                      <div
                        key={ride.id}
                        style={s.rideCard}
                        onClick={() => setRideDetail(ride)}
                      >
                        <div style={s.rideCardTop}>
                          <span
                            style={{
                              ...s.statusBadge,
                              background: "#A855F722",
                              color: "#A855F7",
                              border: "0.5px solid #A855F744",
                            }}
                          >
                            Scheduled
                          </span>
                          <span style={s.rideTime}>
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
                        <div style={s.rideName}>
                          {(ride as any).passenger?.name ?? "Unknown"}
                        </div>
                        <div style={s.rideAddr}>
                          {ride.pickup_address} → {ride.dropoff_address}
                        </div>
                        {ride.fare_estimate && (
                          <div style={s.rideFare}>
                            ${ride.fare_estimate.toFixed(2)}
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}

                <div style={{ ...s.sectionTitle, marginTop: 16 }}>
                  Recent ({recentRides.length})
                </div>
                {recentRides.map((ride) => (
                  <div
                    key={ride.id}
                    style={{ ...s.rideCard, opacity: 0.75 }}
                    onClick={() => setRideDetail(ride)}
                  >
                    <div style={s.rideCardTop}>
                      <span
                        style={{
                          ...s.statusBadge,
                          background: STATUS_COLORS[ride.status] + "22",
                          color: STATUS_COLORS[ride.status],
                          border: `0.5px solid ${STATUS_COLORS[ride.status]}44`,
                        }}
                      >
                        {STATUS_LABELS[ride.status]}
                      </span>
                      <span style={s.rideFare}>
                        {ride.fare_final
                          ? `$${ride.fare_final.toFixed(2)}`
                          : ride.fare_estimate
                            ? `$${ride.fare_estimate.toFixed(2)}`
                            : ""}
                      </span>
                    </div>
                    <div style={s.rideName}>
                      {(ride as any).passenger?.name ?? "Unknown"}
                    </div>
                    <div style={s.rideAddr}>
                      {ride.pickup_address} → {ride.dropoff_address}
                    </div>
                    <div
                      style={{ fontSize: 10, color: "#4B5563", marginTop: 3 }}
                    >
                      Click for details
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === "drivers" && (
              <>
                <div style={s.sectionTitle}>All drivers ({drivers.length})</div>
                {drivers.map((driver) => (
                  <div key={driver.id} style={s.driverCard}>
                    <div style={s.driverCardTop}>
                      <div style={s.driverAvatar}>
                        {((driver as any).profile?.name ?? "D")
                          .split(" ")
                          .map((n: string) => n[0])
                          .join("")
                          .slice(0, 2)}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={s.driverName}>
                          {(driver as any).profile?.name ?? "Unknown"}
                        </div>
                        <div style={s.driverSub}>
                          {driver.vehicle_make} {driver.vehicle_model} ·{" "}
                          {driver.plate_number}
                        </div>
                      </div>
                      <div
                        style={{
                          ...s.onlineDot,
                          background: driver.is_active ? "#1D9E75" : "#4B5563",
                        }}
                      />
                    </div>
                    <div style={s.driverPhone}>
                      {(driver as any).profile?.phone ?? ""}
                    </div>
                  </div>
                ))}
              </>
            )}

            {tab === "revenue" && (
              <>
                <div style={s.sectionTitle}>Revenue overview</div>
                <div style={s.revenueGrid}>
                  <div style={s.revenueCard}>
                    <div style={s.revenueLabel}>Today</div>
                    <div style={s.revenueValue}>
                      ${stats.revenueToday.toFixed(2)}
                    </div>
                    <div style={s.revenueSubLabel}>
                      {stats.completedToday} rides
                    </div>
                  </div>
                  <div style={s.revenueCard}>
                    <div style={s.revenueLabel}>This week</div>
                    <div style={s.revenueValue}>
                      ${stats.revenueWeek.toFixed(2)}
                    </div>
                  </div>
                  <div style={s.revenueCard}>
                    <div style={s.revenueLabel}>This month</div>
                    <div style={{ ...s.revenueValue, color: "#1D9E75" }}>
                      ${stats.revenueMonth.toFixed(2)}
                    </div>
                  </div>
                  <div style={s.revenueCard}>
                    <div style={s.revenueLabel}>Avg fare</div>
                    <div style={s.revenueValue}>
                      ${stats.avgFare.toFixed(2)}
                    </div>
                  </div>
                  <div style={s.revenueCard}>
                    <div style={s.revenueLabel}>Cancel rate</div>
                    <div
                      style={{
                        ...s.revenueValue,
                        color: stats.cancelRate > 20 ? "#E24B4A" : "#F1F5F9",
                      }}
                    >
                      {stats.cancelRate.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div style={{ ...s.sectionTitle, marginTop: 20 }}>
                  Per driver (this month)
                </div>
                {drivers.map((driver) => {
                  const driverRides = rides.filter(
                    (r) =>
                      r.driver_id === driver.id &&
                      r.status === "completed" &&
                      new Date(r.created_at) >=
                        new Date(
                          new Date().getFullYear(),
                          new Date().getMonth(),
                          1,
                        ),
                  );
                  const earnings = driverRides.reduce(
                    (sum, r) => sum + (r.fare_final ?? r.fare_estimate ?? 0),
                    0,
                  );
                  return (
                    <div key={driver.id} style={s.driverRevenueRow}>
                      <div style={s.driverRevName}>
                        {(driver as any).profile?.name ?? "Unknown"}
                      </div>
                      <div style={s.driverRevStats}>
                        <span style={s.driverRevCount}>
                          {driverRides.length} rides
                        </span>
                        <span style={s.driverRevAmount}>
                          ${earnings.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {tab === "invites" && (
              <>
                <div style={s.sectionTitle}>Register new driver</div>
                <form onSubmit={createInvite} style={s.inviteForm}>
                  <input
                    style={s.inviteInput}
                    placeholder="Driver full name"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                  />
                  <input
                    style={s.inviteInput}
                    placeholder="Phone e.g. +19021234567"
                    value={invitePhone}
                    onChange={(e) => setInvitePhone(e.target.value)}
                  />
                  <button
                    style={s.inviteBtn}
                    type="submit"
                    disabled={inviteLoading}
                  >
                    {inviteLoading ? "Creating…" : "Generate invite code"}
                  </button>
                </form>
                {inviteSuccess && (
                  <div style={s.inviteSuccess}>
                    <div
                      style={{
                        fontSize: 12,
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
                      style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}
                    >
                      Code only works for the registered phone number above.
                    </div>
                    <button
                      style={{ ...s.cancelAssignBtn, marginTop: 8 }}
                      onClick={() => setInviteSuccess("")}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                <div style={{ ...s.sectionTitle, marginTop: 16 }}>
                  Pending invites ({pendingInvites.length})
                </div>
                {pendingInvites.length === 0 && (
                  <div style={s.empty}>No pending invites</div>
                )}
                {pendingInvites.map((invite) => (
                  <div key={invite.id} style={s.inviteCard}>
                    <div style={s.inviteCardTop}>
                      <div style={s.inviteName}>{invite.name}</div>
                      <span
                        style={{
                          ...s.statusBadge,
                          background: "#F59E0B22",
                          color: "#F59E0B",
                          border: "0.5px solid #F59E0B44",
                        }}
                      >
                        Pending
                      </span>
                    </div>
                    <div style={s.invitePhone}>{invite.phone}</div>
                    <div style={s.inviteCodeRow}>
                      <span style={s.inviteCode}>{invite.code}</span>
                      <button
                        style={s.revokeBtn}
                        onClick={() => revokeInvite(invite.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
                <div style={{ ...s.sectionTitle, marginTop: 16 }}>
                  Registered drivers ({usedInvites.length})
                </div>
                {usedInvites.length === 0 && (
                  <div style={s.empty}>No registered drivers yet</div>
                )}
                {usedInvites.map((invite) => (
                  <div
                    key={invite.id}
                    style={{
                      ...s.inviteCard,
                      borderColor: "rgba(29,158,117,0.2)",
                    }}
                  >
                    <div style={s.inviteCardTop}>
                      <div style={s.inviteName}>{invite.name}</div>
                      <span
                        style={{
                          ...s.statusBadge,
                          background: "#1D9E7522",
                          color: "#1D9E75",
                          border: "0.5px solid #1D9E7544",
                        }}
                      >
                        ✓ Registered
                      </span>
                    </div>
                    <div style={s.invitePhone}>{invite.phone}</div>
                    <div
                      style={{ fontSize: 11, color: "#4B5563", marginTop: 4 }}
                    >
                      Registered{" "}
                      {new Date(invite.created_at).toLocaleDateString("en-CA", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        {/* MAP — always in DOM */}
        <div style={s.mapWrap}>
          <div ref={mapRef} style={s.map} />
        </div>
      </div>

      {/* NEW RIDE MODAL */}
      {bookingOpen && (
        <div style={s.modalOverlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>New ride</div>
            <form
              onSubmit={createManualBooking}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <label style={s.modalLabel}>Passenger phone number *</label>
              <input
                style={s.modalInput}
                placeholder="+19021234567"
                value={bookPassenger}
                onChange={(e) => setBookPassenger(e.target.value)}
                required
              />
              <label style={s.modalLabel}>Pickup address *</label>
              <input
                style={s.modalInput}
                placeholder="123 Main St, Kentville"
                value={bookPickup}
                onChange={(e) => setBookPickup(e.target.value)}
                required
              />
              <label style={s.modalLabel}>Drop-off address *</label>
              <input
                style={s.modalInput}
                placeholder="456 Elm St, Wolfville"
                value={bookDropoff}
                onChange={(e) => setBookDropoff(e.target.value)}
                required
              />
              <label style={s.modalLabel}>Estimated fare (optional)</label>
              <input
                style={s.modalInput}
                placeholder="12.50"
                type="number"
                step="0.01"
                value={bookFare}
                onChange={(e) => setBookFare(e.target.value)}
              />
              <label style={s.modalLabel}>Assign driver (optional)</label>
              <select
                style={s.modalSelect}
                value={bookDriver}
                onChange={(e) => setBookDriver(e.target.value)}
              >
                <option value="">— No driver assigned yet —</option>
                {onlineDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {(d as any).profile?.name ?? "Driver"} · {d.vehicle_make}{" "}
                    {d.vehicle_model}
                  </option>
                ))}
              </select>
              <label style={s.modalLabel}>Schedule for (optional)</label>
              <input
                style={s.modalInput}
                type="datetime-local"
                value={bookScheduled}
                onChange={(e) => setBookScheduled(e.target.value)}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button
                  style={s.modalCancelBtn}
                  type="button"
                  onClick={() => setBookingOpen(false)}
                >
                  Cancel
                </button>
                <button
                  style={s.modalSubmitBtn}
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

      {/* RIDE DETAIL POPUP */}
      {rideDetail && (
        <div style={s.modalOverlay} onClick={() => setRideDetail(null)}>
          <div
            style={{ ...s.modal, maxWidth: 480 }}
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
              <div style={s.modalTitle}>Ride details</div>
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: "#6B7280",
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
                style={{
                  ...s.statusBadge,
                  background: STATUS_COLORS[rideDetail.status] + "22",
                  color: STATUS_COLORS[rideDetail.status],
                  border: `0.5px solid ${STATUS_COLORS[rideDetail.status]}44`,
                }}
              >
                {STATUS_LABELS[rideDetail.status]}
              </span>
              <span style={{ fontSize: 12, color: "#6B7280" }}>
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
              <div
                key={label}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                  borderBottom: "0.5px solid rgba(255,255,255,0.06)",
                }}
              >
                <span style={{ fontSize: 12, color: "#6B7280" }}>{label}</span>
                <span
                  style={{
                    fontSize: 13,
                    color: "#F1F5F9",
                    fontWeight: 500,
                    maxWidth: "60%",
                    textAlign: "right",
                  }}
                >
                  {value}
                </span>
              </div>
            ))}
            <button
              style={{ ...s.modalCancelBtn, width: "100%", marginTop: 16 }}
              onClick={() => setRideDetail(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: "#111827",
    fontFamily: "system-ui, sans-serif",
    overflow: "hidden",
    position: "relative",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    background: "#1E2A3A",
    borderBottom: "0.5px solid rgba(255,255,255,0.08)",
    flexShrink: 0,
    zIndex: 20,
    position: "relative",
  },
  topLeft: { display: "flex", alignItems: "center", gap: 12 },
  logo: { fontSize: 22, fontWeight: 700, color: "#E8500A", letterSpacing: 0.5 },
  topLabel: { fontSize: 13, color: "#6B7280" },
  backBtn: {
    background: "transparent",
    color: "#9CA3AF",
    border: "none",
    fontSize: 14,
    cursor: "pointer",
    padding: "6px 0",
  },
  statPills: { display: "flex", gap: 16 },
  statPill: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "#9CA3AF",
  },
  analyticsBtn: {
    background: "rgba(168,85,247,0.15)",
    color: "#A855F7",
    border: "0.5px solid rgba(168,85,247,0.3)",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  newRideBtn: {
    background: "#E8500A",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  signOutBtn: {
    background: "transparent",
    color: "#6B7280",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
  body: { display: "flex", flex: 1, overflow: "hidden", minHeight: 0 },
  sidebar: {
    width: 320,
    background: "#111827",
    borderRight: "0.5px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
  },
  tabs: {
    display: "flex",
    borderBottom: "0.5px solid rgba(255,255,255,0.08)",
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: "10px 4px",
    fontSize: 12,
    fontWeight: 500,
    background: "transparent",
    border: "none",
    color: "#6B7280",
    cursor: "pointer",
    borderBottom: "2px solid transparent",
  },
  tabActive: { color: "#E8500A", borderBottom: "2px solid #E8500A" },
  sidebarContent: { flex: 1, overflowY: "auto", padding: 12 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 600,
    color: "#4B5563",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: 8,
    marginTop: 4,
  },
  empty: {
    fontSize: 13,
    color: "#4B5563",
    textAlign: "center",
    padding: "20px 0",
  },
  rideCard: {
    background: "#1E2A3A",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    border: "0.5px solid rgba(255,255,255,0.06)",
    cursor: "pointer",
  },
  rideCardSelected: { border: "0.5px solid rgba(232,80,10,0.5)" },
  rideCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 20,
  },
  rideTime: { fontSize: 11, color: "#6B7280" },
  rideName: {
    fontSize: 13,
    fontWeight: 600,
    color: "#F1F5F9",
    marginBottom: 3,
  },
  rideAddr: {
    fontSize: 11,
    color: "#6B7280",
    marginBottom: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rideFare: { fontSize: 12, fontWeight: 600, color: "#9CA3AF", marginTop: 4 },
  pendingConfirmBadge: {
    fontSize: 11,
    color: "#F59E0B",
    background: "rgba(245,158,11,0.1)",
    borderRadius: 6,
    padding: "4px 8px",
    marginTop: 6,
    border: "0.5px solid rgba(245,158,11,0.25)",
  },
  assignBtn: {
    width: "100%",
    background: "rgba(74,158,255,0.1)",
    color: "#4a9eff",
    border: "0.5px solid rgba(74,158,255,0.3)",
    borderRadius: 8,
    padding: "6px 0",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 500,
  },
  assignLabel: { fontSize: 11, color: "#6B7280", marginBottom: 4 },
  assignDriverBtn: {
    width: "100%",
    background: "rgba(29,158,117,0.1)",
    color: "#1D9E75",
    border: "0.5px solid rgba(29,158,117,0.3)",
    borderRadius: 8,
    padding: "6px 0",
    fontSize: 12,
    cursor: "pointer",
    marginBottom: 4,
  },
  cancelAssignBtn: {
    background: "transparent",
    color: "#6B7280",
    border: "none",
    fontSize: 11,
    cursor: "pointer",
    padding: "4px 0",
  },
  driverCard: {
    background: "#1E2A3A",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    border: "0.5px solid rgba(255,255,255,0.06)",
  },
  driverCardTop: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  driverAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: "#1E3A5F",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 700,
    color: "#93C5FD",
    flexShrink: 0,
  },
  driverName: { fontSize: 13, fontWeight: 600, color: "#F1F5F9" },
  driverSub: { fontSize: 11, color: "#6B7280" },
  driverPhone: { fontSize: 11, color: "#4B5563", marginTop: 2 },
  onlineDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  revenueGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  revenueCard: {
    background: "#1E2A3A",
    borderRadius: 12,
    padding: 12,
    border: "0.5px solid rgba(255,255,255,0.06)",
  },
  revenueLabel: {
    fontSize: 10,
    color: "#6B7280",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  revenueValue: { fontSize: 22, fontWeight: 700, color: "#F1F5F9" },
  revenueSubLabel: { fontSize: 10, color: "#4B5563", marginTop: 2 },
  driverRevenueRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 0",
    borderBottom: "0.5px solid rgba(255,255,255,0.05)",
  },
  driverRevName: { fontSize: 13, color: "#CBD5E1" },
  driverRevStats: { display: "flex", gap: 12, alignItems: "center" },
  driverRevCount: { fontSize: 11, color: "#6B7280" },
  driverRevAmount: { fontSize: 14, fontWeight: 600, color: "#1D9E75" },
  inviteForm: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 12,
  },
  inviteInput: {
    background: "#1E2A3A",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    color: "#F1F5F9",
    outline: "none",
  },
  inviteBtn: {
    background: "#E8500A",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  inviteSuccess: {
    background: "rgba(29,158,117,0.1)",
    border: "0.5px solid rgba(29,158,117,0.3)",
    borderRadius: 12,
    padding: 16,
    textAlign: "center",
    marginBottom: 12,
  },
  inviteCard: {
    background: "#1E2A3A",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    border: "0.5px solid rgba(255,255,255,0.06)",
  },
  inviteCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  inviteName: { fontSize: 13, fontWeight: 600, color: "#F1F5F9" },
  invitePhone: { fontSize: 11, color: "#6B7280", marginBottom: 6 },
  inviteCodeRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  inviteCode: {
    fontSize: 16,
    fontWeight: 700,
    color: "#E8500A",
    letterSpacing: "0.15em",
  },
  revokeBtn: {
    background: "rgba(226,75,74,0.1)",
    color: "#F87171",
    border: "0.5px solid rgba(226,75,74,0.25)",
    borderRadius: 6,
    padding: "3px 10px",
    fontSize: 11,
    cursor: "pointer",
  },
  mapWrap: { flex: 1, position: "relative", minHeight: 0, overflow: "hidden" },
  map: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#1E2A3A",
    borderRadius: 16,
    padding: 28,
    width: "100%",
    maxWidth: 440,
    border: "0.5px solid rgba(255,255,255,0.1)",
    maxHeight: "90vh",
    overflowY: "auto",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#F1F5F9",
    marginBottom: 20,
  },
  modalLabel: { fontSize: 12, color: "#9CA3AF", fontWeight: 500 },
  modalInput: {
    background: "#111827",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    color: "#F1F5F9",
    outline: "none",
    width: "100%",
  },
  modalSelect: {
    background: "#111827",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    color: "#F1F5F9",
    outline: "none",
    width: "100%",
    cursor: "pointer",
  },
  modalCancelBtn: {
    flex: 1,
    background: "transparent",
    color: "#9CA3AF",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "10px",
    fontSize: 14,
    cursor: "pointer",
  },
  modalSubmitBtn: {
    flex: 2,
    background: "#E8500A",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};

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
