// Single client-side source of truth for phone input, normalization and display.
//
// THE RULE, and it is not ours to invent — it is already enforced in two places
// we cannot disagree with:
//   * `profiles_contact_phone_format` CHECK  (20260929000000) : ^\+[1-9][0-9]{7,14}$
//   * vellon-ops `addInvites`                                 : ^\+[1-9]\d{7,14}$
// So E.164 with 8–15 digits is the definition, and this module restates it
// rather than inventing a third dialect. If that regex ever changes, it changes
// in the migration first and here second.
//
// This is a DELIBERATE SECOND COPY of `mgcj-app/src/lib/phone.ts`, byte-for-byte
// apart from this note. The two repos share no package, and the rule is pinned
// by the migration above, so a copy that drifts is caught by the DB rejecting
// the write rather than by either client. Adding a shared package for one
// module is not worth a build-pipeline change in two repos. `src/lib/countries.ts`
// and `src/i18n/locales/countries/*.json` are copies on the same terms, and all
// four move together.
//
// WHY THIS EXISTS: every phone field in the app used to hold a fixed `+1` chip
// over an input that ran `replace(/\D/g, '')` on each keystroke and then
// `.slice(0, 10)`. Those two lines made a non-NANP number literally untypeable —
// the '+' was deleted as you typed it and the digits were truncated to ten — so
// the field was not "defaulting to Canada", it was refusing everything else.
// The server was already country-agnostic (`caller_phone_e164()` just prepends
// '+'), which is why this read as a product limit rather than a bug.
//
// The free-text half below came first and is still the paste and storage path.
// The COUNTRY-SELECTOR LAYER at the bottom is what the fields actually render:
// asking a user to remember their own dialling code AND to lead with a '+' is
// a smaller trap than the old one but still a trap.
import { COUNTRY_DIAL_CODES, MAIN_COUNTRY_BY_DIAL } from './countries'

export const E164_RE = /^\+[1-9]\d{7,14}$/

/** Max digits in any E.164 number, country code included. */
const MAX_DIGITS = 15

/**
 * Normalize typed input to E.164, or null if it cannot be parsed.
 *
 * Now reached mainly through `partsFromStored` below, since the fields collect
 * a country and a national part separately. It is still the parser for a value
 * that arrives as one opaque string — a stored row, or a paste.
 *
 * STRICT on purpose: the caller is reading something a human typed, where
 * "I could not read this" has to be distinguishable from a number. The old
 * per-screen copies returned a bare `+` or `+<digits>` for unparseable input,
 * so their return value was never on its own proof of anything and each caller
 * had to remember to pair it with a length check. One of them didn't.
 *
 * A bare 10-digit number still means Canada/US — that is every existing user,
 * and they must not have to learn a '+1' they never typed before. Bare digits
 * that are NEITHER 10 nor 11-starting-with-1 are REJECTED rather than guessed
 * at: `447911123456` typed without a '+' is far more likely a mistyped local
 * number than a deliberate UK one, and silently minting `+447911123456` from it
 * sends the OTP to a stranger.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null

  let candidate: string
  if (trimmed.startsWith('+')) {
    // An explicit '+' means the caller has told us the country code. Trust it.
    candidate = `+${digits}`
  } else if (digits.length === 10) {
    candidate = `+1${digits}`
  } else if (digits.length === 11 && digits.startsWith('1')) {
    candidate = `+${digits}`
  } else {
    return null
  }

  return E164_RE.test(candidate) ? candidate : null
}

/** `(902) 123-4567`, for up to 10 NANP digits. */
function groupNanp(digits: string): string {
  if (digits.length === 0) return ''
  if (digits.length <= 3) return `(${digits}`
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

/**
 * Render a stored E.164 number for display.
 *
 * NANP gets `+1 (902) 123-4567`; anything else is returned AS-IS rather than
 * run through a NANP regex that would no-op and leave a raw `+447911123456` on
 * screen looking like a formatting failure.
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (raw.trim().startsWith('+1') && digits.length === 11) {
    return `+1 ${groupNanp(digits.slice(1))}`
  }
  if (!raw.trim().startsWith('+') && digits.length === 10) {
    return groupNanp(digits)
  }
  return raw
}


// ───────────────────────────────────────────────────────────────────────────
// COUNTRY-SELECTOR LAYER
//
// The free-text field above ("type + and your country code") is correct and
// still underpins paste and every server-side check, but it asks the user to
// know their own dialling code and to remember the '+'. A picker removes both
// guesses, so the field splits in two: the chip owns the dialling code, the
// input owns the national number, and NEITHER holds the other's digits.
//
// THAT SPLIT IS THE WHOLE POINT. The obvious design — one text field with the
// chip *derived* from what is typed — cannot work, because dialling codes are
// not prefix-unique: '+1' is the US, Canada and ~20 Caribbean countries, '+7'
// is Russia and Kazakhstan, '+44' is the UK plus Jersey, Guernsey and the Isle
// of Man. Pick Jamaica, type a digit, and a derived chip re-resolves '+1' to
// its main country and flips to the US under your hand. So the selection is
// STATE, changed only by the user picking one or by a pasted '+'-number whose
// code disagrees with it.
// ───────────────────────────────────────────────────────────────────────────


/** The company's own region: the default chip, and the '+1' tie-break. */
export const DEFAULT_COUNTRY_ISO = 'CA'

const DIAL_BY_ISO = new Map(COUNTRY_DIAL_CODES)
const MAIN_BY_DIAL = new Map(MAIN_COUNTRY_BY_DIAL)
/** Longest dialling code first, so '+1876' tries '187'/'18' before '1'. */
const DIALS_LONGEST_FIRST = [...new Set(COUNTRY_DIAL_CODES.map(([, d]) => d))].sort(
  (a, b) => b.length - a.length,
)

/** Dialling code for an ISO 3166-1 alpha-2 code, without the '+'. */
export function dialFor(iso: string): string | null {
  return DIAL_BY_ISO.get(iso.toUpperCase()) ?? null
}

/**
 * Flag emoji for an ISO code, by offsetting each letter into the regional
 * indicator block. DECORATION ONLY — several Android builds render these as
 * tofu, so every call site must also show the dialling code as text.
 */
export function flagFor(iso: string): string {
  const code = iso.toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** Every selectable country, unsorted — the picker sorts by localized name. */
export function allCountryIsos(): string[] {
  return COUNTRY_DIAL_CODES.map(([iso]) => iso)
}

/**
 * Chip + input -> E.164, or null if the result is not a sendable number.
 *
 * The national part is stripped of its trunk prefix for the one case we can be
 * certain about: a leading '1' on a NANP number is long-distance dialling, not
 * part of the number, and people type it out of habit.
 */
export function composeE164(dial: string, national: string): string | null {
  let digits = (national ?? '').replace(/\D/g, '')
  if (dial === '1' && digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (!digits) return null
  const candidate = `+${dial}${digits}`
  return E164_RE.test(candidate) ? candidate : null
}

/**
 * Format the NATIONAL part as it is typed. `(902) 123-4567` for NANP, because
 * that is the shape the overwhelming majority of users proof-read against;
 * bare digits for everything else, because guessing group boundaries per
 * country gets them wrong and a misgrouped number reads as a mangled one.
 */
export function formatNationalInput(dial: string, raw: string): string {
  let digits = (raw ?? '').replace(/\D/g, '')
  if (dial === '1') {
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
    return groupNanp(digits.slice(0, 10))
  }
  // 15 digits total minus the country code is the E.164 ceiling.
  return digits.slice(0, MAX_DIGITS - dial.length)
}

/** Max characters `formatNationalInput` can produce, for a TextInput. */
export const NATIONAL_INPUT_MAX_LENGTH = 20

/**
 * Split a full '+'-prefixed number into a country and a national part.
 *
 * This is the paste path, and the ONE place an ambiguous dialling code is
 * resolved by guessing: a pasted '+1876…' is Jamaica but we show Canada,
 * because nothing in the digits says otherwise. That is deliberately
 * survivable — the digits, which are what gets dialled, are untouched, and
 * only the flag is approximate. It must never run over a hand-made choice.
 */
export function splitInternational(raw: string): { iso: string; national: string } | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed.startsWith('+')) return null
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) return null
  const dial = DIALS_LONGEST_FIRST.find(d => digits.startsWith(d))
  if (!dial) return null
  return { iso: isoForDial(dial), national: digits.slice(dial.length) }
}

/**
 * Which country to SHOW for a dialling code several countries share.
 * Our own region wins over libphonenumber's "main country" when it is one of
 * them, so a Canadian's stored '+1902…' shows Canada rather than the US.
 */
function isoForDial(dial: string): string {
  if (DIAL_BY_ISO.get(DEFAULT_COUNTRY_ISO) === dial) return DEFAULT_COUNTRY_ISO
  return MAIN_BY_DIAL.get(dial) ?? COUNTRY_DIAL_CODES.find(([, d]) => d === dial)?.[0] ?? DEFAULT_COUNTRY_ISO
}

/**
 * Seed the chip + input from a number already in the database.
 *
 * Bare 10 digits (or 11 starting with 1) are legacy NANP rows written before
 * anything stored a country, so they resolve to our own region rather than
 * being refused — that is every existing user.
 */
export function partsFromStored(raw: string | null | undefined): { iso: string; national: string } {
  const fallback = { iso: DEFAULT_COUNTRY_ISO, national: '' }
  if (!raw) return fallback
  const split = splitInternational(raw)
  if (split) return split
  const e164 = toE164(raw)
  return e164 ? (splitInternational(e164) ?? fallback) : { ...fallback, national: raw.replace(/\D/g, '') }
}
