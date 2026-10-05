#!/usr/bin/env node
/**
 * Translation drift gate. Ported from `mgcj-app/scripts/check-i18n.mjs`, minus
 * the three sections that have no counterpart here (the Edge Function
 * dictionary, its reference scan, and the serverMessage.ts code map — this repo
 * ships no functions and composes no server copy).
 *
 * The recurring cost of i18n is not the first translation, it's that every
 * later English copy edit silently invalidates N translations. Nothing fails
 * when that happens: i18next falls back to English, so the dashboard looks
 * fine and a French dispatcher just sees English words reappear one at a time
 * over months. This is the only thing that notices.
 *
 * Four checks:
 *   1. MISSING  — key in en, absent from a translation. Renders English.
 *   2. EXTRA    — key in a translation, absent from en. A rename left an
 *                 orphan behind.
 *   3. VARS     — {{placeholders}} differ from en's. The dangerous class: a
 *                 dropped {{time}} produces a grammatical sentence that is
 *                 missing the fact, and no fallback catches it.
 *   4. The un-externalized-string inventory (find-strings.mjs), because checks
 *      1–3 compare the locale files to EACH OTHER and so are perfectly happy
 *      with a screen that was never translated at all. That is the failure
 *      that actually shipped in the app, six times over.
 *
 * Unlike the app, both of these ARE package.json scripts (`check:i18n`,
 * `find:strings`). The app keeps find-strings out of `scripts` because a bare
 * script line moves the Expo fingerprint and orphans every installed build's
 * OTA; this repo has no native build, so the line is free.
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/i18n/locales");
const BASE = "en";

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const vars = (s) =>
  [...s.matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(",");

// The <Trans> markup tags, compared the same way and for the same reason.
// Nine keys here carry an inline <s>…</s> that <Trans> swaps for a real
// element; drop the closing tag in a translation and react-i18next renders the
// span AWAY — the sentence survives, the emphasis and sometimes a whole
// interpolated value do not, and every other check passes. Counts matter, not
// just presence: "<s>{{a}}</s> and <s>{{b}}</s>" needs both pairs.
const tags = (s) =>
  [...s.matchAll(/<\/?(\w+)\s*\/?>/g)]
    .map((m) => m[0].replace(/\s+/g, ""))
    .sort()
    .join(",");

let failed = false;
const problem = (msg) => {
  failed = true;
  console.error(`  ✗ ${msg}`);
};

// ── Locale files against each other ──
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const base = flatten(
  JSON.parse(readFileSync(join(dir, `${BASE}.json`), "utf8")),
);
console.log(`src/i18n/locales — ${Object.keys(base).length} keys in ${BASE}\n`);

for (const file of files.filter((f) => f !== `${BASE}.json`)) {
  const tag = file.replace(/\.json$/, "");
  const t = flatten(JSON.parse(readFileSync(join(dir, file), "utf8")));
  const missing = Object.keys(base).filter((k) => !(k in t));
  const extra = Object.keys(t).filter((k) => !(k in base));
  const badVars = Object.keys(t).filter(
    (k) => k in base && vars(t[k]) !== vars(base[k]),
  );
  const badTags = Object.keys(t).filter(
    (k) => k in base && tags(t[k]) !== tags(base[k]),
  );

  const ok = !missing.length && !extra.length && !badVars.length && !badTags.length;
  console.log(`${ok ? "✓" : "✗"} ${tag}  (${Object.keys(t).length} keys)`);
  missing.forEach((k) => problem(`${tag}: MISSING  ${k}`));
  extra.forEach((k) =>
    problem(`${tag}: EXTRA    ${k}  (orphaned by a rename?)`),
  );
  badVars.forEach((k) =>
    problem(
      `${tag}: VARS     ${k}  en{{${vars(base[k])}}} vs ${tag}{{${vars(t[k])}}}`,
    ),
  );
  badTags.forEach((k) =>
    problem(
      `${tag}: TAGS     ${k}  en[${tags(base[k])}] vs ${tag}[${tags(t[k])}]`,
    ),
  );
}

// ── Keys REFERENCED in src/ but absent from en.json ──
//
// Checks 1–3 compare locales to EACH OTHER, so a key missing from BOTH is
// invisible to all of them — and `parseMissingKeyHandler` falls back to the key
// itself, so what ships is a raw dotted key rendered in the UI.
//
// Only literal `t("…")` calls can be checked. Dynamic lookups (`t(labelFor(x))`,
// `t(STATUS_KEYS[s])`) are invisible here by nature — which is the reason the
// convention is to put KEYS, not English, in those maps: it keeps them
// greppable, and the maps are small enough to eyeball.
const srcFiles = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(full);
  }
})(join(root, "src"));

const referenced = new Map();
for (const f of srcFiles) {
  const src = readFileSync(f, "utf8");
  // `t("…")` and `i18next.t("…")`, plus <Trans i18nKey="…">, which is a real
  // call site with no `t(` anywhere on the line.
  for (const m of src.matchAll(/\bt\(\s*["']([a-zA-Z][\w.]*\.[\w.]+)["']/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], f.replace(root + "/", ""));
  }
  for (const m of src.matchAll(/\bi18nKey=["']([a-zA-Z][\w.]*\.[\w.]+)["']/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], f.replace(root + "/", ""));
  }
}

// i18next resolves `key_one`/`key_other` from a bare `key` + count, so a
// reference to "x.y" is satisfied by either the plain key or its plural forms.
const satisfied = (k) =>
  k in base || Object.keys(base).some((b) => b.startsWith(k + "_"));

const unresolved = [...referenced].filter(([k]) => !satisfied(k));
console.log(`\nreferenced in src/ — ${referenced.size} distinct keys`);
if (unresolved.length) {
  for (const [k, f] of unresolved) problem(`MISSING FROM en.json: ${k}  (${f})`);
} else {
  console.log("✓ every literal t() / <Trans> key exists in en.json");
}

// ── <Trans> components must match the tags in the string ──
//
// A `<Trans i18nKey="x" components={{ s: <strong/> }}>` whose string says
// `<b>…</b>` renders the markup away with no error anywhere — and the reverse
// (a tag in the string that the components map does not name) is the same
// silent loss. tsc cannot see it: both sides are just data. This is the static
// stand-in for opening the page, and it is the only automated cover the nine
// <Trans> sites have.
const transTags = (str) =>
  new Set([...str.matchAll(/<(\w+)>/g)].map((m) => m[1]));
let transChecked = 0;
for (const f of srcFiles) {
  const src = readFileSync(f, "utf8");
  // One <Trans …/> element at a time. NOT a non-greedy match to the first
  // `/>`: that slash belongs to `<strong />` INSIDE the components map, so a
  // multi-line <Trans> got truncated before its components were visible and
  // this check reported all three of them as naming nothing. Walk to the `/>`
  // at which the braces balance instead.
  // `(?!>)` excludes a bare `<Trans>` written in PROSE — two comments in this
  // codebase explain why a site uses <Trans>, and both say "<Trans>" with the
  // bracket closed. A real element always has an attribute next.
  for (const m of src.matchAll(/<Trans\b(?!>)/g)) {
    const from = m.index + m[0].length;
    let el = null;
    for (const close of src.slice(from).matchAll(/\/>/g)) {
      const candidate = src.slice(from, from + close.index);
      const opens = (candidate.match(/\{/g) ?? []).length;
      const closes = (candidate.match(/\}/g) ?? []).length;
      if (opens === closes) { el = candidate; break; }
    }
    // No end and no key means this is PROSE, not an element: LoginPage's own
    // comment explains why it uses <Trans> and that mention matched here.
    // Require a key before complaining about anything.
    if (el === null) {
      if (/i18nKey=/.test(src.slice(from, from + 400))) {
        problem(`<Trans> at ${f.replace(root + "/", "")} — could not find its end (unbalanced braces?)`);
      }
      continue;
    }
    const key = /i18nKey=["']([\w.]+)["']/.exec(el)?.[1];
    if (!key) continue;
    transChecked++;
    const named = new Set(
      [...el.matchAll(/components=\{\{([\s\S]*?)\}\}/g)]
        .flatMap((c) => [...c[1].matchAll(/(\w+)\s*:/g)].map((p) => p[1])),
    );
    const where = f.replace(root + "/", "");
    if (!satisfied(key)) continue; // already reported by the reference check
    for (const [tag, str] of Object.entries(
      Object.fromEntries(files.map((file) => [
        file.replace(/\.json$/, ""),
        flatten(JSON.parse(readFileSync(join(dir, file), "utf8")))[key],
      ])),
    )) {
      if (typeof str !== "string") continue;
      for (const needed of transTags(str)) {
        if (!named.has(needed)) {
          problem(
            `<Trans> ${key} (${where}) renders <${needed}> in ${tag}, but components={} names only {${[...named].join(", ")}}`,
          );
        }
      }
    }
  }
}
console.log(`\n<Trans> sites — ${transChecked} checked`);
if (!failed) console.log("✓ every <Trans> names a component for each tag in its string");

// ── Keys reached only through a MAP (`t(RIDE_STATUS_KEYS[s])`) ──
//
// The reference check above sees literal t("…") calls and nothing else, so the
// dominant pattern in this repo is invisible to it: module-scope tables whose
// VALUES are keys, resolved dynamically at the render site (src/lib/labels.ts,
// EVENT_LABEL_KEYS, SETTLEMENT_ROUTE_SHORT_KEYS, REPORT_CATEGORY_KEYS, the
// SECTION_ITEMS `labelKey` lists…). A typo in one of those renders the raw
// dotted key in the UI, and every check above passes.
//
// Scoped by NAMESPACE to stay precise: a dotted string is only treated as a key
// when its first segment is a top-level namespace in en.json. That is what
// keeps event types ("ride.created"), supabase columns and file paths — which
// are dotted too — out of the check. The cost of that scoping: a map value
// pointing at a namespace that does not exist AT ALL is invisible here. The
// render site shows it immediately, which is the trade.
const namespaces = new Set(Object.keys(
  JSON.parse(readFileSync(join(dir, `${BASE}.json`), "utf8")),
));
const mapped = new Map();
for (const f of srcFiles) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:labelKey|label|key)?\s*:\s*"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) {
    const k = m[1];
    if (!namespaces.has(k.split(".")[0])) continue;
    if (!mapped.has(k)) mapped.set(k, f.replace(root + "/", ""));
  }
}
const badMapped = [...mapped].filter(([k]) => !satisfied(k));
console.log(`\nkey-map values in src/ — ${mapped.size} distinct keys`);
if (badMapped.length) {
  for (const [k, f] of badMapped) problem(`MAPPED KEY MISSING FROM en.json: ${k}  (${f})`);
} else {
  console.log("✓ every mapped key exists in en.json");
}

// ── Un-externalized strings ──
//
// Vetted non-copy sites carry `// i18n-ok` on their own line or the line
// directly above. Use it rather than loosening a rule in find-strings.mjs: a
// gate with a permanent floor of known hits is a gate nobody reads, which is
// how six rounds of English shipped in the app.
const inventory = spawnSync(
  process.execPath,
  [new URL("./find-strings.mjs", import.meta.url).pathname, "src"],
  { cwd: root, encoding: "utf8", env: { ...process.env, VERBOSE: "1" } },
);
const invOut = (inventory.stdout ?? "") + (inventory.stderr ?? "");
const totalMatch = /TOTAL candidate strings: (\d+)/.exec(invOut);
// A missing TOTAL line means the inventory did not run (a parse failure, a
// moved file). Treat that as a FAILURE, never as zero: "0 across 0 files" and
// "the tool crashed" must not look the same from here. Same family as the
// seeded-institution bug in mgcj-app's deletion-tests.sql.
if (!totalMatch) {
  problem("find-strings.mjs produced no TOTAL line — it did not run");
  console.error(invOut.trim());
}
const total = Number(totalMatch?.[1] ?? "0");
console.log(`\nun-externalized strings — ${total} candidates`);
if (total > 0) {
  console.log(invOut.trim());
  problem(
    `${total} user-facing string(s) are not behind t(). Externalize them, or mark a vetted non-copy site with // i18n-ok`,
  );
} else if (totalMatch) {
  console.log("✓ no un-externalized user-facing strings");
}

console.log(failed ? "\ni18n drift found." : "\nNo i18n drift.");
process.exit(failed ? 1 : 0);
