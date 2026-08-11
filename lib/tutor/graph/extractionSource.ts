/**
 * PURE lesson-text derivation (TUTOR-1 Wave 1.3 · Directive §1.2 step 2).
 *
 * The extraction SOURCE is the published PublicationSnapshot — NEVER the draft
 * (the snapshot is immutable, already answer-stripped, and is what learners see).
 * `deriveLessonChunks` walks each lesson's readable content into one text chunk +
 * a candidate-anchor list (which blocks/slides contributed), capped per lesson.
 *
 * Readable text per lesson:
 *   - lesson title + objective
 *   - slide_deck: each slide's flat element text (runs invariant ⇒ el.text IS the
 *     plain text) OR its structured template's string slots (walked generically)
 *   - quiz: question STEMS only (the snapshot is answer-stripped; we never read
 *     an answer — none exist to read)
 *   - homework: instructions + per-exercise prompts
 *   - lecture_text / example / exercise / resource: their prose
 *
 * NOT read: imported_deck (bytes live off-doc), video (media). Both still become
 * candidate anchors if they carry a title, so a concept can still be anchored to
 * them — there's just no text to mine.
 *
 * PURE: no IO, no clock, no randomness — golden-testable against a hand-built
 * snapshot fixture.
 */

import type {
  PublicationSnapshot,
  PublishedLesson,
  PublishedLessonBlock,
} from "@/lib/course/publish/schemas";
import { CHUNK_TRUNCATION_MARKER } from "./config";

/** A block/slide that contributed text to a lesson chunk — a CANDIDATE anchor the
 *  extractor later resolves against the snapshot (blockId always present; slideId
 *  when the text came from a specific slide). */
export interface LessonChunkAnchor {
  blockId: string;
  slideId?: string;
}

/** One lesson's mined text + provenance. `text` is capped (see config); `anchors`
 *  are every block/slide that contributed (dedup-free order of contribution). */
export interface LessonChunk {
  lessonId: string;
  moduleId: string;
  lessonTitle: string;
  moduleTitle: string;
  text: string;
  anchors: LessonChunkAnchor[];
}

/* ─────────────────────────── generic slot walker ────────────────────────── */

/**
 * Collect every human-readable string out of an arbitrary structured-template
 * content object. A `RichText` slot is `{text, runs?}` — we read `text` (the runs
 * invariant guarantees concat(runs)===text, so `text` is the plain value). We walk
 * generically so a NEW structured layout needs no change here: any `{text:string}`
 * or bare string reachable in the content tree is mined; `imageUrl`/`storagePath`/
 * `intentHash`/enum flags are skipped by an ignore-key list.
 */
const IGNORE_KEYS = new Set([
  "imageUrl",
  "storagePath",
  "intentHash",
  "src",
  "url",
  "alt", // alt is descriptive but not taught-content; skip to avoid asset-noise
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

export function collectStrings(value: unknown, out: string[], depth = 0): void {
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
    // A RichText leaf ({text, runs?}) — read `text` (plain-value invariant) and stop.
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") {
      const s = rec.text.trim();
      if (s) out.push(s);
      // still descend into non-text keys (e.g. a `code` slot alongside `text`)
    }
    for (const [key, v] of Object.entries(rec)) {
      if (key === "text") continue; // handled above
      if (IGNORE_KEYS.has(key)) continue;
      collectStrings(v, out, depth + 1);
    }
  }
}

/* ─────────────────────────── per-block mining ───────────────────────────── */

/** Text mined from one published block + whether it contributed slide-level
 *  anchors. Returns null text-parts when the block carries no readable prose. */
interface BlockMining {
  /** Text fragments, in reading order. */
  parts: string[];
  /** Slide-level anchors (blockId + slideId) for text that came from a slide. */
  slideAnchors: LessonChunkAnchor[];
  /** Whether the block contributed ANY text (⇒ it becomes a block-level anchor). */
  contributed: boolean;
}

function mineBlock(block: PublishedLessonBlock): BlockMining {
  const parts: string[] = [];
  const slideAnchors: LessonChunkAnchor[] = [];
  if (block.title && block.title.trim()) parts.push(block.title.trim());

  switch (block.type) {
    case "slide_deck": {
      for (const slide of block.slides) {
        const before = parts.length;
        if (slide.title && slide.title.trim()) parts.push(slide.title.trim());
        if (slide.template) {
          collectStrings(slide.template.content, parts);
        } else {
          for (const el of slide.elements) {
            // Flat slides: the runs invariant means el.text IS the plain text.
            const anyEl = el as unknown as Record<string, unknown>;
            if (typeof anyEl.text === "string" && anyEl.text.trim()) {
              parts.push(anyEl.text.trim());
            }
            if (Array.isArray(anyEl.items)) {
              for (const it of anyEl.items as unknown[]) {
                if (typeof it === "string" && it.trim()) parts.push(it.trim());
              }
            }
            if (typeof anyEl.code === "string" && anyEl.code.trim()) {
              parts.push(anyEl.code.trim());
            }
            if (Array.isArray(anyEl.rows)) {
              for (const row of anyEl.rows as unknown[]) {
                if (Array.isArray(row)) {
                  for (const cell of row) {
                    if (typeof cell === "string" && cell.trim()) parts.push(cell.trim());
                  }
                }
              }
            }
          }
        }
        if (parts.length > before) {
          slideAnchors.push({ blockId: block.id, slideId: slide.id });
        }
      }
      break;
    }
    case "quiz": {
      // STEMS ONLY. The published snapshot is answer-stripped by construction —
      // there is no correct answer/explanation on a PublishedQuizQuestion to read.
      for (const q of block.questions) {
        if (q.prompt && q.prompt.trim()) parts.push(q.prompt.trim());
        if ("choices" in q && Array.isArray(q.choices)) {
          // Choice TEXT is not an answer (which choice is correct lives in the
          // server-only answer-key table) — it's readable content that names the
          // concept's options, so it's safe + useful to mine.
          for (const c of q.choices) {
            if (c.text && c.text.trim()) parts.push(c.text.trim());
          }
        }
      }
      break;
    }
    case "homework": {
      if (block.instructions && block.instructions.trim()) parts.push(block.instructions.trim());
      for (const ex of block.exercises) {
        if (ex.title && ex.title.trim()) parts.push(ex.title.trim());
        if (ex.prompt && ex.prompt.trim()) parts.push(ex.prompt.trim());
      }
      break;
    }
    case "lecture_text": {
      for (const p of block.paragraphs) {
        if (p.text && p.text.trim()) parts.push(p.text.trim());
      }
      break;
    }
    case "example": {
      for (const s of [block.context, block.explanation, ...block.steps, block.takeaway]) {
        if (s && s.trim()) parts.push(s.trim());
      }
      break;
    }
    case "exercise": {
      if (block.prompt && block.prompt.trim()) parts.push(block.prompt.trim());
      break;
    }
    case "resource": {
      for (const l of block.links) {
        if (l.label && l.label.trim()) parts.push(l.label.trim());
        if (l.note && l.note.trim()) parts.push(l.note.trim());
      }
      break;
    }
    // imported_deck / video: no readable prose in the doc (bytes/media live off-doc).
    default:
      break;
  }

  const titleOnly = block.title && block.title.trim() ? 1 : 0;
  return {
    parts,
    slideAnchors,
    // The block contributed if it produced ANY part beyond a bare title.
    contributed: parts.length > titleOnly || slideAnchors.length > 0,
  };
}

/* ─────────────────────────── chunk assembly ─────────────────────────────── */

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trimEnd() + CHUNK_TRUNCATION_MARKER;
}

function deriveOneLesson(
  lesson: PublishedLesson,
  moduleId: string,
  moduleTitle: string,
  maxChars: number
): LessonChunk {
  const parts: string[] = [];
  if (lesson.title && lesson.title.trim()) parts.push(lesson.title.trim());
  if (lesson.objective && lesson.objective.trim()) parts.push(lesson.objective.trim());

  const anchors: LessonChunkAnchor[] = [];
  for (const block of lesson.blocks) {
    const mined = mineBlock(block);
    if (mined.contributed) {
      anchors.push({ blockId: block.id });
      for (const a of mined.slideAnchors) anchors.push(a);
    }
    parts.push(...mined.parts);
  }

  const text = capText(parts.join("\n"), maxChars);
  return {
    lessonId: lesson.id,
    moduleId,
    lessonTitle: lesson.title,
    moduleTitle,
    text,
    anchors,
  };
}

/**
 * Derive one LessonChunk per lesson of a publication snapshot. PURE. Lessons with
 * zero readable text still produce a chunk (title/objective at minimum) so the
 * grain-zero flag can fire downstream rather than the lesson silently vanishing.
 */
export function deriveLessonChunks(snapshot: PublicationSnapshot): LessonChunk[] {
  const chunks: LessonChunk[] = [];
  const maxChars = 6000; // default; the orchestrator passes cfg.chunkMaxChars via deriveLessonChunksWithConfig
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      chunks.push(deriveOneLesson(lesson, mod.id, mod.title, maxChars));
    }
  }
  return chunks;
}

/** Config-aware variant — the orchestrator calls THIS with cfg.chunkMaxChars so
 *  the cap is tunable; `deriveLessonChunks` keeps the directive-named default
 *  signature for the golden suite. */
export function deriveLessonChunksWithCap(
  snapshot: PublicationSnapshot,
  maxChars: number
): LessonChunk[] {
  const chunks: LessonChunk[] = [];
  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      chunks.push(deriveOneLesson(lesson, mod.id, mod.title, maxChars));
    }
  }
  return chunks;
}
