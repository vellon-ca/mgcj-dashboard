import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";
import { useTranslation } from "react-i18next";
import { fmtDate, fmtDateTime, fmtTime } from "../i18n/format";
import { dayStart, fromDateTimeLocal, toDateTimeLocal } from "../lib/companyZone";

// The announcement / offer composer. Design: mgcj-app
// .claude/notes/announcements-design.md (step 4). What the app does with each
// field is decided server-side (my_announcements, record_message_event,
// claim_offer, _shared/messagePush.ts); this page only writes the row and
// calls the staff RPCs.

type Audience = "all_passengers" | "all_drivers";
type Category = "announcement" | "offer";
type Repeat = "once" | "until_tapped" | "must_acknowledge";
type CtaMode = "none" | "url" | "app";

interface MessageRow {
  id: string;
  category: Category;
  target_type: Audience;
  display_mode: "inbox" | "interstitial";
  title: string;
  body: string;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  cta_label: string | null;
  cta_kind: "url" | "app" | null;
  cta_target: string | null;
  repeat_mode: Repeat;
  repeat_max: number;
  repeat_gap_hours: number;
  push: boolean;
  push_sent_at: string | null;
  discount_code_id: string | null;
  starts_at: string | null;
  expires_at: string | null;
  ended_at: string | null;
  edited_at: string | null;
  created_at: string;
}

interface Stats {
  message_id: string;
  audience: number;
  shown: number;
  opened: number;
  cta: number;
  acknowledged: number;
  dismissed: number;
  claimed: number;
  redeemed: number;
  discounted: number;
}

interface CodeRow {
  id: string;
  code: string;
  label: string | null;
  amount_type: "percent" | "fixed";
  amount: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  one_per_passenger: boolean;
  max_redemptions: number | null;
}

// Where an in-app button may go, per audience. Must stay inside the CHECK in
// 20261024040000 (messages_cta_check), and the driver list inside what the
// driver app handles (DriverHomeScreen.navigateFromMessage) — anything else
// would be a button that does nothing.
const APP_TARGETS: Record<Audience, string[]> = {
  all_passengers: ["book", "add_card", "discounts", "scheduled", "inbox"],
  all_drivers: ["scheduled", "inbox"],
};

const COLUMNS =
  "id, category, target_type, display_mode, title, body, image_url, image_width, image_height, cta_label, cta_kind, cta_target, repeat_mode, repeat_max, repeat_gap_hours, push, push_sent_at, discount_code_id, starts_at, expires_at, ended_at, edited_at, created_at";

// Photos are shrunk before upload: a 12-megapixel phone photo is ~4 MB that
// every passenger would otherwise download.
const MAX_IMAGE_EDGE = 1600;

async function shrinkImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image"));
      el.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    // JPEG has no transparency: without a fill, a transparent PNG flyer
    // comes out black.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85),
    );
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function codeTerms(c: Pick<CodeRow, "amount_type" | "amount">): string {
  return c.amount_type === "percent" ? `${c.amount}%` : `$${Number(c.amount).toFixed(2)}`;
}

const EMPTY_FORM = {
  audience: "all_passengers" as Audience,
  category: "announcement" as Category,
  popup: false,
  repeat: "once" as Repeat,
  repeatMax: "3",
  repeatGap: "24",
  title: "",
  body: "",
  ctaMode: "none" as CtaMode,
  ctaLabel: "",
  ctaUrl: "",
  ctaTarget: "book",
  codeId: "",
  startsAt: "",
  expiresAt: "",
  push: true,
};

const EMPTY_CODE = {
  code: "",
  label: "",
  amount_type: "percent" as "percent" | "fixed",
  amount: "",
  ends_at: "",
  one_per_passenger: false,
  max_redemptions: "",
};

interface Props {
  companyId: string;
  adminId: string;
  isAdmin: boolean;
}

export default function AnnouncementsPage({ companyId, adminId, isAdmin }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [audienceFilter, setAudienceFilter] = useState<"all" | Audience>("all");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCodeOpen, setNewCodeOpen] = useState(false);
  const [newCode, setNewCode] = useState(EMPTY_CODE);
  const [savingCode, setSavingCode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: "", body: "", ctaMode: "none" as CtaMode, ctaLabel: "", ctaUrl: "", ctaTarget: "book", expiresAt: "" });
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchAll();
  }, [companyId]);

  async function fetchAll() {
    setLoading(true);
    try {
      const [msgRes, statRes, codeRes] = await Promise.all([
        supabase
          .from("messages")
          .select(COLUMNS)
          .eq("company_id", companyId)
          .in("target_type", ["all_passengers", "all_drivers"])
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase.rpc("announcement_stats"),
        supabase
          .from("discount_codes")
          .select("id, code, label, amount_type, amount, active, starts_at, ends_at, one_per_passenger, max_redemptions")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false }),
      ]);
      setMessages((msgRes.data as MessageRow[] | null) ?? []);
      const byId: Record<string, Stats> = {};
      for (const s of (statRes.data as Stats[] | null) ?? []) byId[s.message_id] = s;
      setStats(byId);
      setCodes((codeRes.data as CodeRow[] | null) ?? []);
    } finally {
      setLoading(false);
    }
  }

  const now = Date.now();
  const usableCodes = codes.filter(
    (c) => c.active && (!c.ends_at || new Date(c.ends_at).getTime() > now),
  );
  const selectedCode = codes.find((c) => c.id === form.codeId) ?? null;
  // A code already in another offer is already public; attaching it again
  // widens nothing, so no warning.
  const codeAlreadyPublic =
    !!selectedCode && messages.some((m) => m.discount_code_id === selectedCode.id);

  function setAudience(audience: Audience) {
    setForm((f) => ({
      ...f,
      audience,
      // Offers are passengers-only (messages_offer_audience_check); must
      // acknowledge is drivers-only (messages_acknowledge_check).
      category: audience === "all_drivers" ? "announcement" : f.category,
      codeId: audience === "all_drivers" ? "" : f.codeId,
      repeat: audience === "all_passengers" && f.repeat === "must_acknowledge" ? "once" : f.repeat,
      ctaTarget: APP_TARGETS[audience].includes(f.ctaTarget) ? f.ctaTarget : APP_TARGETS[audience][0],
    }));
  }

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function clearImage() {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Shared by send and edit; returns an error key or null.
  function ctaFields(mode: CtaMode, label: string, url: string, target: string, audience: Audience) {
    if (mode === "none") return { ok: true as const, cta_label: null, cta_kind: null, cta_target: null };
    if (!label.trim()) return { ok: false as const, err: "announcements.errButtonLabel" };
    if (mode === "url") {
      const u = url.trim();
      if (!/^https:\/\/\S+$/.test(u)) return { ok: false as const, err: "announcements.errButtonUrl" };
      return { ok: true as const, cta_label: label.trim(), cta_kind: "url" as const, cta_target: u };
    }
    if (!APP_TARGETS[audience].includes(target)) return { ok: false as const, err: "announcements.errButtonTarget" };
    return { ok: true as const, cta_label: label.trim(), cta_kind: "app" as const, cta_target: target };
  }

  async function sendMessage() {
    setError(null);
    if (!form.title.trim() || !form.body.trim()) {
      setError(t("announcements.errRequired"));
      return;
    }
    const isOfferWithCode = form.category === "offer" && !!form.codeId;
    const cta = isOfferWithCode
      ? { ok: true as const, cta_label: null, cta_kind: null, cta_target: null }
      : ctaFields(form.ctaMode, form.ctaLabel, form.ctaUrl, form.ctaTarget, form.audience);
    if (!cta.ok) {
      setError(t(cta.err));
      return;
    }
    const startsAt = form.startsAt ? fromDateTimeLocal(form.startsAt) : null;
    let expiresAt = form.expiresAt ? fromDateTimeLocal(form.expiresAt) : null;
    // The message must not outlive the deal it advertises.
    if (isOfferWithCode && selectedCode?.ends_at) {
      const codeEnd = new Date(selectedCode.ends_at);
      if (!expiresAt || expiresAt > codeEnd) expiresAt = codeEnd;
    }
    if (startsAt && expiresAt && startsAt >= expiresAt) {
      setError(t("announcements.errWindow"));
      return;
    }
    const repeatMax = Math.max(1, Math.min(10, Number(form.repeatMax) || 3));
    const repeatGap = Math.max(1, Math.min(720, Number(form.repeatGap) || 24));

    setSending(true);
    try {
      let imageUrl: string | null = null;
      let imageWidth: number | null = null;
      let imageHeight: number | null = null;
      if (imageFile) {
        const shrunk = await shrinkImage(imageFile);
        // First path segment is the company id: the upload policy checks it.
        const path = `${companyId}/${crypto.randomUUID()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("message-images")
          .upload(path, shrunk.blob, { contentType: "image/jpeg" });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from("message-images").getPublicUrl(path).data.publicUrl;
        imageWidth = shrunk.width;
        imageHeight = shrunk.height;
      }

      // A start in the past is just "now": the column stays NULL so the insert
      // webhook pushes it rather than the scheduled sweep.
      const scheduled = !!startsAt && startsAt.getTime() > Date.now();
      const { error: insertError } = await supabase.from("messages").insert({
        company_id: companyId,
        sender_id: adminId,
        category: form.category,
        target_type: form.audience,
        display_mode: form.popup ? "interstitial" : "inbox",
        title: form.title.trim(),
        body: form.body.trim(),
        image_url: imageUrl,
        image_width: imageWidth,
        image_height: imageHeight,
        cta_label: cta.cta_label,
        cta_kind: cta.cta_kind,
        cta_target: cta.cta_target,
        repeat_mode: form.popup ? form.repeat : "once",
        repeat_max: repeatMax,
        repeat_gap_hours: repeatGap,
        push: form.push,
        discount_code_id: isOfferWithCode ? form.codeId : null,
        starts_at: scheduled ? startsAt!.toISOString() : null,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
      });
      if (insertError) throw insertError;

      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: form.audience === "all_drivers" ? "announcement.drivers" : "announcement.passengers",
        details: {
          category: form.category,
          display_mode: form.popup ? "interstitial" : "inbox",
          repeat_mode: form.popup ? form.repeat : "once",
          title: form.title.trim(),
          has_image: !!imageUrl,
          button: cta.cta_kind,
          code: isOfferWithCode ? (selectedCode?.code ?? null) : null,
          starts_at: scheduled ? startsAt!.toISOString() : null,
          push: form.push,
        },
      });

      setForm((f) => ({ ...EMPTY_FORM, audience: f.audience }));
      clearImage();
      await fetchAll();
    } catch (e: any) {
      setError(e?.message ?? t("announcements.errSendFailed"));
    } finally {
      setSending(false);
    }
  }

  async function createCode() {
    const codeStr = newCode.code.trim().toUpperCase();
    const amount = Number(newCode.amount);
    if (!codeStr) return setError(t("discounts.errNoCode"));
    if (Number.isNaN(amount) || amount <= 0) return setError(t("discounts.errBadAmount"));
    if (newCode.amount_type === "percent" && amount > 100) return setError(t("discounts.errPctMax"));
    setSavingCode(true);
    setError(null);
    try {
      const { data, error: insErr } = await supabase
        .from("discount_codes")
        .insert({
          company_id: companyId,
          code: codeStr,
          label: newCode.label.trim() || null,
          amount_type: newCode.amount_type,
          amount,
          // Whole days on the company's clock, as on the Discounts page.
          ends_at: newCode.ends_at ? dayStart(newCode.ends_at, 1).toISOString() : null,
          max_redemptions: newCode.max_redemptions ? Number(newCode.max_redemptions) : null,
          one_per_passenger: newCode.one_per_passenger,
          active: true,
          created_by: adminId,
        })
        .select("id, code, label, amount_type, amount, active, starts_at, ends_at, one_per_passenger, max_redemptions")
        .single();
      if (insErr) throw insErr;
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: "discount.created",
        details: {
          code: codeStr,
          label: newCode.label.trim() || null,
          amount_type: newCode.amount_type,
          amount,
          ends_at: newCode.ends_at || null,
          max_redemptions: newCode.max_redemptions ? Number(newCode.max_redemptions) : null,
          source: "announcement",
        },
      });
      const row = data as CodeRow;
      setCodes((prev) => [row, ...prev]);
      setForm((f) => ({ ...f, codeId: row.id }));
      setNewCode(EMPTY_CODE);
      setNewCodeOpen(false);
    } catch (e: any) {
      setError(e?.code === "23505" ? t("announcements.errCodeTaken") : (e?.message ?? t("announcements.errCodeFailed")));
    } finally {
      setSavingCode(false);
    }
  }

  function startEdit(m: MessageRow) {
    setEditingId(m.id);
    setEditForm({
      title: m.title,
      body: m.body,
      ctaMode: (m.cta_kind ?? "none") as CtaMode,
      ctaLabel: m.cta_label ?? "",
      ctaUrl: m.cta_kind === "url" ? (m.cta_target ?? "") : "",
      ctaTarget: m.cta_kind === "app" ? (m.cta_target ?? "book") : APP_TARGETS[m.target_type][0],
      expiresAt: m.expires_at ? toDateTimeLocal(m.expires_at) : "",
    });
  }

  async function saveEdit(m: MessageRow) {
    setError(null);
    if (!editForm.title.trim() || !editForm.body.trim()) return setError(t("announcements.errRequired"));
    const cta = m.discount_code_id
      ? { ok: true as const, cta_label: null, cta_kind: null, cta_target: null }
      : ctaFields(editForm.ctaMode, editForm.ctaLabel, editForm.ctaUrl, editForm.ctaTarget, m.target_type);
    if (!cta.ok) return setError(t(cta.err));
    let expires = editForm.expiresAt ? fromDateTimeLocal(editForm.expiresAt) : null;
    // As at send: an offer ends no later than its code.
    const code = m.discount_code_id ? codes.find((c) => c.id === m.discount_code_id) : null;
    if (code?.ends_at && (!expires || expires > new Date(code.ends_at))) expires = new Date(code.ends_at);
    if (expires && m.starts_at && new Date(m.starts_at) >= expires) return setError(t("announcements.errWindow"));
    setRowBusy(m.id);
    try {
      const { error: rpcErr } = await supabase.rpc("edit_announcement", {
        p_id: m.id,
        p_title: editForm.title.trim(),
        p_body: editForm.body.trim(),
        p_cta_label: cta.cta_label,
        p_cta_kind: cta.cta_kind,
        p_cta_target: cta.cta_target,
        p_expires_at: expires ? expires.toISOString() : null,
      });
      if (rpcErr) throw rpcErr;
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: "announcement.edited",
        details: { message_id: m.id, title: editForm.title.trim() },
      });
      setEditingId(null);
      await fetchAll();
    } catch (e: any) {
      setError(e?.message ?? t("announcements.errSendFailed"));
    } finally {
      setRowBusy(null);
    }
  }

  async function endOrDelete(m: MessageRow, action: "end" | "delete") {
    if (!window.confirm(t(action === "end" ? "announcements.confirmEnd" : "announcements.confirmDelete"))) return;
    setRowBusy(m.id);
    setError(null);
    try {
      const { error: rpcErr } = await supabase.rpc(
        action === "end" ? "end_announcement" : "delete_announcement",
        { p_id: m.id },
      );
      if (rpcErr) throw rpcErr;
      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: action === "end" ? "announcement.ended" : "announcement.deleted",
        details: { message_id: m.id, title: m.title },
      });
      await fetchAll();
    } catch (e: any) {
      setError(e?.message ?? t("announcements.errSendFailed"));
    } finally {
      setRowBusy(null);
    }
  }

  function status(m: MessageRow): "scheduled" | "live" | "ended" | "expired" {
    const n = Date.now();
    if (m.ended_at) return "ended";
    if (m.expires_at && new Date(m.expires_at).getTime() <= n) return "expired";
    if (m.starts_at && new Date(m.starts_at).getTime() > n) return "scheduled";
    return "live";
  }

  const filteredMessages = messages.filter(
    (m) => audienceFilter === "all" || m.target_type === audienceFilter,
  );
  const groupedByDate = useMemo(() => {
    const groups: { date: string; items: MessageRow[] }[] = [];
    for (const m of filteredMessages) {
      const dateLabel = fmtDate(m.starts_at ?? m.created_at, {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      });
      const last = groups[groups.length - 1];
      if (last && last.date === dateLabel) last.items.push(m);
      else groups.push({ date: dateLabel, items: [m] });
    }
    return groups;
  }, [filteredMessages]);

  const isOffer = form.category === "offer";
  const offerWithCode = isOffer && !!form.codeId;
  const previewButton = offerWithCode
    ? t("announcements.previewUseOffer")
    : form.ctaMode !== "none" && form.ctaLabel.trim()
      ? form.ctaLabel.trim()
      : form.repeat === "must_acknowledge"
        ? t("announcements.previewUnderstand")
        : t("announcements.previewGotIt");
  const scheduledSend = !!form.startsAt && fromDateTimeLocal(form.startsAt).getTime() > Date.now();

  const renderCtaFields = (
    mode: CtaMode,
    label: string,
    url: string,
    target: string,
    audience: Audience,
    set: (patch: Partial<{ ctaMode: CtaMode; ctaLabel: string; ctaUrl: string; ctaTarget: string }>) => void,
  ) => (
    <div className="mp-field">
      <label className="mp-label">{t("announcements.button")}</label>
      <div className="mp-toggle-row">
        {(["none", "url", "app"] as CtaMode[]).map((k) => (
          <button key={k} className={`mp-toggle-btn${mode === k ? " active" : ""}`} onClick={() => set({ ctaMode: k })}>
            {t(`announcements.button_${k}`)}
          </button>
        ))}
      </div>
      {mode !== "none" && (
        <>
          <input
            className="mp-input mp-gap"
            value={label}
            maxLength={40}
            onChange={(e) => set({ ctaLabel: e.target.value })}
            placeholder={t(mode === "url" ? "announcements.buttonLabelUrlPh" : "announcements.buttonLabelAppPh")}
          />
          {mode === "url" ? (
            <input
              className="mp-input mp-gap"
              value={url}
              onChange={(e) => set({ ctaUrl: e.target.value })}
              // i18n-ok — a URL scheme, not copy.
              placeholder="https://"
            />
          ) : (
            <select className="mp-input mp-gap" value={target} onChange={(e) => set({ ctaTarget: e.target.value })}>
              {APP_TARGETS[audience].map((tg) => (
                <option key={tg} value={tg}>{t(`announcements.target_${tg}`)}</option>
              ))}
            </select>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <style>{`
        .mp-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }

        .mp-compose { width: 360px; flex-shrink: 0; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); padding: 20px; overflow-y: auto; }
        .mp-compose-title { font-size: 14px; font-weight: 700; color: #F1F5F9; margin-bottom: 16px; }

        .mp-field { margin-bottom: 14px; }
        .mp-label { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; display: block; }
        .mp-input, .mp-textarea { width: 100%; box-sizing: border-box; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 9px 11px; color: #E2E8F0; font-size: 13px; font-family: system-ui, sans-serif; }
        .mp-input:focus, .mp-textarea:focus { outline: none; border-color: #E8500A; }
        .mp-textarea { resize: vertical; min-height: 120px; }
        .mp-gap { margin-top: 6px; }
        .mp-row2 { display: flex; gap: 8px; }
        .mp-row2 > * { flex: 1; min-width: 0; }
        .mp-hint { font-size: 11px; color: #6B7280; margin-top: 6px; line-height: 1.45; }
        .mp-warn { font-size: 11px; color: #F59E0B; margin-top: 6px; line-height: 1.45; }

        .mp-toggle-row { display: flex; gap: 6px; flex-wrap: wrap; }
        .mp-toggle-btn { flex: 1; padding: 8px 6px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); color: #9CA3AF; transition: all 0.12s; }
        .mp-toggle-btn.active { border-color: #E8500A; color: #F1F5F9; }
        .mp-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: #E2E8F0; cursor: pointer; }
        .mp-check input { margin-top: 2px; }
        .mp-sub { margin: 10px 0 0 22px; }

        .mp-image-picker { border: 1px dashed rgba(255,255,255,0.15); border-radius: 8px; padding: 12px; text-align: center; cursor: pointer; color: #9CA3AF; font-size: 13px; }
        .mp-image-remove, .mp-link { font-size: 12px; color: #F87171; cursor: pointer; background: none; border: none; padding: 0; margin-top: 6px; }
        .mp-link { color: #60A5FA; }

        .mp-box { background: #162133; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 12px; margin-top: 8px; }

        .mp-error { font-size: 12px; color: #F87171; margin-bottom: 10px; }
        .mp-send-btn { width: 100%; padding: 11px; border-radius: 8px; background: #E8500A; color: #fff; border: none; font-size: 13px; font-weight: 700; cursor: pointer; margin-top: 6px; }
        .mp-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .mp-preview { width: 320px; flex-shrink: 0; background: #0B111B; border-right: 1px solid rgba(255,255,255,0.06); padding: 20px; overflow-y: auto; }
        .mp-phone { width: 270px; height: 540px; margin: 0 auto; border-radius: 34px; border: 8px solid #1F2937; background: #2B3240; position: relative; overflow: hidden; }
        .mp-phone-scrim { position: absolute; inset: 0; background: rgba(0,0,0,0.45); }
        .mp-sheet { position: absolute; left: 0; right: 0; bottom: 0; max-height: 88%; background: #1B1C1F; border-radius: 18px 18px 0 0; display: flex; flex-direction: column; }
        .mp-sheet-scroll { overflow-y: auto; padding-bottom: 6px; }
        .mp-sheet-img { width: 100%; display: block; background: #25262A; object-fit: contain; }
        .mp-sheet-body { padding: 12px 16px 0; }
        .mp-sheet-eyebrow { font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #9A9BA0; margin-bottom: 6px; }
        .mp-sheet-title { font-size: 15px; font-weight: 700; color: #EDEDEF; margin-bottom: 6px; }
        .mp-sheet-text { font-size: 11.5px; color: #B4B5BA; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
        .mp-sheet-offer { margin-top: 10px; background: #25262A; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-weight: 700; color: #EDEDEF; }
        .mp-sheet-foot { padding: 10px 16px 14px; border-top: 1px solid rgba(255,255,255,0.06); }
        .mp-sheet-btn { background: #E8500A; color: #fff; border-radius: 10px; text-align: center; font-size: 12.5px; font-weight: 700; padding: 10px; }
        .mp-sheet-later { text-align: center; font-size: 11.5px; color: #9A9BA0; margin-top: 8px; }
        .mp-inbox-row { margin: 14px auto 0; width: 270px; background: #1B1C1F; border-radius: 12px; padding: 10px 12px; display: flex; gap: 10px; }
        .mp-inbox-row img { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; }
        .mp-preview-cap { font-size: 11px; color: #6B7280; text-align: center; margin: 10px 0 0; }

        .mp-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; min-width: 0; }
        .mp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .mp-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .mp-subtitle-text { font-size: 12px; color: #6B7280; }

        .mp-filter-row { display: flex; gap: 6px; margin-bottom: 20px; }
        .mp-filter-btn { padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); color: #9CA3AF; }
        .mp-filter-btn.active { border-color: #E8500A; color: #F1F5F9; }

        .mp-date-heading { font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin: 20px 0 10px; }
        .mp-date-heading:first-child { margin-top: 0; }

        .mp-card { background: #1E2A3A; border-radius: 12px; padding: 16px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); }
        .mp-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .mp-badges { display: flex; gap: 6px; flex-wrap: wrap; }
        .mp-badge { font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 20px; white-space: nowrap; background: rgba(255,255,255,0.06); color: #9CA3AF; }
        .mp-badge-live { color: #34D399; }
        .mp-badge-scheduled { color: #60A5FA; }
        .mp-badge-ended, .mp-badge-expired { color: #F87171; }
        .mp-card-date { font-size: 11px; color: #6B7280; white-space: nowrap; }
        .mp-card-title { font-size: 14px; font-weight: 600; color: #E2E8F0; margin-bottom: 6px; }
        .mp-card-body { font-size: 13px; color: #9CA3AF; white-space: pre-wrap; word-break: break-word; }
        .mp-card-image { width: 100%; max-width: 280px; border-radius: 8px; margin-top: 10px; }
        .mp-card-meta { font-size: 11px; color: #6B7280; margin-top: 8px; }
        .mp-stats { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
        .mp-stat { font-size: 11px; color: #6B7280; }
        .mp-stat b { display: block; font-size: 15px; color: #E2E8F0; font-weight: 700; }
        .mp-of { font-weight: 400; font-size: 11px; color: #6B7280; }
        .mp-actions { display: flex; gap: 8px; margin-top: 12px; }
        .mp-action { font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; cursor: pointer; background: transparent; border: 1px solid rgba(255,255,255,0.12); color: #CBD5E1; }
        .mp-action.danger { color: #F87171; border-color: rgba(248,113,113,0.35); }
        .mp-action:disabled { opacity: 0.5; cursor: not-allowed; }

        .mp-empty { color: #6B7280; font-size: 14px; text-align: center; padding: 60px 0; }
        .mp-loading { color: #6B7280; text-align: center; padding: 60px; font-size: 14px; }

        @media (max-width: 1280px) { .mp-preview { display: none; } }
      `}</style>

      <div className="mp-wrap">
        {/* ── Compose ─────────────────────────────────────────────── */}
        <div className="mp-compose">
          <div className="mp-compose-title">{t("announcements.new")}</div>
          {error && <div className="mp-error">{error}</div>}

          <div className="mp-field">
            <label className="mp-label">{t("announcements.audience")}</label>
            <div className="mp-toggle-row">
              <button className={`mp-toggle-btn${form.audience === "all_passengers" ? " active" : ""}`} onClick={() => setAudience("all_passengers")}>
                {t("announcements.allPassengers")}
              </button>
              <button className={`mp-toggle-btn${form.audience === "all_drivers" ? " active" : ""}`} onClick={() => setAudience("all_drivers")}>
                {t("announcements.allDrivers")}
              </button>
            </div>
          </div>

          {form.audience === "all_passengers" && (
            <div className="mp-field">
              <label className="mp-label">{t("announcements.category")}</label>
              <div className="mp-toggle-row">
                <button className={`mp-toggle-btn${form.category === "announcement" ? " active" : ""}`} onClick={() => setForm((f) => ({ ...f, category: "announcement", codeId: "" }))}>
                  {t("announcements.categoryAnnouncement")}
                </button>
                <button className={`mp-toggle-btn${form.category === "offer" ? " active" : ""}`} onClick={() => setForm((f) => ({ ...f, category: "offer" }))}>
                  {t("announcements.categoryOffer")}
                </button>
              </div>
            </div>
          )}

          {isOffer && (
            <div className="mp-field">
              <label className="mp-label">{t("announcements.offerCode")}</label>
              <select
                className="mp-input"
                value={form.codeId}
                onChange={(e) => setForm((f) => ({ ...f, codeId: e.target.value }))}
              >
                <option value="">{t("announcements.noCode")}</option>
                {usableCodes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {codeTerms(c)}{c.label ? ` · ${c.label}` : ""}
                  </option>
                ))}
              </select>
              {selectedCode && (
                <div className="mp-hint">
                  {[
                    selectedCode.one_per_passenger ? t("announcements.codeOnePer") : null,
                    selectedCode.max_redemptions != null ? t("announcements.codeMax", { count: selectedCode.max_redemptions }) : null,
                    selectedCode.ends_at ? t("announcements.codeEnds", { when: fmtDate(selectedCode.ends_at, { month: "short", day: "numeric" }) }) : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              )}
              {selectedCode && !codeAlreadyPublic && (
                <div className="mp-warn">{t("announcements.codeGoesPublic")}</div>
              )}
              {!form.codeId && <div className="mp-hint">{t("announcements.noCodeHint")}</div>}
              {isAdmin && !newCodeOpen && (
                <button className="mp-link" onClick={() => setNewCodeOpen(true)}>{t("announcements.newCode")}</button>
              )}
              {isAdmin && newCodeOpen && (
                <div className="mp-box">
                  <div className="mp-row2">
                    <input className="mp-input" placeholder={t("announcements.newCodeCode")} value={newCode.code}
                      onChange={(e) => setNewCode((c) => ({ ...c, code: e.target.value.toUpperCase() }))} />
                    <input className="mp-input" placeholder={t("announcements.newCodeLabel")} value={newCode.label}
                      onChange={(e) => setNewCode((c) => ({ ...c, label: e.target.value }))} />
                  </div>
                  <div className="mp-row2 mp-gap">
                    <select className="mp-input" value={newCode.amount_type}
                      onChange={(e) => setNewCode((c) => ({ ...c, amount_type: e.target.value as "percent" | "fixed" }))}>
                      <option value="percent">{t("announcements.percentOff")}</option>
                      <option value="fixed">{t("announcements.dollarsOff")}</option>
                    </select>
                    <input className="mp-input" type="number" min="0" step="0.01" placeholder={t("announcements.newCodeAmount")}
                      value={newCode.amount} onChange={(e) => setNewCode((c) => ({ ...c, amount: e.target.value }))} />
                  </div>
                  <div className="mp-row2 mp-gap">
                    <div>
                      <label className="mp-label mp-gap">{t("announcements.newCodeLastDay")}</label>
                      <input className="mp-input" type="date" value={newCode.ends_at}
                        onChange={(e) => setNewCode((c) => ({ ...c, ends_at: e.target.value }))} />
                    </div>
                    <div>
                      <label className="mp-label mp-gap">{t("announcements.newCodeMaxUses")}</label>
                      <input className="mp-input" type="number" min="1" value={newCode.max_redemptions}
                        onChange={(e) => setNewCode((c) => ({ ...c, max_redemptions: e.target.value }))} />
                    </div>
                  </div>
                  <label className="mp-check mp-gap">
                    <input type="checkbox" checked={newCode.one_per_passenger}
                      onChange={(e) => setNewCode((c) => ({ ...c, one_per_passenger: e.target.checked }))} />
                    {t("announcements.codeOnePer")}
                  </label>
                  <div className="mp-row2 mp-gap">
                    <button className="mp-action" onClick={() => { setNewCodeOpen(false); setNewCode(EMPTY_CODE); }}>{t("common.cancel")}</button>
                    <button className="mp-action" disabled={savingCode} onClick={createCode}>
                      {savingCode ? t("common.saving") : t("announcements.newCodeCreate")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mp-field">
            <label className="mp-label">{t("announcements.titleLabel")}</label>
            <input className="mp-input" value={form.title} maxLength={80}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={t("announcements.titlePlaceholder")} />
          </div>

          <div className="mp-field">
            <label className="mp-label">{t("announcements.messageLabel")}</label>
            <textarea className="mp-textarea" value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              placeholder={t("announcements.bodyPlaceholder")} />
            <div className="mp-hint">{t("announcements.linksHint")}</div>
          </div>

          <div className="mp-field">
            <label className="mp-label">{t("announcements.photoOptional")}</label>
            {imagePreview ? (
              <div>
                <img className="mp-card-image" src={imagePreview} alt="" />
                <div><button className="mp-image-remove" onClick={clearImage}>{t("announcements.removePhoto")}</button></div>
              </div>
            ) : (
              <div className="mp-image-picker" onClick={() => fileInputRef.current?.click()}>
                {t("announcements.addPhoto")}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={pickImage} />
          </div>

          {!offerWithCode &&
            renderCtaFields(form.ctaMode, form.ctaLabel, form.ctaUrl, form.ctaTarget, form.audience, (p) =>
              setForm((f) => ({ ...f, ...p })),
            )}

          <div className="mp-field">
            <label className="mp-check">
              <input type="checkbox" checked={form.popup}
                onChange={(e) => setForm((f) => ({ ...f, popup: e.target.checked, repeat: e.target.checked ? f.repeat : "once" }))} />
              <span>
                {t("announcements.showPopup")}
                <div className="mp-hint">{t("announcements.showPopupHint")}</div>
              </span>
            </label>
            {form.popup && (
              <div className="mp-sub">
                <label className="mp-label">{t("announcements.howOften")}</label>
                <select className="mp-input" value={form.repeat}
                  onChange={(e) => setForm((f) => ({ ...f, repeat: e.target.value as Repeat }))}>
                  <option value="once">{t("announcements.repeatOnce")}</option>
                  <option value="until_tapped">{t("announcements.repeatUntilTapped")}</option>
                  {form.audience === "all_drivers" && (
                    <option value="must_acknowledge">{t("announcements.repeatMustAck")}</option>
                  )}
                </select>
                {form.repeat === "until_tapped" && (
                  <div className="mp-row2 mp-gap">
                    <div>
                      <label className="mp-label mp-gap">{t("announcements.repeatMax")}</label>
                      <input className="mp-input" type="number" min="1" max="10" value={form.repeatMax}
                        onChange={(e) => setForm((f) => ({ ...f, repeatMax: e.target.value }))} />
                    </div>
                    <div>
                      <label className="mp-label mp-gap">{t("announcements.repeatGap")}</label>
                      <input className="mp-input" type="number" min="1" max="720" value={form.repeatGap}
                        onChange={(e) => setForm((f) => ({ ...f, repeatGap: e.target.value }))} />
                    </div>
                  </div>
                )}
                <div className="mp-hint">{t(`announcements.repeatHint_${form.repeat}`)}</div>
              </div>
            )}
          </div>

          <div className="mp-field">
            <div className="mp-row2">
              <div>
                <label className="mp-label">{t("announcements.startsOptional")}</label>
                <input className="mp-input" type="datetime-local" value={form.startsAt}
                  onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} />
              </div>
              <div>
                <label className="mp-label">{t("announcements.expiresOptional")}</label>
                <input className="mp-input" type="datetime-local" value={form.expiresAt}
                  onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
              </div>
            </div>
            {offerWithCode && selectedCode?.ends_at && (
              <div className="mp-hint">{t("announcements.endsWithCode")}</div>
            )}
          </div>

          <div className="mp-field">
            <label className="mp-check">
              <input type="checkbox" checked={form.push} onChange={(e) => setForm((f) => ({ ...f, push: e.target.checked }))} />
              <span>
                {t("announcements.sendPush")}
                {form.push && isOffer && <div className="mp-hint">{t("announcements.pushOptOutHint")}</div>}
                {form.push && scheduledSend && <div className="mp-hint">{t("announcements.pushAtStart")}</div>}
              </span>
            </label>
          </div>

          <button className="mp-send-btn" disabled={sending} onClick={sendMessage}>
            {sending
              ? t("settings.sending")
              : scheduledSend
                ? t("announcements.schedule")
                : t(form.audience === "all_drivers" ? "announcements.sendToDrivers" : "announcements.sendToPassengers")}
          </button>
        </div>

        {/* ── Preview: what the phone shows ───────────────────────── */}
        <div className="mp-preview">
          <div className="mp-label" style={{ textAlign: "center" }}>
            {t(form.popup ? "announcements.previewPopup" : "announcements.previewInbox")}
          </div>
          {form.popup ? (
            <div className="mp-phone">
              <div className="mp-phone-scrim" />
              <div className="mp-sheet">
                <div className="mp-sheet-scroll">
                  {imagePreview && <img className="mp-sheet-img" src={imagePreview} alt="" style={{ maxHeight: 220 }} />}
                  <div className="mp-sheet-body">
                    <div className="mp-sheet-eyebrow">
                      {t(isOffer ? "announcements.categoryOffer" : "announcements.categoryAnnouncement")}
                    </div>
                    <div className="mp-sheet-title">{form.title || t("announcements.titlePlaceholder")}</div>
                    <div className="mp-sheet-text">{form.body || t("announcements.bodyPlaceholder")}</div>
                    {offerWithCode && selectedCode && (
                      <div className="mp-sheet-offer">{t("announcements.previewOff", { terms: codeTerms(selectedCode) })}</div>
                    )}
                  </div>
                </div>
                <div className="mp-sheet-foot">
                  <div className="mp-sheet-btn">{previewButton}</div>
                  {form.repeat === "until_tapped" && <div className="mp-sheet-later">{t("announcements.previewLater")}</div>}
                </div>
              </div>
            </div>
          ) : null}
          <div className="mp-inbox-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mp-sheet-title" style={{ fontSize: 12.5, marginBottom: 3 }}>
                {form.title || t("announcements.titlePlaceholder")}
              </div>
              <div className="mp-sheet-text" style={{ fontSize: 11, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {form.body || t("announcements.bodyPlaceholder")}
              </div>
            </div>
            {imagePreview && <img src={imagePreview} alt="" />}
          </div>
          <div className="mp-preview-cap">{t("announcements.previewCaption")}</div>
        </div>

        {/* ── Sent ────────────────────────────────────────────────── */}
        <div className="mp-content">
          <div className="mp-header">
            <div className="mp-title">{t("announcements.sentTitle")}</div>
            <div className="mp-subtitle-text">{t("announcements.sentCount", { count: filteredMessages.length })}</div>
          </div>

          <div className="mp-filter-row">
            {(["all", "all_passengers", "all_drivers"] as const).map((k) => (
              <button key={k} className={`mp-filter-btn${audienceFilter === k ? " active" : ""}`} onClick={() => setAudienceFilter(k)}>
                {t(k === "all" ? "announcements.filterAll" : k === "all_passengers" ? "announcements.audiencePassengers" : "announcements.audienceDrivers")}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="mp-loading">{t("common.loading")}</div>
          ) : filteredMessages.length === 0 ? (
            <div className="mp-empty">{t("announcements.nothingSent")}</div>
          ) : (
            groupedByDate.map((group) => (
              <div key={group.date}>
                <div className="mp-date-heading">{group.date}</div>
                {group.items.map((m) => {
                  const st = status(m);
                  const s = stats[m.id];
                  const code = m.discount_code_id ? codes.find((c) => c.id === m.discount_code_id) : null;
                  const editing = editingId === m.id;
                  return (
                    <div key={m.id} className="mp-card">
                      <div className="mp-card-top">
                        <div className="mp-badges">
                          <span className={`mp-badge mp-badge-${st}`}>{t(`announcements.status_${st}`)}</span>
                          <span className="mp-badge">{t(m.target_type === "all_drivers" ? "announcements.audienceDrivers" : "announcements.audiencePassengers")}</span>
                          <span className="mp-badge">{t(m.category === "offer" ? "announcements.categoryOffer" : "announcements.categoryAnnouncement")}</span>
                          <span className="mp-badge">
                            {m.display_mode === "interstitial"
                              ? `${t("announcements.popup")} · ${t(`announcements.repeatShort_${m.repeat_mode}`)}`
                              : t("announcements.inbox")}
                          </span>
                          {code && <span className="mp-badge">{code.code} · {codeTerms(code)}</span>}
                          {!m.push && <span className="mp-badge">{t("announcements.noPush")}</span>}
                          {m.edited_at && <span className="mp-badge">{t("announcements.edited")}</span>}
                        </div>
                        <div className="mp-card-date">
                          {fmtTime(m.starts_at ?? m.created_at, { hour: "numeric", minute: "2-digit" })}
                        </div>
                      </div>

                      {editing ? (
                        <div>
                          <input className="mp-input" value={editForm.title} maxLength={80}
                            onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))} />
                          <textarea className="mp-textarea mp-gap" value={editForm.body}
                            onChange={(e) => setEditForm((f) => ({ ...f, body: e.target.value }))} />
                          <div className="mp-gap" />
                          {!m.discount_code_id &&
                            renderCtaFields(editForm.ctaMode, editForm.ctaLabel, editForm.ctaUrl, editForm.ctaTarget, m.target_type, (p) =>
                              setEditForm((f) => ({ ...f, ...p })),
                            )}
                          <label className="mp-label">{t("announcements.expiresOptional")}</label>
                          <input className="mp-input" type="datetime-local" value={editForm.expiresAt}
                            onChange={(e) => setEditForm((f) => ({ ...f, expiresAt: e.target.value }))} />
                          <div className="mp-hint">{t("announcements.editHint")}</div>
                          <div className="mp-actions">
                            <button className="mp-action" onClick={() => setEditingId(null)}>{t("common.cancel")}</button>
                            <button className="mp-action" disabled={rowBusy === m.id} onClick={() => saveEdit(m)}>{t("common.save")}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="mp-card-title">{m.title}</div>
                          <div className="mp-card-body">{m.body}</div>
                          {m.image_url && <img className="mp-card-image" src={m.image_url} alt="" />}
                          <div className="mp-card-meta">
                            {[
                              m.cta_label ? t("announcements.buttonMeta", { label: m.cta_label }) : null,
                              st === "scheduled" && m.starts_at
                                ? t("announcements.startsAt", { when: fmtDateTime(m.starts_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) })
                                : null,
                              m.expires_at && st !== "ended"
                                ? t("announcements.expiresAt", { when: fmtDateTime(m.expires_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) })
                                : null,
                            ].filter(Boolean).join(" · ")}
                          </div>
                        </>
                      )}

                      {s && st !== "scheduled" && (
                        <div className="mp-stats">
                          {/* Two counts, not one "reached": a person can be in both
                              (popped up, then read in the inbox) and the RPC
                              returns counts, not the people behind them. */}
                          {m.display_mode === "interstitial" && (
                            <div className="mp-stat">
                              <b>{s.shown}<span className="mp-of"> / {s.audience}</span></b>
                              {t("announcements.statPopped")}
                            </div>
                          )}
                          <div className="mp-stat">
                            <b>{s.opened}{m.display_mode === "inbox" && <span className="mp-of"> / {s.audience}</span>}</b>
                            {t("announcements.statOpened")}
                          </div>
                          {m.cta_kind && <div className="mp-stat"><b>{s.cta}</b>{t("announcements.statButton")}</div>}
                          {m.display_mode === "interstitial" && (
                            <div className="mp-stat">
                              <b>{s.acknowledged}</b>
                              {t(m.repeat_mode === "must_acknowledge" ? "announcements.statAcknowledged" : "announcements.statGotIt")}
                            </div>
                          )}
                          {m.discount_code_id && (
                            <>
                              <div className="mp-stat"><b>{s.claimed}</b>{t("announcements.statSaved")}</div>
                              <div className="mp-stat"><b>{s.redeemed}</b>{t("announcements.statRides")}</div>
                              <div className="mp-stat"><b>${Number(s.discounted).toFixed(2)}</b>{t("announcements.statDiscounted")}</div>
                            </>
                          )}
                        </div>
                      )}

                      {!editing && (
                        <div className="mp-actions">
                          {(st === "live" || st === "scheduled") && (
                            <>
                              <button className="mp-action" disabled={rowBusy === m.id} onClick={() => startEdit(m)}>{t("announcements.edit")}</button>
                              <button className="mp-action" disabled={rowBusy === m.id} onClick={() => endOrDelete(m, "end")}>
                                {t(st === "scheduled" ? "announcements.cancelScheduled" : "announcements.endNow")}
                              </button>
                            </>
                          )}
                          <button className="mp-action danger" disabled={rowBusy === m.id} onClick={() => endOrDelete(m, "delete")}>{t("announcements.delete")}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
