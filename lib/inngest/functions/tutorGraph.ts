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
  type TutorExtractionRequestedData,
} from "../tutorGraphEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withSemaphore } from "@/lib/ai/subagent";
import { runGraphExtraction, type GraphExtractionResult } from "@/lib/tutor/graph/extraction";

/** The step's return shape: the full GraphExtractionResult, or a benign
 *  not-configured stub when the admin/model env is absent (never a throw). */
type ExtractStepResult =
  | GraphExtractionResult
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
      const model = withSemaphore(createOpenAIModelClient());
      const result = await runGraphExtraction(
        { supabase: admin, model },
        { courseId, publicationId, runId }
      );

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
