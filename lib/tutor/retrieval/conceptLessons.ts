/**
 * TUTOR-1 Amendment A4, Wave 3 — the concept ↔ lesson resolver (pure).
 *
 * The Wave-0 audit (A0-11) found the mapping exists in the data
 * (`concept_nodes.anchors[].lessonId` + prerequisite `concept_edges`) but no
 * packaged accessor. This is that accessor: given the loaded concept nodes/edges
 * (already in the turn's `TutorContext`) it answers lesson→concepts,
 * concept→lessons, question→concepts, and prereq-of-active→covering-lessons —
 * the inputs the expansion codes need. PURE.
 */

import type { LessonConceptNode } from "@/lib/tutor/runtime/lessonContext";
import type { EdgeLike, MasteryLike } from "@/lib/tutor/mastery/queries";
import { rootCause } from "@/lib/tutor/mastery/queries";
import { resolveMasteryConfig } from "@/lib/tutor/mastery/config";

/** Tolerantly read the lesson ids off a concept node's jsonb anchors (an anchor
 *  is `{lessonId, blockId, slideId?}`; a malformed/absent anchor contributes
 *  nothing). Deduped, order-preserving. */
export function anchorLessonIds(node: LessonConceptNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(node.anchors)) return out;
  for (const a of node.anchors) {
    if (!a || typeof a !== "object") continue;
    const lid = (a as Record<string, unknown>).lessonId;
    if (typeof lid === "string" && lid && !seen.has(lid)) {
      seen.add(lid);
      out.push(lid);
    }
  }
  return out;
}

/** Concept nodes anchored to a given lesson. */
export function conceptsForLesson(nodes: LessonConceptNode[], lessonId: string): LessonConceptNode[] {
  return nodes.filter((n) => anchorLessonIds(n).includes(lessonId));
}

/** Concept nodes anchored to ANY of the given lessons. */
export function conceptsForLessons(nodes: LessonConceptNode[], lessonIds: Iterable<string>): LessonConceptNode[] {
  const set = new Set(lessonIds);
  return nodes.filter((n) => anchorLessonIds(n).some((l) => set.has(l)));
}

/* ─────────────────────────── question → concepts ────────────────────────── */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "what", "why", "how", "does", "do", "is", "are", "a", "an",
  "of", "to", "in", "on", "this", "that", "these", "those", "can", "you", "me", "my", "i",
  "about", "explain", "compare", "between", "versus", "vs", "review", "help",
]);

/** Significant lowercase tokens (len ≥ 3, non-stopword) of a string. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Map a learner message to the concepts it names — a LEXICAL match (we do not
 * embed the question against concepts here): a concept matches when its title
 * appears as a phrase in the message, OR ≥1 significant title token appears as a
 * message word. Coarse by design (it feeds the multi_concept_span signal, which a
 * downstream check confirms), and conservative on stopwords to avoid over-matching.
 */
export function questionConcepts(nodes: LessonConceptNode[], message: string): LessonConceptNode[] {
  const msg = message.toLowerCase();
  const msgTokens = new Set(tokens(message));
  return nodes.filter((n) => {
    const title = n.title.toLowerCase().trim();
    if (title.length >= 3 && msg.includes(title)) return true;
    return tokens(n.title).some((t) => msgTokens.has(t));
  });
}

/** The distinct lessons the message's concepts belong to (via their anchors). */
export function questionLessonIds(nodes: LessonConceptNode[], message: string): Set<string> {
  const out = new Set<string>();
  for (const n of questionConcepts(nodes, message)) for (const l of anchorLessonIds(n)) out.add(l);
  return out;
}

/* ─────────────────────── prerequisite → covering lessons ─────────────────── */

export interface PrereqLessonGap {
  /** The weak prerequisite concept node. */
  prereqNodeId: string;
  /** The lessons that cover it (its anchors). */
  coveringLessonIds: string[];
}

/**
 * For each concept of the ACTIVE lesson, find the deepest WEAK prerequisite
 * ancestor (rootCause over the prerequisite DAG + the learner's mastery), then map
 * that prerequisite to the lessons that cover it. Returns one entry per distinct
 * weak prerequisite. Empty when the active lesson has no concepts, or none has a
 * weak prerequisite. This is the `prerequisite_gap` selector's data.
 */
export function prerequisiteLessonGaps(args: {
  nodes: LessonConceptNode[];
  edges: EdgeLike[];
  mastery: MasteryLike[];
  activeLessonId: string;
}): PrereqLessonGap[] {
  const cfg = resolveMasteryConfig();
  const activeConcepts = conceptsForLesson(args.nodes, args.activeLessonId);
  const nodeById = new Map(args.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const gaps: PrereqLessonGap[] = [];
  for (const concept of activeConcepts) {
    const prereqId = rootCause(args.mastery, args.edges, concept.id, cfg);
    if (!prereqId || seen.has(prereqId)) continue;
    seen.add(prereqId);
    const prereqNode = nodeById.get(prereqId);
    const coveringLessonIds = prereqNode ? anchorLessonIds(prereqNode) : [];
    gaps.push({ prereqNodeId: prereqId, coveringLessonIds });
  }
  return gaps;
}
