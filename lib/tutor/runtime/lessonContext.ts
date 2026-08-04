/**
 * Prompt layer L2 — the LESSON CONTEXT block (TUTOR-1 · Directive §3.2).
 *
 * `assembleLessonContext` renders ONE lesson of a publication snapshot into a
 * compact, human-readable text block for the tutor prompt: the lesson's readable
 * content (mirroring `extractionSource.ts`'s snapshot walk) followed by the
 * concept nodes anchored to that lesson. It marks the learner's CURRENT position
 * (block/slide) when supplied, and clamps to a character budget deterministically.
 *
 * ── INVARIANT: byte-identical across learners ────────────────────────────────
 * For the same (publication snapshot, lessonId, conceptNodes, opts) the output is
 * IDENTICAL. There is NO clock, NO randomness, NO map-iteration-order dependence
 * (concepts sort by title; blocks/slides ride the snapshot's own array order).
 * This lets the L2 block cache as a stable prompt prefix per (publication, lesson).
 *
 * ── WHAT IS READ (mirrors extractionSource.ts, answer-safe) ──────────────────
 *   - lesson title + objective
 *   - each block IN ORDER: a typed one-line header (`[slide deck] <title>`) + its
 *     readable text: flat slide element text (runs invariant ⇒ el.text IS plain
 *     text), structured template STRING slots (walked generically), quiz question
 *     STEMS ONLY (never a field whose name starts correct/expected/accepted,
 *     nor explanation — none exist on the answer-stripped snapshot anyway),
 *     homework prompts,
 *     lecture/example/exercise/resource prose.
 *   - the lesson's CONCEPTS: concept nodes whose anchors reference this lesson.
 *
 * PURE: no IO. Unknown lessonId → a one-line "lesson not found" string (never a
 * throw).
 */

import type {
  PublicationSnapshot,
  PublishedLesson,
  PublishedLessonBlock,
} from "@/lib/course/publish/schemas";

/** A concept node handed to L2. `anchors` is jsonb (parsed leniently below): an
 *  array of {lessonId, blockId, slideId?} pointing at where the concept lives. */
export interface LessonConceptNode {
  id: string;
  title: string;
  description: string;
  anchors: unknown;
}

export interface AssembleLessonContextOpts {
  /** The block the learner is currently viewing (marks `>> you are here`). */
  blockId?: string;
  /** The slide the learner is currently viewing (marks `>> you are here`). */
  slideId?: string;
  /** Total character budget for the whole block (default 10_000 ≈ 2500 tokens). */
  budgetChars?: number;
}

/** Default L2 budget — ≈ the 2500-token L2 allowance. */
const DEFAULT_BUDGET_CHARS = 10_000;
/** Max concept lines rendered (extra concepts are truncated). */
const MAX_CONCEPT_LINES = 12;
/** Explicit truncation marker (identical everywhere so output stays deterministic). */
const TRUNCATED = "…[truncated]";
/** Reserve of the budget given to the concepts section (rest goes to blocks). */
const CONCEPT_BUDGET_FRACTION = 0.25;

/* ───────────────────────────── generic slot walker ──────────────────────── */

/**
 * Collect readable strings out of an arbitrary structured-template content object
 * — the same generic walk `extractionSource.ts` uses so a new structured layout
 * needs no change here. A RichText leaf is `{text, runs?}` → read `text` (the runs
 * invariant guarantees concat(runs)===text). Asset/enum keys are skipped.
 */
const IGNORE_KEYS = new Set([
  "imageUrl",
  "storagePath",
  "intentHash",
  "src",
  "url",
  "alt",
  "language",
  "layoutId",
  "variant",
  "titleStyle",
  "presentation",
  "decor",
  "sticker",
  "icon",
  "kind",
  "direction",
  "sentiment",
  "source",
  "badge",
  "markerKind",
  "markerText",
  "markerColor",
  "textColor",
]);

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") {
      const s = rec.text.trim();
      if (s) out.push(s);
    }
    for (const [key, v] of Object.entries(rec)) {
      if (key === "text") continue;
      if (IGNORE_KEYS.has(key)) continue;
      collectStrings(v, out, depth + 1);
    }
  }
}

/* ───────────────────────────── per-block header ─────────────────────────── */

const BLOCK_TYPE_LABEL: Record<string, string> = {
  slide_deck: "slide deck",
  imported_deck: "imported deck",
  video: "video",
  quiz: "quiz",
  homework: "homework",
  lecture_text: "lecture",
  example: "example",
  exercise: "exercise",
  resource: "resource",
};

function blockHeader(block: PublishedLessonBlock): string {
  const label = BLOCK_TYPE_LABEL[block.type] ?? block.type;
  const title = block.title && block.title.trim() ? block.title.trim() : "(untitled)";
  // The citeable id rides in every header: without it the model can only cite
  // by TITLE, which the grounding validator (correctly) drops — observed live
  // as every turn flagging `ungrounded`.
  return `[${label}] ${title} (blockId: ${block.id})`;
}

/* ───────────────────────────── per-block mining ─────────────────────────── */

/**
 * Mine one block's readable text as a list of lines, marking the learner's
 * current position when opts.blockId/slideId match. Mirrors extractionSource's
 * walk; quiz reads STEMS ONLY (no answer fields exist on the snapshot).
 */
function mineBlockLines(
  block: PublishedLessonBlock,
  opts: AssembleLessonContextOpts
): string[] {
  const lines: string[] = [];
  const hereBlock = opts.blockId != null && opts.blockId === block.id;
  const header = blockHeader(block);
  lines.push(hereBlock && opts.slideId == null ? `${header}  >> you are here` : header);

  switch (block.type) {
    case "slide_deck": {
      for (const slide of block.slides) {
        const slideParts: string[] = [];
        if (slide.title && slide.title.trim()) slideParts.push(slide.title.trim());
        if (slide.template) {
          collectStrings(slide.template.content, slideParts);
        } else {
          for (const el of slide.elements) {
            const anyEl = el as unknown as Record<string, unknown>;
            if (typeof anyEl.text === "string" && anyEl.text.trim()) {
              slideParts.push(anyEl.text.trim());
            }
            if (Array.isArray(anyEl.items)) {
              for (const it of anyEl.items as unknown[]) {
                if (typeof it === "string" && it.trim()) slideParts.push(it.trim());
              }
            }
            if (typeof anyEl.code === "string" && anyEl.code.trim()) {
              slideParts.push(anyEl.code.trim());
            }
            if (Array.isArray(anyEl.rows)) {
              for (const row of anyEl.rows as unknown[]) {
                if (Array.isArray(row)) {
                  for (const cell of row) {
                    if (typeof cell === "string" && cell.trim()) slideParts.push(cell.trim());
                  }
                }
              }
            }
          }
        }
        if (slideParts.length === 0) continue;
        const hereSlide = hereBlock && opts.slideId != null && opts.slideId === slide.id;
        const marker = hereSlide ? "  >> you are here" : "";
        lines.push(`  - ${slideParts.join(" · ")}${marker}`);
      }
      break;
    }
    case "quiz": {
      // STEMS ONLY. The snapshot is answer-stripped by construction — no
      // correct*/expected*/accepted*/explanation field exists to read.
      for (const q of block.questions) {
        if (q.prompt && q.prompt.trim()) lines.push(`  - ${q.prompt.trim()}`);
      }
      break;
    }
    case "homework": {
      if (block.instructions && block.instructions.trim()) {
        lines.push(`  ${block.instructions.trim()}`);
      }
      for (const ex of block.exercises) {
        if (ex.prompt && ex.prompt.trim()) lines.push(`  - ${ex.prompt.trim()}`);
      }
      break;
    }
    case "lecture_text": {
      for (const p of block.paragraphs) {
        if (p.text && p.text.trim()) lines.push(`  ${p.text.trim()}`);
      }
      break;
    }
    case "example": {
      for (const s of [block.context, block.explanation, ...block.steps, block.takeaway]) {
        if (s && s.trim()) lines.push(`  ${s.trim()}`);
      }
      break;
    }
    case "exercise": {
      if (block.prompt && block.prompt.trim()) lines.push(`  ${block.prompt.trim()}`);
      break;
    }
    case "resource": {
      for (const l of block.links) {
        const label = l.label && l.label.trim() ? l.label.trim() : "";
        const note = l.note && l.note.trim() ? l.note.trim() : "";
        const joined = [label, note].filter(Boolean).join(" — ");
        if (joined) lines.push(`  - ${joined}`);
      }
      break;
    }
    // imported_deck / video: no readable prose (bytes/media live off-doc). The
    // header alone stands so the learner's `>> you are here` can still land.
    default:
      break;
  }

  return lines;
}

/* ───────────────────────────── anchor parsing ───────────────────────────── */

/** Leniently parse a concept node's jsonb `anchors` into a list of anchor rows.
 *  Anything malformed is skipped (never throws) — deterministic. */
function parseAnchors(anchors: unknown): Array<{ lessonId?: string; blockId?: string; slideId?: string }> {
  if (!Array.isArray(anchors)) return [];
  const out: Array<{ lessonId?: string; blockId?: string; slideId?: string }> = [];
  for (const a of anchors) {
    if (a == null || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    const lessonId = typeof rec.lessonId === "string" ? rec.lessonId : undefined;
    const blockId = typeof rec.blockId === "string" ? rec.blockId : undefined;
    const slideId = typeof rec.slideId === "string" ? rec.slideId : undefined;
    out.push({ lessonId, blockId, slideId });
  }
  return out;
}

/** Build the set of blockIds that belong to a lesson (so a concept anchored by
 *  blockId — without a lessonId — can still be matched to this lesson). */
function lessonBlockIds(lesson: PublishedLesson): Set<string> {
  const set = new Set<string>();
  for (const block of lesson.blocks) set.add(block.id);
  return set;
}

/**
 * Does any of a concept's anchors reference THIS lesson? A match is either an
 * anchor naming the lessonId directly, or an anchor whose blockId lives in the
 * lesson (lessonId-less anchors from an older extraction still resolve).
 */
function conceptAnchoredToLesson(
  anchors: unknown,
  lessonId: string,
  blockIds: Set<string>
): boolean {
  for (const a of parseAnchors(anchors)) {
    if (a.lessonId === lessonId) return true;
    if (a.lessonId == null && a.blockId != null && blockIds.has(a.blockId)) return true;
  }
  return false;
}

/* ───────────────────────────── budget clamping ──────────────────────────── */

/** Clamp a list of lines to a character budget, appending an explicit marker
 *  when anything is dropped. Whole-line granularity keeps output readable +
 *  deterministic. A single over-budget first line is hard-sliced. */
function clampLines(lines: string[], budgetChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1; // +1 for the joining newline
    if (used + cost > budgetChars) {
      if (kept.length === 0) {
        // First line already over budget — hard-slice it so we always emit
        // something bounded.
        const room = Math.max(0, budgetChars - TRUNCATED.length);
        kept.push(line.slice(0, room).trimEnd() + TRUNCATED);
        return kept;
      }
      kept.push(TRUNCATED);
      return kept;
    }
    kept.push(line);
    used += cost;
  }
  return kept;
}

/* ───────────────────────────── main entry ───────────────────────────────── */

/**
 * Assemble the L2 lesson-context block. PURE + deterministic (byte-identical
 * across learners for the same inputs). Unknown lessonId → a one-line
 * "lesson not found" string (never throws).
 */
export function assembleLessonContext(
  snapshot: PublicationSnapshot,
  lessonId: string,
  conceptNodes: Array<LessonConceptNode>,
  opts: AssembleLessonContextOpts = {}
): string {
  // Locate the lesson.
  let lesson: PublishedLesson | undefined;
  for (const mod of snapshot.modules) {
    for (const l of mod.lessons) {
      if (l.id === lessonId) {
        lesson = l;
        break;
      }
    }
    if (lesson) break;
  }
  if (!lesson) return `Lesson not found: ${lessonId}`;

  const budgetChars =
    opts.budgetChars != null && opts.budgetChars > 0 ? opts.budgetChars : DEFAULT_BUDGET_CHARS;

  // Split the budget: concepts get a reserved slice, blocks get the rest.
  const conceptBudget = Math.floor(budgetChars * CONCEPT_BUDGET_FRACTION);
  const blocksBudget = budgetChars - conceptBudget;

  /* ── Lesson header ── */
  const headerLines: string[] = [];
  headerLines.push(`LESSON: ${lesson.title.trim()} (lessonId: ${lesson.id})`);
  if (lesson.objective && lesson.objective.trim()) {
    headerLines.push(`OBJECTIVE: ${lesson.objective.trim()}`);
  }
  headerLines.push(
    "Citations MUST use the exact lessonId/blockId values shown in parentheses — never titles."
  );

  /* ── Blocks (in order) ── */
  const blockLines: string[] = [];
  for (const block of lesson.blocks) {
    blockLines.push(...mineBlockLines(block, opts));
  }
  // The header is always emitted; blocks share the blocks budget minus the header cost.
  const headerCost = headerLines.reduce((n, l) => n + l.length + 1, 0);
  const clampedBlocks = clampLines(blockLines, Math.max(0, blocksBudget - headerCost));

  /* ── Concepts (anchored to this lesson, sorted by title, capped) ── */
  const blockIds = lessonBlockIds(lesson);
  const matched = conceptNodes.filter((n) =>
    conceptAnchoredToLesson(n.anchors, lessonId, blockIds)
  );
  // Deterministic order: title asc, then id asc as a stable tiebreak.
  matched.sort((a, b) => {
    const t = a.title.localeCompare(b.title);
    return t !== 0 ? t : a.id.localeCompare(b.id);
  });

  const conceptLinesRaw: string[] = [];
  const overLineCap = matched.length > MAX_CONCEPT_LINES;
  for (const n of matched.slice(0, MAX_CONCEPT_LINES)) {
    const title = n.title.trim();
    const desc = n.description && n.description.trim() ? n.description.trim() : "";
    // The nodeId rides in the line for the same reason blockIds ride in block
    // headers: evidence items reference concepts BY ID, and a model that has
    // only seen titles can only fabricate ids (observed live — the whole turn
    // failed schema parse before the contract was loosened to drop-and-flag).
    const tag = `(nodeId: ${n.id})`;
    conceptLinesRaw.push(desc ? `• ${title} ${tag}: ${desc}` : `• ${title} ${tag}`);
  }
  if (overLineCap) conceptLinesRaw.push(TRUNCATED);
  const clampedConcepts = clampLines(conceptLinesRaw, conceptBudget);

  /* ── Compose ── */
  const sections: string[] = [];
  sections.push(headerLines.join("\n"));
  if (clampedBlocks.length > 0) {
    sections.push("CONTENT:\n" + clampedBlocks.join("\n"));
  }
  if (clampedConcepts.length > 0) {
    sections.push("CONCEPTS:\n" + clampedConcepts.join("\n"));
  }
  return sections.join("\n\n");
}
