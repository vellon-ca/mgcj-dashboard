import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";
import { fmtDate } from "../i18n/format";
import { paymentLabel } from "../lib/cardLabel";
import { zonedDayISO } from "../lib/companyZone";

// A business account's monthly statements, as the TAXI COMPANY sees them
// (mgcj-app .claude/notes/business-account-statements-design.md). The monthly
// run issues them and emails the managers; here staff read them, and admins
// record what the business paid, withdraw a wrong statement (only before any
// payment) and issue the month again. Every write is a ba_* function.

type Status = "owing" | "part_paid" | "paid" | "void";

interface Row {
  id: string;
  month: string;
  number: string;
  status: Status;
  issued_at: string;
  ride_count: number;
  total_cents: number;
  /** Recorded payments + card lines. */
  paid_cents: number;
  /** Lines already charged to the business's card (2b); never owed. */
  card_paid_cents?: number;
  /** Monthly card: the part charged to the business's card, and where that stands. */
  charge_cents?: number;
  time_zone?: string;
  charge_state?: "scheduled" | "paid" | "declined" | "not_needed" | null;
  charge_due_at?: string | null;
  charged_at?: string | null;
  charge_declined_at?: string | null;
  charge_card_brand?: string | null;
  charge_card_last4?: string | null;
  last_paid_on: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

interface Line {
  id: string;
  pickup_at: string;
  ride_month: string;
  rider_name: string;
  team_name: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  fare_cents: number;
  booking_fee_cents: number;
  total_cents: number;
  tax_rate_percent: number | null;
  ride_ref: string | null;
  /** card = already charged to the business's card (amounts net of any refund at issue). */
  kind?: "invoice" | "card" | "card_monthly";
  refunded_cents?: number;
  card_last4?: string | null;
}

interface Detail {
  statement: Row & { account_id: string; account_name: string; time_zone: string };
  lines: Line[];
  payments: { id: string; amount_cents: number; received_on: string; note: string | null;
    by_card?: boolean; card_brand?: string | null; card_last4?: string | null }[];
}

// Monthly card: the statement's charge to the business's card.
const chargeOwed = (r: Row) => (r.status === "owing" || r.status === "part_paid") && (r.charge_cents ?? 0) > 0;
const chargeScheduled = (r: Row) => chargeOwed(r) && r.charge_state === "scheduled";
const chargeDeclined = (r: Row) => chargeOwed(r) && r.charge_state === "declined";
// The shared "Visa ••4242" label (lib/cardLabel.ts); its fallback is the
// business's card when the digits are unknown.
const cardName = (brand: string | null | undefined, last4: string | null | undefined, t: (k: string, o?: Record<string, unknown>) => string) =>
  last4
    ? paymentLabel({ payment_method: "card", card_brand: brand, card_last4: last4 },
        { card: t("accounts.stCardNameNone"), cash: "", account: () => "" })
    : t("accounts.stCardNameNone");
/** "Will be charged to … on …", "Charged to … on …", "The charge to … was declined on …". */
function chargeLine(
  r: Row,
  t: (k: string, o?: Record<string, unknown>) => string,
  fmtDate: (iso: string, o: Intl.DateTimeFormatOptions) => string,
): string | null {
  const day = (iso: string) => fmtDate(iso, { month: "long", day: "numeric", timeZone: r.time_zone });
  const card = cardName(r.charge_card_brand, r.charge_card_last4, t);
  if (r.charge_state === "paid" && r.charged_at) return t("accounts.stChargedLine", { card, date: day(r.charged_at) });
  if (chargeDeclined(r) && r.charge_declined_at) return t("accounts.stChargeDeclinedLine", { card, date: day(r.charge_declined_at) });
  if (chargeScheduled(r) && r.charge_due_at) return t("accounts.stChargeScheduledLine", { date: day(r.charge_due_at) });
  return null;
}

/** A month that was all card: already paid, by the business's card. */
const allCard = (r: Row) => r.status === "paid" && (r.card_paid_cents ?? 0) >= r.total_cents;
/** The status as read: "Paid by card" for an all-card month, and "Owing" while
    only the card lines are paid (nothing has been paid on the rest yet). */
const statusKey = (r: Row) =>
  allCard(r) ? "accounts.stPaidByCard"
  : r.status === "part_paid" && r.paid_cents <= (r.card_paid_cents ?? 0) ? STATUS.owing.key
  : STATUS[r.status].key;

const STATUS: Record<Status, { key: string; color: string }> = {
  owing: { key: "accounts.stOwing", color: "var(--c-amber)" },
  part_paid: { key: "accounts.stPartPaid", color: "var(--c-amber)" },
  paid: { key: "accounts.stPaid", color: "var(--c-green)" },
  void: { key: "accounts.stVoid", color: "var(--c-text-3)" },
};

function useMoney() {
  const { i18n } = useTranslation();
  return (cents: number) =>
    new Intl.NumberFormat(i18n.language, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" }).format(
      Number(cents) / 100,
    );
}

// A month or a received-on date is a calendar DATE: formatted in UTC, where its
// midnight is still that day, never through the company's zone.
const dateOnly = (iso: string, opts: Intl.DateTimeFormatOptions) => fmtDate(`${iso}T00:00:00Z`, { ...opts, timeZone: "UTC" });
const monthName = (iso: string) => dateOnly(iso, { month: "long", year: "numeric" });

export default function AccountStatements({
  accountId,
  isAdmin,
  usage,
  onChanged,
}: {
  accountId: string;
  isAdmin: boolean;
  /** This month's running total (ba_account_usage), shown as the first row. */
  usage: { month: string; used_cents: number } | null;
  /** The balance moved: the account list's "owing" needs a reload. */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const money = useMoney();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [owing, setOwing] = useState(0);
  const [version, setVersion] = useState(0);
  const [paying, setPaying] = useState<Row | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc("ba_list_statements", { p_account: accountId }).then(({ data, error: e }) => {
      if (!alive) return;
      if (e || !data?.ok) {
        setError(t("accounts.errLoad"));
        return;
      }
      setRows(data.statements as Row[]);
      setOwing(Number(data.owing_cents));
    });
    return () => {
      alive = false;
    };
  }, [accountId, version, t]);

  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  async function reissue(r: Row) {
    setError(null);
    const { data, error: e } = await supabase.rpc("ba_reissue_statement", { p_account: accountId, p_month: r.month });
    if (e || !data?.ok) {
      setError(
        data?.reason === "nothing_to_bill"
          ? t("accounts.errReissueNothing")
          : data?.reason === "already_issued"
            ? t("accounts.errReissueAlready")
            : t("accounts.errGeneric"),
      );
      return;
    }
    reload();
  }

  // A withdrawn month with no live statement can be issued again.
  const liveMonths = new Set((rows ?? []).filter((r) => r.status !== "void").map((r) => r.month));
  const nextIssue = usage
    ? fmtDate(new Date(Date.UTC(+usage.month.slice(0, 4), +usage.month.slice(5, 7), 1)), { month: "short", day: "numeric", timeZone: "UTC" })
    : "";

  return (
    <div className="ac-card">
      <style>{`
        .as-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--c-border-subtle); }
        .as-name { font-size: 13px; font-weight: 600; color: var(--c-text); }
        .as-amt { font-size: 13px; font-weight: 600; color: var(--c-text); text-align: right; }
        .as-sub { font-size: 11px; color: var(--c-text-2); display: flex; align-items: center; gap: 6px; }
        .as-acts { display: flex; gap: 12px; justify-content: flex-end; }
        .as-void .as-name, .as-void .as-amt { color: var(--c-text-3); }
      `}</style>
      <div className="ac-card-label">
        <span>{t("accounts.statementsTitle")}</span>
        <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--c-text)" }}>
          {t("accounts.owing")} <b>{money(owing)}</b>
        </span>
      </div>
      {error && <div className="ac-small" style={{ color: "var(--c-red)", marginBottom: 8 }}>{error}</div>}
      {usage && (
        <div className="ac-kv" style={{ paddingBottom: 10 }}>
          <span>{t("accounts.notIssued", { month: dateOnly(usage.month, { month: "long" }) })}</span>
          <span className="ac-muted">{t("accounts.soFar", { amount: money(usage.used_cents), date: nextIssue })}</span>
        </div>
      )}
      {rows === null ? (
        <div className="ac-small">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="ac-small" style={{ padding: "6px 0" }}>{t("accounts.statementsNone")}</div>
      ) : (
        rows.map((r) => (
          <div key={r.id} className={`as-row${r.status === "void" ? " as-void" : ""}`}>
            <span className="as-name">
              {dateOnly(r.month, { month: "long" })} · {r.number}
            </span>
            <span className="as-amt">{money(r.total_cents)}</span>
            <span className="as-sub">
              <span className="ac-dot" style={{ background: chargeDeclined(r) ? "var(--c-red)" : STATUS[r.status].color }} />
              {chargeDeclined(r)
                ? t("accounts.stChargeDeclined")
                : chargeScheduled(r) && r.charge_due_at
                ? t("accounts.stChargeOn", { date: fmtDate(r.charge_due_at, { month: "short", day: "numeric", timeZone: r.time_zone }) })
                : r.status === "paid" && r.last_paid_on
                ? t("accounts.stPaidOn", { date: dateOnly(r.last_paid_on, { month: "short", day: "numeric" }) })
                : t("accounts.stLine", {
                    status: t(statusKey(r)),
                    date: fmtDate(r.issued_at, { month: "short", day: "numeric" }),
                    count: r.ride_count,
                  })}
            </span>
            <span className="as-acts">
              {isAdmin && (r.status === "owing" || r.status === "part_paid") && (
                <button className="ac-linkbtn" onClick={() => setPaying(r)}>{t("accounts.recordPayment")}</button>
              )}
              {isAdmin && r.status === "void" && !liveMonths.has(r.month) && (
                <button className="ac-linkbtn" onClick={() => reissue(r)}>{t("accounts.issueAgain")}</button>
              )}
              <button className="ac-linkbtn" onClick={() => setOpenId(r.id)}>{t("accounts.open")}</button>
            </span>
          </div>
        ))
      )}
      <div className="ac-small" style={{ marginTop: 8 }}>{t("accounts.statementsNote")}</div>

      {paying && (
        <PaymentDialog
          row={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            reload();
          }}
        />
      )}
      {openId && (
        <StatementDialog
          id={openId}
          isAdmin={isAdmin}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function PaymentDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const amountId = useId();
  const dateId = useId();
  const noteId = useId();
  const owing = row.total_cents - row.paid_cents;
  const [amount, setAmount] = useState((owing / 100).toFixed(2));
  const [date, setDate] = useState(zonedDayISO());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cents = (() => {
    const s = amount.replace(/[,$\s]/g, "");
    return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : 0;
  })();

  async function submit() {
    if (cents <= 0) return setMsg(t("accounts.errPayAmount"));
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("ba_record_payment", {
      p_statement: row.id,
      p_amount_cents: cents,
      p_received_on: date,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error || !data?.ok) {
      setMsg(
        data?.reason === "over_owing"
          ? t("accounts.errPayOver", { amount: money(Number(data.owing_cents)) })
          : data?.reason === "bad_date"
            ? t("accounts.errPayDate")
            : t("accounts.errGeneric"),
      );
      return;
    }
    onDone();
  }

  return (
    <div className="ac-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ac-form" role="dialog" aria-label={t("accounts.payTitle")}>
        <div className="ac-form-title">{t("accounts.payTitle")}</div>
        <div className="ac-form-sub">
          {t("accounts.paySub", { number: row.number, month: monthName(row.month), amount: money(owing) })}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <div className="ac-field" style={{ flex: 1 }}>
            <label className="ac-label" htmlFor={amountId}>{t("accounts.payAmount")}</label>
            <div className="ac-money">
              <span>$</span>
              <input id={amountId} inputMode="decimal" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="ac-field" style={{ flex: 1 }}>
            <label className="ac-label" htmlFor={dateId}>{t("accounts.payDate")}</label>
            <input id={dateId} className="ac-input" type="date" value={date} max={zonedDayISO()} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div className="ac-field">
          <label className="ac-label" htmlFor={noteId}>{t("accounts.payNote")}</label>
          <input
            id={noteId}
            className="ac-input"
            maxLength={200}
            value={note}
            placeholder={t("accounts.payNotePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="ac-small">{t("accounts.payHint")}</div>
        {msg && <div className="ac-small" style={{ color: "var(--c-red)", marginTop: 8 }}>{msg}</div>}
        <div className="ac-row-actions" style={{ marginTop: 18 }}>
          <button className="ac-btn" style={{ flex: 1 }} onClick={onClose} type="button">{t("common.cancel")}</button>
          <button className="ac-btn ac-btn-primary" style={{ flex: 1 }} disabled={busy || cents <= 0} onClick={submit} type="button">
            {t("accounts.payRecord", { amount: money(cents) })}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatementDialog({
  id,
  isAdmin,
  onClose,
  onChanged,
}: {
  id: string;
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const money = useMoney();
  const reasonId = useId();
  const [d, setD] = useState<Detail | null>(null);
  const [version, setVersion] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc("ba_get_statement", { p_statement: id }).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data?.ok) return setMsg(t("accounts.errLoad"));
      setD(data as Detail);
    });
    return () => {
      alive = false;
    };
  }, [id, version, t]);

  async function removePayment(p: Detail["payments"][number]) {
    if (!window.confirm(t("accounts.confirmRemovePayment", { amount: money(p.amount_cents) }))) return;
    const { data, error } = await supabase.rpc("ba_remove_payment", { p_payment: p.id });
    if (error || !data?.ok) return setMsg(t("accounts.errGeneric"));
    setVersion((v) => v + 1);
    onChanged();
  }

  async function withdraw() {
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("ba_void_statement", { p_statement: id, p_reason: reason.trim() });
    setBusy(false);
    if (error || !data?.ok) {
      setMsg(data?.reason === "has_payments" ? t("accounts.voidHasPayments") : t("accounts.errGeneric"));
      return;
    }
    setReason("");
    setVersion((v) => v + 1);
    onChanged();
  }

  const s = d?.statement;
  // Payments staff recorded; card lines alone never stop a void.
  const cardPaid = s?.card_paid_cents ?? 0;
  const recorded = s ? s.paid_cents - cardPaid : 0;
  const zoned = (iso: string) =>
    fmtDate(iso, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: s?.time_zone });

  return (
    <div className="ac-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <style>{`
        .as-dlg { max-width: 860px !important; max-height: 88vh; overflow-y: auto; }
        .as-lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
        .as-lines th { text-align: left; font-size: 10px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--c-border-subtle); }
        .as-lines td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--c-border-subtle); color: var(--c-text); vertical-align: top; }
        .as-lines .num { text-align: right; white-space: nowrap; }
        .as-chip { font-size: 10px; font-weight: 600; color: var(--c-text-2); border: 1px solid var(--c-border-strong); border-radius: 5px; padding: 0 5px; margin-left: 6px; }
        .as-section { margin-top: 16px; }
      `}</style>
      <div className="ac-form as-dlg" role="dialog" aria-label={s ? t("accounts.stTitle", { number: s.number }) : undefined}>
        {!d || !s ? (
          <div className="ac-small">{msg ?? t("common.loading")}</div>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div className="ac-form-title">{t("accounts.stTitle", { number: s.number })}</div>
                <div className="ac-form-sub" style={{ marginBottom: 6 }}>
                  {s.account_name} · {monthName(s.month)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="ac-form-title">{money(s.total_cents)}</div>
                <div className="as-sub" style={{ justifyContent: "flex-end" }}>
                  <span className="ac-dot" style={{ background: STATUS[s.status].color }} />
                  {t(statusKey(s))}
                  {(s.status === "owing" || s.status === "part_paid") && ` · ${money(s.total_cents - s.paid_cents)}`}
                </div>
              </div>
            </div>
            {chargeLine(s, t, fmtDate) && (
              <div className="ac-small" style={{ marginTop: 6, color: chargeDeclined(s) ? "var(--c-red-text)" : undefined }}>
                {chargeLine(s, t, fmtDate)}
              </div>
            )}
            {s.status === "void" && s.voided_at && (
              <div className="ac-small" style={{ marginTop: 6 }}>
                {t("accounts.voidedNote", { date: fmtDate(s.voided_at, { month: "short", day: "numeric" }), reason: s.void_reason ?? "" })}
              </div>
            )}

            <div className="as-section">
              <div className="ac-card-label" style={{ marginBottom: 0 }}>
                <span>{t("accounts.stRides")} · {d.lines.length}</span>
              </div>
              <table className="as-lines">
                <thead>
                  <tr>
                    <th>{t("accounts.colPickup")}</th>
                    <th>{t("accounts.colRider")}</th>
                    <th>{t("accounts.colTeam")}</th>
                    <th>{t("accounts.colFromTo")}</th>
                    <th className="num">{t("accounts.colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l) => (
                    <tr key={l.id}>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {zoned(l.pickup_at)}
                        {l.ride_month !== s.month && <span className="as-chip">{dateOnly(l.ride_month, { month: "short" })}</span>}
                      </td>
                      <td>{l.rider_name}</td>
                      <td className="ac-muted">{l.team_name ?? t("accounts.noTeam")}</td>
                      <td className="ac-muted">{l.pickup_address} → {l.dropoff_address}</td>
                      <td className="num">
                        {l.kind === "card" && (
                          <span className="as-chip" style={{ marginLeft: 0, marginRight: 6 }}>
                            {l.card_last4 ? t("accounts.stCardMark", { last4: l.card_last4 }) : t("accounts.stCardMarkNoDigits")}
                            {(l.refunded_cents ?? 0) > 0 && " *"}
                          </span>
                        )}
                        {money(l.total_cents)}
                      </td>
                    </tr>
                  ))}
                  {cardPaid > 0 && (
                    <>
                      <tr>
                        <td colSpan={4}>{t("accounts.stPaidByCard")}</td>
                        <td className="num">{money(-cardPaid)}</td>
                      </tr>
                      <tr>
                        <td colSpan={4}><b>{t("accounts.stToPay")}</b></td>
                        <td className="num"><b>{money(s.total_cents - cardPaid)}</b></td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
              {d.lines.some((l) => (l.refunded_cents ?? 0) > 0) && <div className="ac-small" style={{ marginTop: 6 }}>{t("accounts.stRefundedNote")}</div>}
              {d.lines.some((l) => l.ride_month !== s.month) && <div className="ac-small" style={{ marginTop: 6 }}>{t("accounts.lateMonth")}</div>}
            </div>

            {d.payments.length > 0 && (
              <div className="as-section">
                <div className="ac-card-label" style={{ marginBottom: 4 }}>
                  <span>{t("accounts.stPayments")}</span>
                </div>
                {d.payments.map((p) => (
                  <div key={p.id} className="ac-li">
                    <div className="ac-li-main">
                      {dateOnly(p.received_on, { dateStyle: "medium" })}
                      {p.note && <span className="ac-muted"> · {p.note}</span>}
                      {p.by_card && (
                        <span className="ac-muted"> · {t("accounts.stChargedTo", { card: cardName(p.card_brand, p.card_last4, t) })}</span>
                      )}
                    </div>
                    <b>{money(p.amount_cents)}</b>
                    {isAdmin && !p.by_card && (
                      <button className="ac-linkbtn danger" onClick={() => removePayment(p)}>{t("accounts.stRemovePayment")}</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isAdmin && s.status !== "void" && (
              <div className="as-section">
                <div className="ac-card-label" style={{ marginBottom: 4 }}>
                  <span>{t("accounts.voidTitle")}</span>
                </div>
                <div className="ac-small" style={{ marginBottom: 8 }}>
                  {recorded > 0 ? t("accounts.voidHasPayments") : t("accounts.voidNote")}
                </div>
                {recorded === 0 && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      id={reasonId}
                      className="ac-input"
                      maxLength={300}
                      aria-label={t("accounts.voidReason")}
                      placeholder={t("accounts.voidReason")}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button className="ac-btn" style={{ color: "var(--c-red)" }} disabled={busy || !reason.trim()} onClick={withdraw}>
                      {t("accounts.voidButton")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {msg && <div className="ac-small" style={{ color: "var(--c-red)", marginTop: 8 }}>{msg}</div>}
            <div className="ac-row-actions" style={{ marginTop: 18, justifyContent: "flex-end" }}>
              <button className="ac-btn" onClick={onClose} type="button">{t("common.close")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
