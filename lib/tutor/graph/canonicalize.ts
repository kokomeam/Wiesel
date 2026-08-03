/**
 * Concept CANONICALIZATION (TUTOR-1 Wave 1.3 · Directive §1.2 step 4).
 *
 * Two lessons often teach the same concept under slightly different titles.
 * Canonicalization collapses those into ONE node:
 *   1. exact-title pre-merge (case/whitespace-insensitive) — deterministic, no model
 *   2. cosine clustering of the embedded remainder (title+": "+description)
 *   3. ONE Terra merge-adjudication call per multi-member cluster — the model may
 *      decline a merge; a kept merge unions anchors + records aliases
 *
 * `clusterByCosine` is PURE greedy single-link (documented choice below). The
 * merge-adjudication SCHEMA + responseFormat name live here (the mock seam); the
 * orchestrator owns the embed/model calls.
 */

import { z } from "zod";
import type { LessonProposal } from "./propose";
import type { LessonChunkAnchor } from "./extractionSource";

/* ─────────────────────────── clustering (pure) ──────────────────────────── */

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector
 *  (no direction). Pure. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Greedy SINGLE-LINK clustering by cosine similarity ≥ `threshold`.
 *
 * DESIGN CHOICE (documented per directive): single-link (transitive) — an item
 * joins a cluster if it's ≥threshold to ANY member, not the centroid. This is the
 * cheap, deterministic, order-stable choice appropriate here because (a) the
 * downstream Terra adjudication is the real merge authority (it can DECLINE a loose
 * cluster), so a slightly greedy cluster is safe, and (b) it needs no iteration to
 * convergence. Determinism: items are processed in input order; each unclustered
 * item seeds or joins the FIRST cluster it matches. Returns clusters as arrays of
 * the input `key`s, singletons included.
 */
export function clusterByCosine(
  items: { key: string; vector: number[] }[],
  threshold: number
): string[][] {
  const clusters: { keys: string[]; vectors: number[][] }[] = [];
  for (const item of items) {
    let joined = false;
    for (const cluster of clusters) {
      if (cluster.vectors.some((v) => cosineSimilarity(v, item.vector) >= threshold)) {
        cluster.keys.push(item.key);
        cluster.vectors.push(item.vector);
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ keys: [item.key], vectors: [item.vector] });
  }
  return clusters.map((c) => c.keys);
}

/* ─────────────────────────── exact-title merge ──────────────────────────── */

/** Normalize a title for exact-dupe detection: lowercase, collapse internal
 *  whitespace, trim. Two proposals with the same normalized title ALWAYS merge
 *  (no model call needed). Pure. */
export function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/* ─────────────────────── merge-adjudication schema ──────────────────────── */

/** One adjudicated merge group. `keepIndex` is the survivor (index into the
 *  cluster's member list handed to the model); `mergeIndexes` fold into it;
 *  `canonicalTitle` renames the survivor; `aliases` records the folded titles.
 *  The model DECLINES a merge by simply not returning a group for that cluster. */
export const MergeGroupSchema = z.object({
  keepIndex: z.number().int().min(0),
  mergeIndexes: z.array(z.number().int().min(0)),
  canonicalTitle: z.string().min(1).max(200),
  aliases: z.array(z.string()),
});
export type MergeGroup = z.infer<typeof MergeGroupSchema>;

export const MergeAdjudicationSchema = z.object({
  groups: z.array(MergeGroupSchema),
});
export type MergeAdjudication = z.infer<typeof MergeAdjudicationSchema>;

/** The responseFormat name — the mock's `opts.structured` map key. */
export const MERGE_RESPONSE_NAME = "graph_merge_adjudication";

export const MERGE_SYSTEM_PROMPT = [
  "You decide which of these candidate concepts describe the SAME durable idea and",
  "should be merged into one canonical concept.",
  "",
  "For each group of duplicates return: keepIndex (the survivor), mergeIndexes (the",
  "others that fold into it), a canonicalTitle for the survivor, and aliases (the",
  "titles being folded away, so they stay searchable).",
  "",
  "DECLINE a merge by simply NOT returning a group for those candidates — when in",
  "doubt, keep them separate. Only merge concepts that are genuinely the same idea",
  "taught in different words, not merely related.",
  "",
  "Return ONLY the JSON object matching the schema.",
].join("\n");

/* ─────────────────────── canonical-node assembly (pure) ─────────────────── */

/** A canonical concept after exact + cluster + adjudication folding. Carries the
 *  union of member anchors + aliases; `isAssumedPrior` is true iff ALL folded
 *  members were assumed priors (a taught member wins — the concept IS taught). */
export interface CanonicalConcept {
  title: string;
  description: string;
  anchors: LessonChunkAnchor[];
  aliases: string[];
  confidence: number;
  isAssumedPrior: boolean;
  /** The evidence quotes of the folded members (deduped). */
  evidenceQuotes: string[];
}

/** Fold a set of member proposals into one canonical concept. Survivor content
 *  (title/description) comes from `survivor`; anchors + aliases + evidence union
 *  across all members. Confidence = the MAX member confidence. Pure. */
export function foldConcept(
  survivor: LessonProposal,
  members: LessonProposal[],
  canonicalTitle: string,
  extraAliases: string[]
): CanonicalConcept {
  const anchorSet = new Map<string, LessonChunkAnchor>();
  const aliasSet = new Set<string>();
  const quoteSet = new Set<string>();
  let confidence = 0;
  let allPriors = true;

  for (const m of members) {
    for (const a of m.proposal.lessonAnchors) {
      const key = `${a.blockId}::${a.slideId ?? ""}`;
      if (!anchorSet.has(key)) {
        anchorSet.set(key, { blockId: a.blockId, ...(a.slideId ? { slideId: a.slideId } : {}) });
      }
    }
    confidence = Math.max(confidence, m.proposal.confidence);
    if (!m.proposal.isAssumedPrior) allPriors = false;
    const t = m.proposal.title.trim();
    if (t && normalizeTitleKey(t) !== normalizeTitleKey(canonicalTitle)) aliasSet.add(t);
    const q = m.proposal.evidenceQuote.trim();
    if (q) quoteSet.add(q);
  }
  for (const a of extraAliases) {
    const t = a.trim();
    if (t && normalizeTitleKey(t) !== normalizeTitleKey(canonicalTitle)) aliasSet.add(t);
  }

  return {
    title: canonicalTitle,
    description: survivor.proposal.description,
    anchors: [...anchorSet.values()],
    aliases: [...aliasSet],
    confidence,
    isAssumedPrior: allPriors,
    evidenceQuotes: [...quoteSet],
  };
}
