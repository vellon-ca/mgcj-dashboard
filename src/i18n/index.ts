// i18next init. Imported for its side effect exactly once, from LocaleContext.
//
// Ported from `mgcj-app/src/i18n/index.ts` and intentionally close to it: the
// two surfaces share a French glossary ("course", "chauffeur", "passager") and
// drifting the runtimes apart is how that glossary drifts too. Differences from
// the app's copy are flagged in comments where they exist.
//
// Deliberately NOT using a language detector plugin: detection is three
// ordered sources here (explicit pick > profiles.locale > navigator.languages)
// and the account half of that lives behind Supabase auth, which no detector
// plugin can see. See LocaleContext for the precedence and why it is that way.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import { DEFAULT_LOCALE } from "./locales";

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
