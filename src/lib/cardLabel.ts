// How a receipt names a payment: "Apple Pay ••1234", "Visa ••4242",
// "Card ••1234" (a brand we have no name for), "Card" (no details: a ride from
// before mgcj-app's 20261023010000), "Cash".
//
// The facts (card_brand / card_last4 / card_wallet) are frozen on the ride by
// capture-payment and copied into ride_receipts by send-ride-receipt. This is
// the second copy of the formatter; the first is mgcj-app
// supabase/functions/_shared/cardLabel.ts, which renders the emailed receipt.
// Change both.

export type CardFacts = {
  payment_method?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  card_wallet?: string | null;
};

const WALLET_NAMES: Record<string, string> = {
  apple_pay: "Apple Pay", // i18n-ok: trademark
  google_pay: "Google Pay", // i18n-ok: trademark
  samsung_pay: "Samsung Pay", // i18n-ok: trademark
  link: "Link",
};

const BRAND_NAMES: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express", // i18n-ok: trademark
  discover: "Discover",
  interac: "Interac",
  jcb: "JCB",
  unionpay: "UnionPay",
  diners: "Diners Club", // i18n-ok: trademark
  cartes_bancaires: "Cartes Bancaires", // i18n-ok: trademark
  eftpos_au: "eftpos",
};

/**
 * `words` are the locale's "Card" and "Cash". Brand and wallet names are
 * trademarks and are not translated. NULL payment_method gives "—".
 */
export function paymentLabel(row: CardFacts, words: { card: string; cash: string }): string {
  if (!row.payment_method) return "—";
  if (row.payment_method === "cash") return words.cash;
  const last4 = row.card_last4 && /^\d{4}$/.test(row.card_last4) ? row.card_last4 : null;
  if (!last4) return words.card;
  const name = (row.card_wallet && WALLET_NAMES[row.card_wallet])
    || (row.card_brand && BRAND_NAMES[row.card_brand])
    || words.card;
  return `${name} ••${last4}`;
}
