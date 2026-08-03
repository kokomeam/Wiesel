/**
 * Mastery WRITER (TUTOR-1 Wave 2). IMPURE — persists a refold's `MasteryRow[]`
 * into learner_mastery for one (user, course) as a FULL REPLACE:
 *   1. DELETE the pair's rows whose node_id is NOT in the new set (a node that
 *      lost all its evidence, or was retired out of the active graph, must not
 *      strand a stale mastery row);
 *   2. UPSERT the rest (PK (user_id, course_id, node_id)); computed_at = nowIso.
 *
 * NO LOCK — and that's correct: the refold output is deterministic-idempotent
 * (Amendment R-22 — identical evidence ⇒ byte-identical rows), and the Inngest
 * mastery functions SERIALIZE per (user, course) via a concurrency key (limit 1),
 * so two writers for the same pair never overlap. Even a hypothetical overlap is
 * safe: last-writer-wins upserts land the same values. A plain
 * upsert-then-prune, no optimistic version, no advisory lock.
 *
 * ⚠ TYPE LAG: learner_mastery may not be in database.types.ts yet (the sibling
 * is splicing it). The writes go through a narrowly-cast client so tsc stays
 * clean here; the casts become no-ops once the types land.
 *
 * ZERO MODEL CALLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { MasteryRow } from "./refold";

type DB = SupabaseClient<Database>;

/** The learner_mastery row we upsert (snake_case; mirrors the sibling's DDL). */
interface LearnerMasteryInsert {
  user_id: string;
  course_id: string;
  node_id: string;
  p_learned: number;
  decayed_p: number;
  evidence_count: number;
  last_positive_at: string | null;
  computed_at: string;
}

/**
 * Full-replace the (user, course)'s learner_mastery rows with `rows`. Deletes
 * stale node rows (node_id ∉ the new set) then upserts the new set on the PK.
 * `computed_at` is stamped `nowIso` on every row (the refold's decay instant).
 */
export async function writeMastery(
  admin: DB,
  params: { userId: string; courseId: string; rows: MasteryRow[]; nowIso: string }
): Promise<{ upserted: number; deletedAll: boolean }> {
  const { userId, courseId, rows, nowIso } = params;

  // The cast client — learner_mastery may not be typed yet.
  const client = admin as unknown as {
    from: (t: string) => {
      delete: () => {
        eq: (c: string, v: string) => {
          eq: (c2: string, v2: string) => {
            not: (c3: string, op: string, v3: string) => Promise<{ error: { message: string } | null }>;
          };
        };
      };
      upsert: (
        rows: LearnerMasteryInsert[],
        opts: { onConflict: string }
      ) => Promise<{ error: { message: string } | null }>;
    };
  };

  // (1) DELETE stale rows for the pair whose node_id is NOT in the new set.
  // PostgREST `not(node_id, in, (a,b,c))`; an empty new set deletes ALL the pair's
  // rows (a learner who lost every anchored node). The `in.()` filter needs
  // parenthesized, comma-joined values.
  const keepIds = rows.map((r) => r.nodeId);
  const inList = keepIds.length > 0 ? `(${keepIds.join(",")})` : "()";
  const { error: delErr } = await client
    .from("learner_mastery")
    .delete()
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .not("node_id", "in", inList);
  if (delErr) throw new Error(`writeMastery delete: ${delErr.message}`);

  // (2) UPSERT the new set on the composite PK.
  let upserted = 0;
  if (rows.length > 0) {
    const payload: LearnerMasteryInsert[] = rows.map((r) => ({
      user_id: userId,
      course_id: courseId,
      node_id: r.nodeId,
      p_learned: r.pLearned,
      decayed_p: r.decayedP,
      evidence_count: r.evidenceCount,
      last_positive_at: r.lastPositiveAt,
      computed_at: nowIso,
    }));
    const { error: upErr } = await client
      .from("learner_mastery")
      .upsert(payload, { onConflict: "user_id,course_id,node_id" });
    if (upErr) throw new Error(`writeMastery upsert: ${upErr.message}`);
    upserted = payload.length;
  }

  return { upserted, deletedAll: keepIds.length === 0 };
}
