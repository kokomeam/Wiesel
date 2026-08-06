/**
 * TUTOR-1 Amendment A2 Wave 2 — the PROSE EXTRACTOR pure suite (no key, no DB, no
 * browser). Proves the R-2 incremental scanner:
 *
 *   • clean pass-through of the first-field string value;
 *   • JSON escapes (\" \\ \/ \n \t \r \b \f \uXXXX) decoded incrementally;
 *   • an escape split across two pushes never emits half an escape;
 *   • all four span markers ⟦g⟧ ⟦/g⟧ ⟦s⟧ ⟦/s⟧ stripped;
 *   • a marker split across two pushes is stripped (held back until disambiguated);
 *   • once the prose value ends, subsequent JSON (citations/rung/…) emits nothing;
 *   • a total-junk stream (no key) emits "" forever, done() is a no-op;
 *   • a realistic fixture (JSON.stringify of a real TurnOutput) sliced into 7-char
 *     chunks reassembles to the EXACT marker-stripped prose.
 *
 * Run: `npx tsx scripts/verify-tutor-prose-extractor.ts`
 */

import { createProseExtractor } from "@/lib/tutor/runtime/proseExtractor";
import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  SUPPLEMENTAL_OPEN,
  SUPPLEMENTAL_CLOSE,
  type TurnOutput,
} from "@/lib/tutor/runtime/outputContract";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Feed the whole raw JSON string to a fresh extractor in `chunkSize`-char slices;
 *  return the concatenated display prose. */
function runChunks(raw: string, chunkSize: number): string {
  const ex = createProseExtractor();
  let out = "";
  for (let i = 0; i < raw.length; i += chunkSize) {
    out += ex.push(raw.slice(i, i + chunkSize));
  }
  ex.done();
  return out;
}

/** Feed an explicit list of pushes; return concatenated display prose. */
function runPushes(pushes: string[]): string {
  const ex = createProseExtractor();
  let out = "";
  for (const p of pushes) out += ex.push(p);
  ex.done();
  return out;
}

/** Build a raw JSON string whose FIRST field is proseWithSpanMarkers = `value`
 *  (JSON-escaped by JSON.stringify), followed by the rest of a TurnOutput. Ordering
 *  is guaranteed because we assemble the object with proseWithSpanMarkers first. */
function rawWithProse(value: string): string {
  const out: TurnOutput = {
    proseWithSpanMarkers: value,
    citations: [{ lessonId: "L", blockId: "B", slideId: null }],
    rung: 2,
    evidence: [],
    practiceItems: undefined,
    escalationProposal: null,
  };
  const raw = JSON.stringify(out);
  // JSON.stringify keeps insertion order, so proseWithSpanMarkers is first.
  if (!raw.startsWith('{"proseWithSpanMarkers"')) {
    throw new Error(`fixture invariant broken — prose key is not first: ${raw.slice(0, 40)}`);
  }
  return raw;
}

function cleanPassThroughSuite(): void {
  section("1. clean pass-through");
  const raw = rawWithProse("Hello there, learner.");
  // Full-string push.
  check("whole-string push yields the exact prose", runChunks(raw, raw.length) === "Hello there, learner.");
  // Chunked pushes reassemble.
  check("7-char chunks reassemble the exact prose", runChunks(raw, 7) === "Hello there, learner.");
  check("1-char chunks reassemble the exact prose", runChunks(raw, 1) === "Hello there, learner.");
}

function escapeSuite(): void {
  section("2. JSON escapes decoded");
  const value = 'A "quote", a \\ backslash, a /slash/, then\na newline\ttab.';
  const raw = rawWithProse(value);
  check("all escapes decode to the original value (whole)", runChunks(raw, raw.length) === value);
  check("all escapes decode to the original value (7-char)", runChunks(raw, 7) === value);
  check("all escapes decode to the original value (1-char)", runChunks(raw, 1) === value);

  // A \uXXXX escape (é = é).
  const uValue = "Café au lait";
  const rawU = rawWithProse(uValue);
  check("\\uXXXX decodes (whole)", runChunks(rawU, rawU.length) === uValue);
  check("\\uXXXX decodes (1-char, split across boundaries)", runChunks(rawU, 1) === uValue);
  check("\\uXXXX decodes (3-char)", runChunks(rawU, 3) === uValue);
}

function escapeSplitSuite(): void {
  section("3. an escape split across pushes never emits half an escape");
  // Hand-craft the value region so a \n is split: the opening key+quote in push 1,
  // then a lone `\` at the end of push 2, then the `n` in push 3.
  // Build the raw JSON and split at a chosen index INSIDE the escape.
  const raw = rawWithProse("line1\nline2");
  // Find the position of the escape sequence `\n` in the raw JSON.
  const escIdx = raw.indexOf("\\n");
  check("fixture contains a \\n escape", escIdx > 0);
  // Split BETWEEN the backslash and the n.
  const p1 = raw.slice(0, escIdx + 1); // ends with the lone backslash
  const p2 = raw.slice(escIdx + 1); // begins with the n
  const out = runPushes([p1, p2]);
  check("split escape reassembles to the newline value", out === "line1\nline2", JSON.stringify(out));

  // A \uXXXX split mid-hex.
  const rawU = rawWithProse("xéy");
  const uIdx = rawU.indexOf("\\u");
  const q1 = rawU.slice(0, uIdx + 3); // `\u0` — incomplete
  const q2 = rawU.slice(uIdx + 3); // `0e9…`
  const outU = runPushes([q1, q2]);
  check("split \\uXXXX reassembles to the é value", outU === "xéy", JSON.stringify(outU));
}

function markerSuite(): void {
  section("4. all four span markers stripped");
  const value = `${GROUNDED_OPEN}grounded claim${GROUNDED_CLOSE} and ${SUPPLEMENTAL_OPEN}extra note${SUPPLEMENTAL_CLOSE} end`;
  const raw = rawWithProse(value);
  const expected = "grounded claim and extra note end";
  check("markers stripped (whole)", runChunks(raw, raw.length) === expected, JSON.stringify(runChunks(raw, raw.length)));
  check("markers stripped (7-char)", runChunks(raw, 7) === expected);
  check("markers stripped (1-char)", runChunks(raw, 1) === expected);

  // Each marker individually.
  for (const [name, open, close] of [
    ["grounded", GROUNDED_OPEN, GROUNDED_CLOSE],
    ["supplemental", SUPPLEMENTAL_OPEN, SUPPLEMENTAL_CLOSE],
  ] as const) {
    const v = `${open}inside${close}`;
    const r = rawWithProse(v);
    check(`${name} markers stripped to 'inside'`, runChunks(r, 3) === "inside");
  }
}

function markerSplitSuite(): void {
  section("5. a marker split across pushes is stripped");
  // ⟦g⟧ is U+27E6 'g' U+27E7 → three code units. Split so the ⟦ arrives in one
  // push and 'g⟧' in the next.
  const raw = rawWithProse(`before${GROUNDED_OPEN}mid${GROUNDED_CLOSE}after`);
  const openIdx = raw.indexOf(GROUNDED_OPEN);
  check("fixture contains the grounded-open marker", openIdx > 0);
  // Split right AFTER the ⟦ (the first code unit of the marker).
  const p1 = raw.slice(0, openIdx + 1); // ends with ⟦ (a strict marker prefix)
  const p2 = raw.slice(openIdx + 1); // starts with g⟧
  const out = runPushes([p1, p2]);
  check("split-open marker fully stripped", out === "beforemidafter", JSON.stringify(out));

  // Split the CLOSE marker ⟦/g⟧ across two pushes at each internal boundary.
  const closeIdx = raw.indexOf(GROUNDED_CLOSE);
  for (let cut = 1; cut < GROUNDED_CLOSE.length; cut++) {
    const a = raw.slice(0, closeIdx + cut);
    const b = raw.slice(closeIdx + cut);
    const o = runPushes([a, b]);
    check(`split-close marker at cut ${cut} fully stripped`, o === "beforemidafter", JSON.stringify(o));
  }
}

function endOfValueSuite(): void {
  section("6. after the prose value ends, subsequent JSON emits nothing");
  // The value contains the SUBSTRING "proseWithSpanMarkers" would-be confusion is
  // avoided because we scan for the KEY only until in_value; once in_value, the
  // scanner reads to the closing quote and then stops.
  const raw = rawWithProse("done");
  // Push everything; then push a spurious extra chunk that mentions the key again.
  const ex = createProseExtractor();
  let out = "";
  out += ex.push(raw);
  const afterClose = ex.push('{"proseWithSpanMarkers":"SHOULD NOT APPEAR"}');
  check("prose value emitted", out === "done", JSON.stringify(out));
  check("post-value push emits nothing", afterClose === "");
  ex.done();
  // Also verify the citations text after the prose (which contains "B","L") never leaks.
  check("citations/rung after prose never leak", runChunks(raw, 4) === "done");
}

function junkSuite(): void {
  section("7. total-junk stream emits nothing; done() no-op");
  const ex = createProseExtractor();
  let out = "";
  out += ex.push('{"somethingElse":"value"');
  out += ex.push(',"more":123}');
  out += ex.push("plain text no json at all");
  check("junk stream emits '' throughout", out === "", JSON.stringify(out));
  // done() must not throw and must be idempotent.
  let threw = false;
  try {
    ex.done();
    ex.done();
  } catch {
    threw = true;
  }
  check("done() is a no-op that never throws", !threw);
  check("push after done emits nothing", ex.push('{"proseWithSpanMarkers":"x"}') === "");

  // A stream where the key appears but split across the very first pushes.
  const key = '{"proseWithSpanMarkers":"';
  const r2 = createProseExtractor();
  let out2 = "";
  for (let i = 0; i < key.length; i += 2) out2 += r2.push(key.slice(i, i + 2));
  out2 += r2.push('recovered"}');
  check("key split across 2-char pushes still finds the value", out2 === "recovered", JSON.stringify(out2));
}

function realisticFixtureSuite(): void {
  section("8. realistic fixture — 7-char chunks reassemble exact marker-stripped prose");
  const value =
    `${GROUNDED_OPEN}A binary search halves the search space each step${GROUNDED_CLOSE}, ` +
    `so it runs in ${GROUNDED_OPEN}O(log n)${GROUNDED_CLOSE} time. ` +
    `${SUPPLEMENTAL_OPEN}Historically it dates to the 1940s.${SUPPLEMENTAL_CLOSE} ` +
    `Consider the array [1, 2, 3] — "midpoint" math uses (lo + hi) / 2.\n` +
    `Try it: what happens when the target isn't present?`;
  const raw = rawWithProse(value);

  // The EXPECTED display prose = the value with the four markers removed.
  const expected = value
    .split(GROUNDED_OPEN).join("")
    .split(GROUNDED_CLOSE).join("")
    .split(SUPPLEMENTAL_OPEN).join("")
    .split(SUPPLEMENTAL_CLOSE).join("");

  check("7-char chunking reassembles the exact prose", runChunks(raw, 7) === expected, JSON.stringify(runChunks(raw, 7)));
  check("1-char chunking reassembles the exact prose", runChunks(raw, 1) === expected);
  check("13-char chunking reassembles the exact prose", runChunks(raw, 13) === expected);
  check("whole-string reassembles the exact prose", runChunks(raw, raw.length) === expected);
  // And a sanity check the expected prose contains NO marker code units.
  check(
    "expected prose has no marker code units",
    ![GROUNDED_OPEN, GROUNDED_CLOSE, SUPPLEMENTAL_OPEN, SUPPLEMENTAL_CLOSE].some((m) => expected.includes(m))
  );
}

function main(): void {
  cleanPassThroughSuite();
  escapeSuite();
  escapeSplitSuite();
  markerSuite();
  markerSplitSuite();
  endOfValueSuite();
  junkSuite();
  realisticFixtureSuite();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
