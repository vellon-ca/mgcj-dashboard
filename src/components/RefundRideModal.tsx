import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invokeFunction } from "../lib/invokeFunction";
import { formatRideRef } from "../lib/numbering";
import { COMPANY_REFUND_REASONS, REFUND_REASON_KEYS } from "../lib/labels";

/**
 * A company admin refunds a card fare charged on the company's own Stripe
 * account. The `company-refund` Edge Function does everything that matters —
 * role, company, what is left to refund (read from Stripe, not from the row
 * this modal was opened with), the refund itself, the audit event and the
 * passenger's push. This only collects amount + reason and shows the answer.
 *
 * Carries its own styles (rf-*): it opens from the live board AND from
 * Analytics, and those two pages each define their own modal classes. An older
 * ride is only reachable from Analytics — the board loads the latest 150.
 */
// i18n-ok: CSS, not copy.
const STYLES = `
  .rf-overlay { position: fixed; inset: 0; background: var(--c-scrim); display: flex; align-items: center; justify-content: center; z-index: 1100; backdrop-filter: blur(3px); }
  .rf-modal { background: var(--c-surface); color: var(--c-text); border-radius: 14px; padding: 26px; width: 100%; max-width: 420px; border: 1px solid var(--c-border); max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px var(--c-shadow); font-family: system-ui, -apple-system, sans-serif; }
  .rf-title { font-size: 17px; font-weight: 700; color: var(--c-text); margin-bottom: 20px; }
  .rf-ref { margin-left: 10px; font-size: 12px; font-weight: 600; color: var(--c-text-2); letter-spacing: 0.08em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; user-select: all; }
  .rf-label { font-size: 11px; color: var(--c-text-2); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; display: block; margin-bottom: 6px; }
  .rf-input { background: var(--c-input); border: 1px solid var(--c-border); border-radius: 8px; padding: 10px 12px; font-size: 14px; color: var(--c-text); outline: none; width: 100%; box-sizing: border-box; font-family: inherit; margin-bottom: 14px; }
  .rf-input:focus { border-color: var(--c-brand); }
  .rf-hint { font-size: 11px; line-height: 1.5; color: var(--c-text-2); margin-bottom: 12px; }
  .rf-error { color: var(--c-red); font-size: 13px; margin-bottom: 12px; }
  .rf-actions { display: flex; gap: 10px; }
  .rf-btn { flex: 1; border-radius: 8px; padding: 10px; font-size: 14px; cursor: pointer; font-family: inherit; }
  .rf-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .rf-btn.cancel { background: transparent; color: var(--c-text-2); border: 1px solid var(--c-border); }
  .rf-btn.go { background: var(--c-red-fill); color: #FFFFFF; border: none; font-weight: 600; }
`;

export default function RefundRideModal({
  ride,
  onClose,
  onDone,
}: {
  ride: { id: string; ride_ref: string; fare_final: number | null; refunded_amount_cents: number | null };
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  // What the row says is left. Only a default for the box: the server re-reads
  // the charge and refuses anything over what Stripe has.
  const remaining = Math.max(
    0,
    Math.round((ride.fare_final ?? 0) * 100) - (ride.refunded_amount_cents ?? 0),
  );
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(Number(amount) * 100);
  const amountOk = Number.isFinite(cents) && cents > 0 && cents <= remaining;
  const canSubmit = amountOk && !!reason && (reason !== "other" || note.trim().length > 0) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: err } = await invokeFunction<{
      ok?: boolean;
      code?: string;
      refunded_cents?: number;
      refund_status?: string;
    }>("company-refund", {
      ride_id: ride.id,
      amount_cents: cents,
      reason,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (err || !data?.ok) {
      // The server's `code` is a translation key under refundErr.*; its English
      // `error` is the fallback for a code this build does not know yet.
      const key = data?.code ? `refundErr.${data.code.replace(/^refund\./, "")}` : "";
      setError(key && t(key, { defaultValue: "" }) ? t(key) : (err ?? t("common.error")));
      return;
    }
    const sum = `$${((data.refunded_cents ?? cents) / 100).toFixed(2)}`;
    onDone(
      data.refund_status === "pending"
        ? t("refund.donePending", { amount: sum })
        : t("refund.done", { amount: sum }),
    );
  }

  return (
    <div className="rf-overlay" onClick={busy ? undefined : onClose}>
      <style>{STYLES}</style>
      <div className="rf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rf-title">
          {t("refund.title")}
          <span className="rf-ref">{formatRideRef(ride.ride_ref)}</span>
        </div>

        <label className="rf-label">
          {t("refund.amount", { max: `$${(remaining / 100).toFixed(2)}` })}
        </label>
        <input
          className="rf-input"
          type="number"
          min="0.01"
          step="0.01"
          max={(remaining / 100).toFixed(2)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
        />

        <label className="rf-label">{t("refund.reason")}</label>
        <select
          className="rf-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        >
          <option value="">{t("refund.chooseReason")}</option>
          {COMPANY_REFUND_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(REFUND_REASON_KEYS[r])}
            </option>
          ))}
        </select>

        <label className="rf-label">
          {reason === "other" ? t("refund.noteRequired") : t("refund.noteOptional")}
        </label>
        <textarea
          className="rf-input"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          style={{ resize: "vertical" }}
        />

        <div className="rf-hint">{t("refund.explainer")}</div>

        {error && (
          <div role="alert" className="rf-error">
            {error}
          </div>
        )}

        <div className="rf-actions">
          <button className="rf-btn cancel" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="rf-btn go" onClick={submit} disabled={!canSubmit}>
            {busy
              ? t("refund.working")
              : t("refund.confirm", { amount: amountOk ? `$${(cents / 100).toFixed(2)}` : "" }).trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
