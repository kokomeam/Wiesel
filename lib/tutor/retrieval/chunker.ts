/**
 * TUTOR-1 Amendment A4, Wave 2 — the retrieval CHUNKER (pure).
 *
 * Walks a published `PublicationSnapshot` into retrieval chunks at the natural
 * grain (Wave-0 audit A0-4): ONE chunk per SLIDE of a slide_deck, ONE per
 * non-deck text block (quiz / lecture_text / example / homework / exercise /
 * resource). imported_deck + video carry no in-snapshot prose and are skipped.
 * Each chunk carries a resolvable display anchor {lessonId, blockId, slideId?} —
 * the SLIDE is the finest unit the /learn player can deep-link to (fixes D-8).
 *
 * The chunk `text` is prefixed with a compact `module › lesson` heading so both
 * the lexical and vector arms have lesson context, then the slide/block's own
 * readable text. Source is the immutable, answer-stripped snapshot — never the
 * draft. PURE: no IO, golden-testable against a hand-built snapshot.
 */

import type {
  PublicationSnapshot,
  PublishedLessonBlock,
} from "@/lib/course/publish/schemas";
import type { Slide } from "@/lib/course/types";
import { collectStrings } from "@/lib/tutor/graph/extractionSource";
import { RETRIEVAL_CHUNK_MAX_CHARS } from "./config";

/** The resolvable deep-link tuple stored on every chunk. */
export interface RetrievalChunkAnchor {
  lessonId: string;
  blockId: string;
  slideId: string | null;
}

/** One retrieval chunk (pre-embedding). `chunkOrdinal` is stable within the
 *  publication (document order). */
export interface RetrievalChunk {
  courseId: string;
  moduleId: string;
  moduleTitle: string;
  lessonId: string;
  lessonTitle: string;
  blockId: string;
  slideId: string | null;
  chunkOrdinal: number;
  text: string;
  anchor: RetrievalChunkAnchor;
}

/* ─────────────────────────── per-unit text mining ───────────────────────── */

/** A slide's readable text: its title + structured-template string slots (walked
 *  generically) OR flat-element text/items/code/table cells. Mirrors the
 *  concept-graph miner but PER SLIDE (not concatenated across the deck). */
function slideText(slide: Slide): string {
  const parts: string[] = [];
  if (slide.title && slide.title.trim()) parts.push(slide.title.trim());
  if (slide.template) {
    collectStrings(slide.template.content, parts);
  } else {
    for (const el of slide.elements) {
      const anyEl = el as unknown as Record<string, unknown>;
      if (typeof anyEl.text === "string" && anyEl.text.trim()) parts.push(anyEl.text.trim());
      if (Array.isArray(anyEl.items)) {
        for (const it of anyEl.items as unknown[]) {
          if (typeof it === "string" && it.trim()) parts.push(it.trim());
        }
      }
      if (typeof anyEl.code === "string" && anyEl.code.trim()) parts.push(anyEl.code.trim());
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
  return parts.join("\n");
}

/** A non-deck block's readable text (answer-stripped by construction). Returns ""
 *  for a block that carries no prose (imported_deck / video, or empty). */
function nonDeckBlockText(block: PublishedLessonBlock): string {
  const parts: string[] = [];
  if (block.title && block.title.trim()) parts.push(block.title.trim());
  switch (block.type) {
    case "quiz":
      for (const q of block.questions) {
        if (q.prompt && q.prompt.trim()) parts.push(q.prompt.trim());
        if ("choices" in q && Array.isArray(q.choices)) {
          for (const c of q.choices) if (c.text && c.text.trim()) parts.push(c.text.trim());
        }
      }
      break;
    case "lecture_text":
      for (const p of block.paragraphs) if (p.text && p.text.trim()) parts.push(p.text.trim());
      break;
    case "example":
      for (const s of [block.context, block.explanation, ...block.steps, block.takeaway]) {
        if (s && s.trim()) parts.push(s.trim());
      }
      break;
    case "homework":
      if (block.instructions && block.instructions.trim()) parts.push(block.instructions.trim());
      for (const ex of block.exercises) {
        if (ex.title && ex.title.trim()) parts.push(ex.title.trim());
        if (ex.prompt && ex.prompt.trim()) parts.push(ex.prompt.trim());
      }
      break;
    case "exercise":
      if (block.prompt && block.prompt.trim()) parts.push(block.prompt.trim());
      break;
    case "resource":
      for (const l of block.links) {
        if (l.label && l.label.trim()) parts.push(l.label.trim());
        if (l.note && l.note.trim()) parts.push(l.note.trim());
      }
      break;
    // slide_deck handled per-slide; imported_deck / video have no snapshot prose.
    default:
      break;
  }
  return parts.join("\n");
}

/** Cap + prefix a chunk's text with a compact `module › lesson` heading. */
function withHeading(moduleTitle: string, lessonTitle: string, body: string): string {
  const heading = `${moduleTitle} › ${lessonTitle}`;
  const text = `${heading}\n${body}`;
  return text.length <= RETRIEVAL_CHUNK_MAX_CHARS ? text : text.slice(0, RETRIEVAL_CHUNK_MAX_CHARS).trimEnd();
}

/* ─────────────────────────────── the walk ───────────────────────────────── */

/**
 * Chunk a published snapshot for retrieval. Emits chunks in document order with a
 * running `chunkOrdinal`. A slide/block that mines no readable text is skipped
 * (no empty chunks). Deterministic + pure.
 */
export function deriveRetrievalChunks(snapshot: PublicationSnapshot): RetrievalChunk[] {
  const courseId = snapshot.course.id;
  const chunks: RetrievalChunk[] = [];
  let ordinal = 0;

  for (const mod of snapshot.modules) {
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        // imported_deck + video carry no readable prose in the snapshot (bytes /
        // media live off-doc) — skip entirely (never a title-only chunk).
        if (block.type === "imported_deck" || block.type === "video") continue;
        if (block.type === "slide_deck") {
          for (const slide of block.slides) {
            const body = slideText(slide);
            if (!body.trim()) continue;
            chunks.push({
              courseId,
              moduleId: mod.id,
              moduleTitle: mod.title,
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              blockId: block.id,
              slideId: slide.id,
              chunkOrdinal: ordinal++,
              text: withHeading(mod.title, lesson.title, body),
              anchor: { lessonId: lesson.id, blockId: block.id, slideId: slide.id },
            });
          }
          continue;
        }
        const body = nonDeckBlockText(block);
        if (!body.trim()) continue;
        chunks.push({
          courseId,
          moduleId: mod.id,
          moduleTitle: mod.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          blockId: block.id,
          slideId: null,
          chunkOrdinal: ordinal++,
          text: withHeading(mod.title, lesson.title, body),
          anchor: { lessonId: lesson.id, blockId: block.id, slideId: null },
        });
      }
    }
  }
  return chunks;
}

/* ─────────────────────────────── anchor resolution ──────────────────────── */

/**
 * Resolve a chunk's display anchor to a /learn deep-link path (fixes D-8). Pure —
 * the caller supplies the course slug (resolved from the publication). Mirrors the
 * citation deep-link the player already honors (`?block=&slide=`).
 */
export function retrievalAnchorToHref(slug: string, anchor: RetrievalChunkAnchor): string {
  const base = `/learn/${slug}/${anchor.lessonId}?block=${encodeURIComponent(anchor.blockId)}`;
  return anchor.slideId ? `${base}&slide=${encodeURIComponent(anchor.slideId)}` : base;
}
