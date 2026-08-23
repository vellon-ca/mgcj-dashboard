import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";

interface Props {
  companyId: string;
  adminId: string;
  isAdmin: boolean;
}

type Section = "pricing" | "vehicle_classes" | "support" | "team";

interface DispatchReport {
  id: string;
  admin_id: string;
  category: string;
  message: string;
  status: "open" | "resolved";
  created_at: string;
  admin_name: string | null;
}

const REPORT_CATEGORIES: { id: string; label: string }[] = [
  { id: "bug", label: "Bug / technical issue" },
  { id: "driver_issue", label: "Driver issue" },
  { id: "billing", label: "Payment / billing" },
  { id: "feature_request", label: "Feature request" },
  { id: "other", label: "Other" },
];
const REPORT_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  REPORT_CATEGORIES.map(c => [c.id, c.label])
);

interface StaffMember {
  id: string;
  name: string | null;
  phone: string | null;
  role: "admin" | "dispatcher";
  is_active: boolean;
  created_at: string;
}

export default function SettingsPage({ companyId, adminId, isAdmin }: Props) {
  const SECTIONS: { id: Section; label: string }[] = isAdmin
    ? [
        { id: "pricing", label: "Pricing" },
        { id: "vehicle_classes", label: "Vehicle Classes" },
        { id: "team", label: "Team" },
        { id: "support", label: "Support" },
      ]
    : [{ id: "support", label: "Support" }];

  const [section, setSection] = useState<Section>(isAdmin ? "pricing" : "support");

  // Pricing state
  const [baseFare, setBaseFare] = useState("");
  const [ratePerKm, setRatePerKm] = useState("");
  const [dispatchPhone, setDispatchPhone] = useState("");
  const [savedBaseFare, setSavedBaseFare] = useState("");
  const [savedRatePerKm, setSavedRatePerKm] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vehicle classes state
  interface VehicleClass { id: string; name: string; capacity: number; surcharge_percent: number; display_order: number; is_active: boolean; }
  const [vehicleClasses, setVehicleClasses] = useState<VehicleClass[]>([]);
  const [vcLoading, setVcLoading] = useState(true);
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCapacity, setEditCapacity] = useState('');
  const [editSurcharge, setEditSurcharge] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [addingClass, setAddingClass] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCapacity, setNewCapacity] = useState('');
  const [newSurcharge, setNewSurcharge] = useState('0');
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Support/report state
  const [reportCategory, setReportCategory] = useState(REPORT_CATEGORIES[0].id);
  const [reportMessage, setReportMessage] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [reports, setReports] = useState<DispatchReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);

  // Team state — admins manage dispatchers only; admin accounts are vendor-managed.
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [addingStaff, setAddingStaff] = useState(false);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffPhone, setNewStaffPhone] = useState('');
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffBusyId, setStaffBusyId] = useState<string | null>(null);
  // Dispatcher edit state
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [editStaffName, setEditStaffName] = useState('');
  const [editStaffPhone, setEditStaffPhone] = useState('');
  const [editStaffSaving, setEditStaffSaving] = useState(false);
  const [editStaffError, setEditStaffError] = useState<string | null>(null);

  useEffect(() => {
    fetchReports();
  }, [companyId]);

  useEffect(() => {
    if (isAdmin) fetchStaff();
  }, [companyId, isAdmin]);

  // background=true skips the loading flag so an optimistic patch isn't blanked
  // out by a "Loading…" flash when we reconcile after a write.
  async function fetchStaff(background = false) {
    if (!background) setStaffLoading(true);
    // `phone` cannot be selected here after 20260765 — it would fail the whole
    // query, not omit the column. profile_phones() re-checks entitlement per id
    // and answers for staff at your own company, which is exactly this list.
    const { data } = await supabase
      .from("profiles")
      .select("id, name, role, is_active, created_at")
      .eq("company_id", companyId)
      .in("role", ["admin", "dispatcher"])
      .order("created_at");
    const rows = data ?? [];
    const { data: phones, error: phoneError } = await supabase.rpc(
      "profile_phones",
      { p_profile_ids: rows.map((r: any) => r.id) },
    );
    if (phoneError) console.error("[fetchStaff] phone lookup failed:", phoneError);
    const phoneById = new Map<string, string>(
      ((phones ?? []) as any[]).filter((r) => r?.phone).map((r) => [r.id, r.phone]),
    );
    setStaff(
      rows.map((r: any) => ({ ...r, phone: phoneById.get(r.id) ?? "" })) as StaffMember[],
    );
    if (!background) setStaffLoading(false);
  }

  async function addStaff() {
    setStaffError(null);
    if (!newStaffName.trim()) { setStaffError("Name is required."); return; }
    if (!newStaffPhone.trim()) { setStaffError("Phone number is required."); return; }
    setStaffSaving(true);
    const { data, error: err } = await supabase.functions.invoke("create-staff-account", {
      body: { name: newStaffName.trim(), phone: newStaffPhone.trim() },
    });
    setStaffSaving(false);
    if (err || data?.error) { setStaffError(data?.error ?? err?.message ?? "Failed to create account."); return; }
    setAddingStaff(false);
    setNewStaffName(''); setNewStaffPhone('');
    fetchStaff(true);
  }

  function openEditStaff(member: StaffMember) {
    setEditingStaffId(member.id);
    setEditStaffName(member.name ?? '');
    setEditStaffPhone(member.phone ?? '');
    setEditStaffError(null);
  }

  async function saveStaffEdit() {
    if (!editingStaffId) return;
    setEditStaffError(null);
    if (!editStaffName.trim()) { setEditStaffError("Name is required."); return; }
    if (!editStaffPhone.trim()) { setEditStaffError("Phone number is required."); return; }
    setEditStaffSaving(true);
    const { data, error: err } = await supabase.functions.invoke("update-staff-account", {
      body: { staff_id: editingStaffId, name: editStaffName.trim(), phone: editStaffPhone.trim() },
    });
    setEditStaffSaving(false);
    if (err || data?.error) { setEditStaffError(data?.error ?? err?.message ?? "Failed to save changes."); return; }
    // Optimistic local patch so the edited name/phone shows immediately.
    const savedName = editStaffName.trim();
    const savedPhone = editStaffPhone.trim();
    setStaff(prev => prev.map(m => m.id === editingStaffId ? { ...m, name: savedName, phone: savedPhone } : m));
    // The update-staff-account edge function logs the staff.updated activity event
    // server-side (with before→after detail), so we deliberately don't log here.
    setEditingStaffId(null);
    fetchStaff(true);
  }

  async function toggleStaffActive(member: StaffMember) {
    // Dispatchers only — admin rows are read-only in the UI and blocked by RLS.
    setStaffBusyId(member.id);
    const nextActive = !member.is_active;
    const { data: updated, error: err } = await supabase
      .from("profiles")
      .update({ is_active: nextActive })
      .eq("id", member.id)
      .select("id, is_active");
    setStaffBusyId(null);
    if (err) { setStaffError(err.message); return; }
    if (!updated?.length) {
      setStaffError("No rows updated — you can only manage dispatchers at your own company.");
      return;
    }
    // Optimistic local patch so the badge flips immediately (same as the driver
    // list's patchDriverProfile), then reconcile with a background refetch.
    setStaff(prev => prev.map(m => m.id === member.id ? { ...m, is_active: nextActive } : m));
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: nextActive ? "staff.reactivated" : "staff.deactivated",
      details: { staff_id: member.id, name: member.name },
    });
    fetchStaff(true);
  }

  async function fetchReports() {
    setReportsLoading(true);
    const { data } = await supabase
      .from("dispatch_reports")
      .select("id, admin_id, category, message, status, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });
    const rows = data ?? [];
    const adminIds = [...new Set(rows.map(r => r.admin_id))];
    const { data: admins } = adminIds.length
      ? await supabase.from("profiles").select("id, name").in("id", adminIds)
      : { data: [] as { id: string; name: string | null }[] };
    const nameById = new Map((admins ?? []).map(a => [a.id, a.name]));
    setReports(rows.map(r => ({ ...r, admin_name: nameById.get(r.admin_id) ?? null })));
    setReportsLoading(false);
  }

  async function submitReport() {
    setReportError(null);
    setReportSent(false);
    if (!reportMessage.trim()) { setReportError("Please describe the problem."); return; }
    setReportSubmitting(true);
    const { error: err } = await supabase.from("dispatch_reports").insert({
      company_id: companyId,
      admin_id: adminId,
      category: reportCategory,
      message: reportMessage.trim(),
    });
    setReportSubmitting(false);
    if (err) { setReportError(err.message); return; }
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "dispatch_report.submitted",
      details: { category: reportCategory },
    });
    setReportMessage("");
    setReportSent(true);
    fetchReports();
  }

  useEffect(() => {
    supabase
      .from("companies")
      .select("base_fare, rate_per_km, phone")
      .eq("id", companyId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setBaseFare(String(data.base_fare ?? 4));
          setRatePerKm(String(data.rate_per_km ?? 1.8));
          setSavedBaseFare(String(data.base_fare ?? 4));
          setSavedRatePerKm(String(data.rate_per_km ?? 1.8));
          setDispatchPhone(data.phone ?? "");
        }
        setLoading(false);
      });
  }, [companyId]);

  useEffect(() => {
    fetchVehicleClasses();
  }, [companyId]);

  async function fetchVehicleClasses() {
    setVcLoading(true);
    const { data } = await supabase
      .from("vehicle_classes")
      .select("id, name, capacity, surcharge_percent, display_order, is_active")
      .eq("company_id", companyId)
      .order("display_order");
    setVehicleClasses(data ?? []);
    setVcLoading(false);
  }

  function openEditClass(vc: VehicleClass) {
    setEditingClassId(vc.id);
    setEditName(vc.name);
    setEditCapacity(String(vc.capacity));
    setEditSurcharge(String(vc.surcharge_percent));
    setEditError(null);
  }

  async function saveEditClass() {
    if (!editingClassId) return;
    const before = vehicleClasses.find(v => v.id === editingClassId);
    const cap = parseInt(editCapacity);
    const sur = parseFloat(editSurcharge);
    if (!editName.trim()) { setEditError("Name is required."); return; }
    if (isNaN(cap) || cap < 1) { setEditError("Capacity must be at least 1."); return; }
    if (isNaN(sur) || sur < 0) { setEditError("Surcharge must be 0 or greater."); return; }
    setEditSaving(true);
    const { error: err } = await supabase
      .from("vehicle_classes")
      .update({ name: editName.trim(), capacity: cap, surcharge_percent: sur })
      .eq("id", editingClassId);
    setEditSaving(false);
    if (err) { setEditError(err.message); return; }
    if (before) {
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: "settings.vehicle_class_updated",
        details: {
          name: editName.trim(),
          name_from: before.name,
          name_to: editName.trim(),
          capacity_from: before.capacity,
          capacity_to: cap,
          surcharge_percent_from: before.surcharge_percent,
          surcharge_percent_to: sur,
        },
      });
    }
    setEditingClassId(null);
    fetchVehicleClasses();
  }

  async function toggleClassActive(vc: VehicleClass) {
    await supabase.from("vehicle_classes").update({ is_active: !vc.is_active }).eq("id", vc.id);
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.vehicle_class_status_changed",
      details: { name: vc.name, is_active: !vc.is_active },
    });
    fetchVehicleClasses();
  }

  async function addVehicleClass() {
    const cap = parseInt(newCapacity);
    const sur = parseFloat(newSurcharge);
    if (!newName.trim()) { setAddError("Name is required."); return; }
    if (isNaN(cap) || cap < 1) { setAddError("Capacity must be at least 1."); return; }
    if (isNaN(sur) || sur < 0) { setAddError("Surcharge must be 0 or greater."); return; }
    setAddSaving(true);
    const nextOrder = Math.max(...vehicleClasses.map(v => v.display_order), -1) + 1;
    const { error: err } = await supabase.from("vehicle_classes").insert({
      company_id: companyId,
      name: newName.trim(),
      capacity: cap,
      surcharge_percent: sur,
      display_order: nextOrder,
      is_active: true,
    });
    setAddSaving(false);
    if (err) { setAddError(err.message); return; }
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.vehicle_class_created",
      details: { name: newName.trim(), capacity: cap, surcharge_percent: sur },
    });
    setAddingClass(false);
    setNewName(''); setNewCapacity(''); setNewSurcharge('0');
    fetchVehicleClasses();
  }

  async function save() {
    setError(null);
    setSaved(false);
    const base = parseFloat(baseFare);
    const rate = parseFloat(ratePerKm);
    if (isNaN(base) || base < 0) { setError("Base fare must be a valid number."); return; }
    if (isNaN(rate) || rate < 0) { setError("Rate per km must be a valid number."); return; }
    setSaving(true);
    const { error: err } = await supabase
      .from("companies")
      .update({
        base_fare: base,
        rate_per_km: rate,
        phone: dispatchPhone.trim() || null,
      })
      .eq("id", companyId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    setSaved(true);
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.pricing_updated",
      details: {
        base_fare_from: parseFloat(savedBaseFare),
        base_fare_to: base,
        rate_per_km_from: parseFloat(savedRatePerKm),
        rate_per_km_to: rate,
      },
    });
    setSavedBaseFare(String(base));
    setSavedRatePerKm(String(rate));
  }

  return (
    <>
      <style>{`
        .st-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .st-panel { width: 200px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .st-panel-title { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .st-section-btn { display: flex; align-items: center; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #6B7280; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .st-section-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .st-section-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .st-content { flex: 1; overflow-y: auto; padding: 24px 32px; background: #111827; }
        .st-content::-webkit-scrollbar { width: 4px; }
        .st-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .st-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 16px; }
        .st-title { font-size: 18px; font-weight: 700; color: #F1F5F9; margin-bottom: 4px; }
        .st-subtitle { font-size: 13px; color: #6B7280; line-height: 1.5; max-width: 480px; }

        .st-card { background: #1E2A3A; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.05); max-width: 520px; }
        .st-card-label { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 16px; }

        .st-field-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .st-field-row:last-of-type { margin-bottom: 0; }
        .st-field-text { display: flex; flex-direction: column; gap: 2px; }
        .st-field-label { font-size: 14px; font-weight: 600; color: #E2E8F0; }
        .st-field-hint { font-size: 12px; color: #6B7280; }
        .st-input-wrap { display: flex; align-items: center; background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        .st-prefix { padding: 0 10px; font-size: 13px; font-weight: 600; color: #6B7280; border-right: 1px solid rgba(255,255,255,0.08); height: 36px; display: flex; align-items: center; }
        .st-suffix { padding: 0 10px; font-size: 12px; color: #6B7280; border-left: 1px solid rgba(255,255,255,0.08); height: 36px; display: flex; align-items: center; }
        .st-input { width: 80px; background: none; border: none; outline: none; color: #F1F5F9; font-size: 14px; font-weight: 600; padding: 0 10px; height: 36px; font-family: system-ui, sans-serif; text-align: right; }

        .st-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 14px 0; }

        .st-save-btn { background: #E8500A; color: #fff; border: none; border-radius: 9px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, opacity 0.12s; white-space: nowrap; }
        .st-save-btn:hover:not(:disabled) { background: #D6470B; }
        .st-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .st-save-btn.st-saved { background: rgba(29,158,117,0.12); color: #1D9E75; }
        .st-error { font-size: 12px; color: #F87171; margin-top: 10px; }

        .vc-table { width: 100%; max-width: 620px; border-collapse: collapse; }
        .vc-th { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; padding: 0 12px 8px; text-align: left; }
        .vc-th.right { text-align: right; }
        .vc-row { background: #1E2A3A; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); }
        .vc-row + .vc-row { margin-top: 6px; }
        .vc-td { padding: 12px; font-size: 13px; color: #E2E8F0; vertical-align: middle; }
        .vc-td.muted { color: #6B7280; }
        .vc-td.right { text-align: right; }
        .vc-input { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; color: #F1F5F9; font-size: 13px; font-family: system-ui, sans-serif; padding: 5px 9px; outline: none; width: 100%; box-sizing: border-box; }
        .vc-input:focus { border-color: rgba(74,158,255,0.4); }
        .vc-input.narrow { width: 64px; }
        .vc-badge-active { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 20px; padding: 2px 9px; font-size: 11px; font-weight: 600; white-space: nowrap; }
        .vc-badge-inactive { background: rgba(107,114,128,0.1); color: #6B7280; border: 1px solid rgba(107,114,128,0.2); border-radius: 20px; padding: 2px 9px; font-size: 11px; font-weight: 600; white-space: nowrap; }
        .vc-btn { background: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #6B7280; font-size: 12px; font-weight: 600; padding: 4px 11px; cursor: pointer; font-family: system-ui, sans-serif; transition: color 0.12s, border-color 0.12s; white-space: nowrap; }
        .vc-btn:hover { color: #E2E8F0; border-color: rgba(255,255,255,0.2); }
        .vc-btn-save { background: #E8500A; color: #fff; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; padding: 5px 12px; cursor: pointer; font-family: system-ui, sans-serif; white-space: nowrap; }
        .vc-btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
        .vc-rate-preview { font-size: 12px; color: #4a9eff; font-weight: 600; }
        .vc-add-row { background: rgba(255,255,255,0.02); border: 1px dashed rgba(255,255,255,0.08); border-radius: 10px; padding: 14px; max-width: 620px; margin-top: 8px; }
        .vc-add-grid { display: grid; grid-template-columns: 1fr 80px 100px; gap: 10px; align-items: end; margin-bottom: 10px; }
        .vc-add-field { display: flex; flex-direction: column; gap: 4px; }
        .vc-add-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; }
        .vc-add-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .vc-add-cancel { background: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 7px; color: #6B7280; font-size: 12px; padding: 6px 12px; cursor: pointer; font-family: system-ui, sans-serif; }
        .vc-add-save { background: #E8500A; color: #fff; border: none; border-radius: 7px; font-size: 12px; font-weight: 600; padding: 6px 14px; cursor: pointer; font-family: system-ui, sans-serif; }
        .vc-add-save:disabled { opacity: 0.5; }
        .vc-add-class-btn { background: none; border: 1px dashed rgba(255,255,255,0.1); border-radius: 8px; color: #6B7280; font-size: 13px; padding: 9px 16px; cursor: pointer; font-family: system-ui, sans-serif; display: flex; align-items: center; gap: 6px; margin-top: 8px; transition: color 0.12s; max-width: 620px; width: 100%; }
        .vc-add-class-btn:hover { color: #E2E8F0; border-color: rgba(255,255,255,0.2); }
        .vc-error { font-size: 12px; color: #F87171; margin-top: 6px; }

        .st-select { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #F1F5F9; font-size: 13px; font-family: system-ui, sans-serif; padding: 9px 10px; outline: none; width: 100%; box-sizing: border-box; margin-bottom: 14px; }
        .st-textarea { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #F1F5F9; font-size: 13px; font-family: system-ui, sans-serif; padding: 10px; outline: none; width: 100%; box-sizing: border-box; min-height: 100px; resize: vertical; }
        .rp-table { width: 100%; max-width: 720px; border-collapse: collapse; margin-top: 8px; }
        .rp-row { background: #1E2A3A; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); }
        .rp-row + .rp-row { margin-top: 6px; }
        .rp-td { padding: 12px; font-size: 13px; color: #E2E8F0; vertical-align: top; }
        .rp-td.muted { color: #6B7280; font-size: 12px; white-space: nowrap; }
        .rp-cat { font-size: 11px; font-weight: 600; color: #E8500A; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 3px; }
        .rp-msg { font-size: 13px; color: #E2E8F0; white-space: pre-wrap; }
        .rp-badge-open { background: rgba(74,158,255,0.1); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 20px; padding: 2px 9px; font-size: 11px; font-weight: 600; white-space: nowrap; }
        .rp-badge-resolved { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 20px; padding: 2px 9px; font-size: 11px; font-weight: 600; white-space: nowrap; }

        .tm-table { width: 100%; max-width: 620px; border-collapse: collapse; }
        .tm-row { background: #1E2A3A; border-radius: 10px; border: 1px solid rgba(255,255,255,0.05); }
        .tm-row + .tm-row { margin-top: 6px; }
        .tm-td { padding: 12px; font-size: 13px; color: #E2E8F0; vertical-align: middle; }
        .tm-td.muted { color: #6B7280; font-size: 12px; }
        .tm-badge-role { background: rgba(74,158,255,0.1); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 20px; padding: 2px 9px; font-size: 11px; font-weight: 600; text-transform: capitalize; white-space: nowrap; }
      `}</style>

      <div className="st-wrap">
        <div className="st-panel">
          <p className="st-panel-title">Settings</p>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`st-section-btn${section === s.id ? " active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="st-content">
          {section === "vehicle_classes" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">Vehicle Classes</div>
                  <div className="st-subtitle">
                    Define the vehicle types your fleet offers. Passengers choose a class at booking; the surcharge is applied on top of your base rate per km.
                  </div>
                </div>
              </div>

              {vcLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>Loading…</div>
              ) : (
                <>
                  <table className="vc-table" style={{ marginBottom: 4 }}>
                    <thead>
                      <tr>
                        <th className="vc-th">Class</th>
                        <th className="vc-th">Seats</th>
                        <th className="vc-th">Surcharge</th>
                        <th className="vc-th">Effective rate /km</th>
                        <th className="vc-th">Status</th>
                        <th className="vc-th" />
                      </tr>
                    </thead>
                    <tbody>
                      {vehicleClasses.map((vc) => {
                        const baseRate = parseFloat(savedRatePerKm) || 0;
                        const effectiveRate = baseRate * (1 + vc.surcharge_percent / 100);
                        const isEditing = editingClassId === vc.id;
                        const editSurchargeNum = parseFloat(editSurcharge) || 0;
                        const previewRate = baseRate * (1 + editSurchargeNum / 100);
                        return (
                          <tr key={vc.id} className="vc-row">
                            <td className="vc-td" style={{ minWidth: 120 }}>
                              {isEditing
                                ? <input className="vc-input" value={editName} onChange={e => setEditName(e.target.value)} />
                                : <strong>{vc.name}</strong>}
                            </td>
                            <td className="vc-td">
                              {isEditing
                                ? <input className="vc-input narrow" type="number" min="1" value={editCapacity} onChange={e => setEditCapacity(e.target.value)} />
                                : vc.capacity}
                            </td>
                            <td className="vc-td">
                              {isEditing ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <input className="vc-input narrow" type="number" min="0" step="0.5" value={editSurcharge} onChange={e => setEditSurcharge(e.target.value)} />
                                  <span style={{ color: '#6B7280', fontSize: 12 }}>%</span>
                                </div>
                              ) : (
                                `+${vc.surcharge_percent}%`
                              )}
                            </td>
                            <td className="vc-td">
                              {isEditing
                                ? <span className="vc-rate-preview">${previewRate.toFixed(2)}/km</span>
                                : <span className={vc.is_active ? "vc-rate-preview" : "vc-td muted"}>${effectiveRate.toFixed(2)}/km</span>}
                            </td>
                            <td className="vc-td">
                              <span className={vc.is_active ? "vc-badge-active" : "vc-badge-inactive"}>
                                {vc.is_active ? "Active" : "Inactive"}
                              </span>
                            </td>
                            <td className="vc-td right" style={{ whiteSpace: 'nowrap' }}>
                              {isEditing ? (
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                  <button className="vc-btn" onClick={() => { setEditingClassId(null); setEditError(null); }}>Cancel</button>
                                  <button className="vc-btn-save" onClick={saveEditClass} disabled={editSaving}>{editSaving ? '…' : 'Save'}</button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                  <button className="vc-btn" onClick={() => openEditClass(vc)}>Edit</button>
                                  {vehicleClasses.length > 1 && (
                                    <button className="vc-btn" onClick={() => toggleClassActive(vc)}>
                                      {vc.is_active ? 'Deactivate' : 'Activate'}
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {editError && <div className="vc-error">{editError}</div>}

                  {addingClass ? (
                    <div className="vc-add-row">
                      <div className="vc-add-grid">
                        <div className="vc-add-field">
                          <div className="vc-add-label">Class name</div>
                          <input className="vc-input" placeholder="e.g. SUV" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
                        </div>
                        <div className="vc-add-field">
                          <div className="vc-add-label">Seats</div>
                          <input className="vc-input" type="number" min="1" placeholder="5" value={newCapacity} onChange={e => setNewCapacity(e.target.value)} />
                        </div>
                        <div className="vc-add-field">
                          <div className="vc-add-label">Surcharge %</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input className="vc-input" type="number" min="0" step="0.5" placeholder="0" value={newSurcharge} onChange={e => setNewSurcharge(e.target.value)} />
                            <span style={{ color: '#6B7280', fontSize: 12, flexShrink: 0 }}>%</span>
                          </div>
                        </div>
                      </div>
                      {newSurcharge && !isNaN(parseFloat(newSurcharge)) && (
                        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 10 }}>
                          Effective rate: <span className="vc-rate-preview">${((parseFloat(savedRatePerKm) || 0) * (1 + parseFloat(newSurcharge) / 100)).toFixed(2)}/km</span>
                        </div>
                      )}
                      {addError && <div className="vc-error">{addError}</div>}
                      <div className="vc-add-actions">
                        <button className="vc-add-cancel" onClick={() => { setAddingClass(false); setNewName(''); setNewCapacity(''); setNewSurcharge('0'); setAddError(null); }}>Cancel</button>
                        <button className="vc-add-save" onClick={addVehicleClass} disabled={addSaving}>{addSaving ? 'Saving…' : 'Add class'}</button>
                      </div>
                    </div>
                  ) : (
                    <button className="vc-add-class-btn" onClick={() => setAddingClass(true)}>
                      <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add vehicle class
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {section === "pricing" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">Pricing</div>
                  <div className="st-subtitle">
                    Fare estimates shown to passengers: <strong style={{ color: "#E2E8F0" }}>base fare + (km × rate)</strong>
                  </div>
                </div>
                <button
                  className={`st-save-btn${saved ? " st-saved" : ""}`}
                  onClick={save}
                  disabled={saving || loading}
                >
                  {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
                </button>
              </div>

              {loading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>Loading…</div>
              ) : (
                <div className="st-card">
                  <p className="st-card-label">Fare formula</p>

                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">Base fare</span>
                      <span className="st-field-hint">Flat fee at the start of every ride</span>
                    </div>
                    <div className="st-input-wrap">
                      <span className="st-prefix">$</span>
                      <input
                        className="st-input"
                        type="number"
                        min="0"
                        step="0.25"
                        value={baseFare}
                        onChange={e => { setBaseFare(e.target.value); setSaved(false); }}
                      />
                    </div>
                  </div>

                  <div className="st-divider" />

                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">Rate per km</span>
                      <span className="st-field-hint">Applied to the routed distance</span>
                    </div>
                    <div className="st-input-wrap">
                      <span className="st-prefix">$</span>
                      <input
                        className="st-input"
                        type="number"
                        min="0"
                        step="0.05"
                        value={ratePerKm}
                        onChange={e => { setRatePerKm(e.target.value); setSaved(false); }}
                      />
                      <span className="st-suffix">/km</span>
                    </div>
                  </div>

                  {error && <p className="st-error">{error}</p>}
                </div>
              )}

              {/* Reached by a passenger escalating a live ride ("Something's
                  wrong with this ride" → "Call dispatch"). Left blank, the app
                  shows the flag on its own with no call option, which is a
                  working but weaker experience — so this is worth filling in
                  at onboarding. */}
              {!loading && (
                <div className="st-card">
                  <p className="st-card-label">Dispatch contact</p>
                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">Phone number</span>
                      <span className="st-field-hint">
                        Shown to passengers who flag a problem during a ride
                      </span>
                    </div>
                    <div className="st-input-wrap">
                      <input
                        className="st-input"
                        style={{ width: 150, textAlign: "left" }}
                        type="tel"
                        placeholder="902-555-0100"
                        value={dispatchPhone}
                        onChange={e => { setDispatchPhone(e.target.value); setSaved(false); }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {section === "team" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">Team</div>
                  <div className="st-subtitle">
                    Add and manage dispatchers, who handle day-to-day ride ops. Admin accounts (pricing, discounts, staff) are managed by Vellon — contact us to add or change one.
                  </div>
                </div>
              </div>

              {staffLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>Loading…</div>
              ) : (
                <table className="tm-table" style={{ marginBottom: 4 }}>
                  <tbody>
                    {staff.map(member => {
                      const isAdminRow = member.role === "admin";
                      const isEditing = editingStaffId === member.id;
                      if (isEditing) {
                        return (
                          <tr key={member.id} className="tm-row">
                            <td className="tm-td" colSpan={5}>
                              <div className="vc-add-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 10 }}>
                                <div className="vc-add-field">
                                  <div className="vc-add-label">Name</div>
                                  <input className="vc-input" value={editStaffName} onChange={e => setEditStaffName(e.target.value)} autoFocus />
                                </div>
                                <div className="vc-add-field">
                                  <div className="vc-add-label">Phone</div>
                                  <input className="vc-input" value={editStaffPhone} onChange={e => setEditStaffPhone(e.target.value)} />
                                </div>
                              </div>
                              {editStaffError && <div className="vc-error" style={{ marginBottom: 8 }}>{editStaffError}</div>}
                              <div className="vc-add-actions">
                                <button className="vc-add-cancel" onClick={() => { setEditingStaffId(null); setEditStaffError(null); }}>Cancel</button>
                                <button className="vc-add-save" onClick={saveStaffEdit} disabled={editStaffSaving}>{editStaffSaving ? 'Saving…' : 'Save'}</button>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      return (
                        <tr key={member.id} className="tm-row">
                          <td className="tm-td" style={{ minWidth: 140 }}>
                            <strong>{member.name ?? "Unnamed"}</strong>
                            {member.id === adminId && <span className="tm-td muted"> (you)</span>}
                          </td>
                          <td className="tm-td muted">{member.phone}</td>
                          <td className="tm-td">
                            <span className="tm-badge-role">{member.role}</span>
                          </td>
                          <td className="tm-td">
                            <span className={member.is_active ? "vc-badge-active" : "vc-badge-inactive"}>
                              {member.is_active ? "Active" : "Deactivated"}
                            </span>
                          </td>
                          <td className="tm-td right" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {isAdminRow ? (
                              <span className="tm-td muted" style={{ fontSize: 11 }}>Managed by Vellon</span>
                            ) : (
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button className="vc-btn" onClick={() => openEditStaff(member)}>Edit</button>
                                <button
                                  className="vc-btn"
                                  onClick={() => toggleStaffActive(member)}
                                  disabled={staffBusyId === member.id}
                                >
                                  {staffBusyId === member.id ? '…' : member.is_active ? 'Deactivate' : 'Reactivate'}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {addingStaff ? (
                <div className="vc-add-row">
                  <div className="vc-add-field" style={{ marginBottom: 10 }}>
                    <div className="vc-add-label">Name</div>
                    <input className="vc-input" placeholder="Full name" value={newStaffName} onChange={e => setNewStaffName(e.target.value)} autoFocus />
                  </div>
                  <div className="vc-add-field" style={{ marginBottom: 10 }}>
                    <div className="vc-add-label">Phone</div>
                    <input className="vc-input" placeholder="(902) 555-0100" value={newStaffPhone} onChange={e => setNewStaffPhone(e.target.value)} />
                  </div>
                  {staffError && <div className="vc-error">{staffError}</div>}
                  <div className="vc-add-actions">
                    <button className="vc-add-cancel" onClick={() => { setAddingStaff(false); setNewStaffName(''); setNewStaffPhone(''); setStaffError(null); }}>Cancel</button>
                    <button className="vc-add-save" onClick={addStaff} disabled={staffSaving}>{staffSaving ? 'Adding…' : 'Add dispatcher'}</button>
                  </div>
                </div>
              ) : (
                <button className="vc-add-class-btn" onClick={() => setAddingStaff(true)}>
                  <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add dispatcher
                </button>
              )}
            </>
          )}

          {section === "support" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">Support</div>
                  <div className="st-subtitle">
                    Report a bug, a driver issue, or anything else — this goes straight to the Vellon team.
                  </div>
                </div>
              </div>

              <div className="st-card">
                <p className="st-card-label">New report</p>

                <select
                  className="st-select"
                  value={reportCategory}
                  onChange={e => setReportCategory(e.target.value)}
                >
                  {REPORT_CATEGORIES.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>

                <textarea
                  className="st-textarea"
                  placeholder="Describe the problem…"
                  value={reportMessage}
                  onChange={e => { setReportMessage(e.target.value); setReportSent(false); }}
                />

                {reportError && <p className="st-error">{reportError}</p>}

                <div style={{ marginTop: 14 }}>
                  <button
                    className={`st-save-btn${reportSent ? " st-saved" : ""}`}
                    onClick={submitReport}
                    disabled={reportSubmitting}
                  >
                    {reportSubmitting ? "Sending…" : reportSent ? "Sent ✓" : "Send report"}
                  </button>
                </div>
              </div>

              <p className="st-card-label" style={{ marginTop: 24 }}>Company reports</p>
              {reportsLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>Loading…</div>
              ) : reports.length === 0 ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>No reports yet.</div>
              ) : (
                <table className="rp-table">
                  <tbody>
                    {reports.map(r => (
                      <tr key={r.id} className="rp-row">
                        <td className="rp-td" style={{ width: "60%" }}>
                          <div className="rp-cat">{REPORT_CATEGORY_LABELS[r.category] ?? r.category}</div>
                          <div className="rp-msg">{r.message}</div>
                        </td>
                        <td className="rp-td muted">{r.admin_name ?? "Unknown"}</td>
                        <td className="rp-td muted">{new Date(r.created_at).toLocaleDateString()}</td>
                        <td className="rp-td">
                          <span className={r.status === "resolved" ? "rp-badge-resolved" : "rp-badge-open"}>
                            {r.status === "resolved" ? "Resolved" : "Open"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
