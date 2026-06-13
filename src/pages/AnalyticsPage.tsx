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
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      // Fetch rides
      const { data: rides, error: ridesError } = await supabase
        .from("rides")
        .select("*")
        .gte("created_at", startDate.toISOString())
        .order("created_at", { ascending: true });

      if (ridesError || !rides) {
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
          const ex = dayMap.get(day) ?? { revenue: 0, rides: 0 };
          dayMap.set(day, {
            revenue: ex.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
            rides: ex.rides + 1,
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

      // Totals
      const completed = rides.filter((r) => r.status === "completed");
      const cancelled = rides.filter((r) => r.status === "cancelled");
      const totalRev = completed.reduce(
        (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
        0,
      );
      setTotals({
        revenue: totalRev,
        rides: completed.length,
        passengers: new Set(rides.map((r) => r.passenger_id)).size,
        avgFare: completed.length ? totalRev / completed.length : 0,
        cancelRate: rides.length ? (cancelled.length / rides.length) * 100 : 0,
      });

      // Driver stats — fetch drivers first, then profiles in parallel
      const { data: drivers } = await supabase.from("drivers").select("id");
      if (drivers && drivers.length > 0) {
        const stats: DriverStat[] = await Promise.all(
          drivers.map(async (d) => {
            const { data: p } = await supabase
              .from("profiles")
              .select("name")
              .eq("id", d.id)
              .maybeSingle();
            const driverRides = rides.filter((r) => r.driver_id === d.id);
            const comp = driverRides.filter((r) => r.status === "completed");
            const canc = driverRides.filter((r) => r.status === "cancelled");
            const earnings = comp.reduce(
              (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
              0,
            );
            return {
              name: p?.name ?? "Unknown",
              rides: comp.length,
              earnings,
              cancelRate: driverRides.length
                ? (canc.length / driverRides.length) * 100
                : 0,
            };
          }),
        );
        setDriverStats(stats.sort((a, b) => b.earnings - a.earnings));
      } else {
        setDriverStats([]);
      }
    } catch (err) {
      console.error("Analytics error:", err);
    } finally {
      setLoading(false);
    }
  }

  const maxRevenue = Math.max(...dailyData.map((d) => d.revenue), 1);
  const maxHour = Math.max(...hourStats.map((h) => h.rides), 1);
  const peakHour = hourStats.length
    ? hourStats.reduce((a, b) => (b.rides > a.rides ? b : a))
    : null;

  if (loading)
    return (
      <div
        style={{
          color: "#6B7280",
          padding: 40,
          textAlign: "center",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Loading analytics…
      </div>
    );

  return (
    <>
      <style>{`
        .an-page { padding: 24px; font-family: system-ui, -apple-system, sans-serif; background: #111827; min-height: 100%; }

        .an-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
        .an-title  { font-size: 20px; font-weight: 700; color: #F1F5F9; }

        .an-period-btns {
          display: flex; background: #1E2A3A;
          border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 3px; gap: 2px;
        }
        .an-period-btn {
          background: transparent; border: none; border-radius: 6px; padding: 6px 14px;
          font-size: 13px; font-weight: 500; color: #4B5563; cursor: pointer;
          font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s;
        }
        .an-period-btn.active { background: #111827; color: #F1F5F9; }

        .an-kpi-grid { display: grid; grid-template-columns: repeat(5,1fr); gap: 10px; margin-bottom: 20px; }
        .an-kpi-card { background: #1E2A3A; border-radius: 12px; padding: 16px; border: 1px solid rgba(255,255,255,0.05); }
        .an-kpi-label { font-size: 10px; font-weight: 600; color: #4B5563; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
        .an-kpi-value { font-size: 26px; font-weight: 700; color: #F1F5F9; line-height: 1; }

        .an-charts-row { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; }

        .an-chart-card { background: #1E2A3A; border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 12px; }
        .an-chart-title { font-size: 11px; font-weight: 600; color: #4B5563; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 16px; }
        .an-no-data { color: #374151; font-size: 13px; text-align: center; padding: 20px 0; }

        .an-x-labels { display: flex; justify-content: space-between; margin-top: 8px; }
        .an-x-label  { font-size: 10px; color: #374151; }

        .an-bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 110px; padding-bottom: 20px; }
        .an-bar-group { display: flex; flex-direction: column; align-items: center; flex: 1; }
        .an-bar-wrap  { flex: 1; width: 100%; display: flex; align-items: flex-end; }
        .an-bar       { width: 100%; border-radius: 2px 2px 0 0; transition: height 0.3s; min-height: 2px; }
        .an-bar-label { font-size: 9px; color: #374151; margin-top: 3px; }
        .an-peak-note { font-size: 12px; color: #6B7280; margin-top: 8px; }

        .an-table  { width: 100%; border-collapse: collapse; }
        .an-th {
          font-size: 10px; font-weight: 600; color: #4B5563; text-align: left;
          padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05);
          text-transform: uppercase; letter-spacing: 0.06em;
        }
        .an-td { font-size: 13px; color: #9CA3AF; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); }
      `}</style>

      <div className="an-page">
        <div className="an-header">
          <div className="an-title">Analytics</div>
          <div className="an-period-btns">
            {(["week", "month", "year"] as const).map((p) => (
              <button
                key={p}
                className={`an-period-btn${period === p ? " active" : ""}`}
                onClick={() => setPeriod(p)}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* KPIs */}
        <div className="an-kpi-grid">
          <div className="an-kpi-card">
            <div className="an-kpi-label">Revenue</div>
            <div className="an-kpi-value" style={{ color: "#1D9E75" }}>
              ${totals.revenue.toFixed(2)}
            </div>
          </div>
          <div className="an-kpi-card">
            <div className="an-kpi-label">Completed rides</div>
            <div className="an-kpi-value">{totals.rides}</div>
          </div>
          <div className="an-kpi-card">
            <div className="an-kpi-label">Passengers</div>
            <div className="an-kpi-value">{totals.passengers}</div>
          </div>
          <div className="an-kpi-card">
            <div className="an-kpi-label">Avg fare</div>
            <div className="an-kpi-value">${totals.avgFare.toFixed(2)}</div>
          </div>
          <div className="an-kpi-card">
            <div className="an-kpi-label">Cancel rate</div>
            <div
              className="an-kpi-value"
              style={{ color: totals.cancelRate > 20 ? "#E24B4A" : "#F1F5F9" }}
            >
              {totals.cancelRate.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Charts */}
        <div className="an-charts-row">
          {/* Revenue line */}
          <div className="an-chart-card" style={{ flex: 1 }}>
            <div className="an-chart-title">Revenue over time</div>
            {dailyData.length === 0 ? (
              <div className="an-no-data">
                No completed rides in this period
              </div>
            ) : (
              <>
                <svg
                  width="100%"
                  height="140"
                  viewBox={`0 0 ${Math.max(dailyData.length * 40, 400)} 140`}
                  preserveAspectRatio="none"
                >
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                    <line
                      key={t}
                      x1="0"
                      y1={140 - t * 120}
                      x2="100%"
                      y2={140 - t * 120}
                      stroke="rgba(255,255,255,0.04)"
                      strokeWidth="1"
                    />
                  ))}
                  <defs>
                    <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="#E8500A"
                        stopOpacity="0.25"
                      />
                      <stop offset="100%" stopColor="#E8500A" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <polyline
                    fill="url(#rg)"
                    stroke="none"
                    points={[
                      `0,140`,
                      ...dailyData.map(
                        (d, i) =>
                          `${i * 40 + 20},${140 - (d.revenue / maxRevenue) * 120}`,
                      ),
                      `${(dailyData.length - 1) * 40 + 20},140`,
                    ].join(" ")}
                  />
                  <polyline
                    fill="none"
                    stroke="#E8500A"
                    strokeWidth="1.75"
                    strokeLinejoin="round"
                    points={dailyData
                      .map(
                        (d, i) =>
                          `${i * 40 + 20},${140 - (d.revenue / maxRevenue) * 120}`,
                      )
                      .join(" ")}
                  />
                  {dailyData.map((d, i) => (
                    <circle
                      key={i}
                      cx={i * 40 + 20}
                      cy={140 - (d.revenue / maxRevenue) * 120}
                      r="3"
                      fill="#E8500A"
                      stroke="#1E2A3A"
                      strokeWidth="2"
                    />
                  ))}
                </svg>
                <div className="an-x-labels">
                  {dailyData
                    .filter(
                      (_, i) =>
                        i % Math.max(1, Math.floor(dailyData.length / 6)) === 0,
                    )
                    .map((d, i) => (
                      <span key={i} className="an-x-label">
                        {d.day}
                      </span>
                    ))}
                </div>
              </>
            )}
          </div>

          {/* Peak hours */}
          <div className="an-chart-card" style={{ flex: "0 0 280px" }}>
            <div className="an-chart-title">Peak hours</div>
            <div className="an-bar-chart">
              {hourStats
                .filter((h) => h.hour % 3 === 0 || h.rides > 0)
                .map((h) => (
                  <div key={h.hour} className="an-bar-group">
                    <div className="an-bar-wrap">
                      <div
                        className="an-bar"
                        style={{
                          height: `${Math.max(2, (h.rides / maxHour) * 100)}%`,
                          background:
                            peakHour && h.hour === peakHour.hour
                              ? "#E8500A"
                              : "#1E3A5F",
                        }}
                      />
                    </div>
                    <div className="an-bar-label">
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
            {peakHour && peakHour.rides > 0 && (
              <div className="an-peak-note">
                Peak:{" "}
                {peakHour.hour === 0
                  ? "12am"
                  : peakHour.hour < 12
                    ? `${peakHour.hour}am`
                    : peakHour.hour === 12
                      ? "12pm"
                      : `${peakHour.hour - 12}pm`}{" "}
                · {peakHour.rides} rides
              </div>
            )}
          </div>
        </div>

        {/* Driver table */}
        <div className="an-chart-card">
          <div className="an-chart-title">Driver performance</div>
          <table className="an-table">
            <thead>
              <tr>
                {["Driver", "Rides", "Earnings", "Cancel rate", "Avg fare"].map(
                  (h) => (
                    <th key={h} className="an-th">
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
                      i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                  }}
                >
                  <td
                    className="an-td"
                    style={{ color: "#E2E8F0", fontWeight: 500 }}
                  >
                    {d.name}
                  </td>
                  <td className="an-td">{d.rides}</td>
                  <td
                    className="an-td"
                    style={{ color: "#1D9E75", fontWeight: 600 }}
                  >
                    ${d.earnings.toFixed(2)}
                  </td>
                  <td
                    className="an-td"
                    style={{ color: d.cancelRate > 20 ? "#E24B4A" : "#6B7280" }}
                  >
                    {d.cancelRate.toFixed(1)}%
                  </td>
                  <td className="an-td">
                    ${d.rides ? (d.earnings / d.rides).toFixed(2) : "0.00"}
                  </td>
                </tr>
              ))}
              {driverStats.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="an-td"
                    style={{ textAlign: "center", color: "#374151" }}
                  >
                    No data for this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
