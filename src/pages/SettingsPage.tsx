import { useState, useEffect, useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import { fmtDate } from "../i18n/format";
import { useLocale } from "../i18n/LocaleContext";
import { useSubView } from "../lib/viewPath";
import { supabase } from "../lib/supabase";
import { invokeFunction } from "../lib/invokeFunction";
import { logDispatchEvent } from "../lib/logDispatchEvent";
import ServiceAreasSection from "../components/ServiceAreasSection";

interface Props {
  companyId: string;
  adminId: string;
  isAdmin: boolean;
}

type Section =
  | "pricing"
  | "contact"
  | "vehicle_classes"
  | "service_areas"
  | "numbering"
  | "language"
  | "support"
  | "team";

interface DispatchReport {
  id: string;
  admin_id: string;
  category: string;
  message: string;
  status: "open" | "resolved";
  created_at: string;
  admin_name: string | null;
}

// `labelKey`, not `label`. This array is module scope, so it is evaluated
// before any language is active — storing English here would freeze it, and
// storing a t() call would resolve against whatever locale happened to boot.
// The convention of putting KEYS in these maps is also what keeps them
// greppable: check-i18n.mjs can only see literal t("…") calls, so a dynamic
// t(c.labelKey) is invisible to it and the key has to be findable by eye.
const REPORT_CATEGORIES: { id: string; labelKey: string }[] = [
  { id: "bug", labelKey: "settings.reportCategory.bug" },
  { id: "driver_issue", labelKey: "settings.reportCategory.driverIssue" },
  { id: "billing", labelKey: "settings.reportCategory.billing" },
  { id: "feature_request", labelKey: "settings.reportCategory.featureRequest" },
  { id: "other", labelKey: "settings.reportCategory.other" },
];
const REPORT_CATEGORY_KEYS: Record<string, string> = Object.fromEntries(
  REPORT_CATEGORIES.map(c => [c.id, c.labelKey])
);

interface StaffMember {
  id: string;
  name: string | null;
  // Legacy contact only. Email is the staff credential as of 2026-09-26; a
  // number here is what an older account used to sign in with and is now just
  // a way to reach them. Nothing writes it any more.
  phone: string | null;
  email: string | null;
  role: "admin" | "dispatcher";
  is_active: boolean;
  created_at: string;
}

// The icons an admin may choose, stored as a slug in `vehicle_classes.icon`.
//
// THE SLUGS MUST MATCH `CLASS_ICONS` in mgcj-app's PassengerHomeScreen, which
// is what actually renders them to passengers. The emoji here are previews
// only — this repo has no icon library (checked: no react-icons, no lucide),
// and the picker's job is to let an admin recognise the choice, not to render
// the final artwork.
//
// Stored explicitly rather than derived from the class NAME, which is what the
// app used to do: keying an icon off `name.toLowerCase()` silently punished the
// free naming the column allows, so "Family Van" or "Big" got a generic sedan.
// NO WHEELCHAIR ICON HERE, deliberately (Victor, 2026-10-06). Offering one
// invites a company to build an "Accessible" vehicle class — and a class
// carries `surcharge_percent`, so the obvious next step is putting a number on
// it. Charging extra for accessible service is a discrimination exposure under
// the NS Human Rights Act and is commonly barred outright by municipal taxi
// bylaws, which is exactly why accessibility was modelled as a per-vehicle
// attribute with no price field at all (20261005010000). An icon is a small
// thing, but it is the doorway to the wrong model, so the doorway is closed.
//
// `wheelchair` stays in mgcj-app's render map so any class that somehow carries
// the slug still draws correctly — removing it from the PICKER stops it being
// chosen, which is the part that matters.
//
// `label` is a translation key, not prose: these are shown to dispatchers and
// this app ships en + fr.
const CLASS_ICON_CHOICES: { slug: string; emoji: string; label: string }[] = [
  { slug: "sedan",  emoji: "\u{1F697}",          label: "settings.vcIconSedan" },
  { slug: "van",    emoji: "\u{1F690}",          label: "settings.vcIconVan" },
  { slug: "suv",    emoji: "\u{1F699}",          label: "settings.vcIconSuv" },
  { slug: "luxury", emoji: "\u{1F3CE}\u{FE0F}", label: "settings.vcIconLuxury" },
  { slug: "truck",  emoji: "\u{1F6FB}",          label: "settings.vcIconTruck" },
  { slug: "bus",    emoji: "\u{1F68C}",          label: "settings.vcIconBus" },
];

function iconEmoji(slug: string | null): string {
  // Falls back to the sedan rather than to nothing: a class created before
  // `icon` existed, or carrying the retired wheelchair slug, still shows a car.
  return CLASS_ICON_CHOICES.find(c => c.slug === slug)?.emoji ?? "\u{1F697}";
}

export default function SettingsPage({ companyId, adminId, isAdmin }: Props) {
  const { t } = useTranslation();
  const { localeMode, setLocaleMode, available } = useLocale();
  const SECTIONS: { id: Section; label: string }[] = isAdmin
    ? [
        { id: "pricing", label: t("settings.sections.pricing") },
        { id: "contact", label: t("settings.sections.contact") },
        { id: "vehicle_classes", label: t("settings.sections.vehicleClasses") },
        { id: "service_areas", label: t("settings.sections.serviceAreas") },
        { id: "numbering", label: t("settings.sections.numbering") },
        { id: "language", label: t("language.title") },
        { id: "team", label: t("settings.sections.team") },
        { id: "support", label: t("settings.sections.support") },
      ]
    : [
        { id: "language", label: t("language.title") },
        { id: "support", label: t("settings.sections.support") },
      ];

  // Bound to /settings/<section>. The allowed list is the role-filtered one, so
  // a dispatcher who deep-links /settings/pricing lands on Support rather than
  // rendering an admin pane the nav never offered them.
  const SECTION_IDS = useMemo(() => SECTIONS.map(s => s.id), [isAdmin]);
  const [section, setSection] = useSubView<Section>(
    "settings",
    SECTION_IDS,
    isAdmin ? "pricing" : "support",
  );

  // Pricing state
  const [baseFare, setBaseFare] = useState("");
  const [ratePerKm, setRatePerKm] = useState("");
  // Contact state — its own save flags, mirroring Numbering. Sharing Pricing's
  // `saved`/`saving` would light up the wrong button in the wrong pane.
  const [dispatchPhone, setDispatchPhone] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [contactSaving, setContactSaving] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [savedBaseFare, setSavedBaseFare] = useState("");
  const [savedRatePerKm, setSavedRatePerKm] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Numbering state (20260775_fleet_numbering.sql).
  // Three fields per entity, deliberately not a format string: a mini-language
  // is something dispatch gets wrong and support then owns forever. Cars and
  // drivers are configured separately because bare numbers for cars and "D-"
  // for drivers is the common case.
  const [carPrefix, setCarPrefix] = useState("");
  const [carPad, setCarPad] = useState("0");
  const [carStart, setCarStart] = useState("1");
  const [driverPrefix, setDriverPrefix] = useState("");
  const [driverPad, setDriverPad] = useState("0");
  const [numSaving, setNumSaving] = useState(false);
  const [numSaved, setNumSaved] = useState(false);
  const [numError, setNumError] = useState<string | null>(null);

  // Vehicle classes state
  // `capacity` is the MINIMUM SEATS a vehicle needs to serve this class, and
  // the figure shown to passengers — one number for both, so the booking card
  // cannot promise seven while matching demands five. `restricted` means
  // membership is granted by dispatch rather than earned by size. See migration
  // 20261005010000.
  interface VehicleClass { id: string; name: string; capacity: number; surcharge_percent: number; display_order: number; is_active: boolean; restricted: boolean; icon: string | null; }
  const [vehicleClasses, setVehicleClasses] = useState<VehicleClass[]>([]);
  const [editRestricted, setEditRestricted] = useState(false);
  const [editIcon, setEditIcon] = useState<string>("sedan");
  const [newRestricted, setNewRestricted] = useState(false);
  const [newIcon, setNewIcon] = useState<string>("sedan");
  const fleetSizes = useMemo(
    () => [...new Set(vehicleClasses.filter(v => v.is_active).map(v => v.capacity))]
            .sort((a, b) => a - b),
    [vehicleClasses],
  );
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
  const [newStaffEmail, setNewStaffEmail] = useState('');
  const [staffSaving, setStaffSaving] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffBusyId, setStaffBusyId] = useState<string | null>(null);
  // Dispatcher edit state
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [editStaffName, setEditStaffName] = useState('');
  const [editStaffEmail, setEditStaffEmail] = useState('');
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
    // `email` is withheld from authenticated exactly like `phone` is, so it
    // cannot be added to the select above — it would read EMPTY rather than
    // fail. staff_emails() is its definer accessor (20260926000000).
    const { data: emails, error: emailError } = await supabase.rpc(
      "staff_emails",
      { p_profile_ids: rows.map((r: any) => r.id) },
    );
    if (emailError) console.error("[fetchStaff] email lookup failed:", emailError);
    const emailById = new Map<string, string>(
      ((emails ?? []) as any[]).filter((r) => r?.email).map((r) => [r.id, r.email]),
    );
    setStaff(
      rows.map((r: any) => ({
        ...r,
        phone: phoneById.get(r.id) ?? "",
        email: emailById.get(r.id) ?? "",
      })) as StaffMember[],
    );
    if (!background) setStaffLoading(false);
  }

  async function addStaff() {
    setStaffError(null);
    if (!newStaffName.trim()) { setStaffError(t("settings.errNameRequired")); return; }
    if (!newStaffEmail.trim()) { setStaffError(t("settings.errEmailRequired")); return; }
    setStaffSaving(true);
    // invokeFunction, not supabase.functions.invoke: a non-2xx RESOLVES INTO A
    // THROW with `data: null`, so reading `err.message` shows the dispatcher
    // "Edge Function returned a non-2xx status code" while the reason the server
    // actually sent -- "A user with this email address already exists",
    // "Forbidden -- admin only" -- sits unread in `err.context`.
    const { error: err } = await invokeFunction("create-staff-account", {
      name: newStaffName.trim(), email: newStaffEmail.trim(),
    }, t("settings.errCreateFailed"));
    setStaffSaving(false);
    if (err) { setStaffError(err); return; }
    setAddingStaff(false);
    setNewStaffName(''); setNewStaffEmail('');
    fetchStaff(true);
  }

  function openEditStaff(member: StaffMember) {
    setEditingStaffId(member.id);
    setEditStaffName(member.name ?? '');
    setEditStaffEmail(member.email ?? '');
    setEditStaffError(null);
  }

  async function saveStaffEdit() {
    if (!editingStaffId) return;
    setEditStaffError(null);
    if (!editStaffName.trim()) { setEditStaffError(t("settings.errNameRequired")); return; }
    if (!editStaffEmail.trim()) { setEditStaffError(t("settings.errEmailRequired")); return; }
    setEditStaffSaving(true);
    // Same reason as addStaff above -- the server's message lives in err.context.
    const { error: err } = await invokeFunction("update-staff-account", {
      staff_id: editingStaffId, name: editStaffName.trim(), email: editStaffEmail.trim(),
    }, t("settings.errSaveFailed"));
    setEditStaffSaving(false);
    if (err) { setEditStaffError(err); return; }
    // Optimistic local patch so the edited name/phone shows immediately.
    const savedName = editStaffName.trim();
    const savedEmail = editStaffEmail.trim().toLowerCase();
    setStaff(prev => prev.map(m => m.id === editingStaffId ? { ...m, name: savedName, email: savedEmail } : m));
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
      setStaffError(t("settings.errNoRowsUpdated"));
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
    if (!reportMessage.trim()) { setReportError(t("settings.errDescribeProblem")); return; }
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
      .select("base_fare, rate_per_km, phone, support_email, car_number_prefix, car_number_pad, car_number_start, driver_number_prefix, driver_number_pad")
      .eq("id", companyId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setBaseFare(String(data.base_fare ?? 4));
          setRatePerKm(String(data.rate_per_km ?? 1.8));
          setSavedBaseFare(String(data.base_fare ?? 4));
          setSavedRatePerKm(String(data.rate_per_km ?? 1.8));
          setDispatchPhone(data.phone ?? "");
          setSupportEmail(data.support_email ?? "");
          setCarPrefix(data.car_number_prefix ?? "");
          setCarPad(String(data.car_number_pad ?? 0));
          setCarStart(String(data.car_number_start ?? 1));
          setDriverPrefix(data.driver_number_prefix ?? "");
          setDriverPad(String(data.driver_number_pad ?? 0));
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
      .select("id, name, capacity, surcharge_percent, display_order, is_active, restricted, icon")
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
    setEditRestricted(vc.restricted);
    setEditIcon(vc.icon ?? "sedan");
    setEditError(null);
  }

  async function saveEditClass() {
    if (!editingClassId) return;
    const before = vehicleClasses.find(v => v.id === editingClassId);
    if (!before) return;
    const cap = parseInt(editCapacity);
    const sur = parseFloat(editSurcharge);
    if (!editName.trim()) { setEditError(t("settings.errNameRequired")); return; }
    if (isNaN(cap) || cap < 1) { setEditError(t("settings.errCapacityMin")); return; }
    if (isNaN(sur) || sur < 0) { setEditError(t("settings.errSurchargeMin")); return; }
    // ── Warn before silently shrinking who can serve this class ────────────
    //
    // Both of these are one-click ways to make a class unservable, with nothing
    // on screen explaining why afterwards: rides already booked on it go
    // `uncovered` and assign-ride returns `no_drivers`. That is the same shape
    // as the deactivate-a-class bug this whole change fixes, so it would be
    // careless to close one door and leave the other open.
    //
    // Counted against the live table rather than any local state: `drivers` is
    // not loaded on this page, and a stale count is worse than no count when
    // the whole point is to say how many people are affected.
    const turningRestricted = editRestricted && !before.restricted;
    const raisingCapacity = cap > before.capacity;
    if (turningRestricted || raisingCapacity) {
      // Who serves it TODAY and would stop: everyone meeting the old floor
      // who either fails the new floor, or loses it to explicit membership.
      // The migration nulled every `vehicle_class_id`, so a newly restricted
      // class starts with nobody admitted — the count is the full set.
      let q = supabase
        .from("drivers")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .gte("seats", before.capacity);
      if (raisingCapacity && !turningRestricted) q = q.lt("seats", cap);
      const { count } = await q;
      if (count && count > 0) {
        const reason = turningRestricted
          ? t("settings.vcWarnRestricted", { count })
          : t("settings.vcWarnCapacity", { count, seats: cap });
        if (!confirm(t("settings.vcWarnConfirm", { reason }))) return;
      }
    }

    setEditSaving(true);
    const { error: err } = await supabase
      .from("vehicle_classes")
      .update({
        name: editName.trim(),
        capacity: cap,
        surcharge_percent: sur,
        restricted: editRestricted,
        icon: editIcon,
      })
      .eq("id", editingClassId);
    setEditSaving(false);
    if (err) { setEditError(err.message); return; }
    {
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
          restricted_from: before.restricted,
          restricted_to: editRestricted,
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
    if (!newName.trim()) { setAddError(t("settings.errNameRequired")); return; }
    if (isNaN(cap) || cap < 1) { setAddError(t("settings.errCapacityMin")); return; }
    if (isNaN(sur) || sur < 0) { setAddError(t("settings.errSurchargeMin")); return; }
    setAddSaving(true);
    const nextOrder = Math.max(...vehicleClasses.map(v => v.display_order), -1) + 1;
    const { error: err } = await supabase.from("vehicle_classes").insert({
      company_id: companyId,
      name: newName.trim(),
      capacity: cap,
      surcharge_percent: sur,
      display_order: nextOrder,
      is_active: true,
      restricted: newRestricted,
      icon: newIcon,
    });
    setAddSaving(false);
    if (err) { setAddError(err.message); return; }
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.vehicle_class_created",
      details: { name: newName.trim(), capacity: cap, surcharge_percent: sur, restricted: newRestricted },
    });
    setAddingClass(false);
    setNewName(''); setNewCapacity(''); setNewSurcharge('0');
    setNewRestricted(false); setNewIcon('sedan');
    fetchVehicleClasses();
  }

  async function save() {
    setError(null);
    setSaved(false);
    const base = parseFloat(baseFare);
    const rate = parseFloat(ratePerKm);
    if (isNaN(base) || base < 0) { setError(t("settings.errBaseFare")); return; }
    if (isNaN(rate) || rate < 0) { setError(t("settings.errRatePerKm")); return; }
    setSaving(true);
    const { error: err } = await supabase
      .from("companies")
      .update({
        base_fare: base,
        rate_per_km: rate,
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

  async function saveContact() {
    setContactError(null);
    setContactSaved(false);
    // Deliberately no format validation: a dispatch number can legitimately be
    // an extension, a toll-free, or a number with an instruction beside it, and
    // the app formats display-only and falls back to the stored string. An empty
    // field is meaningful too — it means "show no card" rather than "unset".
    setContactSaving(true);
    const { error: err } = await supabase
      .from("companies")
      .update({
        phone: dispatchPhone.trim() || null,
        support_email: supportEmail.trim() || null,
      })
      .eq("id", companyId);
    setContactSaving(false);
    if (err) { setContactError(err.message); return; }
    setContactSaved(true);
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.contact_updated",
      details: {
        phone_set: !!dispatchPhone.trim(),
        support_email_set: !!supportEmail.trim(),
      },
    });
  }

  async function saveNumbering() {
    setNumError(null);
    setNumSaved(false);
    const cp = parseInt(carPad, 10);
    const cs = parseInt(carStart, 10);
    const dp = parseInt(driverPad, 10);
    if (isNaN(cp) || cp < 0 || cp > 6) { setNumError(t("settings.errCarPad")); return; }
    if (isNaN(dp) || dp < 0 || dp > 6) { setNumError(t("settings.errDriverPad")); return; }
    if (isNaN(cs) || cs < 0) { setNumError(t("settings.errCarStart")); return; }
    setNumSaving(true);
    const { error: err } = await supabase
      .from("companies")
      .update({
        car_number_prefix: carPrefix,
        car_number_pad: cp,
        car_number_start: cs,
        driver_number_prefix: driverPrefix,
        driver_number_pad: dp,
      })
      .eq("id", companyId);
    setNumSaving(false);
    if (err) { setNumError(err.message); return; }
    setNumSaved(true);
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "settings.numbering_updated",
      details: {
        car_number_prefix: carPrefix, car_number_pad: cp, car_number_start: cs,
        driver_number_prefix: driverPrefix, driver_number_pad: dp,
      },
    });
  }

  // Formatting only — changing these never rewrites a stored number. A driver
  // number is an int and a car number is the text painted on the car; the
  // prefix and padding are how they are drawn.
  function preview(prefix: string, pad: string, n: number) {
    const p = parseInt(pad, 10);
    return prefix + String(n).padStart(isNaN(p) ? 0 : p, "0");
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

        /* Service Areas is a map section, not a form: it should fill the pane
           down to the bottom padding rather than sit in a short box with the
           page scrolling underneath it. Flex column here + flex:1 on .sa-root
           is what gives the map a definite height to stretch into. overflow-y
           stays auto so a short viewport still scrolls instead of clipping.
           Only above the point where .sa-grid stops being two columns — below
           it the map and the list stack and ordinary page scroll is right. */
        @media (min-width: 901px) {
          .st-content.st-content-fill { display: flex; flex-direction: column; }
        }

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

        /* Number spinners OVERLAY the right edge of the field (Firefox draws them
           over the content, not beside it), and these inputs are text-align:right
           -- so the value sat underneath them and read as clipped. Hiding the
           stepper is the fix: these are typed config values, not things anyone
           nudges one at a time. All three declarations are needed: the standard
           appearance property for current browsers, the -moz- prefix for older
           Firefox, and the ::-webkit- pseudo-elements for Chromium, which
           ignores appearance on the spin buttons themselves.
           (No backticks in here -- this whole block is a template literal, and
           a backtick in a COMMENT ends the string. It did, once.) */
        .st-input[type="number"] { appearance: textfield; -moz-appearance: textfield; }
        .st-input[type="number"]::-webkit-inner-spin-button,
        .st-input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

        /* Free-text fields (phone, email) hold values of unpredictable length --
           an email can run 40 characters. A fixed px width clips them, and
           .st-input-wrap's overflow:hidden means the tail is invisible rather
           than scrollable, so the value silently looks wrong. Grow to fill the
           row instead and let the label column give up space: min-width:0 is
           what allows a flex item to shrink below its content width at all. */
        .st-field-row--wide { gap: 24px; }
        .st-field-row--wide .st-field-text { flex: 1 1 auto; min-width: 0; }
        .st-input-wrap--grow { flex: 1 1 280px; min-width: 180px; max-width: 420px; }
        .st-input--text { width: 100%; text-align: left; }

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
        /* Fits "\u{1F3CE}\u{FE0F} Luxury / premium" without clipping, and does not grow
           at the name field's expense. */
        .vc-icon-select { width: 150px; flex: 0 0 auto; }
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
        .vc-fleet-sizes { font-size: 12px; color: #6B7280; margin: 4px 0 12px; }

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
          <p className="st-panel-title">{t("settings.title")}</p>
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

        <div className={`st-content${section === "service_areas" ? " st-content-fill" : ""}`}>
          {section === "vehicle_classes" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("settings.sections.vehicleClasses")}</div>
                  <div className="st-subtitle">{t("settings.vcSubtitle")}</div>
                </div>
              </div>

              {vcLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
              ) : (
                <>
                  <table className="vc-table" style={{ marginBottom: 4 }}>
                    <thead>
                      <tr>
                        <th className="vc-th">{t("settings.vcClass")}</th>
                        <th className="vc-th">{t("settings.vcMinSeats")}</th>
                        <th className="vc-th">{t("settings.vcSurcharge")}</th>
                        <th className="vc-th">{t("settings.vcEffectiveRate")}</th>
                        <th className="vc-th">{t("settings.vcAccess")}</th>
                        <th className="vc-th">{t("common.status")}</th>
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
                            {/* Wide enough for the icon select AND a readable
                                name. It was minWidth 120 with the select at a
                                fixed 64px, which left about two characters of
                                the name visible while editing. */}
                            <td className="vc-td" style={{ minWidth: 300 }}>
                              {isEditing ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <select
                                    className="vc-input vc-icon-select"
                                    value={editIcon}
                                    onChange={e => setEditIcon(e.target.value)}
                                    aria-label={t("settings.vcIcon")}
                                  >
                                    {CLASS_ICON_CHOICES.map(c => (
                                      <option key={c.slug} value={c.slug}>
                                        {c.emoji} {t(c.label)}
                                      </option>
                                    ))}
                                  </select>
                                  <input
                                    className="vc-input"
                                    style={{ flex: 1, minWidth: 0 }}
                                    value={editName}
                                    onChange={e => setEditName(e.target.value)}
                                    aria-label={t("settings.vcClassName")}
                                  />
                                </div>
                              ) : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <span aria-hidden="true">{iconEmoji(vc.icon)}</span>
                                  <strong>{vc.name}</strong>
                                </span>
                              )}
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
                                ? <span className="vc-rate-preview">${previewRate.toFixed(2)}{t("common.perKm")}</span>
                                : <span className={vc.is_active ? "vc-rate-preview" : "vc-td muted"}>${effectiveRate.toFixed(2)}{t("common.perKm")}</span>}
                            </td>
                            <td className="vc-td">
                              {isEditing ? (
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                                  <input
                                    type="checkbox"
                                    checked={editRestricted}
                                    onChange={e => setEditRestricted(e.target.checked)}
                                  />
                                  <span style={{ fontSize: 12 }}>{t("settings.vcRestricted")}</span>
                                </label>
                              ) : (
                                <span style={{ fontSize: 12, color: '#6B7280' }}>
                                  {vc.restricted ? t("settings.vcRestricted") : t("settings.vcBySize")}
                                </span>
                              )}
                            </td>
                            <td className="vc-td">
                              <span className={vc.is_active ? "vc-badge-active" : "vc-badge-inactive"}>
                                {vc.is_active ? t("common.active") : t("common.inactive")}
                              </span>
                            </td>
                            <td className="vc-td right" style={{ whiteSpace: 'nowrap' }}>
                              {isEditing ? (
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                  <button className="vc-btn" onClick={() => { setEditingClassId(null); setEditError(null); }}>{t("common.cancel")}</button>
                                  <button className="vc-btn-save" onClick={saveEditClass} disabled={editSaving}>{editSaving ? '…' : t("common.save")}</button>
                                </div>
                              ) : (
                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                  <button className="vc-btn" onClick={() => openEditClass(vc)}>{t("common.edit")}</button>
                                  {vehicleClasses.length > 1 && (
                                    <button className="vc-btn" onClick={() => toggleClassActive(vc)}>
                                      {vc.is_active ? t("common.deactivate") : t("common.activate")}
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

                  {/* Derived, never a second list to maintain: the sizes a
                      driver is offered in the app are exactly the distinct
                      capacities of the active classes above. Shown so an admin
                      can see what their drivers will be asked, which is the
                      whole reason the two are the same list. */}
                  {fleetSizes.length > 0 && (
                    <div className="vc-fleet-sizes">
                      {t("settings.vcFleetSizes", { sizes: fleetSizes.join(", ") })}
                    </div>
                  )}

                  {addingClass ? (
                    <div className="vc-add-row">
                      <div className="vc-add-grid">
                        <div className="vc-add-field">
                          <div className="vc-add-label">{t("settings.vcClassName")}</div>
                          <input className="vc-input" placeholder={t("settings.vcClassNamePlaceholder")} value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
                        </div>
                        <div className="vc-add-field">
                          <div className="vc-add-label">{t("settings.vcIcon")}</div>
                          <select className="vc-input" value={newIcon} onChange={e => setNewIcon(e.target.value)}>
                            {CLASS_ICON_CHOICES.map(c => (
                              <option key={c.slug} value={c.slug}>
                                {c.emoji} {t(c.label)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="vc-add-field">
                          <div className="vc-add-label">{t("settings.vcMinSeats")}</div>
                          <input className="vc-input" type="number" min="1" placeholder="5" value={newCapacity} onChange={e => setNewCapacity(e.target.value)} />
                        </div>
                        <div className="vc-add-field">
                          <div className="vc-add-label">{t("settings.vcSurchargePct")}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input className="vc-input" type="number" min="0" step="0.5" placeholder="0" value={newSurcharge} onChange={e => setNewSurcharge(e.target.value)} />
                            <span style={{ color: '#6B7280', fontSize: 12, flexShrink: 0 }}>%</span>
                          </div>
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={newRestricted}
                          onChange={e => setNewRestricted(e.target.checked)}
                        />
                        <span style={{ fontSize: 12, color: '#6B7280' }}>{t("settings.vcRestrictedHint")}</span>
                      </label>
                      {newSurcharge && !isNaN(parseFloat(newSurcharge)) && (
                        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 10 }}>
                          {t("settings.vcEffectiveRateInline")} <span className="vc-rate-preview">${((parseFloat(savedRatePerKm) || 0) * (1 + parseFloat(newSurcharge) / 100)).toFixed(2)}{t("common.perKm")}</span>
                        </div>
                      )}
                      {addError && <div className="vc-error">{addError}</div>}
                      <div className="vc-add-actions">
                        <button className="vc-add-cancel" onClick={() => { setAddingClass(false); setNewName(''); setNewCapacity(''); setNewSurcharge('0'); setAddError(null); }}>{t("common.cancel")}</button>
                        <button className="vc-add-save" onClick={addVehicleClass} disabled={addSaving}>{addSaving ? t("common.saving") : t("settings.vcAddClass")}</button>
                      </div>
                    </div>
                  ) : (
                    <button className="vc-add-class-btn" onClick={() => setAddingClass(true)}>
                      <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> {t("settings.vcAddVehicleClass")}
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
                  <div className="st-title">{t("settings.sections.pricing")}</div>
                  <div className="st-subtitle">
                    <Trans
                      i18nKey="settings.pricingSubtitle"
                      components={{ s: <strong style={{ color: "#E2E8F0" }} /> }}
                    />
                  </div>
                </div>
                <button
                  className={`st-save-btn${saved ? " st-saved" : ""}`}
                  onClick={save}
                  disabled={saving || loading}
                >
                  {saving ? t("common.saving") : saved ? t("common.saved") : t("common.save")}
                </button>
              </div>

              {loading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
              ) : (
                <div className="st-card">
                  <p className="st-card-label">{t("settings.fareFormula")}</p>

                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">{t("settings.baseFare")}</span>
                      <span className="st-field-hint">{t("settings.baseFareHint")}</span>
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
                      <span className="st-field-label">{t("settings.ratePerKm")}</span>
                      <span className="st-field-hint">{t("settings.ratePerKmHint")}</span>
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
                      <span className="st-suffix">{t("common.perKm")}</span>
                    </div>
                  </div>

                  {error && <p className="st-error">{error}</p>}
                </div>
              )}

            </>
          )}

          {section === "contact" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("settings.sections.contact")}</div>
                  <div className="st-subtitle">
                    <Trans
                      i18nKey="settings.contactSubtitle"
                      components={{ s: <strong style={{ color: "#E2E8F0" }} /> }}
                    />
                  </div>
                </div>
                <button
                  className={`st-save-btn${contactSaved ? " st-saved" : ""}`}
                  onClick={saveContact}
                  disabled={contactSaving || loading}
                >
                  {contactSaving ? t("common.saving") : contactSaved ? t("common.saved") : t("common.save")}
                </button>
              </div>

              {/* Both fields reach the apps in two places: a passenger escalating
                  a live ride ("Something's wrong with this ride" → "Call
                  dispatch"), and the Help screen in both apps. Left blank, the
                  app renders no card at all rather than a dead one — so this is
                  worth filling in at onboarding. */}
              {loading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
              ) : (
                <div className="st-card">
                  <p className="st-card-label">{t("settings.shownInApps")}</p>
                  <div className="st-field-row st-field-row--wide">
                    <div className="st-field-text">
                      <span className="st-field-label">{t("settings.phoneNumber")}</span>
                      <span className="st-field-hint">{t("settings.phoneNumberHint")}</span>
                    </div>
                    <div className="st-input-wrap st-input-wrap--grow">
                      <input
                        className="st-input st-input--text"
                        type="tel"
                        placeholder="902-555-0100"
                        value={dispatchPhone}
                        onChange={e => { setDispatchPhone(e.target.value); setContactSaved(false); }}
                      />
                    </div>
                  </div>
                  {/* Your OWN support address, not the billing address Vellon
                      invoices — these reach different inboxes on purpose. Left
                      blank, the apps show no email option at all rather than a
                      dead one. */}
                  <div className="st-field-row st-field-row--wide">
                    <div className="st-field-text">
                      <span className="st-field-label">{t("settings.supportEmail")}</span>
                      <span className="st-field-hint">{t("settings.supportEmailHint")}</span>
                    </div>
                    <div className="st-input-wrap st-input-wrap--grow">
                      <input
                        className="st-input st-input--text"
                        type="email"
                        placeholder={t("settings.supportEmailPlaceholder")}
                        value={supportEmail}
                        onChange={e => { setSupportEmail(e.target.value); setContactSaved(false); }}
                      />
                    </div>
                  </div>

                  {contactError && <p className="st-error">{contactError}</p>}
                </div>
              )}
            </>
          )}

          {section === "service_areas" && (
            <ServiceAreasSection companyId={companyId} />
          )}

          {section === "numbering" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("settings.sections.numbering")}</div>
                  <div className="st-subtitle">{t("settings.numberingSubtitle")}</div>
                </div>
                <button
                  className={`st-save-btn${numSaved ? " st-saved" : ""}`}
                  onClick={saveNumbering}
                  disabled={numSaving || loading}
                >
                  {numSaving ? t("common.saving") : numSaved ? t("common.saved") : t("common.save")}
                </button>
              </div>

              {loading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
              ) : (
                <>
                  <div className="st-card">
                    <p className="st-card-label">
                      {t("settings.carNumbersNext")} <strong style={{ color: "#E2E8F0" }}>
                        {preview(carPrefix, carPad, parseInt(carStart, 10) || 1)}
                      </strong>
                    </p>

                    <div className="st-field-row">
                      <div className="st-field-text">
                        <span className="st-field-label">{t("settings.prefix")}</span>
                        <span className="st-field-hint">{t("settings.prefixHint")}</span>
                      </div>
                      <div className="st-input-wrap">
                        <input
                          className="st-input"
                          type="text"
                          maxLength={8}
                          placeholder={t("settings.nonePlaceholder")}
                          value={carPrefix}
                          onChange={e => { setCarPrefix(e.target.value); setNumSaved(false); }}
                        />
                      </div>
                    </div>

                    <div className="st-divider" />

                    <div className="st-field-row">
                      <div className="st-field-text">
                        <span className="st-field-label">{t("settings.digits")}</span>
                        <span className="st-field-hint">{t("settings.digitsHint")}</span>
                      </div>
                      <div className="st-input-wrap">
                        <input
                          className="st-input"
                          type="number"
                          min="0"
                          max="6"
                          value={carPad}
                          onChange={e => { setCarPad(e.target.value); setNumSaved(false); }}
                        />
                      </div>
                    </div>

                    <div className="st-divider" />

                    <div className="st-field-row">
                      <div className="st-field-text">
                        <span className="st-field-label">{t("settings.startAt")}</span>
                        <span className="st-field-hint">{t("settings.startAtHint")}</span>
                      </div>
                      <div className="st-input-wrap">
                        <input
                          className="st-input"
                          type="number"
                          min="0"
                          value={carStart}
                          onChange={e => { setCarStart(e.target.value); setNumSaved(false); }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="st-card">
                    <p className="st-card-label">
                      {t("settings.driverNumbersExample")} <strong style={{ color: "#E2E8F0" }}>
                        {preview(driverPrefix, driverPad, 7)}
                      </strong>
                    </p>

                    <div className="st-field-row">
                      <div className="st-field-text">
                        <span className="st-field-label">{t("settings.prefix")}</span>
                        <span className="st-field-hint">{t("settings.prefixHint")}</span>
                      </div>
                      <div className="st-input-wrap">
                        <input
                          className="st-input"
                          type="text"
                          maxLength={8}
                          placeholder={t("settings.nonePlaceholder")}
                          value={driverPrefix}
                          onChange={e => { setDriverPrefix(e.target.value); setNumSaved(false); }}
                        />
                      </div>
                    </div>

                    <div className="st-divider" />

                    <div className="st-field-row">
                      <div className="st-field-text">
                        <span className="st-field-label">{t("settings.digits")}</span>
                        <span className="st-field-hint">{t("settings.digitsHint")}</span>
                      </div>
                      <div className="st-input-wrap">
                        <input
                          className="st-input"
                          type="number"
                          min="0"
                          max="6"
                          value={driverPad}
                          onChange={e => { setDriverPad(e.target.value); setNumSaved(false); }}
                        />
                      </div>
                    </div>

                    <p className="st-field-hint" style={{ marginTop: 12, display: "block" }}>
                      {t("settings.driverNumbersNote")}
                    </p>

                    {numError && <p className="st-error">{numError}</p>}
                  </div>
                </>
              )}
            </>
          )}

          {section === "team" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("settings.sections.team")}</div>
                  <div className="st-subtitle">
                    {t("settings.teamSubtitle")}
                  </div>
                </div>
              </div>

              {staffLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
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
                                  <div className="vc-add-label">{t("common.name")}</div>
                                  <input className="vc-input" value={editStaffName} onChange={e => setEditStaffName(e.target.value)} autoFocus />
                                </div>
                                <div className="vc-add-field">
                                  <div className="vc-add-label">{t("common.email")}</div>
                                  <input className="vc-input" type="email" value={editStaffEmail} onChange={e => setEditStaffEmail(e.target.value)} />
                                </div>
                              </div>
                              {editStaffError && <div className="vc-error" style={{ marginBottom: 8 }}>{editStaffError}</div>}
                              <div className="vc-add-actions">
                                <button className="vc-add-cancel" onClick={() => { setEditingStaffId(null); setEditStaffError(null); }}>{t("common.cancel")}</button>
                                <button className="vc-add-save" onClick={saveStaffEdit} disabled={editStaffSaving}>{editStaffSaving ? t("common.saving") : t("common.save")}</button>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      return (
                        <tr key={member.id} className="tm-row">
                          <td className="tm-td" style={{ minWidth: 140 }}>
                            <strong>{member.name ?? t("common.unnamed")}</strong>
                            {member.id === adminId && <span className="tm-td muted"> {t("settings.you")}</span>}
                          </td>
                          <td className="tm-td muted">
                            {member.email || <span style={{ opacity: 0.6 }}>{t("settings.noEmail")}</span>}
                            {member.phone && (
                              <div style={{ fontSize: 11, opacity: 0.7 }}>{member.phone}</div>
                            )}
                          </td>
                          <td className="tm-td">
                            {/* The raw column value renders as English ("admin",
                                "dispatcher") and is not a copy string, so no
                                scanner can see it — the same hazard class as a
                                hardcoded locale tag. */}
                            <span className="tm-badge-role">{t(`settings.role.${member.role}`)}</span>
                          </td>
                          <td className="tm-td">
                            <span className={member.is_active ? "vc-badge-active" : "vc-badge-inactive"}>
                              {member.is_active ? t("common.active") : t("common.deactivated")}
                            </span>
                          </td>
                          <td className="tm-td right" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {isAdminRow ? (
                              <span className="tm-td muted" style={{ fontSize: 11 }}>{t("settings.managedByVellon")}</span>
                            ) : (
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button className="vc-btn" onClick={() => openEditStaff(member)}>{t("common.edit")}</button>
                                <button
                                  className="vc-btn"
                                  onClick={() => toggleStaffActive(member)}
                                  disabled={staffBusyId === member.id}
                                >
                                  {staffBusyId === member.id ? '…' : member.is_active ? t("common.deactivate") : t("common.reactivate")}
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
                    <div className="vc-add-label">{t("common.name")}</div>
                    <input className="vc-input" placeholder={t("settings.fullNamePlaceholder")} value={newStaffName} onChange={e => setNewStaffName(e.target.value)} autoFocus />
                  </div>
                  <div className="vc-add-field" style={{ marginBottom: 10 }}>
                    <div className="vc-add-label">{t("common.email")}</div>
                    <input className="vc-input" type="email" placeholder={t("settings.staffEmailPlaceholder")} value={newStaffEmail} onChange={e => setNewStaffEmail(e.target.value)} />
                  </div>
                  {staffError && <div className="vc-error">{staffError}</div>}
                  <div className="vc-add-actions">
                    <button className="vc-add-cancel" onClick={() => { setAddingStaff(false); setNewStaffName(''); setNewStaffEmail(''); setStaffError(null); }}>{t("common.cancel")}</button>
                    <button className="vc-add-save" onClick={addStaff} disabled={staffSaving}>{staffSaving ? t("settings.adding") : t("settings.addDispatcher")}</button>
                  </div>
                </div>
              ) : (
                <button className="vc-add-class-btn" onClick={() => setAddingStaff(true)}>
                  <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> {t("settings.addDispatcher")}
                </button>
              )}
            </>
          )}

          {section === "language" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("language.title")}</div>
                  <div className="st-subtitle">{t("language.description")}</div>
                </div>
              </div>

              <div className="st-card">
                {/* "Automatic" is listed first and is the DEFAULT, not a reset:
                    it means "nothing chosen in this browser", which is what
                    lets `profiles.locale` — a choice made at another desk —
                    take effect here. Picking a language explicitly outranks it.
                    See src/i18n/LocaleContext.tsx for the full precedence. */}
                <button
                  className={`st-section-btn${localeMode === "system" ? " active" : ""}`}
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => setLocaleMode("system")}
                >
                  {t("language.system")}
                  <span className="st-field-hint" style={{ display: "block" }}>
                    {t("language.systemHint")}
                  </span>
                </button>
                {available.map(l => (
                  <button
                    key={l.tag}
                    className={`st-section-btn${localeMode === l.tag ? " active" : ""}`}
                    style={{ width: "100%", textAlign: "left" }}
                    onClick={() => setLocaleMode(l.tag)}
                    lang={l.tag}
                  >
                    {/* The endonym, never a translated language name: this list
                        has to be readable to someone who cannot read the
                        language the dashboard is currently in. */}
                    {l.endonym}
                  </button>
                ))}
              </div>
            </>
          )}

          {section === "support" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">{t("settings.sections.support")}</div>
                  <div className="st-subtitle">
                    {t("settings.supportSubtitle")}
                  </div>
                </div>
              </div>

              <div className="st-card">
                <p className="st-card-label">{t("settings.newReport")}</p>

                <select
                  className="st-select"
                  value={reportCategory}
                  onChange={e => setReportCategory(e.target.value)}
                >
                  {REPORT_CATEGORIES.map(c => (
                    <option key={c.id} value={c.id}>{t(c.labelKey)}</option>
                  ))}
                </select>

                <textarea
                  className="st-textarea"
                  placeholder={t("settings.describeProblem")}
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
                    {reportSubmitting ? t("settings.sending") : reportSent ? t("settings.sent") : t("settings.sendReport")}
                  </button>
                </div>
              </div>

              <p className="st-card-label" style={{ marginTop: 24 }}>{t("settings.companyReports")}</p>
              {reportsLoading ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
              ) : reports.length === 0 ? (
                <div style={{ color: "#6B7280", fontSize: 14 }}>{t("settings.noReports")}</div>
              ) : (
                <table className="rp-table">
                  <tbody>
                    {reports.map(r => (
                      <tr key={r.id} className="rp-row">
                        <td className="rp-td" style={{ width: "60%" }}>
                          <div className="rp-cat">{REPORT_CATEGORY_KEYS[r.category] ? t(REPORT_CATEGORY_KEYS[r.category]) : r.category}</div>
                          <div className="rp-msg">{r.message}</div>
                        </td>
                        <td className="rp-td muted">{r.admin_name ?? t("common.unknown")}</td>
                        <td className="rp-td muted">{fmtDate(r.created_at)}</td>
                        <td className="rp-td">
                          <span className={r.status === "resolved" ? "rp-badge-resolved" : "rp-badge-open"}>
                            {r.status === "resolved" ? t("settings.resolved") : t("settings.open")}
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
