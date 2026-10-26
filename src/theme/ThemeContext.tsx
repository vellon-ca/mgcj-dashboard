// Light / dark theme for the dashboard.
//
// ── SCOPE: this BROWSER, like the language ──
//
// Victor, 2026-10-26: computers that share one dispatch login should each be
// able to keep their own theme, the same way the language works
// (LocaleContext.tsx). So the choice lives in localStorage and nowhere else:
// it survives a refresh, and nothing chosen on one computer reaches another.
// There is deliberately no `profiles` column behind it; an account-level copy
// would make one desk's choice flip every other desk on the same login, which
// is the locale bug fixed on 2026-10-07.
//
// It is read at module load, before React renders, and index.html's
// first-paint script has already painted the matching background from the
// same key, so a light-mode desk never sees a dark frame.

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { applyTheme, palette, type Palette, type Theme } from "./tokens";

// index.html's first-paint script reads this same key. Change both.
const STORAGE_KEY = "vd_theme";
const DEFAULT_THEME: Theme = "dark";

function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    // Private mode and blocked storage throw; fall through to the default.
  }
  return DEFAULT_THEME;
}

const BOOT_THEME = storedTheme();
applyTheme(BOOT_THEME);

interface ThemeContextType {
  theme: Theme;
  /** Real colour values, for code that cannot use CSS variables (Maps). */
  colors: Palette;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(BOOT_THEME);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Non-persistent is still better than non-functional.
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ theme, colors: palette(theme), toggleTheme }),
    [theme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
