// Settings -> Card payments: the company's own Stripe account.
//
// Design: mgcj-app/.claude/notes/direct-charges-design.md (§3, §11)
//
// Card fares are charged by the taxi company's own Stripe account. The owner
// manages it HERE, through Stripe's own screens embedded in the page (Connect
// embedded components), so they do not have to open Stripe. Things that shape
// this panel:
//
//   • "Can take cards" and "gets paid out" are two states. Stripe turned cards
//     on the moment the form was submitted while payouts waited on an ID check,
//     so one "connected" badge would be wrong for exactly the owner who needs
//     to know there is one more step.
//   • Vellon creates the account, not this page. A company without one sees a
//     short explanation and nothing from Stripe.
//   • The Stripe screens run on a short-lived account session from
//     company-card-setup `session` (admins only, own company only). The
//     publishable key comes back with it, so the page can never pair this
//     project's sessions with another project's key.
//   • Only "Business and bank details" (account management) and the banner's
//     review action ask the owner to sign in to Stripe: a tab that closes
//     itself. Measured 2026-11-12; it cannot be turned off for an account
//     where Stripe collects the verification.
//   • Refunds are NOT offered in Stripe's payments screen; they stay on the
//     ride, where the passenger is notified (see company-card-setup).
//
// The account id is read straight off the company row first, and the Edge
// Function is called only when there is one. That keeps the panel calm (not an
// error) for a company Vellon has not set up yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadConnectAndInitialize, type StripeConnectInstance } from "@stripe/connect-js";
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectBalances,
  ConnectComponentsProvider,
  ConnectDocuments,
  ConnectNotificationBanner,
  ConnectPayments,
  ConnectPayoutsList,
} from "@stripe/react-connect-js";
import { supabase } from "../lib/supabase";
import { invokeFunction } from "../lib/invokeFunction";
import { useTheme } from "../theme/ThemeContext";
import { useLocale } from "../i18n/LocaleContext";
import type { Palette } from "../theme/tokens";

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

interface Session {
  client_secret: string;
  publishable_key: string;
}

type Tone = "ok" | "wait" | "todo";

// Stripe's capability words -> what the owner needs to know. Anything Stripe
// adds later falls into "needs information".
function tone(status: string | null | undefined): Tone {
  if (status === "active") return "ok";
  if (status === "pending") return "wait";
  return "todo";
}

// A status is a dot beside plain text (src/theme/tokens.ts, rule 3).
const PILL: Record<Tone, { dot: string }> = {
  ok: { dot: "var(--c-green)" },
  wait: { dot: "var(--c-amber)" },
  todo: { dot: "var(--c-red)" },
};

const INTER_CSS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";

// Stripe's screens live in their own frames and cannot read our CSS
// variables, so they get the palette's real values.
function appearance(c: Palette) {
  return {
    overlays: "dialog" as const,
    variables: {
      fontFamily: "Inter, system-ui, sans-serif", // i18n-ok
      borderRadius: "8px",
      colorPrimary: c.brandFill,
      colorBackground: c.surface,
      colorText: c.text,
      colorSecondaryText: c.text2,
      colorBorder: c.borderStrong,
      colorDanger: c.redFill,
      buttonPrimaryColorBackground: c.brandFill,
      buttonPrimaryColorBorder: c.brandFill,
      buttonPrimaryColorText: c.onBrand,
      actionPrimaryColorText: c.brand,
    },
  };
}

// The dashboard speaks en and fr. Stripe gets a regional tag it carries.
function stripeLocale(locale: string): string {
  return locale.startsWith("fr") ? "fr-CA" : "en-US"; // i18n-ok
}

export default function CardPaymentsSection({ companyId }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { locale } = useLocale();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState<StripeConnectInstance | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  // One Connect instance per mount of this panel, as Stripe asks. The ref
  // also stops StrictMode's second effect run from making a second one.
  const initStarted = useRef(false);

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

  // Start Stripe's screens once we know there is an account. The first
  // session is fetched here because the publishable key arrives with it; it is
  // handed to Stripe once, and every later refresh asks the server again.
  useEffect(() => {
    if (status?.state !== "created" || initStarted.current) return;
    initStarted.current = true;
    (async () => {
      const first = await invokeFunction<Session>("company-card-setup", { action: "session" });
      if (first.error || !first.data?.client_secret || !first.data.publishable_key) {
        setConnectError(first.error ?? t("common.error"));
        initStarted.current = false;
        return;
      }
      let pending: string | null = first.data.client_secret;
      const instance = loadConnectAndInitialize({
        publishableKey: first.data.publishable_key,
        fetchClientSecret: async () => {
          if (pending) {
            const s = pending;
            pending = null;
            return s;
          }
          const next = await invokeFunction<Session>("company-card-setup", { action: "session" });
          if (next.error || !next.data?.client_secret) throw new Error(next.error ?? "session");
          return next.data.client_secret;
        },
        fonts: [{ cssSrc: INTER_CSS }],
        appearance: appearance(colors),
        locale: stripeLocale(locale),
      });
      setConnect(instance);
    })();
    // colors and locale are applied by the update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.state, t]);

  // Theme and language changes reach Stripe's frames without a reload.
  useEffect(() => {
    connect?.update({ appearance: appearance(colors), locale: stripeLocale(locale) });
  }, [connect, colors, locale]);

  // The old hosted form, kept as a fallback for a company still finishing
  // setup if the embedded form will not load.
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
  const setupDone = cardTone === "ok" && payoutTone === "ok" && outstanding.length === 0;

  const pill = (tn: Tone) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--c-text)",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: PILL[tn].dot, flexShrink: 0 }} />
      {t(`settings.card.status.${tn}`)}
    </span>
  );

  const block = (label: string, hint: string | null, child: React.ReactNode) => (
    <div className="st-card">
      <p className="st-card-label">{label}</p>
      {hint && (
        <p className="st-field-hint" style={{ display: "block", margin: "0 0 12px" }}>
          {hint}
        </p>
      )}
      {child}
    </div>
  );

  const onLoadError = ({ error: e }: { error: { message?: string } }) =>
    setConnectError(e?.message ?? t("common.error"));

  return (
    <>
      <div className="st-header">
        <div>
          <div className="st-title">{t("settings.sections.payments")}</div>
          <div className="st-subtitle">{t("settings.card.subtitle")}</div>
        </div>
      </div>

      {loading && !status ? (
        <div style={{ color: "var(--c-text-2)", fontSize: 14 }}>{t("common.loading")}</div>
      ) : status?.state === "not_created" ? (
        <div className="st-card">
          <p className="st-card-label">{t("settings.card.notCreatedTitle")}</p>
          <p style={{ color: "var(--c-text-2)", fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            {t("settings.card.notCreatedBody")}
          </p>
        </div>
      ) : status ? (
        <>
          {connect && (
            <ConnectComponentsProvider connectInstance={connect}>
              <div style={{ marginBottom: 16 }}>
                <ConnectNotificationBanner onLoadError={onLoadError} />
              </div>
            </ConnectComponentsProvider>
          )}

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
          </div>

          {connect && (
            <ConnectComponentsProvider connectInstance={connect}>
              {!setupDone &&
                block(
                  t("settings.card.setupTitle"),
                  t("settings.card.setupHint"),
                  <>
                    <ConnectAccountOnboarding
                      onExit={load}
                      collectionOptions={{ fields: "eventually_due" }}
                      onLoadError={onLoadError}
                    />
                    <p className="st-field-hint" style={{ display: "block", marginTop: 12 }}>
                      {t("settings.card.formFallback")}{" "}
                      <button
                        onClick={openForm}
                        disabled={opening}
                        style={{ background: "none", border: "none", color: "var(--c-brand)", cursor: "pointer", fontSize: 12, padding: 0 }}
                      >
                        {opening ? t("settings.card.opening") : t("settings.card.openStripeForm")}
                      </button>
                    </p>
                  </>,
                )}
              {block(
                t("settings.card.businessTitle"),
                t("settings.card.businessHint"),
                <ConnectAccountManagement
                  collectionOptions={{ fields: "eventually_due" }}
                  onLoadError={onLoadError}
                />,
              )}
              {block(
                t("settings.card.balanceTitle"),
                t("settings.card.balanceHint"),
                <ConnectBalances onLoadError={onLoadError} />,
              )}
              {block(t("settings.card.payoutsTitle"), null, <ConnectPayoutsList onLoadError={onLoadError} />)}
              {block(
                t("settings.card.paymentsTitle"),
                t("settings.card.paymentsHint"),
                <ConnectPayments onLoadError={onLoadError} />,
              )}
              {block(t("settings.card.documentsTitle"), null, <ConnectDocuments onLoadError={onLoadError} />)}
            </ConnectComponentsProvider>
          )}

          {!connect && !connectError && (
            <div style={{ color: "var(--c-text-2)", fontSize: 14 }}>{t("common.loading")}</div>
          )}
        </>
      ) : null}

      {(error || connectError) && (
        <p className="st-error">
          {error ?? connectError}{" "}
          <button
            onClick={() => {
              setConnectError(null);
              load();
            }}
            style={{ background: "none", border: "none", color: "var(--c-text)", textDecoration: "underline", cursor: "pointer", fontSize: 12, padding: 0 }}
          >
            {t("settings.card.retry")}
          </button>
        </p>
      )}
    </>
  );
}
