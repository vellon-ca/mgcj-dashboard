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
  stripe_processing_fee_cents?: number | null;
};

export const isDirectCharge = (r: SettlementFields): boolean =>
  !r.settlement_route && !!r.stripe_charge_account_id && r.application_fee_cents != null;

/** The stored route, or 'direct'; null when the ride has not settled either way. */
export const settlementRouteOf = (r: SettlementFields): string | null =>
  r.settlement_route ?? (isDirectCharge(r) ? "direct" : null);

/** Dollars. Each is null while the figure it needs is not recorded yet. */
export function settlementFigures(r: SettlementFields): {
  vellonFee: number | null;
  cardFee: number | null;
  net: number | null;
} {
  const vellonFee = isDirectCharge(r)
    ? (r.application_fee_cents as number) / 100
    : r.fare_final != null && r.platform_fee_percent_at_completion != null
      ? r.fare_final * (r.platform_fee_percent_at_completion / 100)
      : null;
  const cardFee = isDirectCharge(r)
    ? r.stripe_processing_fee_cents != null
      ? r.stripe_processing_fee_cents / 100
      : null
    : r.stripe_fee;
  const net =
    r.fare_final != null && vellonFee != null && cardFee != null
      ? r.fare_final - vellonFee - cardFee
      : null;
  return { vellonFee, cardFee, net };
}
