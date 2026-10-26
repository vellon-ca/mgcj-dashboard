import { useState, useEffect } from "react";
import { useSubView } from "../lib/viewPath";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";
import { useTranslation } from "react-i18next";
import { fmtDate } from "../i18n/format";
import { dayStart, zonedDayISO } from "../lib/companyZone";

interface Institution {
  id: string;
  name: string;
  domain: string;
}

interface DiscountCode {
  id: string;
  code: string;
  label: string | null;
  amount_type: "percent" | "fixed";
  amount: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  one_per_passenger: boolean;
  active: boolean;
  created_at: string;
}

interface Redemption {
  id: string;
  created_at: string;
  fare_estimate: number | null;
  discount_amount: number | null;
  status: string;
  passenger_name: string | null;
}

interface Props {
  companyId: string;
  adminId: string;
}

// Keys, not English — module scope is evaluated before a language is active.
const SECTION_ITEMS: { id: "student" | "codes"; labelKey: string }[] = [
  { id: "codes", labelKey: "discounts.sections.codes" },
  { id: "student", labelKey: "discounts.sections.student" },
];

const EMPTY_FORM = {
  code: "",
  label: "",
  amount_type: "percent" as "percent" | "fixed",
  amount: "10",
  starts_at: "",
  ends_at: "",
  max_redemptions: "",
  one_per_passenger: false,
  active: true,
};

const DISCOUNT_SECTIONS = ["student", "codes"] as const;

export default function DiscountsPage({ companyId, adminId }: Props) {
  const { t } = useTranslation();
  // Bound to /discounts/<section>.
  const [section, setSection] = useSubView<"student" | "codes">(
    "discounts",
    DISCOUNT_SECTIONS,
    "codes",
  );

  // Student discount state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [sponsoredIds, setSponsoredIds] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(false);
  const [pct, setPct] = useState("0");
  const [dirty, setDirty] = useState(false);

  // Discount codes state
  const [codes, setCodes] = useState<DiscountCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [savingCode, setSavingCode] = useState(false);
  const [redemptionsForCode, setRedemptionsForCode] = useState<string | null>(
    null,
  );
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    fetchStudentData();
    fetchCodes();
  }, [companyId]);

  async function fetchStudentData() {
    setLoading(true);
    try {
      const [{ data: allInstitutions }, { data: company }, { data: sponsored }] =
        await Promise.all([
          supabase.from("institutions").select("id, name, domain").order("name"),
          supabase
            .from("companies")
            .select("student_discount_enabled, student_discount_pct")
            .eq("id", companyId)
            .maybeSingle(),
          supabase
            .from("company_sponsored_institutions")
            .select("institution_id")
            .eq("company_id", companyId),
        ]);

      setInstitutions(allInstitutions ?? []);
      setEnabled(company?.student_discount_enabled ?? false);
      setPct(String(company?.student_discount_pct ?? 0));
      setSponsoredIds(new Set((sponsored ?? []).map((s) => s.institution_id)));
      setDirty(false);
    } finally {
      setLoading(false);
    }
  }

  function toggleInstitution(id: string) {
    setSponsoredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }

  async function saveStudentSettings() {
    const pctNum = Number(pct);
    if (Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) {
      alert(t("discounts.errPct"));
      return;
    }

    setSaving(true);
    try {
      const { error: companyError } = await supabase
        .from("companies")
        .update({ student_discount_enabled: enabled, student_discount_pct: pctNum })
        .eq("id", companyId);

      if (companyError) throw companyError;

      await supabase
        .from("company_sponsored_institutions")
        .delete()
        .eq("company_id", companyId);

      if (sponsoredIds.size > 0) {
        const { error: insertError } = await supabase
          .from("company_sponsored_institutions")
          .insert(
            Array.from(sponsoredIds).map((institution_id) => ({
              company_id: companyId,
              institution_id,
            })),
          );
        if (insertError) throw insertError;
      }

      setDirty(false);
    } catch (err: any) {
      alert(err.message ?? t("discounts.errSaveSettings"));
    } finally {
      setSaving(false);
    }
  }

  async function fetchCodes() {
    setCodesLoading(true);
    try {
      const { data } = await supabase
        .from("discount_codes")
        .select("*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: false });
      setCodes(data ?? []);
    } finally {
      setCodesLoading(false);
    }
  }

  async function copyCode(id: string, code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(id);
      setTimeout(() => setCopiedCode((cur) => (cur === id ? null : cur)), 1800);
    } catch (err) {
      console.error("Failed to copy code:", err);
    }
  }

  function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "";
    for (let i = 0; i < 8; i++) {
      result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
  }

  function openCreateForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormOpen(true);
  }

  function openEditForm(c: DiscountCode) {
    setForm({
      code: c.code,
      label: c.label ?? "",
      amount_type: c.amount_type,
      amount: String(c.amount),
      // Stored as instants; shown as the company-clock days they bound. ends_at
      // is the START of the day after the last valid one (see save below).
      starts_at: c.starts_at ? zonedDayISO(c.starts_at) : "",
      ends_at: c.ends_at ? zonedDayISO(new Date(c.ends_at).getTime() - 1) : "",
      max_redemptions: c.max_redemptions != null ? String(c.max_redemptions) : "",
      one_per_passenger: c.one_per_passenger,
      active: c.active,
    });
    setEditingId(c.id);
    setFormOpen(true);
  }

  async function saveCode() {
    const codeStr = form.code.trim().toUpperCase();
    const amountNum = Number(form.amount);

    if (!codeStr) {
      alert(t("discounts.errNoCode"));
      return;
    }
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      alert(t("discounts.errBadAmount"));
      return;
    }
    if (form.amount_type === "percent" && amountNum > 100) {
      alert(t("discounts.errPctMax"));
      return;
    }

    setSavingCode(true);
    try {
      const payload = {
        company_id: companyId,
        code: codeStr,
        label: form.label.trim() || null,
        amount_type: form.amount_type,
        amount: amountNum,
        // Whole days on the company's clock: from its midnight on the first
        // day to its midnight after the last. `new Date("YYYY-MM-DD")` is UTC
        // midnight, which ended an Atlantic code at 8-9 pm the evening BEFORE
        // its end date.
        starts_at: form.starts_at ? dayStart(form.starts_at).toISOString() : null,
        ends_at: form.ends_at ? dayStart(form.ends_at, 1).toISOString() : null,
        max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : null,
        one_per_passenger: form.one_per_passenger,
        active: form.active,
        created_by: adminId,
      };

      if (editingId) {
        const { error } = await supabase
          .from("discount_codes")
          .update(payload)
          .eq("id", editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("discount_codes").insert(payload);
        if (error) throw error;
        logDispatchEvent({
          companyId,
          dispatcherId: adminId,
          eventType: "discount.created",
          details: {
            code: codeStr,
            label: form.label.trim() || null,
            amount_type: form.amount_type,
            amount: amountNum,
            ends_at: form.ends_at || null,
            max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : null,
            one_per_passenger: form.one_per_passenger,
          },
        });
      }

      setFormOpen(false);
      await fetchCodes();
    } catch (err: any) {
      alert(err.message ?? t("discounts.errSaveCode"));
    } finally {
      setSavingCode(false);
    }
  }

  async function toggleCodeActive(c: DiscountCode) {
    await supabase
      .from("discount_codes")
      .update({ active: !c.active })
      .eq("id", c.id);
    fetchCodes();
    if (c.active) {
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: "discount.deactivated",
        details: { code: c.code, label: c.label ?? null },
      });
    }
  }

  async function deleteCode(c: DiscountCode) {
    if (!confirm(t("discounts.confirmDelete", { code: c.code }))) return;
    await supabase.from("discount_codes").delete().eq("id", c.id);
    fetchCodes();
    logDispatchEvent({
      companyId,
      dispatcherId: adminId,
      eventType: "discount.deleted",
      details: { code: c.code, label: c.label ?? null },
    });
  }

  async function viewRedemptions(c: DiscountCode) {
    if (redemptionsForCode === c.id) {
      setRedemptionsForCode(null);
      return;
    }
    setRedemptionsForCode(c.id);
    setRedemptionsLoading(true);
    try {
      const { data: rows } = await supabase
        .from("rides")
        .select("id, created_at, fare_estimate, discount_amount, status, passenger_id")
        .eq("discount_code_id", c.id)
        .order("created_at", { ascending: false })
        .limit(100);

      const enriched: Redemption[] = await Promise.all(
        (rows ?? []).map(async (r: any) => {
          const { data: passenger } = await supabase
            .from("profiles")
            .select("name")
            .eq("id", r.passenger_id)
            .maybeSingle();
          return { ...r, passenger_name: passenger?.name ?? null };
        }),
      );
      setRedemptions(enriched);
    } finally {
      setRedemptionsLoading(false);
    }
  }

  function codeStatusLabel(c: DiscountCode) {
    const now = new Date();
    if (!c.active) return { label: t("common.inactive"), color: "var(--c-text-3)" };
    if (c.starts_at && now < new Date(c.starts_at))
      return { label: t("discounts.statusScheduled"), color: "var(--c-amber)" };
    if (c.ends_at && now >= new Date(c.ends_at))
      return { label: t("discounts.statusExpired"), color: "var(--c-red)" };
    return { label: t("common.active"), color: "var(--c-green)" };
  }

  return (
    <div className="dc-wrap">
      <style>{`
        .dc-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .dc-panel { width: 200px; background: var(--c-surface); border-right: 1px solid var(--c-border); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .dc-panel-title { font-size: 10px; font-weight: 600; color: var(--c-text-2); letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .dc-section-btn { display: flex; align-items: center; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: var(--c-text-2); cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .dc-section-btn:hover { background: var(--c-hover); color: var(--c-text-2); }
        .dc-section-btn.active { border-left-color: var(--c-brand); background: var(--c-surface-sel); color: var(--c-brand); }
        .dc-content { flex: 1; overflow-y: auto; padding: 24px 32px; background: var(--c-bg); }
        .dc-content::-webkit-scrollbar { width: 4px; }
        .dc-content::-webkit-scrollbar-thumb { background: var(--c-hover-strong); border-radius: 2px; }

        .dc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 16px; }
        .dc-title { font-size: 18px; font-weight: 700; color: var(--c-text); margin-bottom: 4px; }
        .dc-subtitle-text { font-size: 13px; color: var(--c-text-2); line-height: 1.5; max-width: 720px; }

        .dc-save-btn { background: var(--c-brand-fill); color: var(--c-on-brand); border: none; border-radius: 9px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, opacity 0.12s; flex-shrink: 0; white-space: nowrap; }
        .dc-save-btn:hover:not(:disabled) { background: var(--c-brand-fill); }
        .dc-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .dc-save-btn.dc-saved { background: var(--c-surface-alt); color: var(--c-green); }

        .dc-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .dc-summary-card { background: var(--c-surface); border-radius: 10px; padding: 16px; border: 1px solid var(--c-border-subtle); }
        .dc-summary-label { font-size: 10px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 6px; }
        .dc-summary-value { font-size: 22px; font-weight: 700; color: var(--c-text); line-height: 1; }

        .dc-settings-grid { display: flex; flex-direction: column; gap: 16px; }

        .dc-card { background: var(--c-surface); border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid var(--c-border-subtle); }
        .dc-card-label { font-size: 11px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 16px; }

        .dc-toggle-row { display: flex; align-items: center; justify-content: space-between; }
        .dc-toggle-text { display: flex; flex-direction: column; gap: 2px; }
        .dc-toggle-title { font-size: 14px; font-weight: 600; color: var(--c-text); }
        .dc-toggle-sub { font-size: 12px; color: var(--c-text-2); }

        .dc-switch { position: relative; width: 42px; height: 24px; border-radius: 12px; border: none; background: var(--c-border-strong); cursor: pointer; transition: background 0.15s; flex-shrink: 0; padding: 0; }
        .dc-switch.on { background: var(--c-brand-fill); }
        .dc-switch-knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 9px; background: #fff; transition: transform 0.15s; }
        .dc-switch.on .dc-switch-knob { transform: translateX(18px); }

        .dc-divider { height: 1px; background: var(--c-hover); margin: 16px 0; }

        .dc-pct-row { display: flex; align-items: center; justify-content: space-between; }
        .dc-pct-label { display: flex; flex-direction: column; gap: 2px; }
        .dc-pct-input-wrap { display: flex; align-items: center; gap: 8px; opacity: 1; transition: opacity 0.15s; }
        .dc-pct-input-wrap.disabled { opacity: 0.4; pointer-events: none; }
        .dc-pct-input { width: 64px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-input); color: var(--c-text); font-size: 14px; font-weight: 600; font-family: system-ui, sans-serif; text-align: center; }
        .dc-pct-input:focus { outline: none; border-color: var(--c-brand); }
        .dc-pct-suffix { font-size: 14px; color: var(--c-text-2); font-weight: 600; }

        .dc-schools-empty { font-size: 13px; color: var(--c-text-2); padding: 8px 0; }
        .dc-schools { display: flex; flex-wrap: wrap; gap: 8px; }
        .dc-school-chip { padding: 9px 16px; border-radius: 20px; border: 1px solid var(--c-border); background: transparent; color: var(--c-text-2); font-size: 13px; font-weight: 500; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, border-color 0.12s, color 0.12s; }
        .dc-school-chip:hover { border-color: var(--c-border-strong); color: var(--c-text); }
        .dc-school-chip.selected { background: var(--c-surface-sel); border-color: var(--c-brand); color: var(--c-brand); }

        .dc-note { font-size: 12px; color: var(--c-text-2); line-height: 1.5; margin-top: 14px; }
        .dc-loading { color: var(--c-text-2); text-align: center; padding: 60px; font-size: 14px; }
        .dc-empty { color: var(--c-text-2); font-size: 14px; text-align: center; padding: 48px 0; }

        /* CODE LIST */
        .dc-codes-grid { display: flex; flex-direction: column; gap: 10px; }
        .dc-code-card { background: var(--c-surface); border-radius: 12px; padding: 18px; border: 1px solid var(--c-border-subtle); }
        .dc-code-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .dc-code-name-row { display: flex; align-items: center; gap: 8px; }
        .dc-code-name { font-size: 15px; font-weight: 700; color: var(--c-text); letter-spacing: 0.02em; }
        .dc-copy-btn { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; background: var(--c-hover); border: 1px solid var(--c-border); border-radius: 6px; color: var(--c-text-2); cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; flex-shrink: 0; }
        .dc-copy-btn:hover { background: var(--c-hover-strong); color: var(--c-text); }
        .dc-copy-btn.copied { background: var(--c-surface-alt); border-color: var(--c-border); color: var(--c-green); }
        .dc-code-label { font-size: 12px; color: var(--c-text-2); margin-top: 2px; }
        .dc-code-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--c-text); white-space: nowrap; flex-shrink: 0; }
        .dc-code-status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--dot, var(--c-text-2)); }
        .dc-code-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 12px; max-width: 560px; }
        .dc-code-meta-item { display: flex; flex-direction: column; gap: 2px; }
        .dc-code-meta-label { font-size: 10px; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
        .dc-code-meta-value { font-size: 13px; color: var(--c-text); font-weight: 500; }
        .dc-code-actions { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--c-border-subtle); }
        .dc-code-action { padding: 6px 14px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; border: none; transition: opacity 0.12s, background 0.12s; }
        .dc-action-edit { background: var(--c-hover); color: var(--c-text-2); border: 1px solid var(--c-border) !important; }
        .dc-action-edit:hover { background: var(--c-hover-strong); }
        .dc-action-history { background: var(--c-surface-alt); color: var(--c-blue); border: 1px solid var(--c-border) !important; }
        .dc-action-history:hover { background: var(--c-surface-alt); }
        .dc-action-toggle { background: var(--c-surface-alt); color: var(--c-green); border: 1px solid var(--c-border) !important; }
        .dc-action-toggle:hover { background: var(--c-surface-alt); }
        .dc-action-toggle.off { background: var(--c-hover); color: var(--c-text-2); border: 1px solid var(--c-border) !important; }
        .dc-action-delete { background: var(--c-surface-alt); color: var(--c-red); border: 1px solid var(--c-border) !important; }
        .dc-action-delete:hover { background: var(--c-surface-alt); }

        .dc-redemptions { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--c-border-subtle); }
        .dc-redemption-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; font-size: 12px; color: var(--c-text-2); border-bottom: 1px solid var(--c-border-subtle); }
        .dc-redemption-name { color: var(--c-text); font-weight: 500; }
        .dc-redemption-empty { font-size: 12px; color: var(--c-text-2); padding: 8px 0; }

        /* CREATE/EDIT FORM */
        .dc-form-overlay { position: fixed; inset: 0; background: var(--c-scrim); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .dc-form { background: var(--c-surface); border-radius: 14px; padding: 26px; width: 100%; max-width: 440px; border: 1px solid var(--c-border); max-height: 88vh; overflow-y: auto; box-shadow: 0 20px 60px var(--c-shadow); }
        .dc-form-title { font-size: 17px; font-weight: 700; color: var(--c-text); margin-bottom: 18px; }
        .dc-form-field { margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
        .dc-form-label { font-size: 12px; color: var(--c-text-2); font-weight: 500; }
        .dc-form-input { padding: 9px 12px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-input); color: var(--c-text); font-size: 13px; font-family: system-ui, sans-serif; }
        .dc-form-input:focus { outline: none; border-color: var(--c-brand); }
        .dc-form-code-row { display: flex; gap: 8px; }
        .dc-form-code-row .dc-form-input { flex: 1; }
        .dc-form-generate { background: var(--c-surface-sel); color: var(--c-brand); border: 1px solid var(--c-border); border-radius: 8px; padding: 9px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; white-space: nowrap; transition: background 0.12s; }
        .dc-form-generate:hover { background: var(--c-surface-sel); }
        .dc-form-row { display: flex; gap: 10px; }
        .dc-form-row .dc-form-field { flex: 1; }
        .dc-form-select { padding: 9px 12px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-input); color: var(--c-text); font-size: 13px; font-family: system-ui, sans-serif; }
        .dc-form-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
        .dc-form-toggle-label { font-size: 13px; color: var(--c-text); }
        .dc-form-hint { font-size: 11px; color: var(--c-text-2); margin-top: -2px; }
        .dc-form-actions { display: flex; gap: 8px; margin-top: 20px; }
        .dc-form-cancel { flex: 1; background: transparent; border: 1px solid var(--c-border); color: var(--c-text-2); border-radius: 8px; padding: 10px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; }
        .dc-form-cancel:hover { background: var(--c-hover); }
        .dc-form-submit { flex: 1; background: var(--c-brand-fill); border: none; color: var(--c-on-brand); border-radius: 8px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; }
        .dc-form-submit:hover { background: var(--c-brand-fill); }
        .dc-form-submit:disabled { opacity: 0.6; cursor: not-allowed; }
      `}</style>

      {/* LEFT PANEL */}
      <div className="dc-panel">
        <div className="dc-panel-title">{t("discounts.title")}</div>
        {SECTION_ITEMS.map((s) => (
          <button
            key={s.id}
            className={`dc-section-btn${section === s.id ? " active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <div className="dc-content">
        {section === "student" ? (
          loading ? (
            <div className="dc-loading">{t("common.loading")}</div>
          ) : (
            <>
              <div className="dc-header">
                <div>
                  <div className="dc-title">{t("discounts.sections.student")}</div>
                  <div className="dc-subtitle-text">{t("discounts.studentSubtitle")}</div>
                </div>
                <button
                  className={`dc-save-btn${!dirty && !saving ? " dc-saved" : ""}`}
                  onClick={saveStudentSettings}
                  disabled={saving || !dirty}
                >
                  {saving ? t("common.saving") : dirty ? t("discounts.saveChanges") : t("discounts.savedShort")}
                </button>
              </div>

              <div className="dc-summary">
                <div className="dc-summary-card">
                  <div className="dc-summary-label">{t("common.status")}</div>
                  <div
                    className="dc-summary-value"
                    style={{ color: enabled ? "var(--c-green)" : "var(--c-text-2)", fontSize: 16 }}
                  >
                    {enabled ? t("discounts.enabled") : t("discounts.disabled")}
                  </div>
                </div>
                <div className="dc-summary-card">
                  <div className="dc-summary-label">{t("discounts.discount")}</div>
                  <div className="dc-summary-value">{Number(pct) || 0}%</div>
                </div>
                <div className="dc-summary-card">
                  <div className="dc-summary-label">{t("discounts.schools")}</div>
                  <div className="dc-summary-value">{sponsoredIds.size}</div>
                </div>
              </div>

              <div className="dc-settings-grid">
                <div className="dc-card">
                  <div className="dc-card-label">{t("settings.title")}</div>

                  <div className="dc-toggle-row">
                    <div className="dc-toggle-text">
                      <span className="dc-toggle-title">{t("discounts.enableStudent")}</span>
                      <span className="dc-toggle-sub">{t("discounts.enableStudentHint")}</span>
                    </div>
                    <button
                      className={`dc-switch${enabled ? " on" : ""}`}
                      onClick={() => {
                        setEnabled((v) => !v);
                        setDirty(true);
                      }}
                      aria-label={t("discounts.toggleStudentAria")}
                    >
                      <span className="dc-switch-knob" />
                    </button>
                  </div>

                  <div className="dc-divider" />

                  <div className="dc-pct-row">
                    <div className="dc-pct-label">
                      <span className="dc-toggle-title">{t("discounts.pctLabel")}</span>
                      <span className="dc-toggle-sub">{t("discounts.pctHint")}</span>
                    </div>
                    <div className={`dc-pct-input-wrap${enabled ? "" : " disabled"}`}>
                      <input
                        className="dc-pct-input"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={pct}
                        onChange={(e) => {
                          setPct(e.target.value);
                          setDirty(true);
                        }}
                        disabled={!enabled}
                      />
                      <span className="dc-pct-suffix">%</span>
                    </div>
                  </div>
                </div>

                <div className="dc-card">
                  <div className="dc-card-label">{t("discounts.sponsoredSchools")}</div>
                  {institutions.length === 0 ? (
                    <div className="dc-schools-empty">{t("discounts.noSchools")}</div>
                  ) : (
                    <div className="dc-schools">
                      {institutions.map((inst) => {
                        const selected = sponsoredIds.has(inst.id);
                        return (
                          <button
                            key={inst.id}
                            className={`dc-school-chip${selected ? " selected" : ""}`}
                            onClick={() => toggleInstitution(inst.id)}
                          >
                            {inst.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="dc-note">{t("discounts.schoolsNote")}</div>
                </div>
              </div>
            </>
          )
        ) : (
          <>
            <div className="dc-header">
              <div>
                <div className="dc-title">{t("discounts.sections.codes")}</div>
                <div className="dc-subtitle-text">{t("discounts.codesSubtitle")}</div>
              </div>
              <button className="dc-save-btn" onClick={openCreateForm}>
                {t("discounts.newCode")}
              </button>
            </div>

            {codesLoading ? (
              <div className="dc-loading">{t("common.loading")}</div>
            ) : codes.length === 0 ? (
              <div className="dc-empty">{t("discounts.noCodes")}</div>
            ) : (
              <div className="dc-codes-grid">
              {codes.map((c) => {
                const status = codeStatusLabel(c);
                return (
                  <div key={c.id} className="dc-code-card">
                    <div className="dc-code-top">
                      <div>
                        <div className="dc-code-name-row">
                          <span className="dc-code-name">{c.code}</span>
                          <button
                            className={`dc-copy-btn${copiedCode === c.id ? " copied" : ""}`}
                            onClick={() => copyCode(c.id, c.code)}
                            aria-label={t("discounts.copyCode")}
                            title={copiedCode === c.id ? t("discounts.copied") : t("discounts.copyCode")}
                          >
                            {copiedCode === c.id ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                              </svg>
                            )}
                          </button>
                        </div>
                        {c.label && <div className="dc-code-label">{c.label}</div>}
                      </div>
                      <span
                        className="dc-code-status"
                        style={{ "--dot": status.color } as React.CSSProperties}
                      >
                        {status.label}
                      </span>
                    </div>

                    <div className="dc-code-meta">
                      <div className="dc-code-meta-item">
                        <span className="dc-code-meta-label">{t("discounts.discount")}</span>
                        <span className="dc-code-meta-value">
                          {c.amount_type === "percent"
                            ? `${c.amount}%`
                            : `$${c.amount.toFixed(2)}`}
                        </span>
                      </div>
                      <div className="dc-code-meta-item">
                        <span className="dc-code-meta-label">{t("discounts.validity")}</span>
                        <span className="dc-code-meta-value">
                          {c.starts_at ? fmtDate(c.starts_at) : t("discounts.now")}
                          {" – "}
                          {c.ends_at ? fmtDate(c.ends_at) : t("discounts.noEnd")}
                        </span>
                      </div>
                      <div className="dc-code-meta-item">
                        <span className="dc-code-meta-label">{t("discounts.limit")}</span>
                        <span className="dc-code-meta-value">
                          {c.max_redemptions
                            ? t("discounts.maxN", { n: c.max_redemptions })
                            : t("discounts.unlimited")}
                          {c.one_per_passenger ? ` · ${t("discounts.onePerPassenger")}` : ""}
                        </span>
                      </div>
                    </div>

                    <div className="dc-code-actions">
                      <button
                        className="dc-code-action dc-action-edit"
                        onClick={() => openEditForm(c)}
                      >
                        {t("common.edit")}
                      </button>
                      <button
                        className="dc-code-action dc-action-history"
                        onClick={() => viewRedemptions(c)}
                      >
                        {redemptionsForCode === c.id ? t("discounts.hideHistory") : t("discounts.history")}
                      </button>
                      <button
                        className={`dc-code-action dc-action-toggle${c.active ? "" : " off"}`}
                        onClick={() => toggleCodeActive(c)}
                      >
                        {c.active ? t("common.deactivate") : t("common.activate")}
                      </button>
                      <button
                        className="dc-code-action dc-action-delete"
                        onClick={() => deleteCode(c)}
                      >
                        {t("common.delete")}
                      </button>
                    </div>

                    {redemptionsForCode === c.id && (
                      <div className="dc-redemptions">
                        {redemptionsLoading ? (
                          <div className="dc-redemption-empty">{t("common.loading")}</div>
                        ) : redemptions.length === 0 ? (
                          <div className="dc-redemption-empty">{t("discounts.noRedemptions")}</div>
                        ) : (
                          redemptions.map((r) => (
                            <div key={r.id} className="dc-redemption-row">
                              <span className="dc-redemption-name">
                                {r.passenger_name ?? "—"}
                              </span>
                              <span>{fmtDate(r.created_at)}</span>
                              <span>
                                {t("discounts.redemptionAmount", {
                                  off: (r.discount_amount ?? 0).toFixed(2),
                                  fare: (r.fare_estimate ?? 0).toFixed(2),
                                })}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>
            )}
          </>
        )}
      </div>

      {formOpen && (
        <div className="dc-form-overlay" onClick={() => setFormOpen(false)}>
          <div className="dc-form" onClick={(e) => e.stopPropagation()}>
            <div className="dc-form-title">
              {editingId ? t("discounts.editCode") : t("discounts.newCodeTitle")}
            </div>

            <div className="dc-form-field">
              <label className="dc-form-label">{t("discounts.code")}</label>
              <div className="dc-form-code-row">
                <input
                  className="dc-form-input"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder={t("discounts.codePlaceholder")}
                  style={{ textTransform: "uppercase" }}
                />
                <button
                  className="dc-form-generate"
                  type="button"
                  onClick={() => setForm({ ...form, code: generateCode() })}
                >
                  {t("discounts.autoGenerate")}
                </button>
              </div>
            </div>

            <div className="dc-form-field">
              <label className="dc-form-label">{t("discounts.labelOptional")}</label>
              <input
                className="dc-form-input"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder={t("discounts.labelPlaceholder")}
              />
            </div>

            <div className="dc-form-row">
              <div className="dc-form-field">
                <label className="dc-form-label">{t("discounts.type")}</label>
                <select
                  className="dc-form-select"
                  value={form.amount_type}
                  onChange={(e) =>
                    setForm({ ...form, amount_type: e.target.value as "percent" | "fixed" })
                  }
                >
                  <option value="percent">{t("discounts.percentOff")}</option>
                  <option value="fixed">{t("discounts.fixedOff")}</option>
                </select>
              </div>
              <div className="dc-form-field">
                <label className="dc-form-label">
                  {form.amount_type === "percent"
                    ? t("discounts.amountPct")
                    : t("discounts.amountDollars")}
                </label>
                <input
                  className="dc-form-input"
                  type="number"
                  min={0}
                  max={form.amount_type === "percent" ? 100 : undefined}
                  step={form.amount_type === "percent" ? 1 : 0.5}
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                />
              </div>
            </div>

            <div className="dc-form-row">
              <div className="dc-form-field">
                <label className="dc-form-label">{t("discounts.startsOptional")}</label>
                <input
                  className="dc-form-input"
                  type="date"
                  value={form.starts_at}
                  onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
                />
              </div>
              <div className="dc-form-field">
                <label className="dc-form-label">{t("discounts.endsOptional")}</label>
                <input
                  className="dc-form-input"
                  type="date"
                  value={form.ends_at}
                  onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
                />
              </div>
            </div>

            <div className="dc-form-field">
              <label className="dc-form-label">{t("discounts.maxRedemptions")}</label>
              <input
                className="dc-form-input"
                type="number"
                min={1}
                value={form.max_redemptions}
                onChange={(e) => setForm({ ...form, max_redemptions: e.target.value })}
                placeholder={t("discounts.maxRedemptionsPlaceholder")}
              />
              <div className="dc-form-hint">{t("discounts.maxRedemptionsHint")}</div>
            </div>

            <div className="dc-form-toggle-row">
              <span className="dc-form-toggle-label">{t("discounts.oneUseLabel")}</span>
              <button
                className={`dc-switch${form.one_per_passenger ? " on" : ""}`}
                onClick={() =>
                  setForm({ ...form, one_per_passenger: !form.one_per_passenger })
                }
              >
                <span className="dc-switch-knob" />
              </button>
            </div>

            <div className="dc-form-toggle-row">
              <span className="dc-form-toggle-label">{t("common.active")}</span>
              <button
                className={`dc-switch${form.active ? " on" : ""}`}
                onClick={() => setForm({ ...form, active: !form.active })}
              >
                <span className="dc-switch-knob" />
              </button>
            </div>

            <div className="dc-form-actions">
              <button className="dc-form-cancel" onClick={() => setFormOpen(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="dc-form-submit"
                onClick={saveCode}
                disabled={savingCode}
              >
                {savingCode ? t("common.saving") : editingId ? t("discounts.saveChanges") : t("discounts.createCode")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
