import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

interface ReportRow {
  id: string;
  ride_id: string | null;
  passenger_id: string;
  driver_id: string;
  reason: string;
  comment: string | null;
  status: "open" | "reviewed" | "dismissed";
  created_at: string;
  passenger_name: string | null;
  driver_name: string | null;
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

const HIGH_SEVERITY = new Set(["unsafe_driving", "harassment"]);

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  reviewed: "Reviewed",
  dismissed: "Dismissed",
};
const STATUS_COLORS: Record<string, string> = {
  open: "#F59E0B",
  reviewed: "#1D9E75",
  dismissed: "#4B5563",
};

interface Props {
  onBadgeChange: (count: number) => void;
}

export default function ReportsPage({ onBadgeChange }: Props) {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [updating, setUpdating] = useState<string | null>(null);

  useEffect(() => {
    fetchReports();
  }, []);

  async function fetchReports() {
    setLoading(true);
    try {
      const { data: rows } = await supabase
        .from("driver_reports")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);

      if (!rows) return;

      const enriched: ReportRow[] = await Promise.all(
        rows.map(async (r: any) => {
          const [{ data: passenger }, { data: driver }] = await Promise.all([
            supabase
              .from("profiles")
              .select("name")
              .eq("id", r.passenger_id)
              .maybeSingle(),
            supabase
              .from("profiles")
              .select("name")
              .eq("id", r.driver_id)
              .maybeSingle(),
          ]);
          return {
            ...r,
            passenger_name: passenger?.name ?? null,
            driver_name: driver?.name ?? null,
          };
        }),
      );

      setReports(enriched);
      const openCount = enriched.filter((r) => r.status === "open").length;
      onBadgeChange(openCount);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: string, status: "reviewed" | "dismissed") {
    setUpdating(id);
    const { error } = await supabase
      .from("driver_reports")
      .update({ status })
      .eq("id", id);
    if (!error) {
      setReports((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status } : r)),
      );
      const openCount = reports.filter(
        (r) => r.id !== id && r.status === "open",
      ).length;
      onBadgeChange(openCount);
    }
    setUpdating(null);
  }

  // Unique drivers for filter dropdown
  const driverOptions = Array.from(
    reports
      .reduce((map, r) => {
        if (!map.has(r.driver_id))
          map.set(r.driver_id, r.driver_name ?? "Unknown");
        return map;
      }, new Map<string, string>())
      .entries(),
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filtered = reports.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (driverFilter !== "all" && r.driver_id !== driverFilter) return false;
    return true;
  });

  const openCount = reports.filter((r) => r.status === "open").length;
  const reviewedCount = reports.filter((r) => r.status === "reviewed").length;
  const dismissedCount = reports.filter((r) => r.status === "dismissed").length;

  return (
    <>
      <style>{`
        .rp-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }

        /* LEFT PANEL */
        .rp-panel { width: 200px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .rp-panel-title { font-size: 10px; font-weight: 600; color: #374151; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .rp-filter-btn { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #4B5563; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .rp-filter-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .rp-filter-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .rp-filter-count { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 8px; background: rgba(255,255,255,0.06); color: #6B7280; }
        .rp-filter-btn.active .rp-filter-count { background: rgba(232,80,10,0.15); color: #E8500A; }
        .rp-filter-count.urgent { background: rgba(248,113,113,0.12); color: #F87171; }

        .rp-panel-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 10px 16px; }
        .rp-panel-subtitle { font-size: 10px; font-weight: 600; color: #374151; letter-spacing: 0.07em; text-transform: uppercase; padding: 8px 16px 6px; }
        .rp-driver-btn { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 34px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 12px; font-weight: 500; color: #4B5563; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s; font-family: system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rp-driver-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .rp-driver-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }

        /* CONTENT */
        .rp-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; }
        .rp-content::-webkit-scrollbar { width: 4px; }
        .rp-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .rp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .rp-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .rp-subtitle-text { font-size: 12px; color: #4B5563; }

        /* SUMMARY STRIP */
        .rp-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
        .rp-summary-card { background: #1E2A3A; border-radius: 10px; padding: 14px; border: 1px solid rgba(255,255,255,0.05); }
        .rp-summary-label { font-size: 10px; font-weight: 600; color: #4B5563; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; }
        .rp-summary-value { font-size: 22px; font-weight: 700; color: #F1F5F9; line-height: 1; }

        /* REPORT CARD */
        .rp-card { background: #1E2A3A; border-radius: 12px; padding: 16px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); }
        .rp-card.high-severity { background: #1A0F0F; border-color: rgba(248,113,113,0.2); }
        .rp-card.dismissed-card { opacity: 0.55; }

        .rp-card-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; gap: 12px; }
        .rp-card-meta { display: flex; flex-direction: column; gap: 3px; }
        .rp-card-date { font-size: 11px; color: #374151; }

        .rp-severity-flag { font-size: 11px; color: #F87171; background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); border-radius: 6px; padding: 3px 8px; display: inline-flex; align-items: center; gap: 4px; margin-bottom: 10px; }

        .rp-reason { font-size: 14px; font-weight: 600; color: #E2E8F0; margin-bottom: 8px; }
        .rp-people { display: flex; gap: 20px; margin-bottom: 8px; }
        .rp-person { font-size: 12px; color: #6B7280; }
        .rp-person span { color: #4B5563; }
        .rp-comment { background: rgba(255,255,255,0.03); border-left: 2px solid #2D3F52; border-radius: 0 6px 6px 0; padding: 8px 12px; font-size: 13px; color: #6B7280; font-style: italic; margin-top: 10px; }

        .rp-status-badge { font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }

        .rp-actions { display: flex; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); }
        .rp-action-btn { padding: 6px 14px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; border: none; transition: opacity 0.12s; }
        .rp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .rp-action-reviewed { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.25) !important; }
        .rp-action-reviewed:hover:not(:disabled) { background: rgba(29,158,117,0.18); }
        .rp-action-dismissed { background: rgba(255,255,255,0.04); color: #4B5563; border: 1px solid rgba(255,255,255,0.07) !important; }
        .rp-action-dismissed:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: #6B7280; }

        .rp-empty { color: #374151; font-size: 14px; text-align: center; padding: 60px 0; }
        .rp-loading { color: #4B5563; text-align: center; padding: 60px; font-size: 14px; }
      `}</style>

      <div className="rp-wrap">
        {/* LEFT PANEL */}
        <div className="rp-panel">
          <div className="rp-panel-title">Filter</div>

          {(["all", "open", "reviewed", "dismissed"] as const).map((s) => {
            const count =
              s === "all"
                ? reports.length
                : reports.filter((r) => r.status === s).length;
            return (
              <button
                key={s}
                className={`rp-filter-btn${statusFilter === s ? " active" : ""}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All reports" : STATUS_LABELS[s]}
                <span
                  className={`rp-filter-count${s === "open" && count > 0 ? " urgent" : ""}`}
                >
                  {count}
                </span>
              </button>
            );
          })}

          {driverOptions.length > 0 && (
            <>
              <div className="rp-panel-divider" />
              <div className="rp-panel-subtitle">By driver</div>
              <button
                className={`rp-driver-btn${driverFilter === "all" ? " active" : ""}`}
                onClick={() => setDriverFilter("all")}
              >
                All drivers
              </button>
              {driverOptions.map((d) => (
                <button
                  key={d.id}
                  className={`rp-driver-btn${driverFilter === d.id ? " active" : ""}`}
                  onClick={() => setDriverFilter(d.id)}
                  title={d.name}
                >
                  {d.name}
                </button>
              ))}
            </>
          )}
        </div>

        {/* CONTENT */}
        <div className="rp-content">
          <div className="rp-header">
            <div className="rp-title">Driver Reports</div>
            <div className="rp-subtitle-text">
              {filtered.length} report{filtered.length !== 1 ? "s" : ""}
              {driverFilter !== "all" &&
                ` · ${driverOptions.find((d) => d.id === driverFilter)?.name}`}
            </div>
          </div>

          {/* Summary strip */}
          <div className="rp-summary">
            <div className="rp-summary-card">
              <div className="rp-summary-label">Open</div>
              <div
                className="rp-summary-value"
                style={{ color: openCount > 0 ? "#F59E0B" : "#F1F5F9" }}
              >
                {openCount}
              </div>
            </div>
            <div className="rp-summary-card">
              <div className="rp-summary-label">Reviewed</div>
              <div className="rp-summary-value" style={{ color: "#1D9E75" }}>
                {reviewedCount}
              </div>
            </div>
            <div className="rp-summary-card">
              <div className="rp-summary-label">Dismissed</div>
              <div className="rp-summary-value">{dismissedCount}</div>
            </div>
          </div>

          {loading ? (
            <div className="rp-loading">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="rp-empty">
              {statusFilter === "open"
                ? "No open reports — all clear."
                : "No reports match these filters."}
            </div>
          ) : (
            filtered.map((r) => {
              const isHigh = HIGH_SEVERITY.has(r.reason);
              return (
                <div
                  key={r.id}
                  className={`rp-card${isHigh && r.status === "open" ? " high-severity" : ""}${r.status === "dismissed" ? " dismissed-card" : ""}`}
                >
                  {isHigh && r.status === "open" && (
                    <div className="rp-severity-flag">
                      ⚠ High severity — requires follow-up
                    </div>
                  )}

                  <div className="rp-card-top">
                    <div className="rp-card-meta">
                      <div className="rp-card-date">
                        {new Date(r.created_at).toLocaleDateString("en-CA", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}{" "}
                        ·{" "}
                        {new Date(r.created_at).toLocaleTimeString("en-CA", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                    <span
                      className="rp-status-badge"
                      style={{
                        background: STATUS_COLORS[r.status] + "18",
                        color: STATUS_COLORS[r.status],
                        border: `1px solid ${STATUS_COLORS[r.status]}30`,
                      }}
                    >
                      {STATUS_LABELS[r.status]}
                    </span>
                  </div>

                  <div className="rp-reason">
                    {REASON_LABELS[r.reason] ?? r.reason}
                  </div>

                  <div className="rp-people">
                    <div className="rp-person">
                      <span>Reported by: </span>
                      {r.passenger_name ?? "—"}
                    </div>
                    <div className="rp-person">
                      <span>Driver: </span>
                      {r.driver_name ?? "—"}
                    </div>
                  </div>

                  {r.comment && <div className="rp-comment">"{r.comment}"</div>}

                  {r.status === "open" && (
                    <div className="rp-actions">
                      <button
                        className="rp-action-btn rp-action-reviewed"
                        disabled={updating === r.id}
                        onClick={() => updateStatus(r.id, "reviewed")}
                      >
                        {updating === r.id ? "Saving…" : "✓ Mark reviewed"}
                      </button>
                      <button
                        className="rp-action-btn rp-action-dismissed"
                        disabled={updating === r.id}
                        onClick={() => updateStatus(r.id, "dismissed")}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
