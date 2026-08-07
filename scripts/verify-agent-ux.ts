/**
 * Agent chat UX PURE verification — no DB, no key, no browser.
 * Run: `npx tsx scripts/verify-agent-ux.ts`
 *
 * Covers:
 *  (a) DRIFT GUARD — imports the REAL tool registry (`ALL_TOOLS` + the named
 *      tool-name sets the loop actually uses) and asserts EVERY tool has an
 *      EXPLICIT `TOOL_LABELS` entry (not just the prettify fallback). Adding a
 *      tool without a friendly label fails this suite.
 *  (b) `friendlyToolLabel` fallback — unknown snake_case prettifies to a
 *      capitalized, underscore-free gerund phrase; prose passes through.
 *  (c) `parseMarkdownBlocks` — paragraphs/bold/italic/code/lists/headings/
 *      code fences, plain-text passthrough, and no-crash on pathological input.
 *  (d) The humanized phase→copy map covers every phase id in lib/ai/events.ts's
 *      phase union (regexed from the source, so a new phase id trips this).
 */

import { readFileSync } from "node:fs";
import {
  ALL_TOOLS,
  ANALYST_TOOL_NAMES,
  AUTHORING_TOOL_NAMES,
  GENERATE_TOOL_NAMES,
  REMEDIATION_TOOL_NAMES,
} from "@/lib/ai/tools";
import {
  AGENT_MAINTENANCE_COPY,
  AGENT_PHASE_COPY,
  friendlyToolDone,
  friendlyToolLabel,
  TOOL_CATEGORIES,
  TOOL_LABELS,
} from "@/lib/ai/toolLabels";
import { parseInline, parseMarkdownBlocks } from "@/components/ui/Markdown";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const CATEGORY_SET = new Set<string>(TOOL_CATEGORIES);

// ── (a) Drift guard: every registered tool has an explicit, well-formed label ──
console.log("\nDrift guard — TOOL_LABELS covers the real tool registry");
for (const tool of ALL_TOOLS) {
  const entry = TOOL_LABELS[tool.name];
  check(
    `explicit label for ${tool.name}`,
    !!entry &&
      entry.label.trim().length > 0 &&
      entry.done.trim().length > 0 &&
      !entry.label.includes("_") &&
      !entry.done.includes("_") &&
      CATEGORY_SET.has(entry.icon),
    entry ? "malformed entry" : "MISSING — add it to lib/ai/toolLabels.ts"
  );
}
check("registry is non-trivial (guards a broken import)", ALL_TOOLS.length >= 30, `got ${ALL_TOOLS.length}`);

const NAMED_SETS: [string, ReadonlySet<string>][] = [
  ["AUTHORING_TOOL_NAMES", AUTHORING_TOOL_NAMES],
  ["GENERATE_TOOL_NAMES", GENERATE_TOOL_NAMES],
  ["ANALYST_TOOL_NAMES", ANALYST_TOOL_NAMES],
  ["REMEDIATION_TOOL_NAMES", REMEDIATION_TOOL_NAMES],
];
for (const [setName, names] of NAMED_SETS) {
  const missing = [...names].filter((n) => !TOOL_LABELS[n]);
  check(`${setName} fully labeled (${names.size} tools)`, missing.length === 0, missing.join(", "));
}

// ── (b) friendlyToolLabel fallback ────────────────────────────────────────────
console.log("\nfriendlyToolLabel");
check("known tool returns its registry label", friendlyToolLabel("add_structured_slides_batch") === "Adding slides");
const unknown = friendlyToolLabel("frobnicate_the_widget");
check("unknown name has no underscores", !unknown.includes("_"), unknown);
check("unknown name is capitalized", /^[A-Z]/.test(unknown), unknown);
const verbed = friendlyToolLabel("summarize_lesson_notes");
check("unknown verb still reads as a phrase", !verbed.includes("_") && /^[A-Z]/.test(verbed), verbed);
check("known verb prettifies to a gerund", friendlyToolLabel("add_flux_capacitor") === "Adding flux capacitor");
check("prose (summary-as-tool fallback) passes through", friendlyToolLabel("Added 3 slides to the deck") === "Added 3 slides to the deck");
check("empty name degrades safely", friendlyToolLabel("") === "Working");
check("friendlyToolDone uses the past phrase", friendlyToolDone("write_quiz") === "Wrote a knowledge check");
check("friendlyToolDone falls back without snake_case", !friendlyToolDone("zap_the_thing").includes("_"));

// ── (c) parseMarkdownBlocks ───────────────────────────────────────────────────
console.log("\nparseMarkdownBlocks");
{
  const plain = parseMarkdownBlocks("Just a plain sentence.");
  check(
    "plain text → one paragraph, text preserved",
    plain.length === 1 &&
      plain[0].type === "paragraph" &&
      plain[0].inline.length === 1 &&
      plain[0].inline[0].type === "text" &&
      plain[0].inline[0].text === "Just a plain sentence."
  );

  const paras = parseMarkdownBlocks("First paragraph.\n\nSecond paragraph.");
  check("blank line splits paragraphs", paras.length === 2 && paras.every((b) => b.type === "paragraph"));

  const bold = parseMarkdownBlocks("This is **very bold** text.");
  check(
    "**bold** parsed",
    bold[0].type === "paragraph" &&
      bold[0].inline.some((s) => s.type === "bold" && s.text === "very bold") &&
      !bold[0].inline.some((s) => s.text.includes("**"))
  );

  const italic = parseMarkdownBlocks("An *emphasized* word.");
  check("*italic* parsed", italic[0].type === "paragraph" && italic[0].inline.some((s) => s.type === "italic" && s.text === "emphasized"));

  const code = parseMarkdownBlocks("Use `applyCoursePatch` here.");
  check("`inline code` parsed", code[0].type === "paragraph" && code[0].inline.some((s) => s.type === "code" && s.text === "applyCoursePatch"));

  const ul = parseMarkdownBlocks("- one\n- two\n- three");
  check("- list → 3 items", ul.length === 1 && ul[0].type === "list" && !ul[0].ordered && ul[0].items.length === 3);

  const ol = parseMarkdownBlocks("1. first\n2. second");
  check("1. list → ordered, 2 items", ol.length === 1 && ol[0].type === "list" && ol[0].ordered && ol[0].items.length === 2);

  const h = parseMarkdownBlocks("### Section title\nBody line.");
  check("### heading parsed at level 3", h.length === 2 && h[0].type === "heading" && h[0].level === 3);

  const fence = parseMarkdownBlocks('Intro:\n```ts\nconst x = 1;\nconst y = 2;\n```\nAfter.');
  check(
    "```code fence``` parsed with lang + verbatim body",
    fence.length === 3 &&
      fence[1].type === "code" &&
      fence[1].lang === "ts" &&
      fence[1].text === "const x = 1;\nconst y = 2;" &&
      fence[2].type === "paragraph"
  );

  const openFence = parseMarkdownBlocks("```\nstill streaming");
  check("unterminated fence swallows the rest as code", openFence.length === 1 && openFence[0].type === "code" && openFence[0].text === "still streaming");

  const notAList = parseMarkdownBlocks("*italic start* of a line");
  check("*italic* at line start is NOT a bullet", notAList[0].type === "paragraph");

  const pathological = ["***", "``", "**unclosed bold", "*", "```", "1.", "- ", "#".repeat(500), "*".repeat(5000), "`a``b`**c***d*"];
  let crashed = false;
  for (const p of pathological) {
    try {
      parseMarkdownBlocks(p);
      parseInline(p);
    } catch {
      crashed = true;
    }
  }
  check("pathological input never throws", !crashed);
  check("empty string → no blocks", parseMarkdownBlocks("").length === 0);

  const mixed = parseMarkdownBlocks("### Plan\nHere is the **plan**:\n\n1. Add `intro` slide\n2. Add quiz\n\n```py\nprint(1)\n```");
  check(
    "mixed document parses in order",
    mixed.length === 4 && mixed[0].type === "heading" && mixed[1].type === "paragraph" && mixed[2].type === "list" && mixed[3].type === "code"
  );
}

// ── (d) Phase copy covers the wire union ─────────────────────────────────────
console.log("\nPhase → copy coverage (lib/ai/events.ts)");
{
  const src = readFileSync("lib/ai/events.ts", "utf8");
  const m = src.match(/phase:\s*((?:"[a-z_]+"\s*\|\s*)+"[a-z_]+")/);
  check("phase union extracted from events.ts", !!m);
  const ids = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  check("union looks sane (≥6 ids incl. plan/generate)", ids.length >= 6 && ids.includes("plan") && ids.includes("generate"), ids.join(","));
  for (const id of ids) {
    if (id === "critique_skipped") continue; // dispatch maps it to null — never rendered
    check(`copy for phase "${id}"`, typeof AGENT_PHASE_COPY[id] === "string" && AGENT_PHASE_COPY[id].length > 0);
  }
  check(
    "dispatch still nulls critique_skipped",
    readFileSync("components/editor/agent/useAgentStream.ts", "utf8").includes("critique_skipped")
  );
  check('structure copy present ("Reorganizing the course")', AGENT_PHASE_COPY.structure === "Reorganizing the course");

  // Maintenance stages (the wire union in events.ts).
  for (const stage of ["analyze", "findings", "remediate", "comms", "report"]) {
    check(`maintenance copy for "${stage}"`, typeof AGENT_MAINTENANCE_COPY[stage] === "string" && AGENT_MAINTENANCE_COPY[stage].length > 0);
    check(`maintenance stage "${stage}" still on the wire`, src.includes(`"${stage}"`));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
