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
 * Rendered inside DashboardPage, whose <style> block defines the db-modal-*
 * classes.
 */
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
    <div className="db-modal-overlay" style={{ zIndex: 1100 }} onClick={busy ? undefined : onClose}>
      <div className="db-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-title">
          {t("refund.title")}
          <span className="db-ride-ref">{formatRideRef(ride.ride_ref)}</span>
        </div>

        <label className="db-modal-label">
          {t("refund.amount", { max: `$${(remaining / 100).toFixed(2)}` })}
        </label>
        <input
          className="db-modal-input"
          type="number"
          min="0.01"
          step="0.01"
          max={(remaining / 100).toFixed(2)}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          style={{ marginBottom: 14 }}
        />

        <label className="db-modal-label">{t("refund.reason")}</label>
        <select
          className="db-modal-select"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          style={{ marginBottom: 14 }}
        >
          <option value="">{t("refund.chooseReason")}</option>
          {COMPANY_REFUND_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(REFUND_REASON_KEYS[r])}
            </option>
          ))}
        </select>

        <label className="db-modal-label">
          {reason === "other" ? t("refund.noteRequired") : t("refund.noteOptional")}
        </label>
        <textarea
          className="db-modal-input"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          style={{ marginBottom: 12, resize: "vertical" }}
        />

        <div className="db-modal-hint" style={{ marginBottom: 12 }}>
          {t("refund.explainer")}
        </div>

        {error && (
          <div role="alert" style={{ color: "#F87171", fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10 }}>
          <button className="db-modal-cancel-btn" style={{ flex: 1 }} onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button
            className="db-modal-submit-btn"
            style={{ flex: 1, opacity: canSubmit ? 1 : 0.5 }}
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy
              ? t("refund.working")
              : t("refund.confirm", { amount: amountOk ? `$${(cents / 100).toFixed(2)}` : "" }).trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
