// i18next init. Imported for its side effect exactly once, from LocaleContext.
//
// Ported from `mgcj-app/src/i18n/index.ts` and intentionally close to it: the
// two surfaces share a French glossary ("course", "chauffeur", "passager") and
// drifting the runtimes apart is how that glossary drifts too. Differences from
// the app's copy are flagged in comments where they exist.
//
// Deliberately NOT using a language detector plugin: the pick is read from
// localStorage synchronously at module load so the first paint is already in
// the right language, and a plugin's own cache would be a second, competing
// copy of that state. See LocaleContext for the precedence (explicit pick >
// navigator.languages) and why the scope is the browser, not the account.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enBase from "./locales/en.json";
import frBase from "./locales/fr.json";
import enCountries from "./locales/countries/en.json";
import frCountries from "./locales/countries/fr.json";
import { DEFAULT_LOCALE } from "./locales";

// Country names are nested INTO `translation` as `countries.<ISO>` rather than
// given their own namespace, so `check:i18n` — which compares the locale files
// to en as one flat key set — sees them like any other copy. Generated, not
// hand-written: mgcj-app/scripts/gen-countries.mjs, then copied across.
const en = { ...enBase, countries: enCountries };
const fr = { ...frBase, countries: frCountries };

export const resources = {
  en: { translation: en },
  fr: { translation: fr },
} as const;

let started = false;

export function startI18n(initialLocale: string) {
  if (started) return i18next;
  started = true;

  i18next.use(initReactI18next).init({
    resources,
    lng: initialLocale,
    fallbackLng: DEFAULT_LOCALE,
    // Belt and braces only: `fallbackLng` above already resolves a key that is
    // missing from a translation to the English string, so this runs just for a
    // key missing from EVERY file (a typo at the call site). It walks en.json by
    // hand because i18next has nothing left to look in by then. Kept because
    // the alternative is a raw dotted key rendering in the UI.
    parseMissingKeyHandler: (key) => {
      const parts = key.split(".");
      let node: unknown = en;
      for (const p of parts) {
        if (node && typeof node === "object" && p in (node as object)) {
          node = (node as Record<string, unknown>)[p];
        } else {
          return key;
        }
      }
      return typeof node === "string" ? node : key;
    },
    interpolation: {
      // React escapes everything it renders, so i18next escaping again turns a
      // plain apostrophe in French copy ("l'appareil") into "l&#39;appareil".
      //
      // THIS REPO HAS AN HTML SINK AND THE APP DOES NOT. `printReport()` in
      // AnalyticsPage builds a document with window.open() + document.write(),
      // so a translated string interpolating untrusted data would land in raw
      // HTML with no escaping anywhere in the chain. The escaping that belongs
      // there belongs at that sink — it has to escape its non-translated values
      // too — not in this setting, which would mangle every apostrophe in the
      // React-rendered 99% to fix the 1%.
      escapeValue: false,
    },
    returnNull: false,
  });

  return i18next;
}

export default i18next;
