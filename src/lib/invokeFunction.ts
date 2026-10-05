import i18next from "i18next";
import { supabase } from "./supabase";

export interface InvokeResult<T = any> {
  /** Parsed response body, on success AND on a 4xx/5xx. Null only if unreadable. */
  data: T | null;
  /** Human-readable message, already unwrapped from the error body. */
  error: string | null;
}

/**
 * supabase-js resolves any non-2xx Edge Function response into a
 * FunctionsHttpError with `data: null`, so the JSON body — where our functions
 * put their `error` string — is only reachable through `error.context`, the raw
 * Response. Read it plainly and a rejected action tells the dispatcher what the
 * server actually objected to, instead of "Edge Function returned a non-2xx
 * status code".
 */
export async function invokeFunction<T = any>(
  name: string,
  body: Record<string, unknown>,
  // Resolved at CALL time, not module load: a default parameter expression is
  // evaluated per call, so this picks up a language change without the module
  // needing to re-evaluate. (A module-level `const FALLBACK = t(…)` would
  // freeze whatever language the tab booted in.)
  fallback = i18next.t("common.error"),
): Promise<InvokeResult<T>> {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (!error) {
    return { data: data ?? null, error: (data as any)?.error ?? null };
  }

  const res: Response | undefined = (error as any)?.context;
  if (res && typeof res.json === "function") {
    try {
      const parsed = await res.json();
      return { data: parsed ?? null, error: parsed?.error ?? error.message ?? fallback };
    } catch {
      // Non-JSON body (a gateway/timeout page) — nothing better than the throw.
    }
  }
  return { data: null, error: error.message ?? fallback };
}
