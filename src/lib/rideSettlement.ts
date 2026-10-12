// Where a completed card ride's money went, and what came off it.
//
// Two kinds of card ride exist (mgcj-app/.claude/notes/direct-charges-design.md):
//
//   platform — charged on Vellon's account, the company's share transferred.
//              `settlement_route` says how that transfer went; Vellon's fee is
//              fare x the frozen percent and Stripe's cost is `stripe_fee`.
//   direct   — charged on the company's OWN Stripe account. There is no
//              transfer and so no stored route. Vellon's fee is the application
//              fee Stripe took at capture and Stripe's cost is billed to the
//              company; both are recorded in cents.
//
// 'direct' is derived here exactly as the company_settlement_* RPCs derive it
// (charge account set AND a fee recorded). Keep the two in step, or a rollup
// row stops matching its own drilldown.

export type SettlementFields = {
  fare_final: number | null;
  settlement_route: string | null;
  stripe_fee: number | null;
  platform_fee_percent_at_completion: number | null;
  stripe_charge_account_id?: string | null;
  application_fee_cents?: number | null;
  application_fee_tax_cents?: number | null;
  stripe_processing_fee_cents?: number | null;
  refunded_amount_cents?: number | null;
};

export const isDirectCharge = (r: SettlementFields): boolean =>
  !r.settlement_route && !!r.stripe_charge_account_id && r.application_fee_cents != null;

/** The stored route, or 'direct'; null when the ride has not settled either way. */
export const settlementRouteOf = (r: SettlementFields): string | null =>
  r.settlement_route ?? (isDirectCharge(r) ? "direct" : null);

/** Dollars. Each is null while the figure it needs is not recorded yet. */
export function settlementFigures(r: SettlementFields): {
  vellonFee: number | null;
  /** GST/HST Vellon added on top of its fee; 0 when the fee was not taxed. */
  feeTax: number;
  cardFee: number | null;
  net: number | null;
} {
  // On a direct charge Stripe's application fee is Vellon's fee PLUS the tax
  // on it. Shown as two rows so the fee still reads as the agreed percent.
  const feeTax = isDirectCharge(r) ? (r.application_fee_tax_cents ?? 0) / 100 : 0;
  const vellonFee = isDirectCharge(r)
    ? (r.application_fee_cents as number) / 100 - feeTax
    : r.fare_final != null && r.platform_fee_percent_at_completion != null
      ? r.fare_final * (r.platform_fee_percent_at_completion / 100)
      : null;
  const cardFee = isDirectCharge(r)
    ? r.stripe_processing_fee_cents != null
      ? r.stripe_processing_fee_cents / 100
      : null
    : r.stripe_fee;
  // A refund on a direct charge comes out of the company's own balance, so it
  // comes off the net. (On a platform charge it moves through the transfer
  // clawback, shown on its own row.) Stripe does not return its cost.
  const refunded = isDirectCharge(r) ? (r.refunded_amount_cents ?? 0) / 100 : 0;
  const net =
    r.fare_final != null && vellonFee != null && cardFee != null
      ? r.fare_final - vellonFee - feeTax - cardFee - refunded
      : null;
  return { vellonFee, feeTax, cardFee, net };
}

/** Whether the dashboard should offer Refund on this ride. The server decides
 *  for real, from Stripe; this only hides the button where it cannot work. */
export const canOfferRefund = (
  r: SettlementFields & { payment_method: string; payment_status: string | null; stripe_dispute_id?: string | null },
): boolean =>
  r.payment_method === "card" &&
  isDirectCharge(r) &&
  r.payment_status === "succeeded" &&
  !r.stripe_dispute_id &&
  Math.round((r.fare_final ?? 0) * 100) - (r.refunded_amount_cents ?? 0) > 0;
