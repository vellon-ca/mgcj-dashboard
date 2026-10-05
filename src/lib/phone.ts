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
// 100-line module is not worth a build-pipeline change in two repos.
//
// WHY THIS EXISTS: every phone field used to hold a fixed `+1` chip
// over an input that ran `replace(/\D/g, '')` on each keystroke and then
// `.slice(0, 10)`. Those two lines made a non-NANP number literally untypeable —
// the '+' was deleted as you typed it and the digits were truncated to ten — so
// the field was not "defaulting to Canada", it was refusing everything else.
// The server was already country-agnostic (`caller_phone_e164()` just prepends
// '+'), which is why this read as a product limit rather than a bug.
export const E164_RE = /^\+[1-9]\d{7,14}$/

/** Max digits in any E.164 number, country code included. */
const MAX_DIGITS = 15

/**
 * Normalize typed input to E.164, or null if it cannot be parsed.
 *
 * STRICT on purpose: every caller is validating something a human typed, where
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

/** True if `raw` parses to a number we can actually send an OTP to. */
export function isValidPhone(raw: string | null | undefined): boolean {
  return toE164(raw) !== null
}

/**
 * Format input as the user types, PRESERVING a leading '+'.
 *
 * NANP numbers keep the familiar `(902) 123-4567` grouping, because that is
 * what the overwhelming majority of users are typing and it is the format they
 * proof-read against. Everything else is rendered as plain `+<digits>` with no
 * grouping at all — deliberately. Guessing group boundaries for an arbitrary
 * country gets them wrong, and a number displayed in the wrong shape reads as
 * "this app has mangled my number", which is worse than no grouping.
 */
export function formatPhoneInput(raw: string): string {
  if (!raw) return ''
  const hasPlus = raw.trimStart().startsWith('+')
  let digits = raw.replace(/\D/g, '').slice(0, MAX_DIGITS)

  if (!hasPlus) {
    // Local NANP entry. A leading '1' is the long-distance prefix, not part of
    // the number, so drop it once the 11th digit makes that unambiguous.
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
    return groupNanp(digits.slice(0, 10))
  }

  if (digits.startsWith('1') && digits.length <= 11) {
    const rest = digits.slice(1)
    return rest ? `+1 ${groupNanp(rest)}` : '+1'
  }
  return `+${digits}`
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

/** Longest string `formatPhoneInput` can produce — for an input maxLength. */
export const PHONE_INPUT_MAX_LENGTH = 20
