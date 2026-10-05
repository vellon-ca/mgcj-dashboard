#!/usr/bin/env node
/**
 * PER-RULE control for find-strings.mjs.
 *
 * WHY THIS EXISTS. The first control seeded two strings, watched the scanner
 * find them, and was reported as proof that "1469 → 0" meant no English left.
 * It wasn't: both seeds landed in positions the scanner ALREADY covered, so it
 * tested the plumbing and nothing about coverage. The gate then read clean
 * while six user-visible surfaces — the ride-history, settlement, receipts and
 * driver tables, the settlement filter chips, the chart axes — were English,
 * and the user found them in two minutes.
 *
 * So a control has to seed ONE case PER RULE, including every rule added after
 * a miss, and assert each is found by the kind that is supposed to find it. A
 * rule that stops firing (see the DERIVED regex, dead from the day it was
 * written) then fails here instead of reading as a clean scan.
 *
 * Run: node scripts/control-i18n.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CASES = [
  {
    name: "jsx text",
    kind: "jsx",
    code: `export default function A() { return <div>Pending settlement</div>; }`,
  },
  {
    name: "copy-named attribute",
    kind: "attr",
    code: `export default function A() { return <input placeholder="Search drivers" />; }`,
  },
  {
    name: "copy-named object property",
    kind: "prop",
    code: `const x = { label: "Needs attention" };`,
  },
  {
    name: "ternary inside JSX",
    kind: "jsxexpr",
    code: `export default function A({ b }) { return <p>{b ? "Covered" : "Uncovered"}</p>; }`,
  },
  {
    name: "returned label",
    kind: "ret",
    code: `function f(d) { if (d === 0) return "Today"; return "Later"; }`,
  },
  {
    // The table-header class. Single words, 4+ of them, anonymous array —
    // silenced by BOTH inDataArray and the two-word gate before 2026-10-04.
    name: "header row mapped into JSX",
    kind: "maparr",
    code: `export default function A() { return <tr>{["Date", "Ride", "Driver", "Fare"].map((h) => (<th key={h}>{h}</th>))}</tr>; }`,
  },
  {
    // The filter-chip class: a label nested one array deeper, in a tuple.
    name: "tuple label mapped into JSX",
    kind: "maparr",
    code: `export default function A() { return <div>{[["open", "Open"], ["resolved", "Resolved"]].map(([k, l]) => (<button key={k}>{l}</button>))}</div>; }`,
  },
  {
    // The class no string scanner can see: there is no literal to find.
    name: "label derived from an identifier",
    kind: "DERIVED",
    code: `export default function A({ p }) { return <b>{p.charAt(0).toUpperCase() + p.slice(1)}</b>; }`,
  },
];

// Cases the scanner must stay QUIET about, so the rules above can't be "fixed"
// by simply reporting everything. Each is a real shape from this codebase.
const SILENT = [
  { name: "vehicle make/model data array", code: `const MODELS = ["santa fe", "grand caravan", "silverado", "f-150", "sienna"];` },
  { name: "supabase select list", code: `const q = sb.from("rides").select("id, status, fare_final, driver_id");` },
  { name: "enum compared, not rendered", code: `export default function A({ s }) { return <b>{s === "completed" ? null : null}</b>; }` },
  { name: "css in a style element", code: `export default function A() { return <style>{\`.an-th { padding: 10px 14px; font-weight: 600 }\`}</style>; }` },
  { name: "already translated", code: `export default function A({ t }) { return <div>{t("analytics.col.date")}</div>; }` },
];

const dir = mkdtempSync(join(tmpdir(), "i18n-control-"));
let failures = 0;

function scan(code) {
  const f = join(dir, "Case.tsx");
  writeFileSync(f, code);
  const out = execFileSync("node", ["scripts/find-strings.mjs", f], {
    encoding: "utf8",
    env: { ...process.env, VERBOSE: "1" },
  });
  return out;
}

console.log("── must be FOUND ──");
for (const c of CASES) {
  const out = scan(c.code);
  const found = new RegExp(`\\b${c.kind}\\b`).test(out);
  console.log(`  ${found ? "ok  " : "FAIL"}  ${c.name}  (expects kind=${c.kind})`);
  if (!found) {
    failures++;
    console.log(out.split("\n").map((l) => "        " + l).join("\n"));
  }
}

console.log("\n── must stay SILENT ──");
for (const c of SILENT) {
  const out = scan(c.code);
  const quiet = /TOTAL candidate strings: 0/.test(out);
  console.log(`  ${quiet ? "ok  " : "FAIL"}  ${c.name}`);
  if (!quiet) {
    failures++;
    console.log(out.split("\n").map((l) => "        " + l).join("\n"));
  }
}

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} control case(s) failed — the scanner's coverage changed.`);
  process.exit(1);
}
console.log("\nAll control cases behave as specified.");
