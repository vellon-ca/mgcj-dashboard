import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

interface DayRevenue {
  day: string;
  revenue: number;
  rides: number;
}
interface DriverStat {
  name: string;
  rides: number;
  earnings: number;
  cancelRate: number;
}
interface HourStat {
  hour: number;
  rides: number;
}

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<"week" | "month" | "year">("month");
  const [dailyData, setDailyData] = useState<DayRevenue[]>([]);
  const [driverStats, setDriverStats] = useState<DriverStat[]>([]);
  const [hourStats, setHourStats] = useState<HourStat[]>([]);
  const [totals, setTotals] = useState({
    revenue: 0,
    rides: 0,
    passengers: 0,
    avgFare: 0,
    cancelRate: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, [period]);

  async function fetchAnalytics() {
    setLoading(true);
    const now = new Date();
    let startDate: Date;

    if (period === "week")
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (period === "month")
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    else startDate = new Date(now.getFullYear(), 0, 1);

    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .gte("created_at", startDate.toISOString())
      .order("created_at", { ascending: true });

    if (!rides) {
      setLoading(false);
      return;
    }

    // Daily revenue
    const dayMap = new Map<string, { revenue: number; rides: number }>();
    rides
      .filter((r) => r.status === "completed")
      .forEach((r) => {
        const day = new Date(r.created_at).toLocaleDateString("en-CA", {
          month: "short",
          day: "numeric",
        });
        const existing = dayMap.get(day) ?? { revenue: 0, rides: 0 };
        dayMap.set(day, {
          revenue: existing.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
          rides: existing.rides + 1,
        });
      });
    setDailyData(
      Array.from(dayMap.entries()).map(([day, v]) => ({ day, ...v })),
    );

    // Hour distribution
    const hourMap = new Map<number, number>();
    rides.forEach((r) => {
      const h = new Date(r.created_at).getHours();
      hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
    });
    setHourStats(
      Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        rides: hourMap.get(i) ?? 0,
      })),
    );

    // Driver stats
    const { data: drivers } = await supabase.from("drivers").select("id");
    if (drivers) {
      const stats = await Promise.all(
        drivers.map(async (d) => {
          const { data: p } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", d.id)
            .single();
          const driverRides = rides.filter((r) => r.driver_id === d.id);
          const completed = driverRides.filter((r) => r.status === "completed");
          const cancelled = driverRides.filter((r) => r.status === "cancelled");
          const earnings = completed.reduce(
            (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          );
          const cancelRate = driverRides.length
            ? (cancelled.length / driverRides.length) * 100
            : 0;
          return {
            name: p?.name ?? "Unknown",
            rides: completed.length,
            earnings,
            cancelRate,
          };
        }),
      );
      setDriverStats(stats.sort((a, b) => b.earnings - a.earnings));
    }

    // Totals
    const completed = rides.filter((r) => r.status === "completed");
    const cancelled = rides.filter((r) => r.status === "cancelled");
    const totalRev = completed.reduce(
      (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
      0,
    );
    const uniquePassengers = new Set(rides.map((r) => r.passenger_id)).size;
    setTotals({
      revenue: totalRev,
      rides: completed.length,
      passengers: uniquePassengers,
      avgFare: completed.length ? totalRev / completed.length : 0,
      cancelRate: rides.length ? (cancelled.length / rides.length) * 100 : 0,
    });

    setLoading(false);
  }

  const maxRevenue = Math.max(...dailyData.map((d) => d.revenue), 1);
  const maxHour = Math.max(...hourStats.map((h) => h.rides), 1);

  if (loading) return <div style={s.loading}>Loading analytics…</div>;

  return (
    <div style={s.page}>
      {/* Period selector */}
      <div style={s.periodRow}>
        <div style={s.pageTitle}>Analytics</div>
        <div style={s.periodBtns}>
          {(["week", "month", "year"] as const).map((p) => (
            <button
              key={p}
              style={{
                ...s.periodBtn,
                ...(period === p ? s.periodBtnActive : {}),
              }}
              onClick={() => setPeriod(p)}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* KPI cards */}
      <div style={s.kpiGrid}>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Total revenue</div>
          <div style={{ ...s.kpiValue, color: "#1D9E75" }}>
            ${totals.revenue.toFixed(2)}
          </div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Completed rides</div>
          <div style={s.kpiValue}>{totals.rides}</div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Unique passengers</div>
          <div style={s.kpiValue}>{totals.passengers}</div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Avg fare</div>
          <div style={s.kpiValue}>${totals.avgFare.toFixed(2)}</div>
        </div>
        <div style={s.kpiCard}>
          <div style={s.kpiLabel}>Cancel rate</div>
          <div
            style={{
              ...s.kpiValue,
              color: totals.cancelRate > 20 ? "#E24B4A" : "#F1F5F9",
            }}
          >
            {totals.cancelRate.toFixed(1)}%
          </div>
        </div>
      </div>

      <div style={s.chartsRow}>
        {/* Revenue line chart */}
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Revenue over time</div>
          {dailyData.length === 0 ? (
            <div style={s.noData}>No completed rides in this period</div>
          ) : (
            <div style={s.lineChart}>
              <svg
                width="100%"
                height="160"
                viewBox={`0 0 ${Math.max(dailyData.length * 40, 400)} 160`}
                preserveAspectRatio="none"
              >
                {/* Grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                  <line
                    key={t}
                    x1="0"
                    y1={160 - t * 140}
                    x2="100%"
                    y2={160 - t * 140}
                    stroke="rgba(255,255,255,0.05)"
                    strokeWidth="1"
                  />
                ))}
                {/* Area fill */}
                <defs>
                  <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#E8500A" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#E8500A" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polyline
                  fill="url(#revGrad)"
                  stroke="none"
                  points={[
                    `0,160`,
                    ...dailyData.map(
                      (d, i) =>
                        `${i * 40 + 20},${160 - (d.revenue / maxRevenue) * 140}`,
                    ),
                    `${(dailyData.length - 1) * 40 + 20},160`,
                  ].join(" ")}
                />
                {/* Line */}
                <polyline
                  fill="none"
                  stroke="#E8500A"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  points={dailyData
                    .map(
                      (d, i) =>
                        `${i * 40 + 20},${160 - (d.revenue / maxRevenue) * 140}`,
                    )
                    .join(" ")}
                />
                {/* Dots */}
                {dailyData.map((d, i) => (
                  <circle
                    key={i}
                    cx={i * 40 + 20}
                    cy={160 - (d.revenue / maxRevenue) * 140}
                    r="3"
                    fill="#E8500A"
                    stroke="#111827"
                    strokeWidth="2"
                  />
                ))}
              </svg>
              {/* X labels */}
              <div style={s.xLabels}>
                {dailyData
                  .filter(
                    (_, i) =>
                      i % Math.max(1, Math.floor(dailyData.length / 6)) === 0,
                  )
                  .map((d, i) => (
                    <span key={i} style={s.xLabel}>
                      {d.day}
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Peak hours bar chart */}
        <div style={{ ...s.chartCard, flex: "0 0 320px" }}>
          <div style={s.chartTitle}>Peak hours</div>
          <div style={s.barChart}>
            {hourStats
              .filter((h) => h.hour % 3 === 0 || h.rides > 0)
              .map((h) => (
                <div key={h.hour} style={s.barGroup}>
                  <div style={s.barWrap}>
                    <div
                      style={{
                        ...s.bar,
                        height: `${Math.max(2, (h.rides / maxHour) * 100)}%`,
                        background:
                          h.rides === Math.max(...hourStats.map((x) => x.rides))
                            ? "#E8500A"
                            : "#1E3A5F",
                      }}
                    />
                  </div>
                  <div style={s.barLabel}>
                    {h.hour === 0
                      ? "12a"
                      : h.hour < 12
                        ? `${h.hour}a`
                        : h.hour === 12
                          ? "12p"
                          : `${h.hour - 12}p`}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Driver performance table */}
      <div style={s.chartCard}>
        <div style={s.chartTitle}>Driver performance</div>
        <table style={s.table}>
          <thead>
            <tr>
              {["Driver", "Rides", "Earnings", "Cancel rate", "Avg fare"].map(
                (h) => (
                  <th key={h} style={s.th}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {driverStats.map((d, i) => (
              <tr
                key={i}
                style={{
                  background:
                    i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
                }}
              >
                <td style={s.td}>{d.name}</td>
                <td style={s.td}>{d.rides}</td>
                <td style={{ ...s.td, color: "#1D9E75", fontWeight: 600 }}>
                  ${d.earnings.toFixed(2)}
                </td>
                <td
                  style={{
                    ...s.td,
                    color: d.cancelRate > 20 ? "#E24B4A" : "#9CA3AF",
                  }}
                >
                  {d.cancelRate.toFixed(1)}%
                </td>
                <td style={s.td}>
                  ${d.rides ? (d.earnings / d.rides).toFixed(2) : "0.00"}
                </td>
              </tr>
            ))}
            {driverStats.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{ ...s.td, textAlign: "center", color: "#4B5563" }}
                >
                  No data for this period
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    padding: "20px",
    overflowY: "auto",
    height: "100%",
    background: "#111827",
  },
  loading: { color: "#6B7280", padding: 40, textAlign: "center" },
  periodRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  pageTitle: { fontSize: 20, fontWeight: 700, color: "#F1F5F9" },
  periodBtns: { display: "flex", gap: 6 },
  periodBtn: {
    background: "#1E2A3A",
    border: "0.5px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
    color: "#6B7280",
    cursor: "pointer",
  },
  periodBtnActive: {
    background: "#E8500A",
    color: "#fff",
    border: "0.5px solid #E8500A",
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: 10,
    marginBottom: 16,
  },
  kpiCard: {
    background: "#1E2A3A",
    borderRadius: 12,
    padding: "14px 16px",
    border: "0.5px solid rgba(255,255,255,0.06)",
  },
  kpiLabel: {
    fontSize: 11,
    color: "#6B7280",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  kpiValue: { fontSize: 24, fontWeight: 700, color: "#F1F5F9" },
  chartsRow: { display: "flex", gap: 12, marginBottom: 16 },
  chartCard: {
    flex: 1,
    background: "#1E2A3A",
    borderRadius: 14,
    padding: 16,
    border: "0.5px solid rgba(255,255,255,0.06)",
    marginBottom: 12,
  },
  chartTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "#9CA3AF",
    marginBottom: 14,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  noData: {
    color: "#4B5563",
    fontSize: 13,
    textAlign: "center",
    padding: "20px 0",
  },
  lineChart: { width: "100%" },
  xLabels: { display: "flex", justifyContent: "space-between", marginTop: 6 },
  xLabel: { fontSize: 10, color: "#4B5563" },
  barChart: {
    display: "flex",
    alignItems: "flex-end",
    gap: 3,
    height: 120,
    paddingBottom: 20,
  },
  barGroup: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flex: 1,
  },
  barWrap: { flex: 1, width: "100%", display: "flex", alignItems: "flex-end" },
  bar: {
    width: "100%",
    borderRadius: "2px 2px 0 0",
    transition: "height 0.3s",
    minHeight: 2,
  },
  barLabel: { fontSize: 9, color: "#4B5563", marginTop: 3 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    fontSize: 11,
    color: "#6B7280",
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "0.5px solid rgba(255,255,255,0.06)",
    fontWeight: 500,
  },
  td: {
    fontSize: 13,
    color: "#CBD5E1",
    padding: "10px 12px",
    borderBottom: "0.5px solid rgba(255,255,255,0.04)",
  },
};
