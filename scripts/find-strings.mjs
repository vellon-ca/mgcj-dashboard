#!/usr/bin/env node
/**
 * Inventory of un-externalized user-facing strings.
 *
 * PORTED FROM `mgcj-app/scripts/find-strings.mjs`, which earned every rule in
 * it the hard way. Read that file's history below before "simplifying" any of
 * them — they are scar tissue, not style. Run it as
 * `node scripts/find-strings.mjs [path…]` (or `npm run find:strings`),
 * VERBOSE=1 to list hits.
 *
 * ── WHAT IS DIFFERENT HERE, AND WHY ──
 *
 * This repo styles with per-page `<style>{`…`}</style>` template literals and
 * inline `style={{…}}` objects, so a direct port reports CSS as copy: a page's
 * whole stylesheet as one `tmplx` hit, and every `'8px 18px'` /
 * `'0.5px solid rgba(255,255,255,0.08)'` / `"'Inter', system-ui, sans-serif"`
 * as a `str` hit. Those are not false positives to be tolerated — a gate with a
 * permanent floor of known hits is a gate nobody reads, which is the lesson
 * that produced the app's `// i18n-ok` marker. So CSS is excluded STRUCTURALLY
 * (by position: inside a `<style>` element or a style-ish JSX attribute), not
 * by pattern-matching what CSS looks like.
 *
 * Dropped as inapplicable: React Native's `Alert.alert` copy rule and the
 * `ICONY` Ionicons-name filter. Added: `alt`/`aria-label`/`aria-placeholder` as
 * copy attributes, and the `document.write`/`window.open` HTML sink is treated
 * as rendered rather than diagnostic, because `printReport()` builds real
 * user-facing output there.
 *
 * ── THIS IS AN AST PASS, AND IT IS A REWRITE. DO NOT GO BACK TO REGEX. ──
 *
 * The previous version matched JSX with regular expressions and was rewritten
 * SIX times, each time after a "complete" sweep shipped visibly half-English
 * screens. Every rewrite closed one shape and stayed blind to the next:
 *
 *   1. `return "Head to pickup"` in a switch   — literal pass only scanned
 *      lines that already looked like copy (Alert.alert / label: / title:).
 *   2. single-quoted '…'                        — regex matched only "…".
 *   3. multi-line JSX text                      — needed `>` and `<` on ONE
 *      line; the dominant shape here has the copy on its own line with
 *      neither delimiter, and unquoted, so BOTH passes were blind to it.
 *   4. `>Get where{'\n'}you're going<`          — span died at the first `{`.
 *   5. `>{n} driver{n > 1 ? "s" : ""} free<`    — a `>` INSIDE the braces.
 *   6. `>← Back<`                               — required a leading letter.
 *
 * And the round that prompted this rewrite found three MORE at once:
 *
 *   7. `{ride.review_rating}/5 · Your rating` — survived the span regex, then
 *      NOT_COPY rejected it because `\/` matches its LEADING SLASH, i.e. it
 *      was discarded as a URL.
 *   8. `Available{n > 0 ? ` (${n})` : ""}`    — NESTED braces (a template
 *      literal inside the expression) broke `\{[^{}]*\}`, so the span ended
 *      in the wrong place.
 *   9. The per-line "already translated" filter dropped EVERY finding on any
 *      line containing a `t(`, so `{t("x")} · Your rating` was invisible.
 *
 * The lesson is not that the regex needed a tenth patch. `JSXText` is a node
 * type; asking Babel for it cannot be blind to a shape. Three properties of
 * this version are load-bearing and are the actual fixes:
 *
 *   (a) JSX TEXT HAS NO WORD-COUNT GATE. The old `isCopy` required two words,
 *       because the vehicle make/model arrays are hundreds of bare capitalised
 *       words ("Toyota", "Camry") and reporting them drowned the signal. But
 *       that gate is what hid "Receipts", "Available", "Cash", "Driver",
 *       "Passenger" — single-word labels are the single largest class of
 *       remaining copy. On an AST the distinction is free: a JSXText node is
 *       copy by construction, and a bare literal in an unknown position is
 *       not, so the gate applies only to the latter.
 *   (b) "ALREADY TRANSLATED" IS A NODE RELATION, NOT A LINE. A node counts as
 *       translated iff it is inside a `t()` call. Nothing about its line.
 *   (c) A string literal rendered through a JSXExpressionContainer (the
 *       `cond ? "EMAIL" : "RECEIPTS"` shape) is a known copy position and
 *       skips the gate too.
 *
 * It still errs toward reporting: a false positive costs a glance, a miss
 * ships half-translated copy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
const traverse = _traverse.default ?? _traverse;

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("usage: node scripts/find-strings.mjs <file-or-dir>…");
  process.exit(2);
}

/** Attribute names whose string value is shown to a user. */
const COPY_ATTRS = new Set([
  "placeholder", "title", "label", "alt", "aria-label", "aria-placeholder",
  "subtitle", "sublabel", "text", "message", "confirmText", "cancelText",
  "emptyText", "buttonTitle", "note", "confirmLabel", "header", "caption",
]);
/** Object keys whose string value is shown to a user — `{ label: 'Light' }`. */
const COPY_KEYS = new Set([
  "label", "title", "message", "text", "placeholder", "subtitle", "body",
  "description", "confirmText", "cancelText", "heading", "caption",
  "hint", "error",
]);

/**
 * Not copy because of its SHAPE: a colour, a url, a path, a number. True
 * regardless of where the string sits.
 */
const NOT_COPY_EVER =
  /^(#[0-9a-fA-F]{3,8}$|rgba?\(|https?:|mailto:|tel:|\.?\/|[\d%.\s]+$)/;
/**
 * Not copy because it READS like an identifier — snake_case, kebab-case,
 * SCREAMING_CASE. Only applied OUTSIDE a render position.
 *
 * It must NOT apply inside one: this codebase styles section headers in caps
 * (`{verified ? "EMAIL" : "RECEIPTS"}` in ProfileScreen), and lowercase words
 * are rendered too (`{method === "card" ? "card" : "cash"}`). Treating those
 * as identifiers is exactly how "Receipts" survived two sweeps.
 */
const IDENTIFIERISH = /^([a-z0-9_]+|[a-z0-9]+(-[a-z0-9]+)+|[A-Z0-9_]+)$/;
/**
 * Attributes whose value is styling, never copy. `style` and `className` are
 * returned early by the JSX-attribute rule already, but their values here are
 * OBJECTS and TEMPLATES whose inner literals are reached independently, so the
 * check has to be positional (`inStyleAttribute`) rather than parent-shaped.
 */
const STYLE_ATTRS = new Set(["style", "className", "css"]);

function files(p) {
  const st = statSync(p);
  if (st.isFile()) return [p];
  if (/node_modules|\.git$/.test(p)) return [];
  return readdirSync(p).flatMap((e) => files(join(p, e)));
}

/** Has real words in it — the floor for anything being copy at all. */
const hasWords = (s) => /[A-Za-z]{2}/.test(s);

/** The two-word gate, for literals in positions we cannot vouch for. */
function looksLikeCopy(s) {
  const t = s.trim();
  if (t.length < 3 || !hasWords(t)) return false;
  if (NOT_COPY_EVER.test(t) || IDENTIFIERISH.test(t)) return false;
  return /\s/.test(t);
}

/** Is this node inside a t(…) / i18n translation call? */
function isTranslated(path) {
  return !!path.findParent((p) => {
    if (!p.isCallExpression()) return false;
    const c = p.node.callee;
    return (
      (c.type === "Identifier" && /^(t|tr|translate)$/.test(c.name)) ||
      (c.type === "MemberExpression" &&
        c.property.type === "Identifier" &&
        /^(t|translate)$/.test(c.property.name))
    );
  });
}

/** Is this literal rendered as JSX content, e.g. {cond ? "A" : "B"}? */
function inJsxExpression(path) {
  let p = path.parentPath;
  while (p) {
    if (p.isJSXExpressionContainer()) return p.parentPath?.isJSXElement() || p.parentPath?.isJSXFragment();
    if (
      p.isConditionalExpression() || p.isLogicalExpression() ||
      p.isTemplateLiteral() || p.isBinaryExpression() || p.isParenthesizedExpression()
    ) { p = p.parentPath; continue; }
    return false;
  }
  return false;
}

/**
 * Strip HTML markup from a template literal's text, so a template that is pure
 * STRUCTURE reports nothing while one carrying real copy still reports.
 *
 * Needed for `printReport()` in ReportsPage, which builds a whole printable
 * document with `window.open()` + `document.write()`. Once its copy is behind
 * t(), what is left in the quasis is `<div class="row"><div class="row-label">`
 * — tag and class names, which `hasWords` reads as words. Marking each of the
 * nine fragments `// i18n-ok` would have worked and would have been wrong: a
 * marker says "a human vetted this site", and these sites are exactly where
 * future copy will be added.
 *
 * This is NOT a blind spot: tag-stripping is reductive, so `<title>Driver
 * Report</title>` still reports "Driver Report". It only silences templates
 * with nothing but markup left. `<style>` bodies go too — CSS survives
 * tag-stripping and is not copy either.
 */
function stripMarkup(text) {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Inside a `<style>` element — this repo's dominant styling idiom is a
 * per-page `<style>{`…`}</style>` block, which is a whole stylesheet in one
 * template literal. Structural, not pattern-based: "does CSS look like this"
 * is unbounded, "is this inside a style tag" is a fact.
 */
function inStyleElement(path) {
  return !!path.findParent((p) => {
    if (!p.isJSXElement()) return false;
    const n = p.node.openingElement.name;
    return n.type === "JSXIdentifier" && n.name === "style";
  });
}

/**
 * Inside a `style={{…}}` / `className={…}` attribute value. The JSX-attribute
 * rule below returns early for a DIRECT string value, but these values are
 * objects and templates whose inner literals (`'8px 18px'`,
 * `"'Inter', system-ui, sans-serif"`) are visited on their own and would land
 * in the unvouched-for bucket, where they clear the two-word gate.
 */
function inStyleAttribute(path) {
  return !!path.findParent(
    (p) =>
      p.isJSXAttribute() &&
      p.node.name.type === "JSXIdentifier" &&
      STYLE_ATTRS.has(p.node.name.name),
  );
}

/** Diagnostic sinks — console, crumbs, analytics. Never user-facing. */
function isDiagnostic(path) {
  return !!path.findParent((p) => {
    if (!p.isCallExpression()) return false;
    const src = p.get("callee").toString();
    return /^(console\.|noteTaskEvent|crumb|addCrumb|diary)/.test(src);
  });
}

/**
 * A literal being COMPARED is never rendered: `tab === "mine"`,
 * `status !== "completed"`. These sit inside a JSXExpressionContainer via the
 * `{tab === "mine" && <X/>}` idiom, so the render-position rule would otherwise
 * report every enum value in the app as untranslated copy.
 */
function isComparisonOperand(path) {
  const p = path.parentPath;
  if (!p) return false;
  if (p.isBinaryExpression() && /^(===?|!==?|<|>|<=|>=)$/.test(p.node.operator)) return true;
  if (p.isSwitchCase()) return true;
  return (
    (p.isCallExpression() || p.isOptionalCallExpression()) &&
    /[.?]*(includes|startsWith|endsWith|indexOf|has|test)$/.test(p.get("callee").toString())
  );
}

/** Calls whose string arguments are data, not copy. */
const DATA_CALL =
  /\.(select|eq|neq|in|is|gt|gte|lt|lte|from|rpc|channel|invoke|update|insert|upsert|delete|order|single|maybeSingle|match|filter|like|ilike|or|contains|setItem|getItem|removeItem|deleteItemAsync|getItemAsync|setItemAsync|on|emit|subscribe|track|getString|setString)$|^(fetch|require|encodeURIComponent|decodeURIComponent|JSON\.parse|new URL)$/;

function isDataArgument(path) {
  const p = path.parentPath;
  if ((p?.isCallExpression() || p?.isOptionalCallExpression()) && DATA_CALL.test(p.get("callee").toString()))
    return true;
  // Headers / fetch init objects: { method: "POST", "Content-Type": "application/json" }
  if (p?.isObjectProperty()) {
    const k = p.node.key.type === "Identifier" ? p.node.key.name : p.node.key.value;
    if (/^(method|Authorization|Content-Type|apikey|headers|body|key|id|type|name|uri|url|path)$/i.test(String(k)))
      return true;
  }
  return false;
}

/**
 * A bare array of four or more string literals is a DATA list — the vehicle
 * make/model tables here are hundreds of entries ("Silverado 1500", "Grand
 * Caravan"). Copy does not arrive as an anonymous four-element array.
 */
function inDataArray(path) {
  const arr = path.parentPath;
  if (!arr?.isArrayExpression()) return false;
  return arr.node.elements.filter((e) => e?.type === "StringLiteral").length >= 4;
}

/**
 * An array element REACHED BY `.map()` whose result renders in JSX.
 *
 * This is the blind spot that shipped six user-visible English surfaces while
 * the gate reported zero (found by Victor, 2026-10-04, not by this scanner):
 * a table header row is `{["Date","Ride","Passenger",…].map(h => <th>{h}</th>)}`,
 * which is an anonymous array of four or more single words — the exact shape
 * `inDataArray` silences as a data list, and single words also fall below the
 * two-word gate in rule 6. Two rules compounding into one hole.
 *
 * Count is NOT the discriminator: a header row and a vehicle make/model table
 * are both arrays of words. The structural difference is that one is mapped
 * into JSX and the other is a module-scope constant nothing renders directly.
 * So this is a VOUCHED-FOR position (single words report, like JSX text), and
 * `inDataArray` is consulted only when this is false.
 *
 * Walks up through nested arrays so the tuple form — `[["all","All"],…].map()`
 * — reports too. That over-reports the enum half of each tuple, which is the
 * right direction for a gate: an enum value takes one `i18n-ok`, a missed
 * label takes a customer noticing.
 */
function inMappedJsxArray(path) {
  let arr = path.parentPath;
  if (!arr?.isArrayExpression()) return false;
  // Climb nested arrays (tuple inside a list of tuples).
  for (let i = 0; i < 4 && arr?.isArrayExpression(); i++) {
    const member = arr.parentPath;
    if (
      member?.isMemberExpression() &&
      member.node.property.type === "Identifier" &&
      /^(map|flatMap)$/.test(member.node.property.name)
    ) {
      // The mapped result has to end up rendered, not fed to a data call.
      return !!member.findParent((q) => q.isJSXExpressionContainer() || q.isJSXElement());
    }
    // `as const` / parenthesised array, then up to any enclosing array.
    let up = arr.parentPath;
    while (up?.isTSAsExpression() || up?.isParenthesizedExpression() || up?.isTSConstAssertion?.()) up = up.parentPath;
    arr = up?.isArrayExpression() ? up : up;
    if (!arr?.isArrayExpression()) {
      // One more hop: the `.map` may hang off the as-const wrapper directly.
      const member2 = up?.parentPath;
      if (
        member2?.isMemberExpression() &&
        member2.node.property.type === "Identifier" &&
        /^(map|flatMap)$/.test(member2.node.property.name)
      ) {
        return !!member2.findParent((q) => q.isJSXExpressionContainer() || q.isJSXElement());
      }
      return false;
    }
  }
  return false;
}

/**
 * A dotted lower-camel path IS an i18n key, not copy — several module-scope
 * arrays here deliberately store `label: "reportDriver.rude"` and resolve it at
 * render, because a module-scope array of strings is evaluated before any
 * locale exists.
 */
const I18N_KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

/** Alert button styles, RN enum values on a `style`/`keyboardType`-style key. */
const ENUM_KEY = /^(style|keyboardType|autoCapitalize|autoComplete|textContentType|returnKeyType|mode|variant|kind|code|status|role|resizeMode|note)$/;

/** URL/query fragments and supabase select lists, both of which arrive as templates. */
const MACHINE_TEXT =
  /^[?&]|[?&][a-z_]+=|^https?:|\(#|^node\[|^\);|^sb-|^avatars\/|^[a-z_]+(,\s*[a-z_]+){2,}$/;

let total = 0;
const perFile = [];

for (const root of roots) {
  for (const f of files(root)) {
    if (![".tsx", ".ts"].includes(extname(f))) continue;
    const src = readFileSync(f, "utf8");
    let ast;
    try {
      ast = parse(src, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: true,
      });
    } catch (e) {
      console.error(`PARSE FAIL ${f}: ${e.message}`);
      continue;
    }
    const hits = [];
    /**
     * `// i18n-ok` opts a VETTED site out, on its own line or the line above.
     *
     * This exists so the remaining count stays trustworthy. The alternative is
     * a permanent floor of known-good hits (an `ABC 123` placeholder, a plate
     * normaliser that only looks like a label), and a report with a floor is a
     * report nobody reads — which is how six rounds of English shipped.
     */
    const srcLines = src.split("\n");
    const allowed = (line) =>
      /i18n-ok/.test(srcLines[line - 1] ?? "") || /i18n-ok/.test(srcLines[line - 2] ?? "");
    const add = (node, kind, text) => {
      const n = node.loc?.start.line ?? 0;
      if (allowed(n)) return;
      hits.push({ n, kind, text: text.replace(/\s+/g, " ").trim() });
    };

    traverse(ast, {
      // ── JSX text: copy by construction, no word gate ─────────────────
      JSXText(path) {
        const raw = path.node.value;
        const text = raw.replace(/\s+/g, " ").trim();
        if (!text || !hasWords(text)) return;
        // `<Text>{"{"}</Text>`-style punctuation-only runs are not copy.
        if (!/[A-Za-z]{2}/.test(text)) return;
        add(path.node, "jsx", text);
      },

      StringLiteral(path) {
        const text = path.node.value;
        if (!text.trim() || !hasWords(text)) return;
        if (isTranslated(path) || isDiagnostic(path)) return;
        if (inStyleElement(path) || inStyleAttribute(path)) return;
        const mappedIntoJsx = inMappedJsxArray(path);
        if (isComparisonOperand(path) || isDataArgument(path)) return;
        if (!mappedIntoJsx && inDataArray(path)) return;
        if (I18N_KEY.test(text)) return;
        if (path.parent.type === "ObjectProperty" && !path.parent.computed) {
          const k = path.parent.key.type === "Identifier" ? path.parent.key.name : path.parent.key.value;
          if (ENUM_KEY.test(String(k))) return;
        }
        // Thrown developer errors are not product copy.
        if (path.findParent((p) => p.isThrowStatement() || (p.isNewExpression() && p.get("callee").toString() === "Error"))) return;
        const parent = path.parent;

        // Module specifiers (`from "./x"`) and type-level literals.
        //
        // This MUST test the literal's immediate position, never findParent:
        // `isExportDeclaration()` is true for `ExportDefaultDeclaration`, and
        // every screen in this app is `export default function Screen()`, so a
        // findParent here silently excluded EVERY string in EVERY screen. It is
        // what hid ProfileScreen's "RECEIPTS" from the first AST run — a
        // whole-file blind spot that reported the file as clean.
        if (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration" ||
            parent.type === "ExportAllDeclaration" || parent.type === "ImportAttribute") return;
        if (path.findParent((p) => p.isTSType() || p.isTSLiteralType())) return;

        // 1. JSX attribute from the copy list
        if (parent.type === "JSXAttribute" && COPY_ATTRS.has(parent.name.name)) {
          add(path.node, "attr", text);
          return;
        }
        if (parent.type === "JSXAttribute") return; // style/testID/icon names etc.

        // 2. (The app's Alert.alert(…) rule is dropped — React Native only.
        //    The web equivalents are window.alert/confirm, which this codebase
        //    does not use: every confirmation is a rendered modal, so its copy
        //    is already reached as JSX text or a copy-named prop.)

        // 3. { label: 'Light' } — a copy-named object property
        if (parent.type === "ObjectProperty" && !parent.computed) {
          const key = parent.key.type === "Identifier" ? parent.key.name : parent.key.value;
          if (COPY_KEYS.has(key)) {
            if (!NOT_COPY_EVER.test(text)) add(path.node, "prop", text);
            return;
          }
        }

        // 4. Rendered through a JSX expression container: {cond ? "A" : "B"}
        if (inJsxExpression(path)) {
          if (!NOT_COPY_EVER.test(text)) add(path.node, "jsxexpr", text);
          return;
        }

        // 4b. Array element mapped into JSX — vouched-for, so single words
        //     report. This is the table-header / filter-chip class.
        if (mappedIntoJsx) {
          const txt = text.trim();
          if (!MACHINE_TEXT.test(txt) && !NOT_COPY_EVER.test(text) && !IDENTIFIERISH.test(text))
            add(path.node, "maparr", text);
          return;
        }

        // 5. A RETURNED literal is a label: `if (d === 0) return "Today";`.
        //    Found 2026-10-04 in DriverProfileSheet's formatDate. These are
        //    single words, so the two-word gate below hid them — but unlike the
        //    vehicle tables (which are ARRAY ELEMENTS), a returned string in a
        //    branchy helper is overwhelmingly a status pill or a date label.
        {
          let r = path.parentPath, ret = false;
          while (r) {
            if (r.isFunction()) break;
            if (r.isReturnStatement() || r.isArrowFunctionExpression()) { ret = true; break; }
            if (r.isConditionalExpression() || r.isLogicalExpression()) { r = r.parentPath; continue; }
            break;
          }
          if (ret && !MACHINE_TEXT.test(text.trim()) && !NOT_COPY_EVER.test(text) && !IDENTIFIERISH.test(text)) {
            add(path.node, "ret", text);
            return;
          }
        }

        // 6. Anywhere else — needs the two-word gate or the vehicle lists flood.
        if (!MACHINE_TEXT.test(text.trim()) && looksLikeCopy(text)) add(path.node, "str", text);
      },

      TemplateLiteral(path) {
        if (isTranslated(path) || isDiagnostic(path)) return;
        if (inStyleElement(path) || inStyleAttribute(path)) return;
        if (path.findParent((p) => p.isTaggedTemplateExpression())) return;
        const text = path.node.quasis.map((q) => q.value.cooked ?? "").join(" ");
        // A template that is only markup once its copy is behind t() — see
        // stripMarkup. Tested on the stripped text, reported with the original.
        if (/<[a-z!/]/i.test(text) && !hasWords(stripMarkup(text))) return;
        if (!hasWords(text) || MACHINE_TEXT.test(text.trim())) return;
        if (isComparisonOperand(path) || isDataArgument(path)) return;
        const rendered = inJsxExpression(path) || path.parent.type === "JSXExpressionContainer";
        if (rendered ? !NOT_COPY_EVER.test(text.trim()) : looksLikeCopy(text)) {
          add(path.node, rendered ? "tmplx" : "tmpl", text);
        }
      },

      // ── HARDCODED LOCALE TAGS ────────────────────────────────────────
      //
      // `d.toLocaleDateString("en-CA", …)` renders English month and day names
      // no matter what language the UI is in, and it is not a copy string so
      // nothing above can see it. Found 2026-10-04 at 20 sites while the app
      // was otherwise fully translated: the words were French and every date
      // read "October 4". The fix is always `useFormat()` (src/lib/useFormat.ts),
      // which binds the ACTIVE locale, never a second hardcoded tag.
      MemberExpression(path) {
        const prop = path.node.property;
        if (prop.type !== "Identifier" || !/^toLocale(Date|Time)?String$/.test(prop.name)) return;
        const call = path.parentPath;
        if (!call?.isCallExpression()) return;
        const arg = call.node.arguments[0];
        if (arg?.type === "StringLiteral" && /^[a-z]{2}(-[A-Za-z0-9]+)*$/.test(arg.value)) {
          add(arg, "LOCALE", `${prop.name}("${arg.value}") — hardcoded locale, use src/i18n/format.ts`);
        }
      },

      // ── Labels DERIVED from code identifiers ─────────────────────────
      // `{f.charAt(0).toUpperCase() + f.slice(1)}` over ["all","completed",
      // "cancelled"] renders English that appears NOWHERE as a copy string, so
      // no literal scanner of any kind can see it. Found 2026-10-04 on the
      // ride-history filter tabs. Flagged as its own kind because the fix is
      // different: it needs a key MAP, not a t() around a literal.
      CallExpression(path) {
        // An IIFE's "callee text" is its whole BODY, so any `.toUpperCase()`
        // anywhere inside a 400-line render block matched the test below and
        // reported the block itself as a derived label. Analytics has two such
        // blocks. Skip function-valued callees: this rule is about an
        // identifier being title-cased into copy, which is always a member
        // chain, never a function literal.
        if (path.get("callee").isFunction()) return;
        const callee = path.get("callee").toString();
        // MEASURED DEAD, 2026-10-04: this used to test the callee for
        // `\.toUpperCase\(\)` *with* parens. A callee's own source text never
        // contains the trailing `()` of its own call — `p.charAt(0).toUpperCase()`
        // has the callee `p.charAt(0).toUpperCase` — so the rule could not fire
        // on any input, and the two sites it was credited with finding were
        // found by eye. Match the callee ENDING in the method instead, and keep
        // probe-derived in the control below so a silent rule cannot return.
        if (/\.(toUpperCase|toLowerCase)$/.test(callee) && /charAt|slice|\[0\]/.test(callee)) {
          add(path.node, "DERIVED", `${callee}() — label computed from an identifier`);
        }
      },
    });

    // de-dupe (a node can be reached twice through nested visitors)
    const seen = new Set();
    const kept = hits.filter((h) => {
      const k = `${h.n}|${h.kind}|${h.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (kept.length) {
      perFile.push({ f, kept });
      total += kept.length;
    }
  }
}

perFile.sort((a, b) => b.kept.length - a.kept.length);
for (const { f, kept } of perFile) {
  console.log(`\n${f}  (${kept.length})`);
  if (process.env.VERBOSE) {
    for (const h of kept)
      console.log(`   ${String(h.n).padStart(5)} ${h.kind.padEnd(7)} ${h.text.slice(0, 90)}`);
  }
}
console.log(`\nTOTAL candidate strings: ${total} across ${perFile.length} files`);
