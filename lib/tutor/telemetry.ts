/**
 * Server-side emitter for tutor_model_call cost telemetry (TUTOR-1 Wave 1.1).
 *
 * Every AI-tutor model call (graph extraction, reconciliation, embedding, tutor
 * turn) records its token usage, computed USD cost, and latency onto the ONE
 * analytics pipeline — the SAME learning_events table, the SAME Zod contract,
 * the SAME admin-upsert discipline as lib/analytics/serverEmit.ts. Never a
 * parallel path.
 *
 * SERVER-emitted ONLY (admin client): the client batch schema excludes
 * tutor_model_call and the ingest RPC rejects any tutor_% row.
 *
 * Idempotency: clientEventId is DERIVED from the provider response id
 * (tutorEventId) — a re-emit for the same call upserts into the same
 * client_event_id and no-ops. Cost is computed in TS (computeCostUsd); a null
 * cost means the model was absent from the pricing table.
 *
 * NEVER throws: telemetry must not break a tutor turn or an extraction run. A
 * failed emit is logged and swallowed (mirrors emitServerEvent).
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { computeCostUsd } from "@/lib/ai/modelConfig";
import {
  buildTutorModelCallEvent,
  mapEventToColumns,
  type TutorJobType,
} from "@/lib/analytics/events";

type DB = SupabaseClient<Database>;

/**
 * Deterministic uuid from a provider response id — the retry-stable idempotency
 * key. Same technique as uuidFromSvixId (lib/comms/webhook.ts): sha256 over a
 * PURPOSE-PREFIXED name with uuid version/variant bits set, so the tutor purpose
 * prefix isolates these ids from any other deterministic-uuid usage.
 */
export function tutorEventId(providerResponseId: string): string {
  const hash = createHash("sha256")
    .update(`wisesel.tutor.v1:${providerResponseId}`)
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-derived)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface EmitTutorModelCallArgs {
  courseId: string;
  /** Null for a run with no learner (extraction/reconciliation). */
  learnerUserId?: string | null;
  jobType: TutorJobType;
  model: string;
  /** Responses-API usage: outputTokens ALREADY includes reasoning tokens. */
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
  latencyMs: number;
  /** Retry-stable: clientEventId = tutorEventId(providerResponseId). */
  providerResponseId: string;
  /** The acting principal stamped as the row's user_id — extraction runs pass
   *  the course author id. Distinct from learnerUserId (the attribution). */
  emittedBy: string;
}

/**
 * Emit one tutor_model_call cost-telemetry event. Computes the USD cost via
 * computeCostUsd (null for an unpriced model), builds the event with a
 * provider-derived idempotency key, and upserts through the serverEmit
 * discipline (onConflict client_event_id, ignoreDuplicates). Re-emits with the
 * same providerResponseId are no-ops by construction. NEVER throws.
 */
export async function emitTutorModelCall(
  admin: DB,
  args: EmitTutorModelCallArgs
): Promise<void> {
  try {
    const computedCostUsd = computeCostUsd(args.usage, args.model);
    const event = buildTutorModelCallEvent(
      {
        eventType: "tutor_model_call",
        courseId: args.courseId,
        learnerUserId: args.learnerUserId ?? null,
        jobType: args.jobType,
        model: args.model,
        inputTokens: args.usage.inputTokens,
        cachedInputTokens: args.usage.cachedTokens,
        outputTokens: args.usage.outputTokens,
        computedCostUsd,
        latencyMs: args.latencyMs,
      },
      { clientEventId: tutorEventId(args.providerResponseId) }
    );
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, args.emittedBy)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) {
      console.error("[tutor] cost telemetry emit failed", args.jobType, error.message);
    }
  } catch (err) {
    console.error("[tutor] cost telemetry emit failed", args.jobType, err);
  }
}
