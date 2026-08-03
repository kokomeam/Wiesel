/**
 * verify-ui — UI-1 Waves 1–2 pure suite (no key, no DB, no browser).
 *
 * Sections (named for the AC ledger):
 *   tokens-no-raw-values.test   [AC-W1.1] zero raw hex / px-bracket /
 *                               shadow-[ / tracking-[ / arbitrary text sizes
 *                               in the UI-1 surface files
 *   primitives-snapshot.test    [AC-W1.2] every ui/ fixture SSR-renders;
 *                               golden snapshots (UI_SNAPSHOT_RECORD=1
 *                               regenerates) + structural a11y assertions
 *   status-chip.test            [AC-W1.3] 1:1 status→token mapping; tokens
 *                               exist in globals.css
 *   humanization-map.test       [AC-W1.4] map ≡ the LIVE tool registry's
 *                               mutating set; labels humanized; hard-deny
 *                               covered
 *   relocation.test             [DEV-6] the educators landing set is out of
 *                               components/marketing
 *
 * Run: npm run verify:ui
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ALL_MARKETING_TOOLS } from "../lib/marketing/tools/index";
import { HARD_DENY_TOOLS } from "../lib/marketing/autonomy";
import {
  MUTATING_TOOL_NAMES,
  TOOL_HUMANIZATION,
  TOOL_CATEGORY_META,
} from "../lib/marketing/humanize";
import { STATUS_CHIP_CLASSES } from "../components/ui/StatusChip";
import { UI_FIXTURES } from "../components/ui/fixtures";
import {
  activityChip,
  dayLabel,
  detailMetadata,
  explainGuardrail,
  GUARDRAIL_EXPLANATIONS,
  relativeTime,
  STAGE_LABELS,
  summarizeAction,
  SUMMARY_MAX_CHARS,
} from "../lib/marketing/activitySummaries";
import { MODE_COMPARISON, MODE_DESCRIPTIONS, modeConsequence } from "../lib/marketing/autonomyCopy";
import { DEFAULT_AUTONOMY_SETTINGS } from "../lib/marketing/autonomy";
import {
  ACTIVITY_EMPTY_COPY,
  ACTIVITY_HINT_COPY,
  REVERT_EXPLAINER,
} from "../components/marketing/ActivityFeed";
import { SECTION_NAV_GROUPS } from "../components/marketing/SectionNav";
import { ACCOUNTS_TRUST_NOTE } from "../lib/marketing/accounts/constants";
import { MANUAL_PUBLISH_NOTICE } from "../lib/marketing/social/constants";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ── tokens-no-raw-values.test [AC-W1.1] ─────────────────────────────────
 * Scope = the UI-1 surface (hub + rail + autonomy + activity + shared
 * chrome those surfaces touch), per the approved CHECKPOINT-0 scope. The
 * deep sub-page editors (CampaignBuilder, ClipsView, PostEditor …) are
 * outside UI-1 and adopt tokens as their own waves touch them. */
const SCOPE_FILES = [
  "app/(app)/marketing/page.tsx",
  "app/(app)/marketing/MarketingHub.tsx",
  "app/(app)/marketing/layout.tsx",
  "app/zz-ui-fixtures/page.tsx",
  "components/marketing/ActivityFeed.tsx",
  "components/marketing/ApprovalCard.tsx",
  "components/marketing/QuestionCard.tsx",
  "components/marketing/AutonomySettings.tsx",
  "components/marketing/AutonomyPill.tsx",
  "components/marketing/CampaignCard.tsx",
  "components/marketing/HubStats.tsx",
  "components/marketing/LifecycleControls.tsx",
  "components/marketing/SectionNav.tsx",
  "components/marketing/agent/AgentDock.tsx",
  "components/marketing/agent/AgentPanel.tsx",
  "components/marketing/agent/DockClearance.tsx",
  "components/shell/Sidebar.tsx",
  "components/shell/Topbar.tsx",
  "components/shell/MobileNav.tsx",
  // components/ui/* minus the educators-only display primitives:
  ...readdirSync(join(ROOT, "components/ui"))
    .filter((f) => f.endsWith(".tsx") && !["RotatingText.tsx", "background-paths.tsx"].includes(f))
    .map((f) => `components/ui/${f}`),
];

const RAW_VALUE_RULES: { name: string; re: RegExp }[] = [
  { name: "hex color", re: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/ },
  { name: "arbitrary shadow", re: /shadow-\[/ },
  { name: "arbitrary tracking", re: /tracking-\[/ },
  { name: "arbitrary text size", re: /text-\[\d/ },
  { name: "px inside bracket value", re: /\[[^\]\n]*\d+px[^\]\n]*\]/ },
];

console.log("\n## tokens-no-raw-values.test [AC-W1.1]");
for (const rel of SCOPE_FILES) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const hits: string[] = [];
  for (const rule of RAW_VALUE_RULES) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return; // comments may cite old values
      if (rule.re.test(line)) hits.push(`${rule.name} @ ${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  check(`no raw values in ${rel}`, hits.length === 0, hits.join(" | "));
}

/* ── status-chip.test [AC-W1.3] ──────────────────────────────────────── */
console.log("\n## status-chip.test [AC-W1.3]");
const STATUSES = ["success", "pending", "attention", "neutral", "destructive"] as const;
check("exactly 5 semantic statuses", Object.keys(STATUS_CHIP_CLASSES).length === 5);
for (const s of STATUSES) {
  const cls = STATUS_CHIP_CLASSES[s];
  check(
    `status "${s}" maps 1:1 to its own tokens`,
    cls === `text-status-${s} bg-status-${s}-bg ring-status-${s}-ring`,
    cls
  );
}
const globalsCss = readFileSync(join(ROOT, "app/globals.css"), "utf8");
for (const s of STATUSES) {
  const all = [`--color-status-${s}:`, `--color-status-${s}-bg:`, `--color-status-${s}-ring:`].every((t) =>
    globalsCss.includes(t)
  );
  check(`globals.css defines the ${s} trio`, all);
}
for (const tok of [
  "--text-meta:",
  "--text-secondary:",
  "--text-body:",
  "--text-title:",
  "--text-section:",
  "--text-display:",
  "--spacing-card-pad:",
  "--spacing-gutter:",
  "--spacing-section-gap:",
  "--spacing-row-h:",
  "--spacing-fab-clearance:",
  "--radius-card:",
  "--radius-panel:",
  "--radius-control:",
  "--shadow-card:",
  "--shadow-overlay:",
  "--ease-out-brand:",
  "--tracking-eyebrow:",
]) {
  check(`globals.css defines ${tok.replace(":", "")}`, globalsCss.includes(tok));
}

/* ── humanization-map.test [AC-W1.4] ─────────────────────────────────── */
console.log("\n## humanization-map.test [AC-W1.4]");
const registryMutating = new Set(
  ALL_MARKETING_TOOLS.filter((t) => t.reversibility !== "read").map((t) => t.name)
);
const mapNames = new Set<string>(MUTATING_TOOL_NAMES);
const missingFromMap = [...registryMutating].filter((n) => !mapNames.has(n));
const extraInMap = [...mapNames].filter((n) => !registryMutating.has(n));
check("map covers every mutating registry tool", missingFromMap.length === 0, missingFromMap.join(", "));
check("map has no stale entries", extraInMap.length === 0, extraInMap.join(", "));
check(
  "every hard-denied tool is labeled",
  [...HARD_DENY_TOOLS].every((t) => mapNames.has(t)),
  [...HARD_DENY_TOOLS].filter((t) => !mapNames.has(t)).join(", ")
);
const labelProblems: string[] = [];
for (const name of MUTATING_TOOL_NAMES) {
  const { label, category } = TOOL_HUMANIZATION[name];
  if (!label || label.includes("_")) labelProblems.push(`${name}: "${label}"`);
  if (label[0] !== label[0].toUpperCase()) labelProblems.push(`${name}: not sentence case`);
  if (!TOOL_CATEGORY_META[category]) labelProblems.push(`${name}: bad category ${category}`);
}
check("labels humanized (no snake_case, sentence case, valid category)", labelProblems.length === 0, labelProblems.join(" | "));
check("labels are unique", new Set(MUTATING_TOOL_NAMES.map((n) => TOOL_HUMANIZATION[n].label)).size === MUTATING_TOOL_NAMES.length);

/* ── primitives-snapshot.test [AC-W1.2] ──────────────────────────────── */
console.log("\n## primitives-snapshot.test [AC-W1.2]");
const SNAP_PATH = join(ROOT, "scripts/fixtures/ui-snapshots.json");
const record = process.env.UI_SNAPSHOT_RECORD === "1";
const rendered: Record<string, string> = {};
for (const f of UI_FIXTURES) {
  try {
    rendered[f.name] = renderToStaticMarkup(createElement(Fragment, null, f.node));
  } catch (e) {
    check(`fixture ${f.name} renders`, false, String(e));
  }
}
if (record) {
  mkdirSync(join(ROOT, "scripts/fixtures"), { recursive: true });
  writeFileSync(SNAP_PATH, JSON.stringify(rendered, null, 2));
  console.log(`  recorded ${Object.keys(rendered).length} snapshots → scripts/fixtures/ui-snapshots.json`);
}
const goldens: Record<string, string> = existsSync(SNAP_PATH)
  ? JSON.parse(readFileSync(SNAP_PATH, "utf8"))
  : {};
check("golden snapshot file exists", existsSync(SNAP_PATH), "run UI_SNAPSHOT_RECORD=1 npm run verify:ui");
for (const f of UI_FIXTURES) {
  if (!rendered[f.name]) continue;
  if (!record) {
    check(`snapshot ${f.name}`, goldens[f.name] === rendered[f.name], "markup drifted — review + re-record");
  } else {
    check(`snapshot ${f.name} (recorded)`, true);
  }
}
// Structural a11y assertions (independent of goldens).
const html = (n: string) => rendered[n] ?? "";
check("toggle-on has switch semantics", html("toggle-on").includes('role="switch"') && html("toggle-on").includes('aria-checked="true"'));
check("toggle-off unchecked", html("toggle-off").includes('aria-checked="false"'));
check("segmented control is a radiogroup", html("segmented-control").includes('role="radiogroup"'));
check(
  "segmented control has exactly one selected radio",
  (html("segmented-control").match(/aria-checked="true"/g) ?? []).length === 1
);
check("segmented Recommended badge renders whole", html("segmented-control").includes(">Recommended<"));
check("status chips carry data-status", STATUSES.every((s) => html(`status-chip-${s}`).includes(`data-status="${s}"`)));
check("field error is polite-live", html("field-group-error").includes('aria-live="polite"'));
check("invalid input flagged", html("field-group-error").includes('aria-invalid="true"'));
check("collapsible closed body is hidden", html("collapsible-closed").includes("hidden"));
check("collapsible header is aria-expanded", html("collapsible-open").includes('aria-expanded="true"'));

/* ── relocation.test [DEV-6] ─────────────────────────────────────────── */
console.log("\n## relocation.test [DEV-6]");
const landingSet = [
  "MarketingNav",
  "Hero",
  "HeroPreview",
  "TrustStrip",
  "DualPath",
  "HowItWorks",
  "Features",
  "StatsBand",
  "MarketplacePeek",
  "FinalCTA",
  "Cta",
  "CountUp",
  "MarketingFooter",
  "motion",
];
const marketingDir = readdirSync(join(ROOT, "components/marketing"));
check(
  "landing set no longer in components/marketing",
  landingSet.every((n) => !marketingDir.includes(`${n}.tsx`)),
  landingSet.filter((n) => marketingDir.includes(`${n}.tsx`)).join(", ")
);
const educatorsDir = readdirSync(join(ROOT, "components/educators"));
check(
  "landing set fully present in components/educators",
  landingSet.every((n) => educatorsDir.includes(`${n}.tsx`)),
  landingSet.filter((n) => !educatorsDir.includes(`${n}.tsx`)).join(", ")
);

/* ── activity-summaries.test [AC-W3.2 / AC-W3.3] ─────────────────────── */
console.log("\n## activity-summaries.test [AC-W3.2/AC-W3.3]");
{
  const LONG = "x".repeat(200);
  const stress = [
    null,
    {},
    { entity: LONG, count: 999999, dropped: 999, platform: "youtube_shorts", stage: "tofu" as const, keyword: LONG, preset: "tofu_hook", note: LONG },
  ];
  const overLimit: string[] = [];
  const snake: string[] = [];
  for (const name of MUTATING_TOOL_NAMES) {
    for (const f of stress) {
      const line = summarizeAction(name, f as never);
      if (line.length === 0 || line.length > SUMMARY_MAX_CHARS) overLimit.push(`${name}: ${line.length}ch`);
      if (/\b\w+_\w+\b/.test(line)) snake.push(`${name}: "${line}"`);
    }
  }
  check(`every template ≤${SUMMARY_MAX_CHARS} chars for null/empty/long fields (${MUTATING_TOOL_NAMES.length} tools × 3)`, overLimit.length === 0, overLimit.slice(0, 3).join(" | "));
  check("no snake_case / internal identifiers in any collapsed line", snake.length === 0, snake.slice(0, 3).join(" | "));

  // The appendix quality bar — exact expected outputs.
  const expected: [string, Record<string, unknown> | null, string][] = [
    ["select_clip_moments", { count: 3, dropped: 1 }, "Found 3 clip moments · 1 dropped"],
    ["select_clip_moments", { count: 1 }, "Found 1 clip moment"],
    ["generate_lesson_clips", { entity: "Big O only gives an upper limit" }, "Queued clip render — “Big O only gives an upper limit”"],
    ["generate_posting_kit", { platform: "instagram", keyword: "THETA" }, "Posting kit ready — Instagram Reels · keyword “THETA”"],
    ["send_broadcast", { count: 4 }, "Broadcast to 4 subscribers"],
    ["publish_landing_page", { entity: "Data Structures Interview Prep" }, "Published “Data Structures Interview Prep”"],
    ["build_audience_list", { entity: "Confirmed subscribers", count: 4 }, "List “Confirmed subscribers” — 4 contacts"],
    ["generate_social_post_drafts", { count: 3, dropped: 1, platform: "linkedin" }, "Drafted 3 posts — LinkedIn · 1 dropped"],
    ["activate_sequence", { entity: "Launch drip" }, "Activated “Launch drip”"],
    ["send_test_email", null, "Test email to your own address"],
  ];
  for (const [tool, f, want] of expected) {
    const got = summarizeAction(tool, f as never);
    check(`template ${tool} → "${want}"`, got === want, `got "${got}"`);
  }
  check(
    "unknown tool degrades to the humanized fallback",
    summarizeAction("totally_new_tool", null) === "Totally new tool"
  );

  // Chips + the D-16 predicate.
  const chip = (over: Partial<Parameters<typeof activityChip>[0]>) =>
    activityChip({ toolName: "x", status: "auto_approved", summaryFields: null, routedToApproval: false, autoExecuted: false, ...over });
  check("reverted → Reverted/neutral", chip({ status: "reverted" }).label === "Reverted");
  check(
    "D-16: card-routed + executed → Approved by you (never the policy badge)",
    chip({ status: "executed", routedToApproval: true, autoExecuted: false }).label === "Approved by you"
  );
  check("outcome queued → Queued/pending", chip({ summaryFields: { outcome: "queued" } }).status === "pending");
  check("outcome ready → Ready for you", chip({ summaryFields: { outcome: "ready" } }).label === "Ready for you");
  check("outcome held → Needs review/attention", chip({ summaryFields: { outcome: "held" } }).status === "attention");
  check("pending status → Needs review", chip({ status: "pending" }).label === "Needs review");

  // Render-time translation (D-12/D-14).
  check("funnel codes translate (tofu→Awareness…)", STAGE_LABELS.tofu === "Awareness" && STAGE_LABELS.mofu === "Consideration" && STAGE_LABELS.bofu === "Conversion");
  const md = detailMetadata({ stage: "tofu", preset: "tofu_hook", platform: "instagram" });
  check("detail metadata never leaks codes", md.every((m) => !/tofu|mofu|bofu|_/.test(m.value)), JSON.stringify(md));
  check("known guardrails have creator language", Object.keys(GUARDRAIL_EXPLANATIONS).length >= 8 && explainGuardrail("tool_allowlist").includes("opted"));
  check("unknown guardrail degrades safely", explainGuardrail("mystery_rail").length > 0 && !explainGuardrail("mystery_rail").includes("_"));

  // Time helpers.
  const now = Date.UTC(2026, 7, 2, 12, 0, 0);
  check("relativeTime minutes/hours/days", relativeTime(new Date(now - 5 * 60_000).toISOString(), now) === "5m" && relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now) === "3h" && relativeTime(new Date(now - 26 * 3_600_000).toISOString(), now) === "1d");
  check("dayLabel Today/Yesterday", dayLabel(new Date(now - 60_000).toISOString(), now) === "Today" && dayLabel(new Date(now - 24 * 3_600_000).toISOString(), now) === "Yesterday");
}

/* ── autonomy-copy.test [AC-W4.2 / AC-W4.6] ──────────────────────────── */
console.log("\n## autonomy-copy.test [AC-W4.2/AC-W4.6]");
{
  const withTools = (n: number, mode: "manual" | "assisted" | "auto") => ({
    ...DEFAULT_AUTONOMY_SETTINGS,
    mode,
    policy: { ...DEFAULT_AUTONOMY_SETTINGS.policy, autoApproveTools: Array.from({ length: n }, (_, i) => `t${i}`) },
  });
  check("same mode → no consequence line", modeConsequence(withTools(3, "auto"), "auto") === "");
  const toAuto = modeConsequence(withTools(5, "assisted"), "auto");
  check("→ auto names the opted-in count", toAuto.includes("5 opted-in actions"), toAuto);
  check("→ auto always states social publishing asks", toAuto.includes("Social publishing always asks."));
  const toAutoEmpty = modeConsequence(withTools(0, "assisted"), "auto");
  check("→ auto with empty policy is honest (inert)", toAutoEmpty.includes("Nothing is opted in yet"), toAutoEmpty);
  const toManual = modeConsequence(withTools(2, "auto"), "manual");
  check("→ manual mentions cards + paused opt-ins", toManual.includes("approval card") && toManual.includes("2 auto opt-ins"), toManual);
  const toAssisted = modeConsequence(withTools(0, "manual"), "assisted");
  check("→ assisted mentions clarifying questions", toAssisted.includes("clarifying question"), toAssisted);
  check("mode descriptions are one line each", Object.values(MODE_DESCRIPTIONS).every((d) => !d.includes("\n") && d.length > 20));
  check("comparison table rows complete", MODE_COMPARISON.length >= 4 && MODE_COMPARISON.every((r) => r.manual && r.assisted && r.auto));
  check(
    "no copy implies unset-widens (fails-closed language present)",
    readFileSync(join(ROOT, "components/marketing/AutonomySettings.tsx"), "utf8").includes("fails closed")
  );
}

/* ── trust-copy-locations.test [AC-W3.8] ─────────────────────────────── */
console.log("\n## trust-copy-locations.test [AC-W3.8]");
{
  const PHRASE = /never posts|nothing is ever posted|never publishes/i;
  const ALLOWED = new Set([
    "lib/marketing/social/constants.ts", // the social section notice
    "components/marketing/ActivityFeed.tsx", // the first-run hint
    "lib/marketing/accounts/constants.ts", // the connected-accounts note
  ]);
  const scanDirs = ["app", "components"];
  const offenders: string[] = [];
  // Comments may cite the phrase (e.g. "its 'never publishes' claim…") —
  // only rendered/string code counts.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(rel);
      } else if (/\.(tsx?|mdx?)$/.test(entry.name)) {
        const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
        if (PHRASE.test(src) && !ALLOWED.has(rel)) offenders.push(rel);
      }
    }
  };
  for (const d of scanDirs) walk(d);
  check("reassurance phrase only in the three allowed UI locations", offenders.length === 0, offenders.join(", "));
  for (const rel of ALLOWED) {
    check(`allowed location carries the copy: ${rel}`, PHRASE.test(readFileSync(join(ROOT, rel), "utf8")));
  }
}

/* ── copy-lint.test [AC-W5.1] ────────────────────────────────────────────
 * Lints the RENDERED string corpus: fixture markup text + every activity
 * template output + detail metadata + guardrail/mode/consequence copy +
 * humanized labels + the standing surface strings. Fails on: snake_case
 * tokens, funnel codes, localhost, double spaces, and ALL-CAPS words over 4
 * letters outside the acronym allowlist. Guards the D-6/D-12 class forever. */
console.log("\n## copy-lint.test [AC-W5.1]");
{
  const corpus: { source: string; text: string }[] = [];
  // Tag-stripping stitches text nodes with spaces — collapse runs so the
  // double-space rule only ever judges REAL copy (the literal strings below).
  const htmlToText = (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;| /g, " ")
      .replace(/\s+/g, " ");
  for (const f of UI_FIXTURES) {
    if (rendered[f.name]) corpus.push({ source: `fixture:${f.name}`, text: htmlToText(rendered[f.name]) });
  }
  const sampleFields = [
    null,
    { count: 3, dropped: 1, entity: "Big O only gives an upper limit", platform: "instagram", keyword: "THETA", stage: "tofu" as const, preset: "tofu_hook", outcome: "done" as const },
  ];
  for (const name of MUTATING_TOOL_NAMES) {
    for (const f of sampleFields) corpus.push({ source: `summary:${name}`, text: summarizeAction(name, f as never) });
    corpus.push({ source: `label:${name}`, text: TOOL_HUMANIZATION[name].label });
  }
  corpus.push({
    source: "detail-metadata",
    text: detailMetadata({ stage: "bofu", preset: "mofu_story", platform: "youtube_shorts", keyword: "THETA", count: 3, dropped: 1 })
      .map((m) => `${m.label} ${m.value}`)
      .join(" · "),
  });
  for (const [k, v] of Object.entries(GUARDRAIL_EXPLANATIONS)) corpus.push({ source: `guardrail:${k}`, text: v });
  for (const [k, v] of Object.entries(MODE_DESCRIPTIONS)) corpus.push({ source: `mode:${k}`, text: v });
  for (const r of MODE_COMPARISON) corpus.push({ source: `compare:${r.row}`, text: `${r.row} ${r.manual} ${r.assisted} ${r.auto}` });
  corpus.push({ source: "consequence:auto", text: modeConsequence({ ...DEFAULT_AUTONOMY_SETTINGS, mode: "assisted" }, "auto") });
  corpus.push({ source: "consequence:manual", text: modeConsequence({ ...DEFAULT_AUTONOMY_SETTINGS, mode: "auto" }, "manual") });
  for (const [k, v] of Object.entries(TOOL_CATEGORY_META)) corpus.push({ source: `category:${k}`, text: v.label });
  for (const g of SECTION_NAV_GROUPS) {
    corpus.push({ source: `nav:${g.label}`, text: g.label });
    for (const item of g.items) corpus.push({ source: `nav:${item.label}`, text: `${item.label} ${item.title}` });
  }
  corpus.push({ source: "activity:explainer", text: REVERT_EXPLAINER });
  corpus.push({ source: "activity:hint", text: ACTIVITY_HINT_COPY });
  corpus.push({ source: "activity:empty", text: ACTIVITY_EMPTY_COPY });
  corpus.push({ source: "accounts:trust", text: ACCOUNTS_TRUST_NOTE });
  corpus.push({ source: "social:notice", text: MANUAL_PUBLISH_NOTICE });

  const ACRONYMS = new Set(["UTC", "IANA", "AI", "URL", "FAQ", "CTA", "SEO"]);
  const RULES: { name: string; test: (t: string) => string | null }[] = [
    {
      name: "snake_case token",
      test: (t) => t.match(/\b[a-z0-9]+_[a-z0-9_]+\b/)?.[0] ?? null,
    },
    {
      name: "funnel code",
      test: (t) => t.match(/\b(tofu|mofu|bofu)\b/i)?.[0] ?? null,
    },
    { name: "localhost", test: (t) => (t.includes("localhost") ? "localhost" : null) },
    { name: "double space", test: (t) => (/ {2}/.test(t.trim()) ? "double space" : null) },
    {
      name: "shouted caps",
      test: (t) => {
        // User-supplied values render inside curly quotes (“…”) — exempt
        // them; a creator's comment keyword may legitimately be ALL-CAPS.
        const system = t.replace(/“[^”]*”/g, " ");
        const m = system.match(/\b[A-Z]{5,}\b/g) ?? [];
        const bad = m.filter((w) => !ACRONYMS.has(w));
        return bad[0] ?? null;
      },
    },
  ];
  const offenders: string[] = [];
  for (const { source, text } of corpus) {
    for (const rule of RULES) {
      const hit = rule.test(text);
      if (hit) offenders.push(`${source}: ${rule.name} ("${hit}")`);
    }
  }
  check(`copy-lint clean over ${corpus.length} rendered strings`, offenders.length === 0, offenders.slice(0, 6).join(" | "));
}

console.log(`\n=== verify-ui: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
