// Locale selection for the dashboard.
//
// THIS IS THE REPO'S FIRST REACT CONTEXT, against its own convention (every
// other shared value is a prop drilled down from App). Deliberate: the language
// is read by every page including deep inside AnalyticsPage's sub-sections, and
// react-i18next already puts an identically-shaped provider in the tree via
// useTranslation() — threading a second copy of the same value through props
// would be strictly more plumbing for the same thing.
//
// ── PRECEDENCE: explicit local pick > profiles.locale > navigator.languages ──
//
// The app has two sources (its own override, then the device). The dashboard has
// three, and the ordering is the load-bearing part:
//
//   1. An explicit pick in THIS browser wins. It is the most recent statement of
//      intent and it must not be overridden by anything asynchronous — a value
//      arriving later and winning is a language that visibly flips after login.
//   2. `profiles.locale` next, so a dispatcher who set French at the office desk
//      gets French on a machine they have never touched. This is the ONLY reason
//      the column is read here; staff are explicitly out of scope for the
//      server-composed copy it exists for in the app (see the two skipped
//      notify-* functions in mgcj-app/.claude/notes/i18n-design.md).
//   3. `navigator.languages` last, as the zero-configuration default.
//
// "system" as a mode therefore means "I have not chosen on this browser", not
// "follow the OS" — which is why there is no AppState-resume equivalent of the
// app's re-sync. A browser language change means a reload.
//
// THE MIRROR-WRITE FIRES ONLY ON AN EXPLICIT PICK, and it lives in
// useLocaleSync(), not here. Stamping the profile from browser detection would
// destroy the distinction between "chosen" and "merely detected": the detected
// value would come back as source 2 forever, and would then be indistinguishable
// from a deliberate choice made elsewhere. This provider deliberately does not
// import the Supabase client at all.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { startI18n } from "./index";
import {
  DEFAULT_LOCALE,
  isSupported,
  LOCALES,
  type LocaleMeta,
  metaFor,
  resolveLocale,
} from "./locales";

const STORAGE_KEY = "locale_preference";

/** "system" = nothing chosen in this browser. Anything else is an explicit pick. */
export type LocaleMode = "system" | string;

interface LocaleContextType {
  /** The setting for THIS browser, which may be "system". */
  localeMode: LocaleMode;
  /** The tag actually in effect — never "system". Use this for Intl / Maps. */
  locale: string;
  meta: LocaleMeta;
  available: readonly LocaleMeta[];
  setLocaleMode: (mode: LocaleMode) => void;
  /** Source 2. Fed by useLocaleSync() once the signed-in profile has loaded;
   *  used only while localeMode is "system". */
  setAccountLocale: (tag: string | null) => void;
}

const LocaleContext = createContext<LocaleContextType | null>(null);

/** Source 3. The ORDERED list (not navigator.language) so a browser set to
 *  [ar, fr, en] gets French rather than English. */
function browserLocale(): string {
  try {
    const tags = navigator.languages?.length
      ? [...navigator.languages]
      : [navigator.language];
    return resolveLocale(tags.filter(Boolean));
  } catch {
    return DEFAULT_LOCALE;
  }
}

function storedMode(): LocaleMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "system" || isSupported(stored)) return stored as LocaleMode;
  } catch {
    // Safari private mode and friends throw on localStorage access.
  }
  return "system";
}

// Start i18next before the first render so no screen ever renders raw keys.
// Unlike the app — whose override lives in AsyncStorage and so cannot be read
// synchronously — localStorage IS available here, so an explicit pick is honored
// on the very first paint with no correcting flash.
const BOOT_MODE = storedMode();
const BOOT_LOCALE = BOOT_MODE === "system" ? browserLocale() : BOOT_MODE;
startI18n(BOOT_LOCALE);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [localeMode, setLocaleModeState] = useState<LocaleMode>(BOOT_MODE);
  const [accountLocale, setAccountLocale] = useState<string | null>(null);
  const { i18n } = useTranslation();

  const locale =
    localeMode !== "system"
      ? localeMode
      : isSupported(accountLocale)
        ? (accountLocale as string)
        : browserLocale();

  const meta = useMemo(() => metaFor(locale), [locale]);

  // i18next is a module singleton rather than React state, so this effect is
  // the single seam where "what React thinks the locale is" becomes "what the
  // dashboard renders in". `lang`/`dir` on <html> go with it: lang is what
  // tells the browser which hyphenation and spell-check dictionary to use, and
  // it is also what a screen reader picks a voice from.
  useEffect(() => {
    if (i18n.language !== locale) i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = meta.dir;
  }, [locale, meta.dir, i18n]);

  const setLocaleMode = useCallback((mode: LocaleMode) => {
    setLocaleModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Non-persistent is still better than non-functional.
    }
  }, []);

  const value = useMemo(
    () => ({
      localeMode,
      locale,
      meta,
      available: LOCALES,
      setLocaleMode,
      setAccountLocale,
    }),
    [localeMode, locale, meta, setLocaleMode],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used inside LocaleProvider");
  return ctx;
}
