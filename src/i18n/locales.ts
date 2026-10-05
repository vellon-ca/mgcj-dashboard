// The locales the dashboard ships, and the facts about each that code needs to
// branch on. One table so adding a language is one entry, not a grep.
//
// Kept deliberately parallel to `mgcj-app/src/i18n/locales.ts` — the two
// surfaces should never disagree about which languages exist or how a tag
// resolves. Two fields of the app's table are NOT here:
//
// - `script` drives the app's Manrope font fallback (Latin-only, so a non-Latin
//   locale renders tofu). The dashboard loads no webfont with that limit — it
//   runs on `system-ui`/Inter stacks — so there is nothing for it to feed.
// - `dir` IS here and is deliberately unused, same as in the app: RTL is a
//   separate layout project. Declaring it means adding Arabic later is a layout
//   task and not also a schema task.

export type Dir = "ltr" | "rtl";

export interface LocaleMeta {
  /** BCP-47 tag used for i18next and the Google Maps `language` param. */
  tag: string;
  /** The tag handed to Intl, which is NOT the same thing: we ship one bundle
   *  per LANGUAGE, but dates and times are formatted for a REGION. A
   *  dispatcher in Nova Scotia wants Canadian French (`fr-CA`), not the `fr`
   *  default, which Intl resolves to France. */
  intlTag: string;
  /** Name in the language itself — never translated; a picker must be readable
   *  to someone who cannot read the current language. */
  endonym: string;
  dir: Dir;
}

export const LOCALES: readonly LocaleMeta[] = [
  { tag: "en", intlTag: "en-CA", endonym: "English", dir: "ltr" },
  { tag: "fr", intlTag: "fr-CA", endonym: "Français", dir: "ltr" },
] as const;

export const DEFAULT_LOCALE = "en";

export const SUPPORTED_TAGS = LOCALES.map((l) => l.tag);

export function metaFor(tag: string): LocaleMeta {
  return LOCALES.find((l) => l.tag === tag) ?? LOCALES[0];
}

export function isSupported(tag: string | null | undefined): boolean {
  return !!tag && SUPPORTED_TAGS.includes(tag);
}

/**
 * Resolve an ordered language preference list to something we ship.
 *
 * Takes the ORDERED list, not a single resolved value: a browser set to
 * [ar, fr, en] should get French, and only a preference list can say that —
 * which is why this reads `navigator.languages` and not `navigator.language`.
 * Matches on the base language (`fr-CA` -> `fr`) because we ship one variant
 * per language and a regional mismatch should still land in the right language
 * rather than falling back to English.
 */
export function resolveLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    if (!tag) continue;
    const base = tag.toLowerCase().split(/[-_]/)[0];
    const hit = SUPPORTED_TAGS.find((s) => s === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}
