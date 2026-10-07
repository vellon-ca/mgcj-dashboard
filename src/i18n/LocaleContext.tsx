// Locale selection for the dashboard.
//
// THIS IS THE REPO'S FIRST REACT CONTEXT, against its own convention (every
// other shared value is a prop drilled down from App). Deliberate: the language
// is read by every page including deep inside AnalyticsPage's sub-sections, and
// react-i18next already puts an identically-shaped provider in the tree via
// useTranslation() — threading a second copy of the same value through props
// would be strictly more plumbing for the same thing.
//
// ── PRECEDENCE: explicit pick in THIS browser > navigator.languages ──
//
// Two sources, and the scope is the BROWSER, not the account. Same model as the
// board map's saved opening view (`db-map-home:` in DashboardPage.tsx):
// localStorage with nothing in `profiles` behind it, because a desk preference
// belongs to the desk. A dispatcher who works in French at the office and in
// English on a laptop at home gets both; nothing they pick on one machine
// reaches the other.
//
//   1. An explicit pick in this browser wins. It is read synchronously at
//      module load, so it is honored on the very first paint with no correcting
//      flash — unlike the app, whose override lives in AsyncStorage and cannot
//      be read synchronously.
//   2. `navigator.languages` otherwise, as the zero-configuration default.
//
// "system" as a mode therefore means "I have not chosen on this browser", not
// "follow the OS" — which is why there is no AppState-resume equivalent of the
// app's re-sync. A browser language change means a reload.
//
// THIS PROVIDER DELIBERATELY DOES NOT IMPORT THE SUPABASE CLIENT, and nothing
// here reads or writes `profiles.locale`. That column still exists and is still
// load-bearing — the Edge Functions compose push/email copy from it for
// passengers and drivers (see mgcj-app/.claude/notes/i18n-design.md) — it is
// just not a dashboard input. It was one until 2026-10-07: picking French at
// one desk came back as a precedence source on every other browser where the
// mode was "system", so a choice made at the office silently turned the home
// laptop French. Staff are explicitly out of scope for the server-composed copy
// the column exists for, so the dashboard had no other reason to touch it.
//
// THE BARE STORAGE KEY IS NOT AN OVERSIGHT. The saved map view is keyed by
// profile id because workstations are shared; this cannot be, because the
// locale resolves at module load, before any session exists. A per-profile key
// would mean booting in the browser language and flipping after login — the
// visible post-login flip this whole file is ordered to avoid. Pre-auth there
// is no identity to key on, so the browser is the only coherent scope.

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
}

const LocaleContext = createContext<LocaleContextType | null>(null);

/** Source 2. The ORDERED list (not navigator.language) so a browser set to
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
const BOOT_MODE = storedMode();
const BOOT_LOCALE = BOOT_MODE === "system" ? browserLocale() : BOOT_MODE;
startI18n(BOOT_LOCALE);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [localeMode, setLocaleModeState] = useState<LocaleMode>(BOOT_MODE);
  const { i18n } = useTranslation();

  const locale = localeMode !== "system" ? localeMode : browserLocale();

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
