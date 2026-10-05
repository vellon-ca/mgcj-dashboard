// Dialling-code chip + national-number input, as one control.
//
// The web half of mgcj-app's `PhoneNumberField`/`usePhoneField` pair, on the
// same terms as `src/lib/phone.ts`: a deliberate second copy, because the two
// repos share no package. The MODEL is the part that must not drift —
// selection is state, the input never holds a dialling code, and the two
// therefore cannot contradict each other. See `src/lib/phone.ts` for why a
// chip derived from the typed text cannot work.
//
// Dispatch is arguably the field that needed this most: a dispatcher is typing
// a number somebody read to them over the phone, and a driver invite built as
// `"+1" + digits` for an international driver fails later as "invalid invite
// code", which names nothing about the phone number.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_COUNTRY_ISO,
  NATIONAL_INPUT_MAX_LENGTH,
  allCountryIsos,
  composeE164,
  dialFor,
  flagFor,
  formatNationalInput,
  partsFromStored,
  splitInternational,
} from "../lib/phone";

export type PhoneField = {
  country: string;
  dial: string;
  national: string;
  e164: string | null;
  valid: boolean;
  setCountry: (iso: string) => void;
  onChangeNational: (text: string) => void;
  clear: () => void;
};

export function usePhoneField(initial?: string | null): PhoneField {
  const seed = useMemo(() => partsFromStored(initial), [initial]);
  const [country, setCountryState] = useState(seed.iso);
  const [national, setNational] = useState(() =>
    formatNationalInput(dialFor(seed.iso) ?? "1", seed.national),
  );

  const dial = dialFor(country) ?? dialFor(DEFAULT_COUNTRY_ISO)!;

  const setCountry = useCallback((iso: string) => {
    const next = dialFor(iso);
    if (!next) return;
    setCountryState(iso);
    // Re-format rather than keep the string: moving +1 -> +44 has to drop the
    // NANP brackets, or the field reads "(791) 112-3456" for a UK number.
    setNational((prev) => formatNationalInput(next, prev));
  }, []);

  const onChangeNational = useCallback(
    (text: string) => {
      // A '+' means a full international number was pasted into the national
      // field — the common case here, since dispatch pastes from notes. Hand
      // the country code to the chip rather than letting it become national
      // digits, which would dial +1 447 911 2345 for a UK number.
      if (text.trimStart().startsWith("+")) {
        const split = splitInternational(text);
        if (split) {
          const d = dialFor(split.iso)!;
          setCountryState(split.iso);
          setNational(formatNationalInput(d, split.national));
          return;
        }
        // Still being typed: "+4" matches no dialling code yet. Hold it
        // verbatim so the next keystroke can complete it.
        setNational(text.replace(/[^\d+]/g, "").slice(0, 5));
        return;
      }
      setNational(formatNationalInput(dial, text));
    },
    [dial],
  );

  // Resets the COUNTRY as well, which is where this copy deliberately differs
  // from the app's. A dispatcher's field is reused by whoever books next: one
  // international booking would otherwise leave the chip on +44, and the next
  // local 10-digit number becomes +447785551234 — accepted, dialled, and
  // complained about by nobody. In the app the chip is one person's own
  // country and staying put is right.
  const clear = useCallback(() => {
    setNational("");
    setCountryState(DEFAULT_COUNTRY_ISO);
  }, []);

  const e164 = composeE164(dial, national);
  return { country, dial, national, e164, valid: e164 !== null, setCountry, onChangeNational, clear };
}

/**
 * Fold a string for searching: lower-case, accents removed, non-alphanumerics
 * dropped — so "cote divoire" finds "Côte d'Ivoire". An explicit map rather
 * than `\p{Diacritic}`, to stay identical to the app's copy.
 */
const FOLD: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", ā: "a", ą: "a",
  ç: "c", ć: "c", č: "c",
  è: "e", é: "e", ê: "e", ë: "e", ē: "e", ę: "e", ě: "e",
  ì: "i", í: "i", î: "i", ï: "i", ī: "i",
  ñ: "n", ń: "n", ň: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", ō: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ū: "u", ů: "u",
  ý: "y", ÿ: "y",
  ß: "ss", ł: "l", ś: "s", š: "s", ż: "z", ź: "z", ž: "z", ť: "t", ð: "d", þ: "th", æ: "ae", œ: "oe",
};

function fold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const mapped = FOLD[ch] ?? ch;
    if (/[a-z0-9]/.test(mapped) || mapped.length > 1) out += mapped;
  }
  return out;
}

/** Spoken names that appear in no CLDR list. Kept in step with the app's copy. */
const ALIASES: Record<string, string[]> = {
  GB: ["uk", "england", "scotland", "wales", "britain", "greatbritain", "angleterre", "ecosse", "royaumeuni"],
  US: ["usa", "america", "unitedstates", "etatsunis"],
  AE: ["uae", "dubai", "abudhabi", "emirats"],
  KR: ["southkorea", "coreedusud"],
  NL: ["holland", "hollande"],
  CI: ["ivorycoast"],
  CV: ["capeverde"],
  CD: ["drc", "congokinshasa"],
  MM: ["burma"],
  CZ: ["czechrepublic", "republiquetcheque"],
  TR: ["turkey"],
  CH: ["switzerland", "suisse"],
  DE: ["germany", "deutschland", "allemagne"],
  CN: ["china", "chine"],
  IN: ["india", "inde"],
};

// ── Caret preservation ─────────────────────────────────────────────────────
//
// The input is controlled and its value is RE-FORMATTED on every keystroke, so
// after an edit the DOM string React writes back is not the string the browser
// just produced. A browser given a new value puts the caret at the end — which
// is exactly wrong for the thing a dispatcher does most: hearing "no, 555, not
// 556", clicking into the middle of the number and correcting one digit. The
// caret has to stay where the correction is.
//
// The position is carried across the re-format as a COUNT OF DIGITS, not a
// character offset: the separators move. "(902) 55|5-1234" is "7 digits to my
// left" both before and after formatting, whatever brackets and dashes the
// formatter decides to put in.
function digitsBefore(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (/\d/.test(text[i])) n++;
  return n;
}

/** The character offset just after the nth digit of `text`. */
function offsetAfterDigits(text: string, n: number): number {
  if (n <= 0) {
    // Before the first digit, not offset 0: that would park the caret to the
    // left of the "(" the formatter adds, where the next keystroke types
    // outside the bracket.
    const first = text.search(/\d/);
    return first === -1 ? text.length : first;
  }
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i])) {
      seen++;
      if (seen === n) return i + 1;
    }
  }
  return text.length;
}

type Props = {
  field: PhoneField;
  /** Which surface it sits on — the two differ in background only. */
  variant?: "panel" | "modal";
  autoFocus?: boolean;
  required?: boolean;
  onBlur?: () => void;
  /** Fires on every edit, for state that a changed number invalidates. */
  onEdit?: () => void;
};

export default function PhoneInput({ field, variant = "panel", autoFocus, required, onBlur, onEdit }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Digit count to the left of the caret, pending re-application after the
  // formatter has run. Null when the change came from somewhere else (a seed,
  // a cleared field) and the caret is none of our business.
  const pendingCaret = useRef<number | null>(null);
  // Bumped on every edit so the layout effect below runs even when the
  // re-formatted string is IDENTICAL to the previous one — which is the case
  // for deleting a separator, where React restores the value and the caret
  // would otherwise be dropped at the end with nothing having changed.
  const [editSeq, setEditSeq] = useState(0);

  // Close on an outside click or Escape. Without this the popover survives
  // opening the next modal and floats over it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    const want = pendingCaret.current;
    pendingCaret.current = null;
    const el = inputRef.current;
    if (want === null || !el || document.activeElement !== el) return;
    const pos = offsetAfterDigits(el.value, want);
    el.setSelectionRange(pos, pos);
  }, [editSeq, field.national]);

  // Rebuilt when the language changes, because the SORT ORDER is part of the
  // translation: alphabetical by localized name, not by ISO code.
  const rows = useMemo(() => {
    const list = allCountryIsos().map((iso) => {
      const name = t(`countries.${iso}`);
      // The English name stays searchable in French: a bilingual dispatcher
      // types whichever came to mind first.
      const english = i18n.getFixedT("en")(`countries.${iso}`);
      return {
        iso,
        name,
        dial: dialFor(iso) ?? "",
        haystack: [fold(name), fold(english), iso.toLowerCase(), ...(ALIASES[iso] ?? [])].join(" "),
      };
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, i18n.language));
  }, [t, i18n.language]);

  const filtered = useMemo(() => {
    const q = fold(query);
    const digits = query.replace(/\D/g, "");
    if (!q && !digits) return rows;
    return rows.filter(
      (r) => (q && r.haystack.includes(q)) || (digits && r.dial.startsWith(digits)),
    );
  }, [rows, query]);

  return (
    <div className={`db-tel ${variant === "modal" ? "db-tel-modal" : ""}`} ref={wrapRef}>
      <div className="db-tel-row">
        <button
          type="button"
          className="db-tel-chip"
          onClick={() => setOpen((v) => !v)}
          aria-label={t("common.selectCountry")}
          aria-expanded={open}
        >
          {/* i18n-ok — a flag emoji, decoration only: the dialling code beside
              it is the label that has to be readable. */}
          <span className="db-tel-flag">{flagFor(field.country)}</span>
          {/* i18n-ok — a dialling code. */}
          <span className="db-tel-dial">+{field.dial}</span>
          {/* i18n-ok — a disclosure caret. */}
          <span className="db-tel-caret">▾</span>
        </button>
        <input
          ref={inputRef}
          className="db-tel-input"
          /* i18n-ok — a phone-number FORMAT example, shown only for NANP: an
             example in the wrong national shape reads as a required length. */
          placeholder={field.dial === "1" ? "(902) 555-1234" : ""}
          value={field.national}
          onChange={(e) => {
            const raw = e.target.value;
            pendingCaret.current = digitsBefore(raw, e.target.selectionStart ?? raw.length);
            setEditSeq((n) => n + 1);
            field.onChangeNational(raw);
            onEdit?.();
          }}
          onBlur={onBlur}
          maxLength={NATIONAL_INPUT_MAX_LENGTH}
          inputMode="tel"
          autoComplete="tel-national"
          autoFocus={autoFocus}
          required={required}
        />
      </div>
      {open && (
        <div className="db-tel-pop">
          <input
            ref={searchRef}
            className="db-tel-search"
            placeholder={t("common.searchCountry")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="db-tel-list">
            {filtered.length === 0 && (
              <div className="db-tel-empty">{t("common.noCountryMatch")}</div>
            )}
            {filtered.map((r) => (
              <button
                key={r.iso}
                type="button"
                className={`db-tel-item ${r.iso === field.country ? "db-tel-item-on" : ""}`}
                onClick={() => {
                  // The chip changes the NUMBER, not just the label, so it
                  // owes `onEdit` the same notification the input does. Without
                  // this: type digits, click the chip (which blurs the input and
                  // runs the lookup under the OLD country), pick the right
                  // country — and the green "registered" badge plus a prefilled
                  // name stay on screen for a number that no longer exists.
                  field.setCountry(r.iso);
                  onEdit?.();
                  setQuery("");
                  setOpen(false);
                }}
              >
                {/* i18n-ok — a flag emoji. */}
                <span className="db-tel-flag">{flagFor(r.iso)}</span>
                <span className="db-tel-name">{r.name}</span>
                {/* i18n-ok — a dialling code. */}
                <span className="db-tel-dial-muted">+{r.dial}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
