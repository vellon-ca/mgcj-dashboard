// The two halves of `profiles.locale` for a dispatcher: read it in as source 2
// of the precedence, and write it back when they make an explicit pick.
//
// WHY THE WRITE IS GATED ON AN EXPLICIT PICK. `localeMode === "system"` means
// "nothing chosen in this browser", and in that state the value being rendered
// came from navigator.languages or from a pick made on some OTHER machine.
// Writing either back would turn a detected language into a stored preference
// that then outranks detection everywhere, for a choice nobody made.
//
// WHY THIS IS A HOOK IN THE AUTHED TREE RATHER THAN AN AUTH SUBSCRIPTION — the
// same reason as the app's copy, and the reason is a scar: a supabase call made
// from inside an `onAuthStateChange` callback can deadlock, because auth-js
// AWAITS each subscriber and every PostgREST query resolves its token through
// the very init that is waiting on the callback. See useAuth.ts's setTimeout
// comment. This hook cannot deadlock by construction: `useAuth()` has already
// settled the profile before it sees one, so the write is an ordinary
// render-time effect like any other page's.
//
// THE COLUMN MUST BE IN `PROFILE_COLUMNS` (useAuth.ts) or this silently does
// nothing useful: `profiles` carries no table-wide SELECT grant, and an
// unselected column reads as `undefined` rather than failing — so `locale`
// would look permanently unset, source 2 would never fire, and the no-op check
// below would re-issue the same write on every mount.

import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { useLocale } from "./LocaleContext";
import type { Profile } from "../types";

export function useLocaleSync(profile: Profile | null) {
  const { localeMode, setAccountLocale } = useLocale();
  // Guards against re-firing while a write for the same pair is in flight: the
  // row in memory still holds the old value until the profile is refetched, so
  // a re-render before then would queue the identical write again.
  const wroteRef = useRef<string | null>(null);

  // Read: feed source 2 in. `null` while signed out, so signing out drops back
  // to browser detection rather than keeping the last dispatcher's language.
  useEffect(() => {
    setAccountLocale(profile?.locale ?? null);
  }, [profile?.locale, setAccountLocale]);

  // Write: mirror an explicit pick, so it follows the dispatcher to a machine
  // they have never signed in on.
  useEffect(() => {
    if (!profile || localeMode === "system") return;
    if (profile.locale === localeMode) return;

    const token = `${profile.id}:${localeMode}`;
    if (wroteRef.current === token) return;
    wroteRef.current = token;

    let cancelled = false;
    supabase
      .from("profiles")
      .update({ locale: localeMode })
      .eq("id", profile.id)
      .then(({ error }) => {
        if (cancelled) return;
        if (error) {
          // Allow a retry on the next render rather than latching the failure.
          wroteRef.current = null;
          // Quiet on purpose: this is a preference, and a failed write must
          // never surface as an error on a language change that visibly
          // worked. The local pick is already in effect and persisted; only
          // its portability to another machine is lost.
          console.log("[locale] profile sync skipped:", error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profile?.id, profile?.locale, localeMode]);
}
