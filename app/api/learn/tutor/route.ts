/**
 * /api/learn/tutor — the learner-facing AI-tutor endpoint.
 *
 * POST — one route, five actions dispatched on `body.action`:
 *   • 'turn'            → an interactive tutor turn, STREAMED as SSE. A2 Wave 2:
 *                          real token deltas now flow (turn_started → model_started
 *                          → first_token → text_delta* → turn_completed|turn_aborted),
 *                          every frame TEE'd to the resume buffer, and the turn runs
 *                          to completion SERVER-SIDE even if the learner disconnects.
 *   • 'practice_answer' → record a graded practice answer (plain JSON).
 *   • 'self_report'     → record a self-reported understanding (plain JSON).
 *   • 'hint_request'    → record a hint request (plain JSON).
 *   • 'escalate_consent'→ the learner confirms/declines a tutor-raised escalation.
 *
 * GET — resume a mid-turn stream: replay the buffered frames for the (user, course)
 *   thread's active stream, then follow its live tail until finalized (A2 §2).
 *
 * The signals + the turn ALL pass the ONE access gate (resolveTutorAccess):
 * 'ok' | 'not_enrolled' | 'author_preview' | 'disabled'. An author preview NEVER
 * emits evidence + NEVER persists a transcript. The pooled learner model +
 * deterministic evidence ids live in lib/tutor/runtime/service.ts.
 *
 * Node.js runtime (the OpenAI SDK + admin client need it) + force-dynamic (never
 * cache a stream). The OpenAI key + the service-role key are server-only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// maxDuration covers TUTOR_STREAM_TIMEOUTS.totalMs (240s) + connection overhead —
// valid on Hobby (Fluid compute) and Pro. A streamed turn runs to completion
// server-side; the learner may disconnect without cancelling it.
export const maxDuration = 300;

import { createClient, getSessionUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
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
import type { ModelStreamEvent } from "@/lib/ai/modelClient";
import {
  TutorWireEventSchema,
  encodeWireEvent,
  type TutorWireEvent,
} from "@/lib/tutor/runtime/sseProtocol";
import { streamBufferFromEnv } from "@/lib/tutor/runtime/streamBuffer";
import { readActiveStream } from "@/lib/tutor/runtime/streamState";
import { createProseExtractor } from "@/lib/tutor/runtime/proseExtractor";
import { followStream } from "@/lib/tutor/runtime/streamResume";
import { TUTOR_STREAM_TIMEOUTS } from "@/lib/tutor/runtime/streamConfig";

/* ─────────────────────────────── SSE helpers ────────────────────────────── */

/** Frame + encode ONE wire event. The route emits ONLY through this (the old
 *  inline `TutorSSEEvent` union is gone — every frame is a `TutorWireEvent`). The
 *  legacy four frames (queued/turn/error/done) are byte-compatible with the pre-A2
 *  wire, so the current client keeps working (it ignores unknown types). */
function encodeSSE(event: TutorWireEvent): string {
  return encodeWireEvent(event);
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
 *  the turn action so the client's SSE reader still gets a clean error+done). */
function singleEventStream(event: TutorWireEvent): ReadableStream<Uint8Array> {
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

/** The default learner-visible copy when an irreversible-tier tool halts the turn
 *  (A2 · §7 copy standard: generic, sentence case, no terminal punctuation, no tool
 *  name in the text — the toolName rides the structured field). Dormant today (no
 *  tutor tool is irreversible), but wired + tested. */
const APPROVAL_REQUIRED_MESSAGE =
  "This action needs your approval before the tutor can continue";

/* ─────────────────────────────── the POST route ─────────────────────────── */

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

  // A non-'ok' access returns a typed error streamed as SSE so the client's turn
  // reader still settles. author_preview + not_enrolled + disabled all emit NOTHING
  // (no model call, no persistence, no evidence).
  if (access.kind !== "ok") {
    return sseResponse(singleEventStream({ type: "error", message: ACCESS_MESSAGE[access.kind] }));
  }

  if (!isOpenAIConfigured()) {
    return sseResponse(
      singleEventStream({
        type: "error",
        message: "The tutor isn't configured. Add OPENAI_API_KEY on the server to enable it.",
      })
    );
  }

  // ── ABORT COMPOSITION (A2 §2 invariant — read this carefully) ──────────────
  // The whole-turn deadline is the ONLY thing that aborts the turn. `req.signal`
  // is DELIBERATELY NOT in the composition: a learner disconnect must NOT stop the
  // turn — it runs to completion server-side (persistence + the resume-buffer tee
  // finish), so a client that refreshes can rejoin the finished stream. The chunk
  // watchdog (below) is the second abort source, folded in via one AbortController.
  const deadline = AbortSignal.timeout(TUTOR_STREAM_TIMEOUTS.totalMs);
  const watchdog = new AbortController();
  const composed = AbortSignal.any([deadline, watchdog.signal]);

  const context = await loadTutorContext(admin, courseId);
  const enc = new TextEncoder();

  // The resume buffer (null when Upstash is unconfigured — streaming still works,
  // only mid-turn RESUME is unavailable). Resolved once per request.
  const buffer = streamBufferFromEnv();

  // The stream id for this turn — the resume handle a reconnecting client rejoins.
  const streamId = crypto.randomUUID();

  const dispatchAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let textDeltaCount = 0;

      // ── the chunk watchdog ──────────────────────────────────────────────────
      // A provider can open a stream then stall. We arm a timer per model event; if
      // no event arrives for chunkMs while the model call is in flight, we abort the
      // turn with a distinguishable reason so the wire settles turn_aborted
      // {reason:"stalled"}. Disarmed when the turn settles.
      let watchTimer: ReturnType<typeof setTimeout> | null = null;
      let stalled = false;
      const disarmWatchdog = () => {
        if (watchTimer) {
          clearTimeout(watchTimer);
          watchTimer = null;
        }
      };
      const armWatchdog = () => {
        disarmWatchdog();
        watchTimer = setTimeout(() => {
          stalled = true;
          watchdog.abort();
        }, TUTOR_STREAM_TIMEOUTS.chunkMs);
      };

      // ── emit: HTTP leg + buffer tee ─────────────────────────────────────────
      // Every frame goes to the (still-open) HTTP controller AND the resume buffer.
      // The HTTP enqueue no-ops after the client closed (the tee keeps receiving —
      // the turn runs to completion regardless). Buffer failures are logged, never
      // thrown (Redis down must not kill a turn).
      const emit = (event: TutorWireEvent) => {
        const framed = encodeSSE(event);
        if (!closed) {
          try {
            controller.enqueue(enc.encode(framed));
          } catch {
            closed = true; // the HTTP leg closed; keep teeing to the buffer
          }
        }
        if (buffer) {
          void buffer.append(streamId, framed).catch((err) => {
            console.log(JSON.stringify({ tag: "tutor_stream_buffer", op: "append", error: String(err) }));
          });
        }
      };

      // ── the prose extractor: raw structured-JSON deltas → display prose ──────
      const extractor = createProseExtractor();
      let firstTokenEmitted = false;

      const onModelEvent = (ev: ModelStreamEvent) => {
        // Re-arm the stall watchdog on EVERY event (the stream is alive).
        armWatchdog();
        if (ev.type === "started") {
          emit({ type: "model_started", responseId: ev.responseId });
          return;
        }
        if (ev.type === "text_delta") {
          const display = extractor.push(ev.delta);
          if (display.length === 0) return;
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            emit({ type: "first_token", ttftMs: Math.max(0, Date.now() - dispatchAt) });
          }
          emit({ type: "text_delta", delta: display });
          textDeltaCount += 1;
        }
        // tool_call / error events are not surfaced as their own wire frames here —
        // the settled turn (or a turn_aborted) carries the outcome.
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

      // (1) Open the turn on the wire immediately (the resume handle rides here).
      emit({ type: "turn_started", streamId, ts: new Date().toISOString() });
      armWatchdog();

      try {
        const result = await runTutorTurnForRequest(
          { learnerClient, admin, model, signal: composed, streamId, onModelEvent },
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
        disarmWatchdog();
        extractor.done();

        // (5) An irreversible-tier tool halted the loop → approval_required INSTEAD
        //     of a turn frame (the other agent's `approvalRequired` field). Dormant
        //     today (no tutor tool is irreversible), but wired + tested.
        if (result.turn?.approvalRequired) {
          emit({
            type: "approval_required",
            toolName: result.turn.approvalRequired.toolName,
            message: APPROVAL_REQUIRED_MESSAGE,
          });
        } else if (!result.turn || !result.turn.ok || !result.turn.output) {
          // (4) A failed/aborted turn. If the watchdog stalled it OR the turn was
          //     aborted, settle turn_aborted with the count of deltas we emitted;
          //     otherwise a plain error frame (unchanged payload).
          const errText =
            result.turn?.error ?? "The tutor couldn't complete that turn. Please try again.";
          const aborted = stalled || isAbortError(errText);
          emit({ type: "error", message: aborted ? abortMessage(stalled) : errText });
          if (aborted) {
            emit({
              type: "turn_aborted",
              reason: stalled ? "stalled" : "aborted",
              tokensEmitted: textDeltaCount,
            });
          }
        } else {
          // (3) The settled turn — the validated grounded spans/citations. The FULL
          //     `turn` frame is unchanged (the client renders it authoritatively over
          //     the streamed deltas), followed by turn_completed lifecycle + done.
          const out = result.turn.output;
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
          emit({
            type: "turn_completed",
            finishReason: "stop",
            durationMs: Math.max(0, Date.now() - dispatchAt),
            usage: {
              // The loop surfaces aggregate usage; the wire carries it when present.
              inputTokens: result.turn.usage?.inputTokens ?? null,
              outputTokens: result.turn.usage?.outputTokens ?? null,
              cachedTokens: result.turn.usage?.cachedTokens ?? null,
            },
          });
        }
      } catch (err) {
        // runTutorTurnForRequest never throws on a model failure (it settles
        // turn.ok=false), so reaching here is a genuinely thrown error (or the
        // deadline abort). Treat an abort as turn_aborted; else a plain error.
        disarmWatchdog();
        extractor.done();
        const aborted = stalled || (err instanceof Error && err.name === "AbortError");
        emit({ type: "error", message: aborted ? abortMessage(stalled) : errText(err) });
        if (aborted) {
          emit({ type: "turn_aborted", reason: stalled ? "stalled" : "aborted", tokensEmitted: textDeltaCount });
        }
      } finally {
        disarmWatchdog();
        emit({ type: "done" });
        closed = true;
        // Finalize the resume buffer — no more frames will arrive for this stream.
        if (buffer) {
          void buffer.finalize(streamId).catch((err) => {
            console.log(JSON.stringify({ tag: "tutor_stream_buffer", op: "finalize", error: String(err) }));
          });
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // A2 §2 INVARIANT: the client disconnected. This must NOT abort the turn — we
      // ONLY mark the HTTP leg closed so `emit` stops enqueueing to a dead
      // controller. The turn keeps running server-side (persistence + the buffer tee
      // complete), so a refresh can rejoin the finished stream via GET. Do NOT call
      // watchdog.abort() or otherwise cancel the turn here.
    },
  });

  return sseResponse(stream);
}

/* ─────────────────────────────── the GET route (resume) ─────────────────── */

/**
 * Resume a mid-turn stream. Same auth as POST (requireUser → resolveTutorAccess ok).
 * Reads the (user, course) thread's active stream id; replays the buffered frames
 * from `?from` (default 0) VERBATIM (they are already SSE-encoded), then follows the
 * live tail until finalized or the total deadline. 204 when there is nothing to
 * resume (no active stream, or no resume buffer configured).
 */
export async function GET(req: Request): Promise<Response> {
  await createClient();
  const user = await getSessionUser();
  if (!user) return errorJson("unauthorized", "Sign in to use the tutor.", 401);

  const url = new URL(req.url);
  const courseId = url.searchParams.get("courseId");
  if (!courseId) return errorJson("missing_course", "courseId is required.", 400);
  const from = Math.max(0, Number.parseInt(url.searchParams.get("from") ?? "0", 10) || 0);

  const admin = createAdminClient();
  const access = await resolveTutorAccess(admin, { userId: user.id, courseId });
  if (access.kind !== "ok") return errorJson("forbidden", "You can't resume this stream.", 403);

  // No resume buffer configured ⇒ nothing to replay (dev degrade). 204 = the client
  // falls back to a fresh connection.
  const buffer = streamBufferFromEnv();
  if (!buffer) return new Response(null, { status: 204 });

  const active = await readActiveStream(admin, { userId: user.id, courseId });
  if (!active || !active.streamId) return new Response(null, { status: 204 });
  const streamId = active.streamId;

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const onFrame = (frame: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(frame));
        } catch {
          closed = true;
        }
      };
      try {
        // followStream replays from `from`, then polls the live tail until finalized
        // or the total deadline. Frames are forwarded VERBATIM — they are already the
        // encoded SSE bytes the POST leg wrote, so replay is gap/dup-free by
        // construction (the buffer's nextIndex drives the cursor).
        await followStream(buffer, streamId, {
          from,
          pollMs: 400,
          deadlineMs: TUTOR_STREAM_TIMEOUTS.totalMs,
          onFrame,
        });
      } catch (err) {
        console.log(JSON.stringify({ tag: "tutor_stream_resume", error: String(err) }));
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // The resuming client left — nothing to clean up (the ORIGINAL turn owns the
      // buffer + persistence; this GET is a read-only follower).
    },
  });

  return sseResponse(stream);
}

/* ─────────────────────────────── small helpers ──────────────────────────── */

/** Whether an error string names an abort (the loop stringifies the AbortError). */
function isAbortError(text: string): boolean {
  return /abort/i.test(text);
}

/** The learner-visible abort copy (§7: sentence case, no terminal punctuation). */
function abortMessage(stalled: boolean): string {
  return stalled
    ? "The tutor went quiet and the turn was stopped — please try again"
    : "The turn was cancelled";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "Tutor turn failed";
}

/* ─────────────────────────────── wire-wiring helper (test seam) ──────────── */

/**
 * The per-event wiring used by the POST stream, extracted as a PURE helper so the
 * int suite drives the REAL wiring (prose extractor → wire frames) without a live
 * ReadableStream/HTTP leg. Given an event and a small mutable state bag, it appends
 * the wire frames that event produces (model_started / first_token / text_delta) to
 * `out`. `dispatchAt` seeds first_token's ttft. Mirrors `onModelEvent` above; kept
 * in sync by review (both feed the same extractor + emit the same variants).
 */
export interface TutorWireWiringState {
  extractor: ReturnType<typeof createProseExtractor>;
  dispatchAt: number;
  firstTokenEmitted: boolean;
  textDeltaCount: number;
  now: () => number;
}

export function makeTutorWireWiringState(now: () => number = Date.now): TutorWireWiringState {
  return {
    extractor: createProseExtractor(),
    dispatchAt: now(),
    firstTokenEmitted: false,
    textDeltaCount: 0,
    now,
  };
}

export function wireModelEvent(
  state: TutorWireWiringState,
  ev: ModelStreamEvent,
  out: TutorWireEvent[]
): void {
  if (ev.type === "started") {
    out.push({ type: "model_started", responseId: ev.responseId });
    return;
  }
  if (ev.type === "text_delta") {
    const display = state.extractor.push(ev.delta);
    if (display.length === 0) return;
    if (!state.firstTokenEmitted) {
      state.firstTokenEmitted = true;
      out.push({ type: "first_token", ttftMs: Math.max(0, state.now() - state.dispatchAt) });
    }
    out.push({ type: "text_delta", delta: display });
    state.textDeltaCount += 1;
  }
}

// Ensure the wire union import is referenced even if the wiring helper is tree-shaken
// in a build without the int suite (the schema is used by the route emission above).
void TutorWireEventSchema;
