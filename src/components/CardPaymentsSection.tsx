// Settings -> Card payments: the company's own Stripe account.
//
// Design: mgcj-app/.claude/notes/direct-charges-design.md (§3, §11)
//
// Card fares are charged by the taxi company's own Stripe account, so the
// owner fills in Stripe's form once, here. Three things shape this panel:
//
//   • The setup link lives FIVE MINUTES. It is minted on the click that opens
//     it and never before — a link fetched when the panel loads is dead by the
//     time someone reads the page and presses the button.
//   • "Can take cards" and "gets paid out" are two states. Stripe turned cards
//     on the moment the form was submitted while payouts waited on an ID check,
//     so one "connected" badge would be wrong for exactly the owner who needs
//     to know there is one more step.
//   • Vellon creates the account, not this page. A company without one sees a
//     short explanation and no button.
//
// The account id is read straight off the company row first, and the Edge
// Function is called only when there is one. That keeps the panel calm (not an
// error) for a company Vellon has not set up yet.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";
import { invokeFunction } from "../lib/invokeFunction";

interface Props {
  companyId: string;
}

interface SetupStatus {
  state: "created" | "not_created";
  card?: string | null;
  payouts?: string | null;
  outstanding?: string[];
  url?: string;
}

type Tone = "ok" | "wait" | "todo";

// Stripe's capability words -> what the owner needs to know. Anything Stripe
// adds later falls into "needs information", which sends them to the form.
function tone(status: string | null | undefined): Tone {
  if (status === "active") return "ok";
  if (status === "pending") return "wait";
  return "todo";
}

const PILL: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: "rgba(29,158,117,0.12)", fg: "#1D9E75" },
  wait: { bg: "rgba(245,158,11,0.12)", fg: "#F59E0B" },
  todo: { bg: "rgba(248,113,113,0.12)", fg: "#F87171" },
};

export default function CardPaymentsSection({ companyId }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: company } = await supabase
      .from("companies")
      .select("stripe_direct_account_id")
      .eq("id", companyId)
      .maybeSingle();
    if (!company?.stripe_direct_account_id) {
      setStatus({ state: "not_created" });
      setLoading(false);
      return;
    }
    const { data, error: err } = await invokeFunction<SetupStatus>("company-card-setup", {
      action: "status",
    });
    if (err || !data) setError(err ?? t("common.error"));
    else setStatus(data);
    setLoading(false);
  }, [companyId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function openForm() {
    setOpening(true);
    setError(null);
    const { data, error: err } = await invokeFunction<SetupStatus>("company-card-setup", {
      action: "link",
    });
    if (err || !data?.url) {
      setError(err ?? t("common.error"));
      setOpening(false);
      return;
    }
    // Same tab on purpose: a new tab opened after an await is a blocked popup,
    // and Stripe sends the owner back to this page when the form is done.
    window.location.assign(data.url);
  }

  const cardTone = tone(status?.card);
  const payoutTone = tone(status?.payouts);
  const outstanding = status?.outstanding ?? [];
  const done = cardTone === "ok" && payoutTone === "ok" && outstanding.length === 0;

  const pill = (tn: Tone) => (
    <span
      style={{
        background: PILL[tn].bg,
        color: PILL[tn].fg,
        borderRadius: 999,
        padding: "4px 10px",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {t(`settings.card.status.${tn}`)}
    </span>
  );

  return (
    <>
      <div className="st-header">
        <div>
          <div className="st-title">{t("settings.sections.payments")}</div>
          <div className="st-subtitle">{t("settings.card.subtitle")}</div>
        </div>
        {status?.state === "created" && (
          <button className="st-save-btn" onClick={openForm} disabled={opening || loading}>
            {opening
              ? t("settings.card.opening")
              : done
                ? t("settings.card.update")
                : t("settings.card.continue")}
          </button>
        )}
      </div>

      {loading && !status ? (
        <div style={{ color: "#6B7280", fontSize: 14 }}>{t("common.loading")}</div>
      ) : status?.state === "not_created" ? (
        <div className="st-card">
          <p className="st-card-label">{t("settings.card.notCreatedTitle")}</p>
          <p style={{ color: "#CBD5E1", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            {t("settings.card.notCreatedBody")}
          </p>
        </div>
      ) : status ? (
        <div className="st-card">
          <p className="st-card-label">{t("settings.card.accountLabel")}</p>
          <div className="st-field-row st-field-row--wide">
            <div className="st-field-text">
              <span className="st-field-label">{t("settings.card.cardRow")}</span>
              <span className="st-field-hint">{t(`settings.card.cardHint.${cardTone}`)}</span>
            </div>
            {pill(cardTone)}
          </div>
          <div className="st-field-row st-field-row--wide">
            <div className="st-field-text">
              <span className="st-field-label">{t("settings.card.payoutRow")}</span>
              <span className="st-field-hint">{t(`settings.card.payoutHint.${payoutTone}`)}</span>
            </div>
            {pill(payoutTone)}
          </div>

          {outstanding.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="st-card-label" style={{ marginBottom: 8 }}>
                {t("settings.card.outstanding")}
              </p>
              {/* Stripe's requirement codes, as sent (e.g.
                  person.verification.proof_of_liveness). Not translated or
                  reworded here: the list is open-ended on Stripe's side. */}
              <ul style={{ margin: 0, paddingLeft: 18, color: "#CBD5E1", fontSize: 13, lineHeight: 1.6 }}>
                {outstanding.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="st-field-hint" style={{ marginTop: 16, display: "block" }}>
            {t("settings.card.formNote")}
          </p>
        </div>
      ) : null}

      {error && (
        <p className="st-error">
          {error}{" "}
          <button
            onClick={load}
            style={{ background: "none", border: "none", color: "#E2E8F0", textDecoration: "underline", cursor: "pointer", fontSize: 12, padding: 0 }}
          >
            {t("settings.card.retry")}
          </button>
        </p>
      )}
    </>
  );
}
