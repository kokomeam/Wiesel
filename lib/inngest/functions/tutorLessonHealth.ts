/**
 * Durable tutor LESSON-HEALTH function (TUTOR-1 Wave 5, P5.3).
 *
 *   tutorLessonHealthNightly — cron "0 5 * * *" (05:00 UTC, an hour AFTER the
 *     mastery nightly at 04:00 so mastery_course_aggregate is fresh when the
 *     composite reads it): for every course with a LIVE publication,
 *       (1) recompute the DETERMINISTIC per-lesson composite in SQL
 *           (private.recompute_lesson_health — weighted sum of 5 normalized
 *           inputs; the MODEL never computes or ranks), then
 *       (2) for the TOP-N flagged lessons (highest composite_score) of each
 *           course, call the TUTOR_MODELS.lesson_rationale model to write
 *           the human-readable `rationale` OVER THE ALREADY-COMPUTED evidence and
 *           write it back to rollup_lesson_health.
 *
 * THE MODEL'S ROLE IS BOUNDED: Terra is handed the computed composite + the five
 * inputs + the implicated question/node evidence and writes ONE short paragraph.
 * It does not compute, rank, or invent numbers — the composite is deterministic
 * SQL; the rationale is prose over facts.
 *
 * FAIL-BENIGN + IDEMPOTENT (the tutorMastery/tutorGraph precedent): a missing
 * admin env or a missing OPENAI_API_KEY settles the step with a benign
 * not-configured stub — never a throw, never a retry of a permanent
 * misconfiguration. The SQL recompute is a full delete+insert per publication
 * (re-running is a no-op); the rationale write is an idempotent update keyed by
 * (publication_id, lesson_id). DEV has no INNGEST_EVENT_KEY, so the cron simply
 * reconciles — this function never depends on event round-trips.
 */

import { inngest } from "../client";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withSemaphore, runStructuredCall, poolFor } from "@/lib/ai/subagent";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import {
  buildLessonRationalePrompt,
  LessonRationaleOutputSchema,
  type LessonHealthEvidence,
} from "@/lib/analytics/lessonRationale";

/** How many of a course's worst lessons get a Terra rationale each night. A short
 *  paragraph per lesson × the top few keeps the nightly spend bounded; the rest
 *  render their computed inputs without prose. Env-overridable. */
const TOP_N_FLAGGED = Number.parseInt(process.env.TUTOR_LESSON_HEALTH_TOP_N ?? "3", 10) || 3;

/** A course that has a live publication (the recompute + rationale target). */
interface HealthCourse {
  courseId: string;
}

export const tutorLessonHealthNightly = inngest.createFunction(
  { id: "tutor-lesson-health-nightly", triggers: [{ cron: "0 5 * * *" }] },
  async ({ step }) => {
    // (1) Select the courses to process (any with a live publication).
    const courses = await step.run("select-live-courses", async (): Promise<HealthCourse[]> => {
      if (!isAdminConfigured()) return [];
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("course_publications")
        .select("course_id")
        .eq("status", "live");
      if (error) throw new Error(`select-live-courses: ${error.message}`);
      const seen = new Set<string>();
      const out: HealthCourse[] = [];
      for (const r of data ?? []) {
        const cid = (r as { course_id: string | null }).course_id;
        if (cid && !seen.has(cid)) {
          seen.add(cid);
          out.push({ courseId: cid });
        }
      }
      // Deterministic order (a sweep should be reproducible).
      out.sort((a, b) => (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0));
      return out;
    });

    // (2) Recompute the DETERMINISTIC composite per course (one step each keeps a
    // large sweep inside durable-execution limits + makes a partial failure
    // resumable). The rationale is written by step (3).
    let recomputed = 0;
    for (let i = 0; i < courses.length; i++) {
      const { courseId } = courses[i];
      const ok = await step.run(`recompute-${i}`, async () => {
        if (!isAdminConfigured()) return { ok: false as const, checkpoint: "admin not configured" };
        const admin = createAdminClient();
        // private.recompute_lesson_health is not on the PostgREST rpc surface; the
        // service-role-only public wrapper (recompute_lesson_health_admin) is the
        // one entry point (migration 20260805120000).
        const { error } = await (
          admin as unknown as {
            rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
          }
        ).rpc("recompute_lesson_health_admin", { cid: courseId });
        if (error) return { ok: false as const, checkpoint: error.message.slice(0, 200) };
        return { ok: true as const, courseId };
      });
      if (ok.ok) recomputed += 1;
    }

    // (3) Terra rationale for the TOP-N flagged lessons per course. Fail-benign on a
    // missing key: the composite already ranks + renders without prose.
    let rationaleWritten = 0;
    if (isAdminConfigured() && process.env.OPENAI_API_KEY) {
      const model = withSemaphore(createOpenAIModelClient(), poolFor("creator"));
      for (let i = 0; i < courses.length; i++) {
        const { courseId } = courses[i];
        const written = await step.run(`rationale-${i}`, async () => {
          const admin = createAdminClient();
          const evidence = await loadTopFlaggedEvidence(admin, courseId, TOP_N_FLAGGED);
          let count = 0;
          for (const ev of evidence) {
            const call = await runStructuredCall(model, {
              system:
                "You write ONE short, plain-English case (2–3 sentences) explaining WHY a lesson " +
                "needs a creator's attention, grounded ONLY in the supplied computed evidence. Never " +
                "invent numbers, never rank, never recompute — the composite score is already decided. " +
                "Name the specific signal(s) driving the score and, when present, the implicated " +
                "question or concept. Be concrete and actionable.",
              input: buildLessonRationalePrompt(ev),
              outputName: "lesson_health_rationale",
              outputSchema: LessonRationaleOutputSchema,
              model: TUTOR_MODELS.lesson_rationale.model,
              effort: TUTOR_MODELS.lesson_rationale.effort,
              timeoutMs: TUTOR_MODELS.lesson_rationale.timeoutMs,
              maxRetries: TUTOR_MODELS.lesson_rationale.maxRetries,
              maxOutputTokens: TUTOR_MODELS.lesson_rationale.maxOutputTokens,
            });
            if (!call.ok || !call.data) continue;
            // Idempotent write keyed by (publication_id, lesson_id). rollup_lesson_health
            // is not yet in the generated types (new table this wave) — write through the
            // untyped-client escape hatch rather than splicing database.types.ts (the
            // sibling package may touch it; a splice risks a merge conflict).
            const { error } = await untypedTable(admin, "rollup_lesson_health")
              .update({ rationale: call.data.rationale })
              .eq("publication_id", ev.publicationId)
              .eq("lesson_id", ev.lessonId);
            if (!error) count += 1;
          }
          return { ok: true as const, courseId, count };
        });
        rationaleWritten += written.count;
      }
    } else {
      console.log(
        JSON.stringify({
          tag: "tutor_lesson_health_nightly",
          note: "OPENAI_API_KEY / admin absent — composite recomputed, rationale skipped (benign)",
        })
      );
    }

    console.log(
      JSON.stringify({
        tag: "tutor_lesson_health_nightly",
        courses: courses.length,
        recomputed,
        rationaleWritten,
      })
    );
    return { courses: courses.length, recomputed, rationaleWritten };
  }
);

/* ─────────────────────────── top-flagged evidence load ──────────────────────
 * IMPURE. Load the TOP-N flagged lessons (by composite_score) for a course's LIVE
 * publication, assembling the evidence the rationale prompt reads: the composite +
 * the 5 inputs + the implicated most-missed question + the lesson's concept nodes.
 * Reads the admin client (service-role) — service-role sees the rollups + the
 * definer-RPC-shaped aggregates; it NEVER surfaces a learner row (only aggregates
 * land in the prompt). */
async function loadTopFlaggedEvidence(
  admin: ReturnType<typeof createAdminClient>,
  courseId: string,
  topN: number
): Promise<LessonHealthEvidence[]> {
  // The live publication pins the rollup rows to read.
  const pub = await admin
    .from("course_publications")
    .select("id, version")
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();
  if (pub.error || !pub.data) return [];
  const publicationId = (pub.data as { id: string }).id;

  // rollup_lesson_health is not yet in the generated types (new table this wave) —
  // read through the untyped-client escape hatch (see the update site's note).
  const rows = await untypedTable(admin, "rollup_lesson_health")
    .select(
      "lesson_id, composite_score, mastery_shortfall, confusion_density, first_attempt_error_rate, rewatch_scrub_density, dropout_after_rate"
    )
    .eq("publication_id", publicationId)
    .order("composite_score", { ascending: false })
    .limit(topN);
  if (rows.error || !rows.data) return [];

  // The most-missed question per lesson (the implicated evidence the prose names).
  // Read the author-facing aggregates through the definer RPC would need the author
  // session; service-role reads the ranked rollup + a compact question join here.
  const worstQuestionByLesson = await loadWorstQuestionByLesson(admin, courseId, publicationId);

  return (rows.data as Array<Record<string, number | string | null>>).map((r) => {
    const lessonId = String(r.lesson_id);
    const q = worstQuestionByLesson.get(lessonId) ?? null;
    return {
      publicationId,
      lessonId,
      compositeScore: num(r.composite_score),
      inputs: {
        masteryShortfall: num(r.mastery_shortfall),
        firstAttemptErrorRate: num(r.first_attempt_error_rate),
        confusionDensity: num(r.confusion_density),
        dropoutAfterRate: num(r.dropout_after_rate),
        rewatchScrubDensity: num(r.rewatch_scrub_density),
      },
      worstQuestion: q,
    } satisfies LessonHealthEvidence;
  });
}

/** The lesson's worst question (highest first-attempt error rate, ≥5 learners) —
 *  the concrete evidence the rationale names. Service-role aggregate read over
 *  rollup_question_stats (already floored upstream at rollup time). */
async function loadWorstQuestionByLesson(
  admin: ReturnType<typeof createAdminClient>,
  courseId: string,
  publicationId: string
): Promise<Map<string, { questionId: string; pctCorrect: number | null; n: number }>> {
  const out = new Map<string, { questionId: string; pctCorrect: number | null; n: number }>();
  const qs = await admin
    .from("rollup_question_stats")
    .select("lesson_id, question_id, pct_correct, n")
    .eq("course_id", courseId)
    .eq("publication_id", publicationId);
  if (qs.error || !qs.data) return out;
  for (const r of qs.data as Array<Record<string, number | string | null>>) {
    const lessonId = String(r.lesson_id);
    const n = num(r.n);
    if (n <= 0) continue;
    const pctCorrect = r.pct_correct === null ? null : num(r.pct_correct);
    const errRate = pctCorrect === null ? 0 : 100 - pctCorrect;
    const prev = out.get(lessonId);
    const prevErr = prev ? (prev.pctCorrect === null ? 0 : 100 - prev.pctCorrect) : -1;
    if (!prev || errRate > prevErr) {
      out.set(lessonId, { questionId: String(r.question_id), pctCorrect, n });
    }
  }
  return out;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Minimal untyped query-builder surface for a table absent from the generated
 *  types (rollup_lesson_health, this wave). Mirrors the rpcJson escape-hatch rule:
 *  a new object lands in code before its database.types.ts splice, so we access it
 *  through a narrow cast rather than editing the shared generated types file. */
interface UntypedTable {
  select: (cols: string) => {
    eq: (k: string, v: unknown) => {
      order: (c: string, o: { ascending: boolean }) => {
        limit: (n: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
  update: (patch: Record<string, unknown>) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
}
function untypedTable(admin: ReturnType<typeof createAdminClient>, table: string): UntypedTable {
  return (admin as unknown as { from: (t: string) => UntypedTable }).from(table);
}
