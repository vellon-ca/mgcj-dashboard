import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types";
import type { Session } from "@supabase/supabase-js";

/**
 * Every column of `profiles`, enumerated rather than starred.
 *
 * A star select requires SELECT on every column it expands to, so once `phone`
 * is revoked (see mgcj-app `.claude/notes/g3-phone-column-revoke-plan.md`) a
 * star fails the whole query rather than omitting the column — and this is the
 * dispatch auth path, so that is nobody being able to load the dashboard.
 *
 * Identical to what the star returns today: a behavioural no-op, shipped alone
 * ahead of the revoke. The five marked columns leave in the commit that
 * reroutes their readers through the definer RPC.
 */
const PROFILE_COLUMNS =
  // phone, email, student_email, stripe_customer_id and guest_phone are
  // deliberately ABSENT — 20260765 withholds them, so naming one fails the
  // whole query. Nothing on the dashboard reads the signed-in dispatcher's own
  // number, so there is no bundle to merge back in here; the numbers dispatch
  // DOES need (drivers, passengers, staff) come from profile_phones().
  // Kept on ONE literal line: supabase-js infers the row type from the literal
  // type of this string, and any concatenation or .join() widens it to `string`,
  // which degrades every field to GenericStringError.
  "id, name, role, company_id, avatar_url, created_at, is_active, deactivation_pending, deleted_at, notification_prefs, push_token, is_guest, student_verified, student_institution_id, student_verified_at";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchingForRef = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      // Ignore anonymous sessions — they're created transiently for guest bookings
      if (session?.user?.is_anonymous) {
        setLoading(false);
        return;
      }
      setSession(session);
      if (session) fetchProfile(session.user.id);
      else setLoading(false);
    }).catch(() => setLoading(false));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      // Ignore anonymous users entirely — guest booking creates these transiently
      // and we don't want them to replace the dispatcher's session/profile
      if (session?.user?.is_anonymous) {
        console.log("[Auth] ignoring anonymous session");
        return;
      }

      setSession(session);
      if (session) {
        if (fetchingForRef.current === session.user.id) return;
        // Deferred because auth-js AWAITS this callback: `_notifyAllSubscribers`
        // does `await x.callback(event, session)`. Calling a supabase function
        // here awaits `initializePromise`, which is what is waiting on this
        // callback — a permanent deadlock, cleared only by a fresh JS context.
        //
        // NOT because of the auth lock, which is what this comment used to say.
        // That was true of older auth-js; the lock path is legacy and disabled
        // by default on 2.105.3. The distinction matters because the lock
        // explanation implies a version bump could make this `setTimeout`
        // unnecessary. It cannot — the await on the callback is unconditional.
        //
        // Diagnosed in mgcj-app 2026-08-29 (see its AuthContext.tsx): it only
        // bites after the app has been idle, because a fresh token emits
        // SIGNED_IN before anything subscribes, while a stale one emits after
        // the refresh round trip, by which point this subscriber exists.
        setTimeout(() => fetchProfile(session.user.id), 0);
      } else {
        fetchingForRef.current = null;
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Realtime: push profile changes (e.g. an admin deactivating this dispatcher)
  // to state immediately, so a logged-in session reacts without a manual refresh.
  // Mirrors the mobile app's AuthContext self-subscription.
  useEffect(() => {
    const userId = session?.user?.id;
    if (!userId) return;
    const channel = supabase
      .channel("profile-self-" + userId)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${userId}` },
        (payload) => {
          // Merge, don't replace — correct whether or not Realtime's WAL
          // filter applies the subscribed role's column privileges, which is
          // unverified. If it does, `payload.new` stops carrying the private
          // columns after the revoke (mgcj-app `.claude/notes/
          // g3-phone-column-revoke-plan.md`) and a straight assignment would
          // blank them on the next unrelated write; if it doesn't, this is a
          // no-op. Not asserting which, because it has not been checked.
          setProfile((prev) =>
            prev
              ? { ...prev, ...(payload.new as Partial<Profile>) }
              : (payload.new as Profile),
          );
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id]);

  async function fetchProfile(userId: string, retries = 5) {
    if (fetchingForRef.current === userId) return;
    fetchingForRef.current = userId;

    try {
      let data: any = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await supabase
            .from("profiles")
            .select(PROFILE_COLUMNS)
            .eq("id", userId)
            .single();
          if (!res.error && res.data) {
            data = res.data;
            break;
          }
        } catch {
          // network-level failure (e.g. dead socket after long idle) — treat like a
          // missing row and retry rather than leaving the promise to hang forever.
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500));
      }

      setProfile(data ?? null);

      if (data?.company_id) {
        const { data: company } = await supabase
          .from("companies")
          .select("name")
          .eq("id", data.company_id)
          .maybeSingle();
        setCompanyName(company?.name ?? null);
      }
    } finally {
      fetchingForRef.current = null;
      setLoading(false);
    }
  }

  async function signOut() {
    fetchingForRef.current = null;
    // scope:'local' — supabase-js defaults to 'global', which deletes EVERY
    // auth.sessions row for this user, on every device and in every tab. A
    // dispatcher signing out on the office desktop would silently revoke their
    // own session on the laptop and on any other open tab. Worse, nothing
    // there would LOOK signed out: PostgREST validates a JWT locally
    // (signature + exp only, never auth.sessions), so the board keeps loading
    // rides for up to an hour while every Edge Function that calls getUser()
    // — settle-ride, create-staff-account, delete-driver — 401s with an error
    // that reads like the action failed rather than the session being gone.
    // Signing out means signing out THIS browser.
    await supabase.auth.signOut({ scope: 'local' });
    setProfile(null);
    setCompanyName(null);
  }

  return { session, profile, companyName, loading, signOut };
}
