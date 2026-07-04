import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";

interface ReportRow {
  id: string;
  ride_id: string | null;
  passenger_id: string;
  driver_id: string;
  reason: string;
  comment: string | null;
  status: "open" | "reviewed" | "dismissed";
  created_at: string;
  resolution_notes: string | null;
  passenger_name: string | null;
  driver_name: string | null;
  ride_pickup: string | null;
  ride_dropoff: string | null;
  ride_fare: number | null;
  ride_date: string | null;
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
  dismissed: "#6B7280",
};

interface Props {
  onBadgeChange: (count: number) => void;
  companyId: string;
  adminId: string;
  companyName: string | null;
}

export default function ReportsPage({ onBadgeChange, companyId, adminId, companyName }: Props) {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [selected, setSelected] = useState<ReportRow | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notes, setNotes] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { fetchReports(); }, []);

  useEffect(() => {
    if (selected) setNotes(selected.resolution_notes ?? "");
  }, [selected?.id]);

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
          const [{ data: passenger }, { data: driver }, { data: ride }] = await Promise.all([
            supabase.from("profiles").select("name").eq("id", r.passenger_id).maybeSingle(),
            supabase.from("profiles").select("name").eq("id", r.driver_id).maybeSingle(),
            r.ride_id
              ? supabase
                  .from("rides")
                  .select("pickup_address, dropoff_address, fare_final, fare_estimate, created_at")
                  .eq("id", r.ride_id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          return {
            ...r,
            resolution_notes: r.resolution_notes ?? null,
            passenger_name: passenger?.name ?? null,
            driver_name: driver?.name ?? null,
            ride_pickup: ride?.pickup_address ?? null,
            ride_dropoff: ride?.dropoff_address ?? null,
            ride_fare: ride?.fare_final ?? ride?.fare_estimate ?? null,
            ride_date: ride?.created_at ?? null,
          };
        }),
      );

      setReports(enriched);
      onBadgeChange(enriched.filter((r) => r.status === "open").length);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: string, status: "reviewed" | "dismissed") {
    setUpdating(true);
    const { error } = await supabase
      .from("driver_reports")
      .update({ status, resolution_notes: notes.trim() || null })
      .eq("id", id);
    if (!error) {
      const updated = reports.map((r) =>
        r.id === id ? { ...r, status, resolution_notes: notes.trim() || null } : r,
      );
      setReports(updated);
      onBadgeChange(updated.filter((r) => r.status === "open").length);
      setSelected((prev) => prev ? { ...prev, status, resolution_notes: notes.trim() || null } : null);
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: status === "reviewed" ? "report.reviewed" : "report.dismissed",
        details: {
          driver_id: selected?.driver_id,
          driver_name: selected?.driver_name,
          reason: selected?.reason,
          resolution_notes: notes.trim() || null,
        },
      });
    }
    setUpdating(false);
  }

  function printReport(r: ReportRow) {
    const isHigh = HIGH_SEVERITY.has(r.reason);
    const date = new Date(r.created_at).toLocaleDateString("en-CA", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const time = new Date(r.created_at).toLocaleTimeString("en-CA", {
      hour: "numeric", minute: "2-digit",
    });
    const rideDate = r.ride_date
      ? new Date(r.ride_date).toLocaleDateString("en-CA", {
          year: "numeric", month: "long", day: "numeric",
        })
      : null;
    const driverCount = reports.filter((x) => x.driver_id === r.driver_id).length;

    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "report.printed",
      details: {
        driver_id: r.driver_id,
        driver_name: r.driver_name,
        reason: r.reason,
        report_status: r.status,
      },
    });

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Driver Report — ${r.driver_name ?? "Unknown"}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; padding: 48px; font-size: 13px; line-height: 1.5; max-width: 720px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; border-bottom: 2px solid #1a1a1a; margin-bottom: 24px; }
  .header-left h1 { font-size: 20px; font-weight: 700; }
  .header-left p { color: #6b7280; font-size: 12px; margin-top: 4px; }
  .header-right { text-align: right; font-size: 12px; color: #6b7280; }
  .severity-badge { display: inline-block; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 20px; }
  .section-title { font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }
  .section { margin-bottom: 24px; }
  .row { display: flex; padding: 7px 0; border-bottom: 1px solid #f3f4f6; }
  .row:last-child { border-bottom: none; }
  .row-label { width: 140px; flex-shrink: 0; color: #6b7280; font-size: 12px; }
  .row-value { flex: 1; font-size: 12px; color: #111; }
  .row-value.bold { font-weight: 600; }
  .row-value.reason { font-weight: 700; font-size: 14px; color: #111; }
  .comment-box { background: #f9fafb; border-left: 3px solid #d1d5db; border-radius: 0 6px 6px 0; padding: 10px 14px; font-style: italic; font-size: 13px; color: #374151; margin-top: 12px; }
  .resolution-box { background: #f0fdf4; border-left: 3px solid #86efac; border-radius: 0 6px 6px 0; padding: 10px 14px; font-size: 13px; color: #166534; margin-top: 4px; }
  .status-chip { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
  .status-open { background: #fef3c7; color: #92400e; }
  .status-reviewed { background: #d1fae5; color: #065f46; }
  .status-dismissed { background: #f3f4f6; color: #374151; }
  .driver-count-note { font-size: 11px; color: #6b7280; margin-top: 3px; }
  .sig-section { margin-top: 36px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
  .sig-title { font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 20px; }
  .sig-row { display: flex; gap: 40px; }
  .sig-field { flex: 1; }
  .sig-line { border-bottom: 1px solid #374151; height: 32px; margin-bottom: 5px; }
  .sig-line-label { font-size: 10px; color: #9ca3af; }
  @page { margin: 0; }
  @media print {
    body { padding: 60px 56px; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${companyName ?? ""}</h1>
      <p>Driver Incident Report</p>
    </div>
    <div class="header-right">
      <div>${date}</div>
      <div>${time}</div>
      <div style="margin-top:6px;font-size:11px">Report ID: ${r.id.slice(0, 8).toUpperCase()}</div>
    </div>
  </div>

  ${isHigh ? '<div class="severity-badge">⚠ High severity</div>' : ""}

  <div class="section">
    <div class="section-title">Incident</div>
    <div class="row">
      <div class="row-label">Reason</div>
      <div class="row-value reason">${REASON_LABELS[r.reason] ?? r.reason}</div>
    </div>
    <div class="row">
      <div class="row-label">Reported on</div>
      <div class="row-value">${date} at ${time}</div>
    </div>
    <div class="row">
      <div class="row-label">Status</div>
      <div class="row-value">
        <span class="status-chip status-${r.status}">${STATUS_LABELS[r.status]}</span>
      </div>
    </div>
    ${r.comment ? `<div class="comment-box">"${r.comment}"</div>` : ""}
  </div>

  <div class="section">
    <div class="section-title">Parties</div>
    <div class="row">
      <div class="row-label">Driver</div>
      <div class="row-value bold">
        ${r.driver_name ?? "—"}
        ${driverCount > 1 ? `<div class="driver-count-note">${driverCount} total reports on file for this driver</div>` : ""}
      </div>
    </div>
    <div class="row">
      <div class="row-label">Reported by</div>
      <div class="row-value">${r.passenger_name ?? "—"}</div>
    </div>
  </div>

  ${r.ride_id ? `
  <div class="section">
    <div class="section-title">Associated Ride</div>
    ${rideDate ? `<div class="row"><div class="row-label">Ride date</div><div class="row-value">${rideDate}</div></div>` : ""}
    ${r.ride_pickup ? `<div class="row"><div class="row-label">Pickup</div><div class="row-value">${r.ride_pickup}</div></div>` : ""}
    ${r.ride_dropoff ? `<div class="row"><div class="row-label">Drop-off</div><div class="row-value">${r.ride_dropoff}</div></div>` : ""}
    ${r.ride_fare != null ? `<div class="row"><div class="row-label">Fare</div><div class="row-value bold">$${Number(r.ride_fare).toFixed(2)}</div></div>` : ""}
  </div>` : ""}

  <div class="section">
    <div class="section-title">Resolution</div>
    ${r.resolution_notes
      ? `<div class="resolution-box">${r.resolution_notes}</div>`
      : `<div class="row"><div class="row-label">Notes</div><div class="row-value" style="color:#9ca3af">No resolution notes recorded.</div></div>`}
  </div>

  <div class="sig-section">
    <div class="sig-title">Authorization</div>
    <div class="sig-row">
      <div class="sig-field">
        <div class="sig-line"></div>
        <div class="sig-line-label">Authorized by (print name)</div>
      </div>
      <div class="sig-field">
        <div class="sig-line"></div>
        <div class="sig-line-label">Signature</div>
      </div>
      <div class="sig-field" style="max-width:130px">
        <div class="sig-line"></div>
        <div class="sig-line-label">Date</div>
      </div>
    </div>
  </div>
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  }

  const driverOptions = Array.from(
    reports.reduce((map, r) => {
      if (!map.has(r.driver_id)) map.set(r.driver_id, r.driver_name ?? "Unknown");
      return map;
    }, new Map<string, string>()).entries(),
  ).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  const filtered = reports.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (driverFilter !== "all" && r.driver_id !== driverFilter) return false;
    return true;
  });

  const openCount = reports.filter((r) => r.status === "open").length;
  const highOpen = reports.filter((r) => r.status === "open" && HIGH_SEVERITY.has(r.reason)).length;
  const reviewedCount = reports.filter((r) => r.status === "reviewed").length;
  const dismissedCount = reports.filter((r) => r.status === "dismissed").length;

  return (
    <>
      <style>{`
        .rp-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }

        /* LEFT PANEL */
        .rp-panel { width: 210px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; overflow-y: auto; }
        .rp-panel-title { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .rp-filter-btn { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 40px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #6B7280; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; gap: 6px; }
        .rp-filter-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .rp-filter-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .rp-filter-count { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 8px; background: rgba(255,255,255,0.06); color: #6B7280; flex-shrink: 0; }
        .rp-filter-btn.active .rp-filter-count { background: rgba(232,80,10,0.15); color: #E8500A; }
        .rp-filter-count.urgent { background: rgba(248,113,113,0.12); color: #F87171; }

        .rp-panel-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 10px 16px; }
        .rp-panel-subtitle { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.07em; text-transform: uppercase; padding: 8px 16px 6px; }
        .rp-driver-btn { display: flex; align-items: center; justify-content: space-between; width: 100%; height: 34px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 12px; font-weight: 500; color: #6B7280; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s; font-family: system-ui, sans-serif; gap: 6px; }
        .rp-driver-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .rp-driver-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .rp-driver-btn-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rp-driver-report-count { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 6px; background: rgba(255,255,255,0.05); color: #6B7280; flex-shrink: 0; }

        /* CONTENT */
        .rp-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; }
        .rp-content::-webkit-scrollbar { width: 4px; }
        .rp-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .rp-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
        .rp-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .rp-subtitle-text { font-size: 12px; color: #6B7280; margin-top: 2px; }

        /* SUMMARY STRIP */
        .rp-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
        .rp-summary-card { background: #1E2A3A; border-radius: 10px; padding: 14px 16px; border: 1px solid rgba(255,255,255,0.05); }
        .rp-summary-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; }
        .rp-summary-value { font-size: 24px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .rp-summary-sub { font-size: 11px; color: #6B7280; margin-top: 4px; }

        /* REPORT CARD */
        .rp-card { background: #1E2A3A; border-radius: 12px; padding: 0; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); cursor: pointer; transition: border-color 0.14s, background 0.14s; overflow: hidden; display: flex; }
        .rp-card:hover { border-color: rgba(255,255,255,0.12); background: #213040; }
        .rp-card.high-severity { background: #1A0F0F; border-color: rgba(248,113,113,0.2); }
        .rp-card.high-severity:hover { background: #1f1010; border-color: rgba(248,113,113,0.35); }
        .rp-card.dismissed-card { opacity: 0.5; }

        .rp-card-accent { width: 4px; flex-shrink: 0; }
        .rp-card-body { flex: 1; padding: 14px 16px; min-width: 0; }

        .rp-card-row1 { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
        .rp-card-reason { font-size: 14px; font-weight: 600; color: #E2E8F0; flex: 1; min-width: 0; }
        .rp-status-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; flex-shrink: 0; }

        .rp-card-row2 { display: flex; gap: 16px; margin-bottom: 6px; flex-wrap: wrap; }
        .rp-card-person { font-size: 12px; color: #9CA3AF; }
        .rp-card-person span { color: #6B7280; }

        .rp-card-addr { font-size: 11px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 6px; }

        .rp-card-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
        .rp-card-date { font-size: 11px; color: #6B7280; }
        .rp-card-view-hint { font-size: 11px; color: #4a9eff; opacity: 0.7; }

        .rp-severity-inline { font-size: 10px; color: #F87171; background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.18); border-radius: 5px; padding: 1px 7px; display: inline-block; margin-bottom: 6px; }

        .rp-comment-preview { font-size: 12px; color: #6B7280; font-style: italic; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .rp-empty { color: #6B7280; font-size: 14px; text-align: center; padding: 60px 0; }
        .rp-loading { color: #6B7280; text-align: center; padding: 60px; font-size: 14px; }

        /* MODAL */
        .rp-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(4px); padding: 20px; }
        .rp-modal { background: #1A2535; border-radius: 16px; width: 100%; max-width: 560px; max-height: 90vh; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 24px 64px rgba(0,0,0,0.6); }
        .rp-modal-header { padding: 20px 22px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; display: flex; align-items: flex-start; gap: 12px; }
        .rp-modal-header-left { flex: 1; min-width: 0; }
        .rp-modal-title { font-size: 16px; font-weight: 700; color: #F1F5F9; margin-bottom: 4px; }
        .rp-modal-subtitle { font-size: 12px; color: #6B7280; }
        .rp-modal-header-actions { display: flex; gap: 8px; flex-shrink: 0; }
        .rp-print-btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #9CA3AF; border-radius: 7px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .rp-print-btn:hover { background: rgba(255,255,255,0.09); color: #E2E8F0; }
        .rp-modal-close { background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #6B7280; border-radius: 7px; padding: 6px 10px; font-size: 16px; line-height: 1; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; }
        .rp-modal-close:hover { background: rgba(255,255,255,0.05); color: #9CA3AF; }

        .rp-modal-body { flex: 1; overflow-y: auto; padding: 0 22px 22px; }
        .rp-modal-body::-webkit-scrollbar { width: 4px; }
        .rp-modal-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .rp-modal-section { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin: 18px 0 8px; }
        .rp-detail-row { display: flex; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 12px; }
        .rp-detail-row:last-child { border-bottom: none; }
        .rp-detail-label { font-size: 12px; color: #6B7280; width: 120px; flex-shrink: 0; padding-top: 1px; }
        .rp-detail-value { font-size: 13px; color: #E2E8F0; flex: 1; }
        .rp-detail-value.muted { color: #6B7280; font-style: italic; }

        .rp-comment-block { background: rgba(255,255,255,0.03); border-left: 2px solid #2D3F52; border-radius: 0 6px 6px 0; padding: 10px 14px; font-size: 13px; color: #9CA3AF; font-style: italic; margin-top: 4px; }

        .rp-driver-history-note { display: inline-flex; align-items: center; gap: 5px; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.18); border-radius: 6px; padding: 3px 9px; font-size: 11px; color: #F87171; margin-top: 4px; }
        .rp-driver-history-ok { display: inline-flex; align-items: center; gap: 5px; background: rgba(29,158,117,0.08); border: 1px solid rgba(29,158,117,0.18); border-radius: 6px; padding: 3px 9px; font-size: 11px; color: #1D9E75; margin-top: 4px; }

        .rp-notes-label { font-size: 12px; color: #9CA3AF; margin-bottom: 8px; margin-top: 16px; }
        .rp-notes-textarea { width: 100%; background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #E2E8F0; font-family: system-ui, sans-serif; resize: vertical; min-height: 72px; outline: none; transition: border-color 0.15s; line-height: 1.5; }
        .rp-notes-textarea:focus { border-color: rgba(232,80,10,0.4); }
        .rp-notes-textarea::placeholder { color: #374151; }
        .rp-notes-display { background: rgba(29,158,117,0.05); border: 1px solid rgba(29,158,117,0.15); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: #9CA3AF; line-height: 1.5; margin-top: 6px; }

        .rp-modal-actions { display: flex; gap: 8px; padding: 14px 22px; border-top: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .rp-btn { padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; border: none; transition: opacity 0.12s, background 0.12s; white-space: nowrap; }
        .rp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .rp-btn-reviewed { background: rgba(29,158,117,0.12); color: #1D9E75; border: 1px solid rgba(29,158,117,0.25) !important; }
        .rp-btn-reviewed:hover:not(:disabled) { background: rgba(29,158,117,0.2); }
        .rp-btn-dismissed { background: rgba(255,255,255,0.05); color: #6B7280; border: 1px solid rgba(255,255,255,0.08) !important; }
        .rp-btn-dismissed:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: #9CA3AF; }
        .rp-btn-close { background: transparent; color: #6B7280; border: 1px solid rgba(255,255,255,0.08) !important; margin-left: auto; }
        .rp-btn-close:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
      `}</style>

      <div className="rp-wrap">
        {/* LEFT PANEL */}
        <div className="rp-panel">
          <div className="rp-panel-title">Filter</div>

          {(["all", "open", "reviewed", "dismissed"] as const).map((s) => {
            const count = s === "all" ? reports.length : reports.filter((r) => r.status === s).length;
            return (
              <button
                key={s}
                className={`rp-filter-btn${statusFilter === s ? " active" : ""}`}
                onClick={() => setStatusFilter(s)}
              >
                <span>{s === "all" ? "All reports" : STATUS_LABELS[s]}</span>
                <span className={`rp-filter-count${s === "open" && count > 0 ? " urgent" : ""}`}>
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
                <span className="rp-driver-btn-name">All drivers</span>
              </button>
              {driverOptions.map((d) => {
                const dCount = reports.filter((r) => r.driver_id === d.id).length;
                return (
                  <button
                    key={d.id}
                    className={`rp-driver-btn${driverFilter === d.id ? " active" : ""}`}
                    onClick={() => setDriverFilter(d.id)}
                    title={d.name}
                  >
                    <span className="rp-driver-btn-name">{d.name}</span>
                    {dCount > 1 && (
                      <span className="rp-driver-report-count">{dCount}</span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* CONTENT */}
        <div className="rp-content">
          <div className="rp-header">
            <div>
              <div className="rp-title">Driver Reports</div>
              <div className="rp-subtitle-text">
                {filtered.length} report{filtered.length !== 1 ? "s" : ""}
                {driverFilter !== "all" && ` · ${driverOptions.find((d) => d.id === driverFilter)?.name}`}
              </div>
            </div>
          </div>

          {/* Summary strip */}
          <div className="rp-summary">
            <div className="rp-summary-card">
              <div className="rp-summary-label">Open</div>
              <div className="rp-summary-value" style={{ color: openCount > 0 ? "#F59E0B" : "#F1F5F9" }}>
                {openCount}
              </div>
              {highOpen > 0 && (
                <div className="rp-summary-sub" style={{ color: "#F87171" }}>
                  {highOpen} high severity
                </div>
              )}
            </div>
            <div className="rp-summary-card">
              <div className="rp-summary-label">Reviewed</div>
              <div className="rp-summary-value" style={{ color: "#1D9E75" }}>{reviewedCount}</div>
            </div>
            <div className="rp-summary-card">
              <div className="rp-summary-label">Dismissed</div>
              <div className="rp-summary-value">{dismissedCount}</div>
            </div>
            <div className="rp-summary-card">
              <div className="rp-summary-label">Total</div>
              <div className="rp-summary-value">{reports.length}</div>
            </div>
          </div>

          {loading ? (
            <div className="rp-loading">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="rp-empty">
              {statusFilter === "open" ? "No open reports — all clear." : "No reports match these filters."}
            </div>
          ) : (
            filtered.map((r) => {
              const isHigh = HIGH_SEVERITY.has(r.reason);
              const accentColor = isHigh && r.status === "open"
                ? "#F87171"
                : STATUS_COLORS[r.status];
              return (
                <div
                  key={r.id}
                  className={`rp-card${isHigh && r.status === "open" ? " high-severity" : ""}${r.status === "dismissed" ? " dismissed-card" : ""}`}
                  onClick={() => setSelected(r)}
                >
                  <div className="rp-card-accent" style={{ background: accentColor + "60" }} />
                  <div className="rp-card-body">
                    {isHigh && r.status === "open" && (
                      <div className="rp-severity-inline">⚠ High severity</div>
                    )}
                    <div className="rp-card-row1">
                      <div className="rp-card-reason">{REASON_LABELS[r.reason] ?? r.reason}</div>
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

                    <div className="rp-card-row2">
                      <div className="rp-card-person">
                        <span>Driver: </span>{r.driver_name ?? "—"}
                      </div>
                      <div className="rp-card-person">
                        <span>Reported by: </span>{r.passenger_name ?? "—"}
                      </div>
                    </div>

                    {r.ride_pickup && (
                      <div className="rp-card-addr">
                        {r.ride_pickup} → {r.ride_dropoff}
                      </div>
                    )}

                    {r.comment && (
                      <div className="rp-comment-preview">"{r.comment}"</div>
                    )}

                    <div className="rp-card-footer">
                      <div className="rp-card-date">
                        {new Date(r.created_at).toLocaleDateString("en-CA", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                        {" · "}
                        {new Date(r.created_at).toLocaleTimeString("en-CA", {
                          hour: "numeric", minute: "2-digit",
                        })}
                      </div>
                      <div className="rp-card-view-hint">View details →</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* DETAIL MODAL */}
      {selected && (() => {
        const isHigh = HIGH_SEVERITY.has(selected.reason);
        const driverCount = reports.filter((r) => r.driver_id === selected.driver_id).length;
        const isOpen = selected.status === "open";
        return (
          <div className="rp-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
            <div className="rp-modal">
              {/* Header */}
              <div className="rp-modal-header">
                <div className="rp-modal-header-left">
                  <div className="rp-modal-title">{REASON_LABELS[selected.reason] ?? selected.reason}</div>
                  <div className="rp-modal-subtitle">
                    {new Date(selected.created_at).toLocaleDateString("en-CA", {
                      weekday: "short", month: "short", day: "numeric", year: "numeric",
                    })}
                    {" · "}
                    {new Date(selected.created_at).toLocaleTimeString("en-CA", {
                      hour: "numeric", minute: "2-digit",
                    })}
                    {" · "}
                    <span style={{ color: STATUS_COLORS[selected.status] }}>
                      {STATUS_LABELS[selected.status]}
                    </span>
                    {isHigh && (
                      <span style={{ color: "#F87171", marginLeft: 8 }}>⚠ High severity</span>
                    )}
                  </div>
                </div>
                <div className="rp-modal-header-actions">
                  <button className="rp-print-btn" onClick={() => printReport(selected)}>
                    ↓ Print
                  </button>
                  <button className="rp-modal-close" onClick={() => setSelected(null)}>×</button>
                </div>
              </div>

              {/* Body */}
              <div className="rp-modal-body">
                {/* Parties */}
                <div className="rp-modal-section">Parties</div>
                <div className="rp-detail-row">
                  <div className="rp-detail-label">Driver</div>
                  <div className="rp-detail-value">
                    <div style={{ fontWeight: 600 }}>{selected.driver_name ?? "—"}</div>
                    {driverCount > 1 ? (
                      <div className="rp-driver-history-note">
                        ⚠ {driverCount} total reports on file
                      </div>
                    ) : (
                      <div className="rp-driver-history-ok">
                        ✓ First report for this driver
                      </div>
                    )}
                  </div>
                </div>
                <div className="rp-detail-row">
                  <div className="rp-detail-label">Reported by</div>
                  <div className="rp-detail-value">{selected.passenger_name ?? "—"}</div>
                </div>

                {/* Incident */}
                <div className="rp-modal-section">Incident</div>
                <div className="rp-detail-row">
                  <div className="rp-detail-label">Reason</div>
                  <div className="rp-detail-value" style={{ fontWeight: 600 }}>
                    {REASON_LABELS[selected.reason] ?? selected.reason}
                  </div>
                </div>
                {selected.comment && (
                  <div className="rp-detail-row" style={{ flexDirection: "column", gap: 6 }}>
                    <div className="rp-detail-label">Passenger comment</div>
                    <div className="rp-comment-block">"{selected.comment}"</div>
                  </div>
                )}

                {/* Ride context */}
                {selected.ride_id && (
                  <>
                    <div className="rp-modal-section">Associated Ride</div>
                    {selected.ride_date && (
                      <div className="rp-detail-row">
                        <div className="rp-detail-label">Ride date</div>
                        <div className="rp-detail-value">
                          {new Date(selected.ride_date).toLocaleDateString("en-CA", {
                            weekday: "short", month: "short", day: "numeric", year: "numeric",
                          })}
                        </div>
                      </div>
                    )}
                    {selected.ride_pickup && (
                      <div className="rp-detail-row">
                        <div className="rp-detail-label">Pickup</div>
                        <div className="rp-detail-value">{selected.ride_pickup}</div>
                      </div>
                    )}
                    {selected.ride_dropoff && (
                      <div className="rp-detail-row">
                        <div className="rp-detail-label">Drop-off</div>
                        <div className="rp-detail-value">{selected.ride_dropoff}</div>
                      </div>
                    )}
                    {selected.ride_fare != null && (
                      <div className="rp-detail-row">
                        <div className="rp-detail-label">Fare</div>
                        <div className="rp-detail-value" style={{ fontWeight: 600, color: "#1D9E75" }}>
                          ${Number(selected.ride_fare).toFixed(2)}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Resolution */}
                <div className="rp-modal-section">Resolution</div>
                {isOpen ? (
                  <>
                    <div className="rp-notes-label">
                      Action notes <span style={{ color: "#4B5563" }}>(optional — appears on printed report)</span>
                    </div>
                    <textarea
                      ref={notesRef}
                      className="rp-notes-textarea"
                      placeholder="e.g. Warning issued to driver, counseling scheduled…"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </>
                ) : (
                  <div className="rp-detail-row" style={{ flexDirection: "column", gap: 6 }}>
                    <div className="rp-detail-label">Resolution notes</div>
                    {selected.resolution_notes ? (
                      <div className="rp-notes-display">{selected.resolution_notes}</div>
                    ) : (
                      <div className="rp-detail-value muted">No notes recorded.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer actions */}
              <div className="rp-modal-actions">
                {isOpen ? (
                  <>
                    <button
                      className="rp-btn rp-btn-reviewed"
                      disabled={updating}
                      onClick={() => updateStatus(selected.id, "reviewed")}
                    >
                      {updating ? "Saving…" : "✓ Mark reviewed"}
                    </button>
                    <button
                      className="rp-btn rp-btn-dismissed"
                      disabled={updating}
                      onClick={() => updateStatus(selected.id, "dismissed")}
                    >
                      Dismiss
                    </button>
                  </>
                ) : (
                  <span style={{ fontSize: 12, color: "#6B7280", alignSelf: "center" }}>
                    {selected.status === "reviewed" ? "✓ Marked reviewed" : "Dismissed"}
                  </span>
                )}
                <button className="rp-btn rp-btn-close" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
