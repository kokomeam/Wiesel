/**
 * TUTOR-1 W4.3 — /home tutor entry, PURE suite (no key, no DB, no browser).
 *
 *   - gone.spec: the offline preview panel is REALLY gone — grep-fence over
 *     the components/student + app/(student) trees for the canned-preview
 *     literals ("replies are canned", "coming soon", CANNED_REPLIES,
 *     "AI tutor preview") and the TutorPanel identifier; the file itself is
 *     deleted.
 *   - snippet.spec: trimSnippet goldens (word-boundary 140, whitespace
 *     collapse, hard-cut fallback, trailing-punctuation strip).
 *   - links.spec: tutorDeepLink (continue lesson vs landing) +
 *     reviewWithTutorHref (seed encoding, ?/& separator) + learnHrefSlug.
 *   - wiring.spec: the page/card carry the data-ai-tool hooks, the card stays
 *     a server component, the helper documents its admin-read rationale, and
 *     package.json wires verify:tutor-home into the verify:tutor chain.
 *
 * Run: `npx tsx scripts/verify-tutor-home.ts`
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  TUTOR_SNIPPET_MAX,
  learnHrefSlug,
  reviewWithTutorHref,
  trimSnippet,
  tutorDeepLink,
} from "@/lib/learn/tutorHome";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const root = process.cwd();

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

/* ─────────────────────────────── gone.spec ─────────────────────────────── */

function goneChecks() {
  console.log("\n# gone.spec — the canned tutor preview left no residue");

  check(
    "components/student/TutorPanel.tsx is deleted",
    !existsSync(join(root, "components/student/TutorPanel.tsx"))
  );

  // Case-insensitive literal fence over BOTH student-portal trees. These are
  // the exact strings the offline preview shipped; none may survive anywhere
  // in the student surface (honest-by-construction: the tutor is real now).
  const BANNED = [
    "replies are canned",
    "coming soon",
    "canned_replies", // matches the CANNED_REPLIES identifier
    "ai tutor preview",
  ] as const;
  const trees = [join(root, "components/student"), join(root, "app/(student)")];
  const offenders: string[] = [];
  for (const tree of trees) {
    for (const file of walk(tree)) {
      const content = readFileSync(file, "utf8").toLowerCase();
      for (const literal of BANNED) {
        if (content.includes(literal)) offenders.push(`${file}: "${literal}"`);
      }
    }
  }
  check(
    "no banned preview literal in components/student or app/(student)",
    offenders.length === 0,
    offenders.join("; ")
  );

  // The identifier itself must be gone from the student surface too — no
  // import, no render, not even a comment keeping the old name alive.
  const panelRefs: string[] = [];
  for (const tree of trees) {
    for (const file of walk(tree)) {
      if (readFileSync(file, "utf8").includes("TutorPanel")) panelRefs.push(file);
    }
  }
  check("no TutorPanel reference survives in the student trees", panelRefs.length === 0, panelRefs.join("; "));
}

/* ────────────────────────────── snippet.spec ───────────────────────────── */

function snippetChecks() {
  console.log("\n# snippet.spec — trimSnippet word-boundary goldens");

  check("snippet max is 140", TUTOR_SNIPPET_MAX === 140);
  check("short text unchanged", trimSnippet("Hello world") === "Hello world");
  check("exactly-max text unchanged", trimSnippet("a".repeat(140)) === "a".repeat(140));
  check(
    "whitespace collapses (newlines/tabs → single spaces, trimmed)",
    trimSnippet("  line one\n\nline\t two ") === "line one line two"
  );

  // Word-boundary cut: the trimmed body must be a PREFIX of the cleaned text
  // that ends exactly at a space in the original (never mid-word).
  const long = "alpha bravo charlie delta echo ".repeat(10).trim();
  const trimmed = trimSnippet(long);
  const body = trimmed.slice(0, -1); // strip the ellipsis
  check("long text gains an ellipsis", trimmed.endsWith("…"));
  check("trimmed body stays within max", body.length <= 140);
  check("trimmed body is a prefix of the source", long.startsWith(body));
  check(
    "cut lands on a word boundary (next source char is a space)",
    long.charAt(body.length) === " ",
    `next char: ${JSON.stringify(long.charAt(body.length))}`
  );

  // Pathological unbroken token: hard cut at max, never an empty snippet.
  const unbroken = trimSnippet("x".repeat(200));
  check("unbroken token hard-cuts at max + ellipsis", unbroken === `${"x".repeat(140)}…`);

  // Trailing punctuation is stripped before the ellipsis.
  const punct = trimSnippet("word, ".repeat(40).trim());
  check(
    "trailing punctuation stripped before the ellipsis",
    punct.endsWith("word…") && !punct.includes(",…")
  );
}

/* ─────────────────────────────── links.spec ────────────────────────────── */

function linkChecks() {
  console.log("\n# links.spec — deep-link + seed builders");

  check(
    "deep link with a continue lesson targets the lesson",
    tutorDeepLink("cs61b", "3f2c1a00-0000-4000-8000-000000000001") ===
      "/learn/cs61b/3f2c1a00-0000-4000-8000-000000000001?tutor=open"
  );
  check(
    "deep link without a continue lesson targets the landing",
    tutorDeepLink("cs61b", null) === "/learn/cs61b?tutor=open"
  );

  check(
    "review href on a lesson deep link: ? separator + encoded seed",
    reviewWithTutorHref("/learn/algebra-1/lesson-9", "Fractions & Decimals") ===
      "/learn/algebra-1/lesson-9?tutor=open&seed=Help%20me%20review%20Fractions%20%26%20Decimals"
  );
  check(
    "review href on a course landing: ? separator",
    reviewWithTutorHref("/learn/algebra-1", "Chapter quiz") ===
      "/learn/algebra-1?tutor=open&seed=Help%20me%20review%20Chapter%20quiz"
  );
  check(
    "review href with an existing query string: & separator",
    reviewWithTutorHref("/learn/a?x=1", "Quiz") ===
      "/learn/a?x=1&tutor=open&seed=Help%20me%20review%20Quiz"
  );

  check("slug from a landing href", learnHrefSlug("/learn/cs61b") === "cs61b");
  check(
    "slug from a lesson deep link",
    learnHrefSlug("/learn/cs61b/3f2c1a00-0000-4000-8000-000000000001") === "cs61b"
  );
  check(
    "slug tolerates a query string",
    learnHrefSlug("/learn/cs61b?tutor=open") === "cs61b"
  );
  check("non-learn href → null", learnHrefSlug("/explore") === null);
  check("bare /learn/ → null", learnHrefSlug("/learn/") === null);
}

/* ────────────────────────────── wiring.spec ────────────────────────────── */

function wiringChecks() {
  console.log("\n# wiring.spec — page/card/package hooks");

  const page = readFileSync(join(root, "app/(student)/home/page.tsx"), "utf8");
  check("page renders TutorEntryCard", page.includes("<TutorEntryCard"));
  check(
    'page carries data-ai-tool="home-review-with-tutor"',
    page.includes('data-ai-tool="home-review-with-tutor"')
  );
  check(
    "page builds the review-tutor href via reviewWithTutorHref",
    page.includes("reviewWithTutorHref(item.href, item.quizTitle)")
  );
  check(
    "review-tutor affordance is gated on the tutor-enabled set",
    page.includes("tutorSlugs.has(")
  );

  const card = readFileSync(
    join(root, "components/student/TutorEntryCard.tsx"),
    "utf8"
  );
  check(
    'card carries data-ai-tool="home-tutor-open"',
    card.includes('data-ai-tool="home-tutor-open"')
  );
  check("card invites the first question", card.includes("Ask your first question"));
  check('card pill is labeled "Open tutor"', card.includes("Open tutor"));
  check(
    "card stays a SERVER component (no use-client directive)",
    !card.includes('"use client"') && !card.includes("'use client'")
  );
  check(
    "card collapses to null when no tutor-enabled enrollment exists",
    card.includes("if (entries.length === 0) return null;")
  );

  const helper = readFileSync(join(root, "lib/learn/tutorHome.ts"), "utf8");
  check(
    "helper documents the admin-read rationale (access check BEFORE admin read)",
    helper.includes("enrollment IS the access check") &&
      helper.includes("createAdminClient")
  );
  check(
    "helper excludes only explicitly-disabled courses (ON BY DEFAULT)",
    helper.includes("enabled === false") && !helper.includes('.eq("enabled", true)')
  );

  const pkg = readFileSync(join(root, "package.json"), "utf8");
  check(
    "package.json has the verify:tutor-home script",
    pkg.includes('"verify:tutor-home": "tsx scripts/verify-tutor-home.ts"')
  );
  const chain = /"verify:tutor":\s*"([^"]+)"/.exec(pkg)?.[1] ?? "";
  check(
    "verify:tutor chain ends with verify-tutor-home",
    chain.includes("tsx scripts/verify-tutor-home.ts")
  );
}

/* ─────────────────────────────────── run ───────────────────────────────── */

goneChecks();
snippetChecks();
linkChecks();
wiringChecks();

console.log(`\nverify-tutor-home: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
