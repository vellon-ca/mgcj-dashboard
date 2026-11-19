import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";
import { fmtDate } from "../i18n/format";

// A business's application for an account with this taxi company, sent
// through the company's link on corporate.vellon.ca (mgcj-app
// .claude/notes/business-portal-design.md). Admins approve (the account is
// created under the business with billing, ceiling and terms) or decline with
// an optional reason; the applicant is emailed either way. Rendered inside
// AccountsPage, whose ac-* styles it uses. Mockup approved 2026-11-18.

export interface Application {
  id: string;
  business_id: string;
  business_name: string;
  billing_address: string | null;
  submitted_by_email: string;
  submitted_by_name: string | null;
  contact_phone: string | null;
  expected_use: string;
  rides_per_month: string;
  note: string | null;
  status: "pending" | "approved" | "declined";
  created_at: string;
  decided_at: string | null;
  decline_reason: string | null;
  other_companies: number;
  account_id: string | null;
}

export interface ApplicationSettings {
  open: boolean;
  slug: string;
}

const RIDES_KEY: Record<string, string> = {
  under_20: "accounts.app.ridesUnder20",
  "20_50": "accounts.app.rides20_50",
  "50_100": "accounts.app.rides50_100",
  "100_250": "accounts.app.rides100_250",
  over_250: "accounts.app.ridesOver250",
};

// "$3,000" / "3000.50" -> cents; "" -> null; anything else -> undefined.
function toCents(v: string): number | null | undefined {
  const s = v.replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}

export default function AccountApplication({
  app,
  isAdmin,
  cardsActive,
  settings,
  onDecided,
  onSettings,
}: {
  app: Application;
  isAdmin: boolean;
  /** The company's own Stripe account takes cards: card billing is offered. */
  cardsActive: boolean;
  settings: ApplicationSettings | null;
  onDecided: (accountId: string | null) => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(app.business_name);
  const [ceiling, setCeiling] = useState("");
  const [terms, setTerms] = useState("");
  const [mode, setMode] = useState<"invoice" | "card">("invoice");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    const cents = toCents(ceiling);
    if (cents === undefined) {
      setError(t("accounts.app.errCeiling"));
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("ba_approve_application", {
      p_application: app.id, p_name: name, p_mode: mode,
      p_monthly_cents: cents, p_ride_cents: null, p_terms: mode === "invoice" ? terms : "",
    });
    setBusy(false);
    if (e || !data?.ok) {
      setError(data?.reason === "name_taken" ? t("accounts.errNameTaken")
        : data?.reason === "card_mode_unavailable" ? t("accounts.errCardMode")
        : t("accounts.errGeneric"));
      return;
    }
    onDecided(data.account_id as string);
  }

  async function decline() {
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("ba_decline_application", { p_application: app.id, p_reason: reason });
    setBusy(false);
    if (e || !data?.ok) {
      setError(t("accounts.errGeneric"));
      return;
    }
    onDecided(null);
  }

  return (
    <>
      <div className="ac-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ac-title">{t("accounts.app.title", { name: app.business_name })}</div>
          <div className="ac-sub">{t("accounts.app.sent", { date: fmtDate(app.created_at) })}</div>
        </div>
      </div>
      <div className="ac-grid">
        <div className="ac-col">
          <div className="ac-card">
            <div className="ac-card-label"><span>{t("accounts.app.whatTheySent")}</span></div>
            <div className="ac-kv"><span>{t("accounts.app.appliedBy")}</span><span>{app.submitted_by_name ? `${app.submitted_by_name} · ` : ""}{app.submitted_by_email}</span></div>
            {app.contact_phone && <div className="ac-kv"><span>{t("accounts.app.phone")}</span><span>{app.contact_phone}</span></div>}
            {app.billing_address && <div className="ac-kv"><span>{t("accounts.app.address")}</span><span>{app.billing_address}</span></div>}
            <div className="ac-kv"><span>{t("accounts.app.rides")}</span><span>{t(RIDES_KEY[app.rides_per_month] ?? "accounts.app.rides50_100")}</span></div>
            <div className="ac-kv"><span>{t("accounts.app.otherCompanies")}</span><span>{app.other_companies === 0 ? t("accounts.app.otherNone") : t("accounts.app.otherSome", { count: app.other_companies })}</span></div>
            <div className="ac-card-label" style={{ marginTop: 14, marginBottom: 6 }}><span>{t("accounts.app.whoRides")}</span></div>
            <div className="ac-small" style={{ color: "var(--c-text)", whiteSpace: "pre-wrap" }}>{app.expected_use}</div>
            {app.note && (
              <>
                <div className="ac-card-label" style={{ marginTop: 14, marginBottom: 6 }}><span>{t("accounts.app.note")}</span></div>
                <div className="ac-small" style={{ color: "var(--c-text)", whiteSpace: "pre-wrap" }}>{app.note}</div>
              </>
            )}
          </div>
        </div>
        <div className="ac-col">
          {app.status !== "pending" ? (
            <div className="ac-card">
              <div className="ac-small">
                {app.status === "approved"
                  ? t("accounts.app.wasApproved", { date: fmtDate(app.decided_at ?? app.created_at) })
                  : t("accounts.app.wasDeclined", { date: fmtDate(app.decided_at ?? app.created_at) })}
                {app.decline_reason ? ` ${t("accounts.app.theirReason", { reason: app.decline_reason })}` : ""}
              </div>
            </div>
          ) : (
            <div className="ac-card">
              <div className="ac-card-label"><span>{t("accounts.app.approve")}</span></div>
              <div className="ac-field">
                <label className="ac-small" htmlFor="app-name">{t("accounts.app.accountName")}</label>
                <input id="app-name" className="ac-input" maxLength={80} value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="ac-field">
                <span className="ac-small">{t("accounts.app.billing")}</span>
                <div className="ac-seg">
                  <button className={mode === "invoice" ? "on" : ""} disabled={!isAdmin} aria-pressed={mode === "invoice"} onClick={() => setMode("invoice")}>
                    {t("accounts.app.billingStatement")}
                  </button>
                  <button
                    className={mode === "card" ? "on" : ""}
                    disabled={!isAdmin || !cardsActive}
                    aria-pressed={mode === "card"}
                    title={cardsActive ? undefined : t("accounts.app.cardUnavailable")}
                    onClick={() => setMode("card")}
                  >
                    {t("accounts.app.billingCard")}
                  </button>
                </div>
              </div>
              <div className="ac-field">
                <label className="ac-small" htmlFor="app-ceiling">{t("accounts.app.ceiling")}</label>
                <input id="app-ceiling" className="ac-input" inputMode="decimal" placeholder="$3,000" value={ceiling} disabled={!isAdmin} onChange={(e) => setCeiling(e.target.value)} />
              </div>
              {mode === "invoice" ? (
                <div className="ac-field">
                  <label className="ac-small" htmlFor="app-terms">{t("accounts.app.terms")}</label>
                  <input id="app-terms" className="ac-input" maxLength={120} placeholder={t("accounts.app.termsPlaceholder")} value={terms} disabled={!isAdmin} onChange={(e) => setTerms(e.target.value)} />
                </div>
              ) : (
                <div className="ac-small" style={{ marginBottom: 12 }}>{t("accounts.billingCardNote")}</div>
              )}
              {declining && (
                <div className="ac-field">
                  <label className="ac-small" htmlFor="app-reason">{t("accounts.app.reason")}</label>
                  <textarea id="app-reason" className="ac-input" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}
              {isAdmin ? (
                <div className="ac-row-actions">
                  {declining ? (
                    <>
                      <button className="ac-btn" onClick={() => setDeclining(false)} disabled={busy}>{t("common.cancel")}</button>
                      <button className="ac-btn ac-btn-primary" onClick={decline} disabled={busy}>{t("accounts.app.declineConfirm")}</button>
                    </>
                  ) : (
                    <>
                      <button className="ac-btn" onClick={() => setDeclining(true)} disabled={busy}>{t("accounts.app.decline")}</button>
                      <button className="ac-btn ac-btn-primary" onClick={approve} disabled={busy || !name.trim()}>{t("accounts.app.approveButton")}</button>
                    </>
                  )}
                </div>
              ) : (
                <div className="ac-small">{t("accounts.app.adminOnly")}</div>
              )}
              {error && <div className="ac-error" style={{ marginTop: 8 }}>{error}</div>}
              <div className="ac-small" style={{ marginTop: 8 }}>{t("accounts.app.emailedNote")}</div>
            </div>
          )}
          <ApplicationLinkCard settings={settings} isAdmin={isAdmin} onChanged={onSettings} />
        </div>
      </div>
    </>
  );
}

// The company's link: on/off (admins) and Copy.
export function ApplicationLinkCard({
  settings,
  isAdmin,
  onChanged,
  compact = false,
}: {
  settings: ApplicationSettings | null;
  isAdmin: boolean;
  onChanged: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!settings) return null;
  const link = `corporate.vellon.ca/${settings.slug}`;

  async function toggle() {
    const { data } = await supabase.rpc("ba_set_applications_open", { p_open: !settings!.open });
    if (data?.ok) onChanged();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(`https://${link}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: the link is on screen to select */
    }
  }

  return (
    <div className={compact ? "ac-applink compact" : "ac-card"}>
      <div className="ac-card-label" style={{ marginBottom: 8 }}>
        <span>{t("accounts.app.linkTitle")}</span>
        <button
          className={`ac-switch${settings.open ? " on" : ""}`}
          role="switch"
          aria-checked={settings.open}
          aria-label={t("accounts.app.linkTitle")}
          disabled={!isAdmin}
          onClick={toggle}
        />
      </div>
      {compact ? (
        <button className="ac-btn" style={{ width: "100%" }} onClick={copy} title={link}>
          {copied ? t("accounts.app.copied") : t("accounts.app.copyLink")}
        </button>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="ac-input" readOnly value={link} aria-label={t("accounts.app.linkTitle")} onFocus={(e) => e.target.select()} />
            <button className="ac-btn" onClick={copy}>{copied ? t("accounts.app.copied") : t("accounts.app.copy")}</button>
          </div>
          <div className="ac-small" style={{ marginTop: 8 }}>
            {settings.open ? t("accounts.app.linkOn") : t("accounts.app.linkOff")}
          </div>
        </>
      )}
    </div>
  );
}
