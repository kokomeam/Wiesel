/**
 * Durable tutor ESCALATION functions (TUTOR-1 Wave 6 · P6.2).
 *
 *   tutorEscalationSynthesize — on tutor/escalation.consented: synthesize the
 *     dossier + assign the cluster for ONE consented candidate. concurrency
 *     { key: event.data.courseId, limit: 1 } serializes a course's synthesis runs
 *     (they share the course's open-cluster set, so a shared cluster can't race).
 *     Different courses run in parallel.
 *
 *   tutorEscalationReconcileNightly — cron "0 6 * * *" (06:00 UTC, after the
 *     mastery/lesson-health nightlies): correctness NEVER depends on the event
 *     round-trip (dev has no INNGEST_EVENT_KEY). Every CONSENTED candidate that
 *     still lacks a dossier is synthesized here, and every cluster's member_count
 *     is reconciled — so a lost event self-heals within a day.
 *
 * IDEMPOTENT: synthesizeAndCluster is keyed by candidate_id (the dossier PK) and
 * re-uses an already-assigned cluster, so an Inngest retry / a duplicate event /
 * the nightly overlap all land the same rows (STABLE cluster identity).
 *
 * FAIL-BENIGN: a missing admin env or a missing OPENAI_API_KEY settles the step
 * with a benign not-configured stub — never a throw, never a retry of a permanent
 * misconfiguration (the tutorMastery / tutorLessonHealth precedent). A model-less
 * environment can still cluster + persist the raw payload (the Terra prose is the
 * only part that needs the key; a missing key means an empty dossier summary).
 */

import { inngest } from "../client";
import {
  TUTOR_ESCALATION_CONSENTED_EVENT,
  type TutorEscalationConsentedData,
} from "../escalationEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { synthesizeAndCluster } from "@/lib/tutor/escalation/synthesis";

/** Build the pooled model client for a synthesis run. cost.jobType is
 *  'escalation_dossier' (the Terra call is NOT DB-checked → its runTurn cost row is
 *  skipped by the decorator; the question embed emits under 'embedding'). emittedBy
 *  = the course author (the acting principal — never a learner). runKey =
 *  candidateId so an Inngest retry re-emits the embed cost as a no-op. */
async function pooledModelForCandidate(
  admin: ReturnType<typeof createAdminClient>,
  courseId: string,
  candidateId: string
) {
  const courseRow = await admin.from("courses").select("author_id").eq("id", courseId).maybeSingle();
  const emittedBy = courseRow.data?.author_id ?? courseId;
  return withPooledModel(createOpenAIModelClient(), {
    pool: poolFor("creator"),
    cost: { supabase: admin, courseId, emittedBy, jobType: "escalation_dossier", runKey: candidateId },
  });
}

export const tutorEscalationSynthesize = inngest.createFunction(
  {
    id: "tutor-escalation-synthesize",
    concurrency: { key: "event.data.courseId", limit: 1 },
    triggers: [{ event: TUTOR_ESCALATION_CONSENTED_EVENT }],
  },
  async ({ event, step }) => {
    const { candidateId, courseId } = event.data as TutorEscalationConsentedData;

    return step.run("synthesize", async () => {
      if (!isAdminConfigured() || !process.env.OPENAI_API_KEY) {
        const result = { ok: false as const, checkpoint: "admin/model not configured" };
        console.log(JSON.stringify({ tag: "tutor_escalation_synthesize", candidateId, courseId, ...result }));
        return result;
      }
      const admin = createAdminClient();
      const model = await pooledModelForCandidate(admin, courseId, candidateId);
      const res = await synthesizeAndCluster(admin, model, candidateId);
      console.log(JSON.stringify({ tag: "tutor_escalation_synthesize", candidateId, courseId, ...res }));
      return res;
    });
  }
);

/** A consented candidate the nightly reconcile must synthesize (no dossier yet). */
interface PendingSynthesis {
  candidateId: string;
  courseId: string;
}

export const tutorEscalationReconcileNightly = inngest.createFunction(
  { id: "tutor-escalation-reconcile-nightly", triggers: [{ cron: "0 6 * * *" }] },
  async ({ step }) => {
    // (1) Select CONSENTED candidates lacking a dossier (the event may have been
    // lost — dev has no INNGEST_EVENT_KEY). Deterministic order → reproducible sweep.
    const pending = await step.run("select-pending", async (): Promise<PendingSynthesis[]> => {
      if (!isAdminConfigured()) return [];
      const admin = createAdminClient();
      const consented = await admin
        .from("tutor_escalation_candidates")
        .select("id, course_id")
        .eq("status", "consented");
      if (consented.error || !consented.data) return [];
      const withDossier = await admin.from("escalation_dossier").select("candidate_id");
      const done = new Set((withDossier.data ?? []).map((d) => d.candidate_id));
      const out: PendingSynthesis[] = [];
      for (const c of consented.data) {
        if (!done.has(c.id)) out.push({ candidateId: c.id, courseId: c.course_id });
      }
      out.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
      return out;
    });

    // (2) Synthesize each pending candidate (one step each → resumable partial
    // failure). Fail-benign on a missing key: clustering + raw persist still run;
    // only the Terra prose is skipped.
    let synthesized = 0;
    const modelReady = isAdminConfigured() && Boolean(process.env.OPENAI_API_KEY);
    for (let i = 0; i < pending.length; i++) {
      const { candidateId, courseId } = pending[i];
      const done = await step.run(`synthesize-${i}`, async () => {
        if (!isAdminConfigured()) return { ok: false as const, checkpoint: "admin not configured" };
        const admin = createAdminClient();
        // A key-less environment still clusters; the pooled model's embed/synthesize
        // no-op benignly (empty vector / empty summary) so the sweep never throws.
        const model = modelReady
          ? await pooledModelForCandidate(admin, courseId, candidateId)
          : withPooledModel(createOpenAIModelClient(), { pool: poolFor("creator") });
        const res = await synthesizeAndCluster(admin, model, candidateId);
        return res;
      });
      if (done.ok) synthesized += 1;
    }

    console.log(
      JSON.stringify({
        tag: "tutor_escalation_reconcile_nightly",
        pending: pending.length,
        synthesized,
      })
    );
    return { pending: pending.length, synthesized };
  }
);
