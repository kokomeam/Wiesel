/**
 * TUTOR-1 Amendment A2 Wave 3 — the STATUS-INDICATOR UI pure suite (no key, no
 * DB, no browser). Source-level assertions over the two component files A2 Wave 3
 * owns:
 *
 *   TutorStatusIndicator.tsx
 *     A2-15  — NO timers / no framer-motion (proven over the source).
 *     copy   — the three §6/§7 phase strings appear EXACTLY once each.
 *     §7     — no terminal punctuation, no banned specificity phrases, no
 *              snake_case in learner-visible strings.
 *     shape  — exports TutorStatusPhase with all four kinds incl. the [FWD] tool.
 *     a11y   — role="status" + aria-live="polite" + aria-atomic="true".
 *     A2-18  — the dot pulse is guarded on !reduce.
 *
 *   TutorBody.tsx
 *     wiring — imports + renders TutorStatusIndicator for sent/thinking/composing;
 *              busy covers the three phases + queued; the streamingText bubble
 *              exists; the indicator and the streamed bubble are MUTUALLY
 *              EXCLUSIVE (the indicator render is guarded on streamingText===null).
 *     copy   — the approval-notice copy passes the §7 lint too.
 *
 * Run: `npx tsx scripts/verify-tutor-status-ui.ts`
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const ROOT = process.cwd();
function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Count non-overlapping occurrences of a literal in a string. */
function countOf(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const INDICATOR = "components/learn/tutor/TutorStatusIndicator.tsx";
const BODY = "components/learn/tutor/TutorBody.tsx";

/** The exact §6/§7 phase strings — sentence case, no terminal punctuation. */
const PHASE_STRINGS = ["Sending your question", "Working through it", "Writing your answer"];

/** Data-source-naming phrases that §7 bans anywhere in the learner-visible chrome. */
const BANNED_SPECIFICITY = [
  "Reading course data",
  "Analyzing your progress",
  "Consulting the concept graph",
];

function main() {
  const indicator = readSource(INDICATOR);
  const body = readSource(BODY);

  /* ────────────────── A2-15: NO TIMERS / NO FRAMER-MOTION ────────────────── */
  console.log("\n— A2-15: the indicator holds no timers (source assertion) —");
  {
    for (const banned of ["setTimeout", "setInterval", "requestAnimationFrame"]) {
      check(`indicator source contains no ${banned}`, indicator.includes(banned) === false);
    }
    check(
      "indicator imports no framer-motion",
      indicator.includes("framer-motion") === false
    );
  }

  /* ─────────────────────── §6/§7 COPY TABLE (verbatim) ───────────────────── */
  console.log("\n— §6/§7 copy: each phase string appears exactly once —");
  {
    for (const phrase of PHASE_STRINGS) {
      check(`"${phrase}" appears exactly once`, countOf(indicator, phrase) === 1, `(count=${countOf(indicator, phrase)})`);
    }
  }

  /* ─────────────────────── §7 LINT: terminal punctuation ─────────────────── */
  console.log("\n— §7: no terminal punctuation on the phase strings —");
  {
    for (const phrase of PHASE_STRINGS) {
      const last = phrase.trim().slice(-1);
      check(`"${phrase}" has no terminal punctuation`, ![".", "!", "?", "…"].includes(last), `(last='${last}')`);
    }
  }

  /* ────────────────── §7 LINT: no banned specificity phrases ─────────────── */
  console.log("\n— §7: no data-source specificity phrases (indicator + approval copy) —");
  {
    for (const banned of BANNED_SPECIFICITY) {
      check(`indicator has no "${banned}"`, indicator.includes(banned) === false);
      check(`TutorBody has no "${banned}"`, body.includes(banned) === false);
    }
  }

  /* ────────────── §7 LINT: no snake_case in learner-visible strings ──────── */
  console.log("\n— §7: no snake_case inside JSX-visible text of the indicator —");
  {
    // Learner-visible text sits between JSX tags: >…text…<. A snake_case token
    // (lower_word) there would leak an internal identifier into the UI. We scan
    // the phase strings (the only dynamic learner copy source) + the static JSX
    // text nodes conservatively.
    const jsxText = indicator
      .split("\n")
      .filter((l) => />[^<>]*_[^<>]*</.test(l))
      // exclude className / data-* / aria-* attribute lines (attributes carry _ freely)
      .filter((l) => !/className=|data-|aria-|role=/.test(l));
    check("no snake_case leaked into indicator JSX text nodes", jsxText.length === 0, `(offenders=${jsxText.length})`);
    for (const phrase of PHASE_STRINGS) {
      check(`"${phrase}" carries no snake_case`, /_/.test(phrase) === false);
    }
  }

  /* ───────────────────── CONTRACT: TutorStatusPhase union ────────────────── */
  console.log("\n— contract: TutorStatusPhase exports all four kinds (incl. [FWD] tool) —");
  {
    check("exports TutorStatusPhase type", /export\s+type\s+TutorStatusPhase/.test(indicator));
    check("exports the TutorStatusIndicator component", /export\s+function\s+TutorStatusIndicator/.test(indicator));
    for (const kind of ["sent", "thinking", "composing", "tool"]) {
      check(`union has kind "${kind}"`, indicator.includes(`kind: "${kind}"`));
    }
    // The [FWD] tool variant carries a label field.
    check("tool variant carries a label field", /kind:\s*"tool";\s*label:\s*string/.test(indicator));
  }

  /* ────────────────────────── a11y SOURCE (A2-17) ────────────────────────── */
  console.log("\n— A2-17: role=status + aria-live=polite + aria-atomic —");
  {
    check('indicator has role="status"', indicator.includes('role="status"'));
    check('indicator has aria-live="polite"', indicator.includes('aria-live="polite"'));
    check('indicator has aria-atomic="true"', indicator.includes('aria-atomic="true"'));
  }

  /* ───────────────────── A2-18: pulse guarded on !reduce ─────────────────── */
  console.log("\n— A2-18: the animate-pulse dots are guarded on !reduce —");
  {
    check("indicator uses animate-pulse (motion path)", indicator.includes("animate-pulse"));
    // The pulse markup renders only when reduce is false: `reduce ? null : (…)`
    // (mirrors ThinkingRow's original branch). Assert the guard textually.
    check(
      "the dot cluster renders behind a reduce ? null : … guard",
      /reduce\s*\?\s*null\s*:/.test(indicator)
    );
  }

  /* ─────────────────────────── TutorBody WIRING ──────────────────────────── */
  console.log("\n— TutorBody wires the indicator + the streamed bubble —");
  {
    check("TutorBody imports TutorStatusIndicator", body.includes("TutorStatusIndicator"));
    check("TutorBody destructures streamingText from the hook", /streamingText/.test(body));

    // The indicator renders for sent/thinking/composing.
    check(
      "TutorBody renders <TutorStatusIndicator … phase={{ kind: status.kind }} …>",
      /<TutorStatusIndicator\s+phase=\{\{\s*kind:\s*status\.kind\s*\}\}/.test(body)
    );
    for (const kind of ["sent", "thinking", "composing"]) {
      check(`the indicator guard names status.kind === "${kind}"`, body.includes(`status.kind === "${kind}"`));
    }

    // MUTUAL EXCLUSION: the indicator render is guarded on streamingText === null,
    // and the streamed bubble on streamingText !== null. Assert BOTH textually so
    // status and the growing answer can never stack (§6).
    check(
      "the streamed bubble is guarded on streamingText !== null",
      /streamingText\s*!==\s*null\s*\?/.test(body)
    );
    check(
      "the status indicator is guarded on streamingText === null",
      /streamingText\s*===\s*null\s*&&/.test(body)
    );
    check("TutorBody renders the tutor-streaming-bubble", body.includes('data-ai-component="tutor-streaming-bubble"'));

    // busy derivation covers the three phases + queued.
    for (const kind of ["sent", "thinking", "composing", "queued"]) {
      check(`busy covers status.kind === "${kind}"`, body.includes(`status.kind === "${kind}"`));
    }
  }

  /* ─────────────────────── APPROVAL NOTICE (§7 copy) ─────────────────────── */
  console.log("\n— TutorBody approval notice: amber, sentence-case, no tool name in prose —");
  {
    check(
      "TutorBody renders the tutor-approval-notice",
      body.includes('data-ai-component="tutor-approval-notice"')
    );
    // Amber (not rose) chrome — the notice is a calm pause, not an error.
    check("approval notice uses amber (not rose) tokens", /tutor-approval-notice[\s\S]{0,400}amber/.test(body));
    // §7: the explainer copy is sentence case, no terminal punctuation.
    check(
      "approval explainer copy present with no terminal punctuation",
      body.includes("The tutor paused before doing this") &&
        body.includes("The tutor paused before doing this.") === false
    );
    // No action buttons in A2 — the dormant flow renders NO approve/decide button
    // inside the approval notice sub-view. Assert the ApprovalNotice body carries
    // no <button.
    const approvalFn = body.slice(body.indexOf("function ApprovalNotice"));
    const approvalBody = approvalFn.slice(0, approvalFn.indexOf("\n}\n") + 3);
    check("approval notice has NO action buttons (A2 dormant)", approvalBody.includes("<button") === false);
  }

  /* ──────────────────────── ThinkingRow removed cleanly ──────────────────── */
  console.log("\n— ThinkingRow retired (superseded by TutorStatusIndicator) —");
  {
    check("TutorBody no longer references ThinkingRow", body.includes("ThinkingRow") === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
