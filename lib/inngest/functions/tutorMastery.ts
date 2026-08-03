/**
 * Durable tutor MASTERY functions (TUTOR-1 Wave 2).
 *
 *   tutor-mastery-refold — on tutor/mastery.refold.requested: refold + write ONE
 *     (user, course) pair inside a durable step. It assembles the ADMIN Supabase
 *     client (the maintenance-cron route's assembly pattern MINUS the model — the
 *     whole mastery engine is deterministic arithmetic; there is NO model client
 *     here, by design and by the ZERO-MODEL grep guard) and runs
 *     refoldLearnerCourse → writeMastery. concurrency { key: userId:courseId,
 *     limit: 1 } serializes runs of the SAME pair (the no-lock invariant the
 *     writer relies on); different pairs run in parallel.
 *
 *   tutor-mastery-nightly — cron "0 4 * * *": pick the ACTIVE pairs (learners with
 *     evidence rows newer than their mastery computed_at, OR mastery older than
 *     24h so decay re-materializes), refold each sequentially, then best-effort
 *     kick the course-aggregate materializer (a defensive dynamic import — W2.4
 *     lands lib/tutor/mastery/queries.ts before the wave closes; a missing module
 *     is caught + logged, never a throw).
 *
 * IDEMPOTENCY: a re-run (Inngest retry, or a duplicate requested event) is safe —
 * the refold is deterministic (R-22) and the writer is a full-replace upsert, so
 * re-executing the whole step lands the same rows. NO MODEL KEY is required.
 *
 * FAIL-BENIGN: a missing admin env is a permanent misconfiguration — the step
 * settles with a benign not-configured stub rather than retrying forever (the
 * tutorGraph precedent).
 */

import { inngest } from "../client";
import {
  TUTOR_MASTERY_REFOLD_REQUESTED_EVENT,
  type TutorMasteryRefoldRequestedData,
} from "../tutorMasteryEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";

/** The evidence event types that make a (user, course) pair "active" for a
 *  nightly refold. Mirrors the loader's event set + the two quiz sources'
 *  learners (a learner with a quiz_attempts row is active too). */
const EVIDENCE_EVENT_TYPES = [
  "practice_answer",
  "hint_request",
  "self_report",
  "tutor_inference",
  "content_engagement",
  "slide_viewed",
] as const;

/** How stale a mastery row may get before the nightly re-materializes it for
 *  decay (independent of any new evidence). */
const MASTERY_MAX_AGE_HOURS = 24;

/** One nightly work item: the pair to refold. */
interface NightlyPair {
  userId: string;
  courseId: string;
}

export const tutorMasteryRefold = inngest.createFunction(
  {
    id: "tutor-mastery-refold",
    concurrency: { key: "event.data.userId + \":\" + event.data.courseId", limit: 1 },
    triggers: [{ event: TUTOR_MASTERY_REFOLD_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const { userId, courseId } = event.data as TutorMasteryRefoldRequestedData;

    return step.run("refold", async () => {
      if (!isAdminConfigured()) {
        const result = { ok: false as const, checkpoint: "admin not configured" };
        console.log(JSON.stringify({ tag: "tutor_mastery_refold", userId, courseId, ...result }));
        return result;
      }

      const admin = createAdminClient();
      const nowIso = new Date().toISOString();

      // NO MODEL CLIENT — the mastery engine is deterministic arithmetic.
      const { rows, evidenceCount } = await refoldLearnerCourse(admin, { userId, courseId, nowIso });
      const write = await writeMastery(admin, { userId, courseId, rows, nowIso });

      const result = {
        ok: true as const,
        userId,
        courseId,
        nodeCount: rows.length,
        evidenceCount,
        upserted: write.upserted,
        deletedAll: write.deletedAll,
      };
      console.log(JSON.stringify({ tag: "tutor_mastery_refold", ...result }));
      return result;
    });
  }
);

export const tutorMasteryNightly = inngest.createFunction(
  { id: "tutor-mastery-nightly", triggers: [{ cron: "0 4 * * *" }] },
  async ({ step }) => {
    // (1) SELECT the active pairs.
    const pairs = await step.run("select-active-pairs", async (): Promise<NightlyPair[]> => {
      if (!isAdminConfigured()) return [];
      const admin = createAdminClient();
      return selectActivePairs(admin);
    });

    // (2) Refold each sequentially (one step per pair keeps a large sweep inside
    // durable-execution limits + makes a partial failure resumable).
    let refolded = 0;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const outcome = await step.run(`refold-${i}`, async () => {
        if (!isAdminConfigured()) return { ok: false as const, checkpoint: "admin not configured" };
        const admin = createAdminClient();
        const nowIso = new Date().toISOString();
        const { rows, evidenceCount } = await refoldLearnerCourse(admin, {
          userId: pair.userId,
          courseId: pair.courseId,
          nowIso,
        });
        const write = await writeMastery(admin, {
          userId: pair.userId,
          courseId: pair.courseId,
          rows,
          nowIso,
        });
        return {
          ok: true as const,
          userId: pair.userId,
          courseId: pair.courseId,
          nodeCount: rows.length,
          evidenceCount,
          upserted: write.upserted,
        };
      });
      if (outcome.ok) refolded += 1;
    }

    // (3) Best-effort kick the course-aggregate materializer. W2.4 lands
    // lib/tutor/mastery/queries.ts before the wave closes; a defensive dynamic
    // import keeps this function decoupled — a missing module is caught + logged,
    // never a throw. (Relative path from lib/inngest/functions/ = ../../tutor/…)
    await step.run("materialize-aggregates", async () => {
      if (!isAdminConfigured()) return { ok: false as const, checkpoint: "admin not configured" };
      const admin = createAdminClient();
      const nowIso = new Date().toISOString();
      try {
        const q = await import("./../../tutor/mastery/queries").catch(() => null);
        if (q && typeof (q as { materializeMasteryResults?: unknown }).materializeMasteryResults === "function") {
          await (q as {
            materializeMasteryResults: (
              admin: ReturnType<typeof createAdminClient>,
              opts: { nowIso: string }
            ) => Promise<unknown>;
          }).materializeMasteryResults(admin, { nowIso });
          return { ok: true as const, materialized: true };
        }
        console.log(
          JSON.stringify({
            tag: "tutor_mastery_nightly",
            note: "queries.materializeMasteryResults unavailable (W2.4 not yet landed) — skipped",
          })
        );
        return { ok: true as const, materialized: false };
      } catch (err) {
        console.log(
          JSON.stringify({
            tag: "tutor_mastery_nightly",
            note: "materializeMasteryResults threw — skipped",
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          })
        );
        return { ok: false as const, materialized: false };
      }
    });

    console.log(JSON.stringify({ tag: "tutor_mastery_nightly", pairs: pairs.length, refolded }));
    return { pairs: pairs.length, refolded };
  }
);

/* ───────────────────────────── active-pair selection ────────────────────── */

/**
 * IMPURE. Pick the (user, course) pairs the nightly should refold:
 *   - every pair with evidence rows NEWER than its mastery computed_at
 *     (new evidence arrived since the last refold), OR
 *   - every pair whose mastery is OLDER than MASTERY_MAX_AGE_HOURS (so decay
 *     re-materializes even without new evidence).
 *
 * We read the candidate pairs from learning_events (evidence types) + quiz_attempts
 * (the two quiz sources' learners), then compare each pair's latest evidence
 * instant to its stored mastery computed_at.
 */
async function selectActivePairs(
  admin: ReturnType<typeof createAdminClient>
): Promise<NightlyPair[]> {
  // Latest evidence instant per pair, from learning_events.
  const latestEvidence = new Map<string, string>();
  const bump = (userId: string | null, courseId: string | null, ts: string | null) => {
    if (!userId || !courseId || !ts) return;
    const key = `${userId}::${courseId}`;
    const prev = latestEvidence.get(key);
    if (!prev || ts > prev) latestEvidence.set(key, ts);
  };

  const { data: evRows, error: evErr } = await admin
    .from("learning_events")
    .select("user_id, course_id, server_ts")
    .in("event_type", EVIDENCE_EVENT_TYPES as unknown as string[]);
  if (evErr) throw new Error(`selectActivePairs events: ${evErr.message}`);
  for (const r of evRows ?? []) {
    bump(
      (r as { user_id: string | null }).user_id,
      (r as { course_id: string | null }).course_id,
      (r as { server_ts: string | null }).server_ts
    );
  }

  const { data: qaRows, error: qaErr } = await admin
    .from("quiz_attempts")
    .select("user_id, course_id, submitted_at");
  if (qaErr) throw new Error(`selectActivePairs quiz: ${qaErr.message}`);
  for (const r of qaRows ?? []) {
    bump(
      (r as { user_id: string | null }).user_id,
      (r as { course_id: string | null }).course_id,
      (r as { submitted_at: string | null }).submitted_at
    );
  }

  // Existing mastery computed_at per pair (learner_mastery may not be typed yet).
  const client = admin as unknown as {
    from: (t: string) => {
      select: (c: string) => Promise<{
        data: { user_id: string; course_id: string; computed_at: string }[] | null;
        error: { message: string } | null;
      }>;
    };
  };
  const { data: mRows, error: mErr } = await client
    .from("learner_mastery")
    .select("user_id, course_id, computed_at");
  if (mErr) throw new Error(`selectActivePairs mastery: ${mErr.message}`);

  // Latest computed_at per pair (a pair spans many node rows; take the max).
  const masteryComputedAt = new Map<string, string>();
  for (const r of mRows ?? []) {
    const key = `${r.user_id}::${r.course_id}`;
    const prev = masteryComputedAt.get(key);
    if (!prev || r.computed_at > prev) masteryComputedAt.set(key, r.computed_at);
  }

  const staleCutoff = new Date(Date.now() - MASTERY_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
  const out: NightlyPair[] = [];
  for (const [key, evTs] of latestEvidence) {
    const computedAt = masteryComputedAt.get(key);
    const needsRefold =
      computedAt === undefined || // never computed
      evTs > computedAt || // new evidence since last refold
      computedAt < staleCutoff; // decay re-materialization
    if (needsRefold) {
      const [userId, courseId] = key.split("::");
      out.push({ userId, courseId });
    }
  }
  // Deterministic order (a sweep should be reproducible).
  out.sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0
  );
  return out;
}
