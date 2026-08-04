/**
 * Durable tutor concept-graph function (TUTOR-1 Wave 1.3).
 *
 *   tutorGraphExtract — on tutor/graph.extraction.requested: assemble the admin
 *     Supabase client + a semaphore-wrapped real OpenAI client (the maintenance-
 *     cron route's exact pattern) and run the extraction CORE
 *     (lib/tutor/graph/extraction.runGraphExtraction) inside ONE durable
 *     step.run. The core is internally resumable-enough via its own
 *     budget/checkpoint, so Wave 1 deliberately does NOT split into per-lesson
 *     steps. concurrency { key: event.data.courseId, limit: 1 } serializes runs
 *     of the same course; a different course runs in parallel.
 *
 * IDEMPOTENCY: a re-run (Inngest retry, or a duplicate requested event) is safe
 * because the core's stageExtractionResult SHORT-CIRCUITS on an existing pending
 * concept-graph change-set — it returns { ok:true, alreadyPending:true } and
 * stages nothing new. That's why one step.run is correct: re-executing the whole
 * step can't double-stage.
 *
 * NO MODEL KEY: with OPENAI_API_KEY unset the run returns
 * { ok:false, checkpoint:"model not configured" } WITHOUT throwing (the
 * maintenance-cron route treats a missing key the same way — it just 503s
 * instead; here we surface it as a benign step output so the durable run
 * settles rather than retrying a permanent misconfiguration).
 */

import { inngest } from "../client";
import {
  TUTOR_EXTRACTION_REQUESTED_EVENT,
  TUTOR_RECONCILIATION_REQUESTED_EVENT,
  type TutorExtractionRequestedData,
  type TutorReconciliationRequestedData,
} from "../tutorGraphEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { runGraphExtraction, type GraphExtractionResult } from "@/lib/tutor/graph/extraction";
import { runGraphReconciliation, type GraphReconciliationResult } from "@/lib/tutor/graph/reconcile";

/** The step's return shape: the full GraphExtractionResult, or a benign
 *  not-configured stub when the admin/model env is absent (never a throw). */
type ExtractStepResult =
  | GraphExtractionResult
  | { ok: false; checkpoint: string };

/** Same benign-stub contract for the reconciliation step. */
type ReconcileStepResult =
  | GraphReconciliationResult
  | { ok: false; checkpoint: string };

// NOTE: inngest 4.x's createFunction takes TWO args — (options, handler) — with
// the trigger inside options.triggers (the publish.ts convention). The directive's
// 3-arg `(config, {event}, handler)` shape is the older API; the trigger + concurrency
// live in the single options object here, which is the equivalent that typechecks.
export const tutorGraphExtract = inngest.createFunction(
  {
    id: "tutor-graph-extract",
    concurrency: { key: "event.data.courseId", limit: 1 },
    triggers: [{ event: TUTOR_EXTRACTION_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const { courseId, publicationId, runId } = event.data as TutorExtractionRequestedData;

    return step.run("extract", async (): Promise<ExtractStepResult> => {
      // Fail-benign, don't throw: a missing key/admin env is a permanent
      // misconfiguration — retrying it wastes durable executions. Settle the
      // run with a checkpoint the caller/telemetry can read (the maintenance
      // cron route makes the same call, returning 503 instead of retrying).
      if (!isAdminConfigured() || !process.env.OPENAI_API_KEY) {
        const result: ExtractStepResult = { ok: false, checkpoint: "model not configured" };
        console.log(
          JSON.stringify({ tag: "tutor_graph_extract", courseId, publicationId, runId, ...result })
        );
        return result;
      }

      const admin = createAdminClient();

      // Resolve the course author = the cost-telemetry principal (the decorator emits
      // one tutor_model_call per gated call, keyed `${runId}:${seq}` = retry-stable).
      const courseRow = await admin
        .from("courses")
        .select("author_id")
        .eq("id", courseId)
        .maybeSingle();
      const emittedBy = courseRow.data?.author_id ?? courseId;

      // W3.1 · D-2: route every model call (runTurn + embed) through the CREATOR pool
      // + the single cost interception point. runKey=runId makes the cost ids
      // deterministic so an Inngest step retry re-emits as a no-op.
      const model = withPooledModel(createOpenAIModelClient(), {
        pool: poolFor("creator"),
        cost: { supabase: admin, courseId, emittedBy, jobType: "graph_extraction", runKey: runId },
      });

      // The fate finding's run_id FK → agent_runs.id: the event's runId becomes
      // the run row's id. Idempotent (an Inngest retry upserts the same id) —
      // and the settled row is the auditable trail of what this run did.
      await admin
        .from("agent_runs")
        .upsert(
          { id: runId, course_id: courseId, trigger: "scheduled", status: "running" },
          { onConflict: "id", ignoreDuplicates: true }
        );

      const result = await runGraphExtraction(
        { supabase: admin, model },
        { courseId, publicationId, runId }
      );

      await admin
        .from("agent_runs")
        .update({
          status: result.ok ? "completed" : "failed",
          report: {
            kind: "graph_extraction",
            nodeCount: result.nodeCount,
            edgeCount: result.edgeCount,
            assumedPriorCount: result.assumedPriorCount,
            flags: result.flags,
            droppedEdges: result.droppedEdges,
            costUsd: result.usage.costUsd,
            checkpoint: result.checkpoint,
          },
        })
        .eq("id", runId);

      console.log(
        JSON.stringify({
          tag: "tutor_graph_extract",
          courseId,
          publicationId,
          runId,
          ok: result.ok,
          alreadyPending: result.alreadyPending ?? false,
          changeSetId: result.changeSetId,
          findingId: result.findingId,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          assumedPriorCount: result.assumedPriorCount,
          droppedEdges: result.droppedEdges,
          flags: result.flags,
          costUsd: result.usage.costUsd,
          checkpoint: result.checkpoint,
        })
      );
      return result;
    });
  }
);

/**
 * tutorGraphReconcile — on tutor/graph.reconciliation.requested: the exact mirror
 * of tutorGraphExtract, running the reconciliation CORE
 * (lib/tutor/graph/reconcile.runGraphReconciliation) in ONE durable step.
 * concurrency { key: event.data.courseId, limit: 1 } serializes runs of the same
 * course. IDEMPOTENT: the core short-circuits on an existing pending concept-graph
 * change-set, so re-executing the whole step can't double-stage. NO MODEL KEY ⇒ a
 * benign not-configured stub (never a throw), like the extract path.
 */
export const tutorGraphReconcile = inngest.createFunction(
  {
    id: "tutor-graph-reconcile",
    concurrency: { key: "event.data.courseId", limit: 1 },
    triggers: [{ event: TUTOR_RECONCILIATION_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const { courseId, publicationId, runId } = event.data as TutorReconciliationRequestedData;

    return step.run("reconcile", async (): Promise<ReconcileStepResult> => {
      if (!isAdminConfigured() || !process.env.OPENAI_API_KEY) {
        const result: ReconcileStepResult = { ok: false, checkpoint: "model not configured" };
        console.log(
          JSON.stringify({ tag: "tutor_graph_reconcile", courseId, publicationId, runId, ...result })
        );
        return result;
      }

      const admin = createAdminClient();

      // Resolve the course author = the cost principal (mirror the extract path).
      const courseRow = await admin
        .from("courses")
        .select("author_id")
        .eq("id", courseId)
        .maybeSingle();
      const emittedBy = courseRow.data?.author_id ?? courseId;

      // W3.1 · D-2: CREATOR pool + the single cost interception point. runTurn calls
      // emit under 'reconciliation'; the decorator forces embeds to 'embedding'.
      const model = withPooledModel(createOpenAIModelClient(), {
        pool: poolFor("creator"),
        cost: { supabase: admin, courseId, emittedBy, jobType: "reconciliation", runKey: runId },
      });

      // Mirror the extract path: mint/settle the agent_runs row (the fate
      // finding's run_id FK) with the event's runId as its id.
      await admin
        .from("agent_runs")
        .upsert(
          { id: runId, course_id: courseId, trigger: "scheduled", status: "running" },
          { onConflict: "id", ignoreDuplicates: true }
        );

      const result = await runGraphReconciliation(
        { supabase: admin, model },
        { courseId, publicationId, runId }
      );

      await admin
        .from("agent_runs")
        .update({
          status: result.ok ? "completed" : "failed",
          report: {
            kind: "graph_reconciliation",
            nodeCount: result.nodeCount,
            edgeCount: result.edgeCount,
            classified: result.classified,
            flags: result.flags,
            droppedEdges: result.droppedEdges,
            costUsd: result.usage.costUsd,
            checkpoint: result.checkpoint,
          },
        })
        .eq("id", runId);

      console.log(
        JSON.stringify({
          tag: "tutor_graph_reconcile",
          courseId,
          publicationId,
          runId,
          ok: result.ok,
          alreadyPending: result.alreadyPending ?? false,
          changeSetId: result.changeSetId,
          findingId: result.findingId,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          classified: result.classified,
          droppedEdges: result.droppedEdges,
          flags: result.flags,
          costUsd: result.usage.costUsd,
          checkpoint: result.checkpoint,
        })
      );
      return result;
    });
  }
);
