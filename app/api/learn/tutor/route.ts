/**
 * POST /api/learn/tutor — the learner-facing AI-tutor endpoint (TUTOR-1 Wave 3,
 * W3.4). ONE route, four actions dispatched on `body.action`:
 *
 *   • 'turn'            → an interactive tutor turn, streamed as SSE (mirrors the
 *                          content-agent route's writer). ONE structured call this
 *                          wave — NO fake token deltas.
 *   • 'practice_answer' → record a graded practice answer (plain JSON).
 *   • 'self_report'     → record a self-reported understanding (plain JSON).
 *   • 'hint_request'    → record a hint request (plain JSON).
 *
 * The three discrete signals + the turn ALL pass the ONE access gate
 * (resolveTutorAccess): 'ok' | 'not_enrolled' | 'author_preview' | 'disabled'.
 * An author preview NEVER emits evidence + NEVER persists a transcript — it gets
 * a friendly message on the turn path and a no-op on the signal paths. The pooled
 * learner model + deterministic evidence ids live in lib/tutor/runtime/service.ts.
 *
 * Node.js runtime (the OpenAI SDK + admin client need it) + force-dynamic (never
 * cache a stream). The OpenAI key + the service-role key are server-only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient, getSessionUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import {
  resolveTutorAccess,
  loadTutorContext,
  runTutorTurnForRequest,
  recordPracticeAnswer,
  recordSelfReport,
  recordHintRequest,
  type TurnEnvelope,
  type TutorAccessKind,
} from "@/lib/tutor/runtime/service";
import { sendTutorEscalationConsented } from "@/lib/inngest/escalationEvents";

/* ─────────────────────────────── SSE helpers ────────────────────────────── */

type TutorSSEEvent =
  | { type: "queued"; position: number }
  | {
      type: "turn";
      payload: {
        prose: string;
        spans: unknown;
        citations: unknown;
        rung: number | null;
        practiceItems: unknown;
        escalationProposal: unknown;
        /** W6 · the consent-pending candidate id (present when the tutor raised an
         *  escalation this turn), so the consent card targets the right row. */
        escalationCandidateId: string | null;
        flags: string[];
      };
    }
  | { type: "error"; message: string }
  | { type: "done" };

function encodeSSE(event: TutorSSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** A one-event stream (used for the early typed-error / friendly-message paths on
 *  the turn action so the client's SSE reader still gets a clean turn+done). */
function singleEventStream(event: TutorSSEEvent): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(encodeSSE(event)));
      controller.enqueue(enc.encode(encodeSSE({ type: "done" })));
      controller.close();
    },
  });
}

/* ─────────────────────────────── request body ───────────────────────────── */

interface TutorRequestBody {
  action?: "turn" | "practice_answer" | "self_report" | "hint_request" | "escalate_consent";
  courseId?: string;
  publicationId?: string;
  version?: number;
  lessonId?: string | null;
  blockId?: string | null;
  slideId?: string | null;
  // turn
  message?: string;
  quizActive?: boolean;
  sessionFlags?: Record<string, unknown>;
  // evidence signals
  nodeId?: string;
  practiceItemRef?: string;
  attemptOrdinal?: number;
  evidenceCorrect?: boolean;
  hintRung?: number;
  stableKey?: string;
  key?: string;
  // escalate_consent (W6 · P6.1)
  candidateId?: string;
  finalQuestion?: string;
  consentAction?: "send" | "cancel";
}

/** A typed JSON error the client renders inline. */
function errorJson(kind: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: kind, message }, { status });
}

/** The friendly access-refusal messages (the turn path also SSE-streams these). */
const ACCESS_MESSAGE: Record<Exclude<TutorAccessKind, "ok">, string> = {
  not_enrolled: "Enroll in this course to chat with the tutor.",
  author_preview:
    "You're previewing your own course as its creator — the tutor answers here, but nothing you do is recorded as learner evidence.",
  disabled: "The tutor isn't available for this course yet.",
};

/* ─────────────────────────────── the route ──────────────────────────────── */

export async function POST(req: Request): Promise<Response> {
  await createClient(); // establishes the cookie-scoped session (learner-scoped reads)
  const user = await getSessionUser();
  if (!user) return errorJson("unauthorized", "Sign in to use the tutor.", 401);

  let body: TutorRequestBody;
  try {
    body = (await req.json()) as TutorRequestBody;
  } catch {
    return errorJson("invalid_json", "Invalid JSON body.", 400);
  }

  const action = body.action ?? "turn";
  const { courseId, publicationId, version } = body;
  if (!courseId || !publicationId || typeof version !== "number") {
    return errorJson("missing_envelope", "courseId, publicationId, and version are required.", 400);
  }

  const envelope: TurnEnvelope = {
    courseId,
    publicationId,
    version,
    lessonId: body.lessonId ?? null,
    blockId: body.blockId ?? null,
    slideId: body.slideId ?? null,
  };

  const admin = createAdminClient();
  const learnerClient = await createClient();

  // The ONE access gate — every action goes through it.
  const access = await resolveTutorAccess(admin, { userId: user.id, courseId });

  /* ── the discrete evidence signals (plain JSON) ── */
  if (action === "practice_answer" || action === "self_report" || action === "hint_request") {
    if (access.kind !== "ok") {
      // Author preview + not-enrolled + disabled all no-op (no evidence written);
      // report the access kind so the client can explain.
      return Response.json({ ok: true, access: access.kind, emitted: false });
    }
    if (!body.nodeId) return errorJson("missing_node", "nodeId is required.", 400);

    if (action === "practice_answer") {
      if (
        !body.practiceItemRef ||
        typeof body.attemptOrdinal !== "number" ||
        typeof body.evidenceCorrect !== "boolean"
      ) {
        return errorJson("invalid_practice", "practiceItemRef, attemptOrdinal, evidenceCorrect required.", 400);
      }
      const res = await recordPracticeAnswer(admin, {
        access,
        userId: user.id,
        envelope,
        nodeId: body.nodeId,
        practiceItemRef: body.practiceItemRef,
        attemptOrdinal: body.attemptOrdinal,
        evidenceCorrect: body.evidenceCorrect,
      });
      return Response.json({ ok: true, access: access.kind, emitted: res.emitted });
    }

    if (action === "self_report") {
      if (typeof body.evidenceCorrect !== "boolean" || !body.stableKey) {
        return errorJson("invalid_self_report", "evidenceCorrect and stableKey required.", 400);
      }
      const res = await recordSelfReport(admin, {
        access,
        userId: user.id,
        envelope,
        nodeId: body.nodeId,
        evidenceCorrect: body.evidenceCorrect,
        stableKey: body.stableKey,
      });
      return Response.json({ ok: true, access: access.kind, emitted: res.emitted });
    }

    // hint_request
    if (typeof body.hintRung !== "number" || !body.key) {
      return errorJson("invalid_hint", "hintRung and key required.", 400);
    }
    const res = await recordHintRequest(admin, {
      access,
      userId: user.id,
      envelope,
      nodeId: body.nodeId,
      hintRung: body.hintRung,
      practiceItemRef: body.practiceItemRef ?? null,
      key: body.key,
    });
    return Response.json({ ok: true, access: access.kind, emitted: res.emitted });
  }

  /* ── the escalation-consent transition (W6 · P6.1, plain JSON) ──
   *
   * The learner confirms (send) or declines (cancel) a tutor-raised escalation.
   * The write goes through the LEARNER client — the learner-own UPDATE RLS + the
   * relaxed status-only trigger (migration 20260806100000) permit the
   * consent_pending → consented transition to ALSO edit learner_question (the
   * exact payload the learner confirms). An author preview / not-enrolled caller
   * no-ops (no consent write, no event). The CONSENT INVARIANT holds: this never
   * opens the table to the creator — the consent transition itself is what P6.2's
   * synthesis reads to move the escalation into creator scope. */
  if (action === "escalate_consent") {
    if (access.kind !== "ok") {
      return Response.json({ ok: true, access: access.kind, consented: false });
    }
    if (!body.candidateId) return errorJson("missing_candidate", "candidateId is required.", 400);
    const consentAction = body.consentAction ?? "send";

    if (consentAction === "cancel") {
      const { error } = await learnerClient
        .from("tutor_escalation_candidates")
        .update({ status: "withdrawn" })
        .eq("id", body.candidateId)
        .eq("user_id", user.id)
        .eq("status", "consent_pending");
      if (error) return errorJson("consent_failed", error.message, 400);
      return Response.json({ ok: true, access: access.kind, consented: false, withdrawn: true });
    }

    // send: flip to consented + carry the final (possibly edited) question. The
    // learner-own RLS scopes the row; the relaxed trigger permits the question
    // edit ON THIS transition only.
    const finalQuestion = body.finalQuestion?.trim();
    if (!finalQuestion) return errorJson("missing_question", "finalQuestion is required to send.", 400);
    const { data, error } = await learnerClient
      .from("tutor_escalation_candidates")
      .update({
        status: "consented",
        learner_question: finalQuestion,
        consented_at: new Date().toISOString(),
      })
      .eq("id", body.candidateId)
      .eq("user_id", user.id)
      .eq("status", "consent_pending")
      .select("id, course_id")
      .maybeSingle();
    if (error) return errorJson("consent_failed", error.message, 400);
    if (!data) {
      // Row not found / already resolved (a terminal state) — nothing consented.
      return Response.json({ ok: true, access: access.kind, consented: false, alreadyResolved: true });
    }
    // Fire the FROZEN on-consent event for P6.2 (best-effort; the nightly reconcile
    // synthesizes any consented candidate whose dossier is missing).
    await sendTutorEscalationConsented({ candidateId: data.id, courseId: data.course_id });
    return Response.json({ ok: true, access: access.kind, consented: true });
  }

  /* ── the interactive turn (SSE) ── */
  if (!body.message || !body.message.trim()) {
    return errorJson("missing_message", "message is required for a turn.", 400);
  }

  // A non-'ok' access returns a typed JSON early-return streamed as SSE so the
  // client's turn reader still settles. author_preview + not_enrolled + disabled
  // all emit NOTHING (no model call, no persistence, no evidence).
  if (access.kind !== "ok") {
    return sseResponse(
      singleEventStream({ type: "error", message: ACCESS_MESSAGE[access.kind] })
    );
  }

  if (!isOpenAIConfigured()) {
    return sseResponse(
      singleEventStream({
        type: "error",
        message: "The tutor isn't configured. Add OPENAI_API_KEY on the server to enable it.",
      })
    );
  }

  // Belt-and-braces whole-turn deadline: compose the request abort with a hard
  // ceiling (the model's own timeout + 15s slack) so a wedged stream can't hang
  // the connection open. Aborting frees the pool slot in the decorator; nothing
  // assistant-side persists on an abort.
  const deadline = AbortSignal.timeout(TUTOR_MODELS.tutor_turn.timeoutMs + 15_000);
  const composed = AbortSignal.any([req.signal, deadline]);

  const context = await loadTutorContext(admin, courseId);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: TutorSSEEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(encodeSSE(event)));
        } catch {
          closed = true;
        }
      };

      // The pooled learner model — a `queued` event fires when a call WAITS on the
      // learner pool; cost telemetry rides the decorator (jobType tutor_turn).
      const model = withPooledModel(createOpenAIModelClient(), {
        pool: poolFor("learner"),
        onQueued: (position) => emit({ type: "queued", position }),
        cost: {
          supabase: admin,
          courseId,
          emittedBy: user.id,
          learnerUserId: user.id,
          jobType: "tutor_turn",
        },
      });

      try {
        const result = await runTutorTurnForRequest(
          { learnerClient, admin, model, signal: composed },
          {
            userId: user.id,
            envelope: { ...envelope, version },
            learnerMessage: body.message!,
            quizActive: body.quizActive,
            sessionFlags: body.sessionFlags,
            // access already resolved to 'ok' + context already loaded — pass both
            // to skip a re-read inside the service.
            access,
            context,
          }
        );

        if (!result.turn || !result.turn.ok || !result.turn.output) {
          emit({
            type: "error",
            message: result.turn?.error ?? "The tutor couldn't complete that turn. Please try again.",
          });
        } else {
          const out = result.turn.output;
          // ONE structured call this wave — the whole turn is emitted as a single
          // `turn` event (NO fake token deltas; streaming deltas land in a later wave).
          emit({
            type: "turn",
            payload: {
              prose: out.prose,
              spans: out.spans,
              citations: out.citations,
              rung: result.turn.rung,
              practiceItems: out.practiceItems ?? [],
              escalationProposal: out.escalationProposal ?? null,
              escalationCandidateId: result.turn.escalation?.candidateId ?? null,
              flags: result.turn.groundingFlags,
            },
          });
        }
      } catch (err) {
        // An abort (client disconnect or the deadline) closes the stream; the
        // decorator already freed the pool slot and nothing assistant-side wrote.
        const aborted = err instanceof Error && err.name === "AbortError";
        emit({
          type: "error",
          message: aborted ? "The turn was cancelled." : err instanceof Error ? err.message : "Tutor turn failed",
        });
      } finally {
        emit({ type: "done" });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // The client disconnected — the composed signal's req.signal fires, the
      // pooled call rejects, the pool slot frees. Nothing else to do.
    },
  });

  return sseResponse(stream);
}
