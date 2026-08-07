/**
 * Creator Tutor Console — misconception rollup (TUTOR-1 Amendment A3, A3-23).
 *
 * The TS side of the `tutor_misconception_rollup(p_course_id)` definer RPC
 * (A3 Wave 2 evidence-spine migration): pure display helpers + the author-gated
 * loader for the Analytics tab's "Misconceptions" section. Mirrors
 * `lib/analytics/lessonHealth.ts` — rpcJson + Zod, [] on any error so the tab
 * renders an EmptyState rather than 500-ing.
 *
 * PRIVACY (Amendment D-4 + A3 §6): the RPC applies BOTH floors server-side —
 *   • a (concept, misconception) pair seen by < 5 distinct learners is OMITTED;
 *   • a course whose evidence cohort is < 5 returns NOTHING.
 * The <20 rule LAYERS ON TOP display-side (never replaces the ≥5 floor): when
 * `cohort_size < 20` the UI shows RAW COUNTS ONLY ("4 learners"); at ≥ 20 it may
 * add a percentage alongside. That rule lives in `misconceptionCountDisplay`
 * below — the ONLY place it is encoded (unit-tested in
 * scripts/verify-tutor-analytics-console.ts).
 *
 * NAMING (audit ruling R-1): concepts have NO slug — `node_id` is the concept
 * node uuid and `node_title` joins from concept_nodes.title. Misconception ids
 * are human-readable slugs (model-proposed, e.g. "insertion-order-preserved"),
 * scoped per course in `tutor_misconceptions`.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";

type DB = SupabaseClient<Database>;

/* ────────────────────────── display rules (pure) ──────────────────────────── */

/** Below this cohort size the UI shows RAW COUNTS ONLY — no percentages (A3-23). */
export const MISCONCEPTION_PCT_MIN_COHORT = 20;

/**
 * PURE. Humanize a misconception slug for display: hyphens/underscores → spaces,
 * collapsed whitespace, sentence case ("insertion-order-preserved" →
 * "Insertion order preserved"). The RAW slug stays visible in a muted mono chip
 * next to the humanized label — this never replaces it.
 */
export function humanizeMisconceptionSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (words.length === 0) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * PURE. The A3-23 count-display rule: `cohortSize < 20` ⇒ raw counts ONLY
 * ("4 learners"); at ≥ 20 a percentage of the cohort is appended
 * ("12 learners (24%)"). A non-positive cohort degrades to raw counts (never
 * divides by zero). This layers on top of the RPC's ≥5 disclosure floor —
 * below-floor rows never arrive here at all.
 */
export function misconceptionCountDisplay(count: number, cohortSize: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  const base = `${n} learner${n === 1 ? "" : "s"}`;
  if (!Number.isFinite(cohortSize) || cohortSize < MISCONCEPTION_PCT_MIN_COHORT || cohortSize <= 0) {
    return base;
  }
  return `${base} (${Math.round((n / cohortSize) * 100)}%)`;
}

/* ──────────────────────── tutor_misconception_rollup ───────────────────────── */

/** The RPC row — snake_case on the wire (the frozen Wave-2 contract). */
const MisconceptionRollupWireSchema = z.object({
  node_id: z.string(),
  node_title: z.string(),
  misconception_slug: z.string(),
  learner_count: z.coerce.number(),
  evidence_count: z.coerce.number(),
  cohort_size: z.coerce.number(),
});

export interface MisconceptionRollupRow {
  nodeId: string;
  nodeTitle: string;
  misconceptionSlug: string;
  learnerCount: number;
  evidenceCount: number;
  cohortSize: number;
}

export interface MisconceptionGroupItem {
  slug: string;
  learnerCount: number;
  evidenceCount: number;
}

export interface MisconceptionConceptGroup {
  nodeId: string;
  nodeTitle: string;
  items: MisconceptionGroupItem[];
}

/**
 * PURE. Group rollup rows per concept node for display. Deterministic ordering:
 * groups by their strongest signal (max learner count) desc, then title asc;
 * items within a group by learner count desc, then slug asc. [] in → [] out
 * (the section's empty-state gate).
 */
export function groupMisconceptionsByNode(
  rows: MisconceptionRollupRow[]
): MisconceptionConceptGroup[] {
  const byNode = new Map<string, MisconceptionConceptGroup>();
  for (const r of rows) {
    let group = byNode.get(r.nodeId);
    if (!group) {
      group = { nodeId: r.nodeId, nodeTitle: r.nodeTitle, items: [] };
      byNode.set(r.nodeId, group);
    }
    group.items.push({
      slug: r.misconceptionSlug,
      learnerCount: r.learnerCount,
      evidenceCount: r.evidenceCount,
    });
  }
  const groups = [...byNode.values()];
  for (const g of groups) {
    g.items.sort((a, b) => b.learnerCount - a.learnerCount || a.slug.localeCompare(b.slug));
  }
  const maxCount = (g: MisconceptionConceptGroup) =>
    g.items.reduce((m, i) => Math.max(m, i.learnerCount), 0);
  groups.sort((a, b) => maxCount(b) - maxCount(a) || a.nodeTitle.localeCompare(b.nodeTitle));
  return groups;
}

/**
 * Load the cohort-floored misconception rollup for a course (author-gated
 * definer RPC). Sub-floor pairs are OMITTED and a sub-floor course returns
 * NOTHING — both enforced inside the RPC (this module NEVER reads a raw learner
 * table and NEVER recomputes a floor). Returns [] on any error.
 */
export async function loadMisconceptionRollup(
  supabase: DB,
  courseId: string
): Promise<MisconceptionRollupRow[]> {
  try {
    // A set-returning RPC yields [] for an empty course; a jsonb-returning one
    // may yield null — treat both as the (legitimate) below-floor empty state.
    const wire =
      (await rpcJson(
        supabase,
        "tutor_misconception_rollup",
        { p_course_id: courseId },
        z.array(MisconceptionRollupWireSchema).nullable()
      )) ?? [];
    return wire.map((r) => ({
      nodeId: r.node_id,
      nodeTitle: r.node_title,
      misconceptionSlug: r.misconception_slug,
      learnerCount: r.learner_count,
      evidenceCount: r.evidence_count,
      cohortSize: r.cohort_size,
    }));
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "misconception_rollup_load",
        courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return [];
  }
}
