/**
 * TUTOR-1 W3.3 — grounding validation (Directive §3.3) · A3 Wave 1 ok-rule.
 *
 * Every substantive claim the tutor makes must carry an anchor RESOLVABLE in
 * the learner's OWN snapshot; prose is marked into grounded (⟦g⟧…⟦/g⟧) and
 * supplemental (⟦s⟧…⟦/s⟧) spans by the model per the output contract, and
 * this module — PURE, never throwing — validates and CLEANS a turn:
 *
 *   · citations resolve against the snapshot index; an unknown block DROPS
 *     the citation (flag `citation_dropped`); a slide id that doesn't resolve
 *     inside its block downgrades to block level (strip slideId, keep the
 *     citation — flag `anchor_downgraded`, the R-13 convention);
 *   · surviving citations are DE-DUPLICATED by jump-target identity
 *     (lessonId|blockId|slideId), order-preserving, NO flag — the downgrade
 *     path can manufacture byte-identical duplicates, and the persisted
 *     grounding jsonb must be clean for every future consumer;
 *   · supplemental spans survive only under `course_canon: open` — strict
 *     canon REMOVES their text (flag `supplemental_suppressed`): the charter
 *     says outside-the-course material must not contradict the course;
 *   · THE `ungrounded` CONTRACT (A3/D-6): SUBSTANTIVE cleaned prose
 *     (>200 chars) with zero surviving citations and no escalation proposal
 *     flags `ungrounded` — low confidence must become an escalation proposal,
 *     never invention. Proposing the hand-off is the documented ESCAPE: a
 *     substantive citation-less turn that carries an escalationProposal is ok.
 *     Short citation-less prose (a greeting, "what would you like to
 *     review?") NEVER flags — a greeting is not a claim (the Wave-1 decision;
 *     the old any-grounded-span-without-citations rule silently discarded
 *     routine streamed turns and stranded the learner's question — D-6);
 *   · malformed/unbalanced markers never throw: the remainder is treated as
 *     plain text and the turn flags `span_parse_error`.
 *
 * `ok` is false only on `ungrounded` / `span_parse_error` — dropped
 * citations, downgrades, dedup, and suppressions are CLEANUPS, not failures.
 * (`span_parse_error` still fails ok DELIBERATELY: relaxing it could leak
 * supplemental content under a strict canon.)
 */

import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import type { TurnOutput } from "./outputContract";

/* ───────────────────────────── snapshot index ───────────────────────────── */

export interface SnapshotIndex {
  lessonIds: Set<string>;
  blockIds: Set<string>;
  slideIdsByBlock: Map<string, Set<string>>;
  lessonByBlock: Map<string, string>;
}

/** Mirror of extraction.ts's anchor index, plus lesson membership. */
export function buildSnapshotIndex(snapshot: PublicationSnapshot): SnapshotIndex {
  const lessonIds = new Set<string>();
  const blockIds = new Set<string>();
  const slideIdsByBlock = new Map<string, Set<string>>();
  const lessonByBlock = new Map<string, string>();
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      lessonIds.add(lesson.id);
      for (const block of lesson.blocks) {
        blockIds.add(block.id);
        lessonByBlock.set(block.id, lesson.id);
        if (block.type === "slide_deck") {
          const set = new Set<string>();
          for (const slide of block.slides) set.add(slide.id);
          slideIdsByBlock.set(block.id, set);
        }
      }
    }
  }
  return { lessonIds, blockIds, slideIdsByBlock, lessonByBlock };
}

/* ─────────────────────────────── span parsing ───────────────────────────── */

export interface ProseSpan {
  kind: "grounded" | "supplemental";
  text: string;
}

const OPEN_G = "⟦g⟧";
const CLOSE_G = "⟦/g⟧";
const OPEN_S = "⟦s⟧";
const CLOSE_S = "⟦/s⟧";

/** Parse the marker stream. Text OUTSIDE any marker is a grounded-by-default
 *  span (the model normally marks everything; bare text is tolerated). A
 *  malformed stream (nested/unclosed/stray-close) returns parseError=true and
 *  the WHOLE input as one grounded span — the caller flags, never crashes. */
export function parseSpans(prose: string): { spans: ProseSpan[]; parseError: boolean } {
  const spans: ProseSpan[] = [];
  let i = 0;
  let open: "grounded" | "supplemental" | null = null;
  let buf = "";
  const push = (kind: ProseSpan["kind"]) => {
    if (buf.trim().length > 0) spans.push({ kind, text: buf });
    buf = "";
  };
  while (i < prose.length) {
    if (prose.startsWith(OPEN_G, i) || prose.startsWith(OPEN_S, i)) {
      if (open !== null) return { spans: [{ kind: "grounded", text: prose }], parseError: true };
      push("grounded"); // bare text before the marker
      open = prose.startsWith(OPEN_G, i) ? "grounded" : "supplemental";
      i += OPEN_G.length; // both openers are the same length
      continue;
    }
    if (prose.startsWith(CLOSE_G, i) || prose.startsWith(CLOSE_S, i)) {
      const closes = prose.startsWith(CLOSE_G, i) ? "grounded" : "supplemental";
      if (open !== closes) return { spans: [{ kind: "grounded", text: prose }], parseError: true };
      push(open);
      open = null;
      i += CLOSE_G.length; // both closers are the same length
      continue;
    }
    buf += prose[i];
    i += 1;
  }
  if (open !== null) return { spans: [{ kind: "grounded", text: prose }], parseError: true };
  push("grounded");
  return { spans, parseError: false };
}

/* ─────────────────────────────── validation ─────────────────────────────── */

export interface CleanedTurn extends Omit<TurnOutput, "proseWithSpanMarkers"> {
  /** Marker-free prose after canon suppression. */
  prose: string;
  /** The parsed span list, post-suppression. */
  spans: ProseSpan[];
}

export interface ValidatedTurn {
  ok: boolean;
  cleaned: CleanedTurn;
  flags: string[];
}

export function validateTurnOutput(
  output: TurnOutput,
  index: SnapshotIndex,
  opts: { courseCanon: "strict" | "open" }
): ValidatedTurn {
  const flags: string[] = [];

  // 1. Citations resolve — drop unknown blocks; downgrade unresolvable slides.
  const resolved: TurnOutput["citations"] = [];
  for (const c of output.citations) {
    if (!index.blockIds.has(c.blockId) || index.lessonByBlock.get(c.blockId) !== c.lessonId) {
      flags.push("citation_dropped");
      continue;
    }
    if (c.slideId) {
      const slides = index.slideIdsByBlock.get(c.blockId);
      if (!slides || !slides.has(c.slideId)) {
        flags.push("anchor_downgraded");
        resolved.push({ ...c, slideId: null });
        continue;
      }
    }
    resolved.push(c);
  }

  // 1a. A3/D-3 — dedup survivors by jump-target identity, ORDER-PRESERVING.
  //     The downgrade path above manufactures byte-identical duplicates (two
  //     unresolvable slideIds on one block both become {block, slideId: null}),
  //     and the model may repeat a citation within its allowance. The persisted
  //     grounding jsonb must be clean for every future consumer. No flag —
  //     dedup is a cleanup, not a failure.
  const seenTargets = new Set<string>();
  const citations: TurnOutput["citations"] = [];
  for (const c of resolved) {
    const key = `${c.lessonId}|${c.blockId}|${c.slideId ?? ""}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    citations.push(c);
  }

  // 2. Spans.
  const { spans: parsed, parseError } = parseSpans(output.proseWithSpanMarkers);
  if (parseError) flags.push("span_parse_error");

  // 3. Canon: strict suppresses supplemental content entirely.
  let spans = parsed;
  if (opts.courseCanon === "strict") {
    const kept = parsed.filter((s) => s.kind !== "supplemental");
    if (kept.length !== parsed.length) flags.push("supplemental_suppressed");
    spans = kept;
  }
  const prose = spans.map((s) => s.text).join("").trim();

  // 4. THE ungrounded rule (A3/D-6): only SUBSTANTIVE citation-less prose with
  //    no escalation escape flags — a greeting is not a claim. Substantive-but-
  //    unsupported prose must become an escalation proposal, never invention.
  if (prose.length > 200 && citations.length === 0 && !output.escalationProposal) {
    flags.push("ungrounded");
  }

  const ok = !flags.includes("ungrounded") && !flags.includes("span_parse_error");
  const { proseWithSpanMarkers: _markers, ...rest } = output;
  void _markers;
  return { ok, cleaned: { ...rest, citations, prose, spans }, flags };
}
