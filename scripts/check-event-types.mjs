#!/usr/bin/env node
/**
 * Keep every copy of the dispatch_events event_type list in agreement.
 *
 * WHY THIS EXISTS. `dispatch_events.event_type` is gated by a CHECK constraint in
 * the database, and the same list is retyped by hand in at least four more
 * places in this app. On 2026-09-23 those copies had drifted far enough that TWO
 * live audit events -- ride.flag_resolved (the E7 flag-resolution audit) and
 * settings.numbering_updated -- were rejected with 23514 on dev AND prod every
 * time they fired. Nothing surfaced, because logDispatchEvent only
 * console.error()s: the user's action succeeds and only the audit row is lost.
 * An audit trail with silent holes is worse than none, because it is believed.
 *
 * This is a consistency check, NOT a database check. It compares text to text and
 * needs no credentials -- deliberately, so it can run in the same secret-free CI
 * job as the build. It cannot tell you what the live constraint says; only
 * whether the lists in the repo agree with each other and with the migration.
 *
 * THE CROSS-REPO HALF IS OPTIONAL BY DESIGN. The authoritative list lives in
 * mgcj-app's migrations, a different repo that CI does not check out. When it is
 * reachable (sibling directory, or MGCJ_APP_DIR) that comparison runs; when it is
 * not, it is SKIPPED WITH A NOTICE rather than silently passing. So a local run
 * is the stronger check and CI is the weaker one -- which is the honest way round,
 * since the alternative is a gate that quietly stops testing the thing it was
 * built for.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const note = [];

// ── the union: this app's canonical list ────────────────────────────────────
const unionSrc = readFileSync(join(root, "src/lib/logDispatchEvent.ts"), "utf8");
const unionBody = unionSrc.split("export type DispatchEventType =")[1].split(";")[0];
const union = new Set([...unionBody.matchAll(/\|\s*"([a-z_.]+)"/g)].map(m => m[1]));

// ── the UI maps ─────────────────────────────────────────────────────────────
const analytics = readFileSync(join(root, "src/pages/AnalyticsPage.tsx"), "utf8");
const mapKeys = (name) => {
  const body = analytics.split(`const ${name}: Record<string, string> = {`)[1].split("\n};")[0];
  return new Set([...body.matchAll(/^\s*"([a-z_.]+)":/gm)].map(m => m[1]));
};
const labels = mapKeys("EVENT_LABELS");
const colors = mapKeys("EVENT_COLORS");

// ── the activity filter's <option> list ─────────────────────────────────────
// Located structurally rather than by scanning every <option> in the file: this
// page has other selects, and a global scan would drag their values in.
const anchor = analytics.indexOf('<optgroup label="Rides">');
const selectStart = analytics.lastIndexOf("<select", anchor);
const selectEnd = analytics.indexOf("</select>", anchor);
if (anchor < 0 || selectStart < 0 || selectEnd < 0) {
  fail.push("could not locate the activity filter <select> (the 'Rides' optgroup anchor moved)");
}
const optionBlock = anchor < 0 ? "" : analytics.slice(selectStart, selectEnd);
const options = new Map(
  [...optionBlock.matchAll(/<option value="([a-z_]+\.[a-z_]+)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]),
);

// ── what this app actually emits ────────────────────────────────────────────
const emitted = new Set();
for (const f of readdirSync(join(root, "src/pages"))) {
  if (!f.endsWith(".tsx")) continue;
  const src = readFileSync(join(root, "src/pages", f), "utf8");
  for (const m of src.matchAll(/eventType:\s*"([a-z_.]+)"/g)) emitted.add(m[1]);
}

const diff = (a, b) => [...a].filter(x => !b.has(x)).sort();
const report = (label, missing) => { if (missing.length) fail.push(`${label}: ${missing.join(", ")}`); };

// 1. labels and colours must cover the union exactly. Both directions matter: a
//    missing key renders a raw slug with a grey chip, an extra one is a type the
//    DB will reject if anything ever emits it.
report("in the union but missing from EVENT_LABELS", diff(union, labels));
report("in the union but missing from EVENT_COLORS", diff(union, colors));
report("in EVENT_LABELS but not in the union", diff(labels, union));
report("in EVENT_COLORS but not in the union", diff(colors, union));

// 2. anything this app emits must be filterable. The converse is NOT enforced:
//    types with no emitter are intentionally absent from the filter, because an
//    option that always returns nothing reads as "this never happened" rather
//    than "nothing can produce this". Emitters in mgcj-app's Edge Functions are
//    invisible here, so their options are checked by eye, not by this rule.
report("emitted by this app but not in the activity filter", diff(emitted, new Set(options.keys())));

// 3. every filter option must be a real type, and its text must match the feed's
//    label -- otherwise the same event is called two different things in one UI.
report("in the activity filter but not in the union", diff(new Set(options.keys()), union));
for (const [value, text] of options) {
  const expected = labels.has(value)
    ? analytics.split(`"${value}": "`)[1]?.split('"')[0]
    : null;
  if (expected && text !== expected) {
    fail.push(`filter option "${value}" reads "${text}" but EVENT_LABELS says "${expected}"`);
  }
}

// 4. the authoritative list, when the other repo is at hand.
const appDir = process.env.MGCJ_APP_DIR ?? join(root, "..", "mgcj-app");
const migDir = join(appDir, "supabase", "migrations");
if (!existsSync(migDir)) {
  note.push(`SKIPPED the DB comparison: no migrations at ${migDir}. Set MGCJ_APP_DIR to enable it.`);
} else {
  // The newest migration that (re)defines the constraint wins -- the constraint
  // is dropped and rebuilt whole, so only the last one is live.
  const defining = readdirSync(migDir)
    .filter(f => f.endsWith(".sql"))
    .filter(f => readFileSync(join(migDir, f), "utf8").includes("dispatch_events_event_type_check"))
    .sort();
  const newest = defining.at(-1);
  if (!newest) {
    fail.push(`no migration in ${migDir} defines dispatch_events_event_type_check`);
  } else {
    const sql = readFileSync(join(migDir, newest), "utf8");
    // Take the LAST array in the file: a rebuild migration drops the old
    // constraint before adding the new one, and the baseline dump holds the
    // original alongside it.
    const arrays = [...sql.matchAll(/(?:array|ARRAY)\[([\s\S]*?)\]/g)];
    const dbList = new Set([...arrays.at(-1)[1].matchAll(/'([a-z_.]+)'/g)].map(m => m[1]));
    note.push(`DB list read from ${newest} (${dbList.size} values)`);
    report("allowed by the DB CHECK but missing from the union", diff(dbList, union));
    report("in the union but NOT allowed by the DB CHECK (will be rejected with 23514)", diff(union, dbList));
  }
}

for (const n of note) console.log(`  note  ${n}`);
if (fail.length) {
  console.error("\nevent_type lists disagree:\n");
  for (const f of fail) console.error(`  FAIL  ${f}`);
  console.error(`
Adding an event type is a four-place change:
  1. the DB CHECK          — a migration in mgcj-app (drop and rebuild whole)
  2. DispatchEventType     — src/lib/logDispatchEvent.ts
  3. EVENT_LABELS/COLORS   — src/pages/AnalyticsPage.tsx
  4. the activity filter   — same file, ONLY once something emits the type
`);
  process.exit(1);
}
console.log(`  ok    ${union.size} event types, every list agrees`);
