import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types";
import type { Session } from "@supabase/supabase-js";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchingForRef = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      // Ignore anonymous sessions — they're created transiently for guest bookings
      if (session?.user?.is_anonymous) return;
      setSession(session);
      if (session) fetchProfile(session.user.id);
      else setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      // Ignore anonymous users entirely — guest booking creates these transiently
      // and we don't want them to replace the dispatcher's session/profile
      if (session?.user?.is_anonymous) {
        console.log("[Auth] ignoring anonymous session");
        return;
      }

      setSession(session);
      if (session) {
        if (fetchingForRef.current === session.user.id) return;
        await fetchProfile(session.user.id);
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
          setProfile(payload.new as Profile);
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

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if ((error || !data) && retries > 0) {
      await new Promise((r) => setTimeout(r, 500));
      fetchingForRef.current = null;
      return fetchProfile(userId, retries - 1);
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

    setLoading(false);
  }

  async function signOut() {
    fetchingForRef.current = null;
    await supabase.auth.signOut();
    setProfile(null);
    setCompanyName(null);
  }

  return { session, profile, companyName, loading, signOut };
}
