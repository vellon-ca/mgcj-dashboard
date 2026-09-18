// URL-path navigation for the dashboard, without pulling in a router.
//
// The pathname is two segments: /<view>/<sub>, e.g. /settings/service-areas or
// /analytics/settlements. DashboardPage owns segment 0 (the nav section); each
// page owns segment 1 (the section inside it) via useSubView(). A refresh or a
// pasted link lands exactly where it says, and back/forward walk the same
// stack. (Deep paths depend on the SPA rewrite in vercel.json.)
//
// Why a notify store instead of raw history calls: the four sub-view pages are
// all mounted at once, hidden with display:none rather than unmounted, and
// child effects run BEFORE the parent's. So a child cannot simply write its
// path on mount — at that moment the pathname is still the OLD view's, and a
// replaceState there would overwrite the history entry the parent is about to
// push. Instead every writer goes through navigate(), which notifies after the
// history call, so the newly-visible page re-runs its sync once the parent has
// claimed segment 0 and appends its sub-segment to the entry the parent just
// pushed. Each page bails unless segment 0 is its own view, which is also what
// keeps the three hidden pages from fighting over the URL.

import { useCallback, useEffect, useState } from "react";

// The nav sections, and the first path segment each one owns. Lives here rather
// than in DashboardPage because the login return-path check below has to
// validate against it too.
export const VIEW_PATHS = [
  "rides",
  "drivers",
  "analytics",
  "reports",
  "discounts",
  "settings",
  "announcements",
  "messages",
] as const;
export type View = (typeof VIEW_PATHS)[number];

export const LOGIN_PATH = "/login";

type Listener = () => void;
const listeners = new Set<Listener>();

/** Path segments, slash-trimmed. segment(0) is the view, segment(1) the sub. */
export function segment(i: number): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/").filter(Boolean)[i] ?? "";
}

/**
 * Subscribe to every path change — ours and the browser's back/forward alike.
 * A caller that only listens to popstate would miss the parent's own writes,
 * which is precisely when a hidden page becomes visible and needs to re-sync.
 */
export function subscribePath(fn: Listener): () => void {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

/** Write the path. A no-op when it already matches, which is what lets the
 *  state→URL effects run freely without guarding against feedback loops:
 *  a popstate sets state, state agrees with the URL, the write no-ops. */
export function navigate(path: string, mode: "push" | "replace") {
  if (window.location.pathname === path) return;
  if (mode === "push") window.history.pushState(null, "", path);
  else window.history.replaceState(null, "", path);
  listeners.forEach(l => l());
}

// Section ids are snake_case in code and kebab-case in URLs. No id in any of
// the four pages contains a hyphen, so this round-trips losslessly.
export const toSlug = (id: string) => id.replace(/_/g, "-");
export const fromSlug = (s: string) => s.replace(/-/g, "_");

/**
 * Bind a page's section state to segment 1 of the path.
 *
 * `allowed` must be the list this user can actually reach — pass the
 * role-filtered set, not the full type union, or a dispatcher deep-linking an
 * admin-only section renders a pane the nav never offered them.
 */
export function useSubView<T extends string>(
  view: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const readPath = useCallback((): T | null => {
    if (segment(0) !== view) return null;
    const s = fromSlug(segment(1)) as T;
    return allowed.includes(s) ? s : null;
  }, [view, allowed]);

  const [sub, setSub] = useState<T>(() => readPath() ?? fallback);
  const [tick, setTick] = useState(0);

  // URL → state. Also bumps a tick for the sync effect below, so that a parent
  // write of a bare "/settings" (no sub) still wakes this page up to append one.
  useEffect(
    () =>
      subscribePath(() => {
        const s = readPath();
        if (s) setSub(s);
        setTick(t => t + 1);
      }),
    [readPath],
  );

  // state → URL, but only while this page owns segment 0.
  //
  // push vs replace falls out of what's already in the path: if segment 1 is
  // already a valid section, this is a real move between sections and earns a
  // history entry; if it's missing or junk, we're normalizing (/settings →
  // /settings/pricing) and must not add one.
  useEffect(() => {
    if (segment(0) !== view) return;
    const cur = fromSlug(segment(1)) as T;
    navigate(
      `/${view}/${toSlug(sub)}`,
      allowed.includes(cur) ? "push" : "replace",
    );
  }, [view, allowed, sub, tick]);

  return [sub, setSub];
}


// ── Signed-out detour ───────────────────────────────────────────────────
//
// Login has its own path, so the URL doesn't sit on a dashboard section nobody
// is currently allowed to see. But rewriting to /login would throw away the
// deep link you arrived on — refresh at /settings/team while signed out and
// you'd land on Rides after logging in, which is worse than the old behaviour
// of leaving the path alone. So the target is parked here across the login.
//
// It's a module variable, NOT a ?next= query param, so there is nothing in the
// address bar for anyone to forge: no open redirect, no protocol-relative
// "//evil.com" case, no encoding to get wrong. The cost is that a hard refresh
// while already at /login forgets the target and lands on Rides — which is
// exactly where you'd want to be anyway, having started at login.
let returnPath: string | null = null;
let consumed = false;

/** Call once the session is known to be absent. Parks where you were (if it
 *  was a real section) and puts /login in the address bar. */
export function goToLogin() {
  if (window.location.pathname === LOGIN_PATH) return;
  const here = window.location.pathname;
  returnPath = VIEW_PATHS.includes(segment(0) as View) ? here : null;
  consumed = false; // a fresh detour: the next sign-in gets to restore again
  navigate(LOGIN_PATH, "replace");
}

/**
 * Call synchronously in render, immediately before the dashboard is returned,
 * and only on the branch where the user is actually allowed in.
 *
 * This CANNOT be an effect. DashboardPage picks its view from the path in a
 * useState initializer and useSubView does the same for the section, so the URL
 * has to be whole before any child renders — useEffect and useLayoutEffect both
 * run after that. A render-phase history write is safe here precisely because
 * it touches no React state, which makes StrictMode's double render a no-op;
 * never let this function grow a setState.
 */
export function consumeReturnPath() {
  if (consumed) return;
  if (window.location.pathname !== LOGIN_PATH) return;
  consumed = true;
  navigate(returnPath ?? "/rides", "replace");
  returnPath = null;
}
