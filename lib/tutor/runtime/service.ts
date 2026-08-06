/**
 * TUTOR-1 Wave 3 (W3.4) — the tutor RUNTIME SERVICE: the deps-injected,
 * int-testable layer between the SSE route (`app/api/learn/tutor/route.ts`) and
 * the pure turn loop (`lib/tutor/runtime/loop.ts`).
 *
 * The route is thin: it authenticates, opens the stream, and forwards. THIS
 * module owns everything that touches the DB + the analytics/inngest side
 * effects around one turn:
 *
 *   • resolveTutorAccess  — the ONE gate. 'ok' | 'not_enrolled' |
 *     'author_preview' | 'disabled'. AUTHOR_PREVIEW NEVER EMITS EVIDENCE — every
 *     evidence fn takes the access kind and no-ops unless 'ok'.
 *   • ensureThread        — race-safe get-or-create (insert ignoreDuplicates → select).
 *   • persistLearnerTurn / persistAssistantTurn — the append-only transcript
 *     (assistant rows are admin-only; only COMPLETED turns persist — an abort
 *     writes nothing assistant-side).
 *   • emitTutorEvidence   — the turn's own tutor_inference payloads → the ONE
 *     analytics stream (+ ONE refold fire after ≥1 emission).
 *   • recordPracticeAnswer / recordSelfReport / recordHintRequest — the discrete
 *     learner-signal endpoints (each: access-gated, deterministic id, event +
 *     refold).
 *   • loadTutorContext    — the course's concept nodes/edges + charter row +
 *     settings, loaded once per request.
 *   • runTutorTurnForRequest — the orchestration: access → thread → persist
 *     learner turn → history → context → runTutorTurn → on ok: persist assistant
 *     turn + emit evidence → result.
 *
 * ── INVARIANTS ───────────────────────────────────────────────────────────────
 *  • DEPS-INJECTED: the model client + clock are seams (int tests pass the mock).
 *  • NEVER THROWS into the route on a swallow-able side effect — evidence/refold
 *    are best-effort (they mirror emitServerEvent).
 *  • EVIDENCE IS GATED ON ACCESS 'ok': an author preview or an un-enrolled caller
 *    can never write a learning_events row (the trust boundary of Wave 2).
 *  • DETERMINISTIC IDS: every evidence clientEventId is derived (tutorEvidenceId)
 *    so a retry upserts as a no-op.
 *  • IN-FLIGHT STATE DISCIPLINE (A2-3/A2-11): the main call's `started` event
 *    captures the provider response id onto tutor_threads.active_response_id BEFORE
 *    the first output token (best-effort, never throws); a try/finally around the
 *    turn + persistence ALWAYS clears active_stream_id + active_response_id, so
 *    completion, error, AND abort all leave the thread's in-flight state null.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import type { Database } from "@/lib/database.types";
import type { ModelClient, ModelStreamEvent } from "@/lib/ai/modelClient";
import {
  captureActiveResponseId,
  clearActiveStream,
  setActiveStream,
} from "@/lib/tutor/runtime/streamState";
import {
  buildTutorEvidenceEvent,
  mapEventToColumns,
  type TutorEvidenceServerEvent,
  type TutorInferencePayload,
} from "@/lib/analytics/events";
import { sendTutorMasteryRefoldRequested } from "@/lib/inngest/tutorMasteryEvents";
import type { EdgeLike } from "@/lib/tutor/mastery/queries";
import type { LessonConceptNode } from "./lessonContext";
import type { HistoryTurn } from "./history";
import { runTutorTurn, type RunTutorTurnCtx, type TutorTurnResult } from "./loop";

type DB = SupabaseClient<Database>;

/* ─────────────────────────────── access ─────────────────────────────────── */

export type TutorAccessKind = "ok" | "not_enrolled" | "author_preview" | "disabled";

export interface TutorAccess {
  kind: TutorAccessKind;
}

/** Does the tutor emit evidence for this access kind? ONLY an enrolled learner
 *  ('ok') — an author preview or an un-enrolled caller never writes evidence. */
export function emitsEvidence(access: TutorAccess): boolean {
  return access.kind === "ok";
}

/**
 * The ONE access gate. Order (fail-safe):
 *  1. settings row with enabled=false ⇒ 'disabled'; NO row ⇒ default ON, fall
 *     through (the tutor is ON BY DEFAULT — only an explicit opt-out disables).
 *  2. the caller is the course author → 'author_preview' (preview; NO evidence).
 *  3. an active/completed enrollment → 'ok'.
 *  4. otherwise → 'not_enrolled'.
 *
 * The author check precedes enrollment so a creator testing their own course
 * always previews (even if they also enrolled) — a preview must never emit
 * evidence for the creator.
 */
export async function resolveTutorAccess(
  admin: DB,
  args: { userId: string; courseId: string }
): Promise<TutorAccess> {
  const { userId, courseId } = args;

  // (1) settings gate — ON BY DEFAULT: only an explicit enabled=false disables;
  //     a missing row ⇒ on (fall through to author/enrollment).
  const { data: settings } = await admin
    .from("tutor_course_settings")
    .select("enabled")
    .eq("course_id", courseId)
    .maybeSingle();
  if (settings && settings.enabled === false) return { kind: "disabled" };

  // (2) author preview — the creator can always test their course (no evidence).
  const { data: course } = await admin
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (course?.author_id === userId) return { kind: "author_preview" };

  // (3) enrollment — an active or completed enrollment grants 'ok'.
  const { data: enrollment } = await admin
    .from("enrollments")
    .select("status")
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .in("status", ["active", "completed"])
    .maybeSingle();
  if (enrollment) return { kind: "ok" };

  return { kind: "not_enrolled" };
}

/* ─────────────────────────────── thread ─────────────────────────────────── */

/**
 * Get-or-create the (learner, course) thread, race-safe: insert with
 * ignoreDuplicates (the unique (user_id, course_id) makes a concurrent create a
 * no-op) THEN select. Admin-scoped — the route already gated access. Returns the
 * thread id.
 */
export async function ensureThread(
  admin: DB,
  args: { userId: string; courseId: string }
): Promise<string> {
  const { userId, courseId } = args;
  // Insert ignoring a duplicate (unique user+course); a concurrent create no-ops.
  const { error: insertErr } = await admin
    .from("tutor_threads")
    .upsert({ user_id: userId, course_id: courseId }, {
      onConflict: "user_id,course_id",
      ignoreDuplicates: true,
    });
  if (insertErr) throw new Error(`ensureThread(insert): ${insertErr.message}`);

  const { data, error } = await admin
    .from("tutor_threads")
    .select("id")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .single();
  if (error || !data) throw new Error(`ensureThread(select): ${error?.message ?? "not found"}`);
  return data.id;
}

/* ─────────────────────────────── envelope ───────────────────────────────── */

export interface TurnEnvelope {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId?: string | null;
  blockId?: string | null;
  slideId?: string | null;
}

/* ─────────────────────────────── transcript ─────────────────────────────── */

type TurnInsert = Database["public"]["Tables"]["tutor_turns"]["Insert"];

/**
 * Append a role='learner' turn. Admin-scoped (the route gated access already;
 * learner rows ride the admin client in this route). Returns the row id.
 */
export async function persistLearnerTurn(
  admin: DB,
  args: {
    threadId: string;
    userId: string;
    envelope: TurnEnvelope;
    content: string;
  }
): Promise<string> {
  const row: TurnInsert = {
    thread_id: args.threadId,
    user_id: args.userId,
    course_id: args.envelope.courseId,
    role: "learner",
    content: args.content,
    publication_id: args.envelope.publicationId,
    version: args.envelope.version,
    lesson_id: args.envelope.lessonId ?? null,
    block_id: args.envelope.blockId ?? null,
    slide_id: args.envelope.slideId ?? null,
  };
  const { data, error } = await admin.from("tutor_turns").insert(row).select("id").single();
  if (error || !data) throw new Error(`persistLearnerTurn: ${error?.message ?? "no id"}`);
  return data.id;
}

/**
 * Append the role='assistant' turn (service-role-only — no client policy can
 * forge it). Called ONLY on a COMPLETED turn: an abort persists nothing
 * assistant-side. grounding/rung/response_id ride the row. Returns the row id.
 */
export async function persistAssistantTurn(
  admin: DB,
  args: {
    threadId: string;
    userId: string;
    envelope: TurnEnvelope;
    content: string;
    grounding: unknown;
    rung: number | null;
    responseId: string | null;
  }
): Promise<string> {
  const row: TurnInsert = {
    thread_id: args.threadId,
    user_id: args.userId,
    course_id: args.envelope.courseId,
    role: "assistant",
    content: args.content,
    publication_id: args.envelope.publicationId,
    version: args.envelope.version,
    lesson_id: args.envelope.lessonId ?? null,
    block_id: args.envelope.blockId ?? null,
    slide_id: args.envelope.slideId ?? null,
    grounding: (args.grounding ?? {}) as TurnInsert["grounding"],
    rung: args.rung,
    response_id: args.responseId,
  };
  const { data, error } = await admin.from("tutor_turns").insert(row).select("id").single();
  if (error || !data) throw new Error(`persistAssistantTurn: ${error?.message ?? "no id"}`);
  return data.id;
}

/**
 * Replay a thread's turns (oldest → newest) into the loop's HistoryTurn[]. Reads
 * role + content + response_id; the loop's history layer bounds/collapses it.
 */
export async function loadThreadHistory(
  admin: DB,
  threadId: string,
  cap = 40
): Promise<HistoryTurn[]> {
  const { data, error } = await admin
    .from("tutor_turns")
    .select("role, content, response_id, created_at, grounding")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(cap);
  if (error) throw new Error(`loadThreadHistory: ${error.message}`);
  return (data ?? []).map((r) => ({
    role: r.role as HistoryTurn["role"],
    content: r.content,
    responseId: r.response_id,
    // createdAt + grounding feed the SESSION-state derivation (W3.5). The textual
    // history replay ignores them; session.ts reads createdAt (the window) and
    // grounding.sessionMarkers (the once-per-session behavior markers).
    createdAt: r.created_at,
    grounding: r.grounding,
  }));
}

/* ─────────────────────────────── evidence ids ───────────────────────────── */

/** Deterministic uuid (v5-style) from a purpose-prefixed name — the retry-stable
 *  idempotency key for evidence rows. Mirrors tutorEventId (telemetry.ts) with a
 *  distinct evidence purpose prefix, so evidence ids never collide with
 *  cost-telemetry ids. */
export function tutorEvidenceId(name: string): string {
  const hash = createHash("sha256").update(`wisesel.tutor-evidence.v1:${name}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-derived)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ─────────────────────────────── evidence emit ──────────────────────────── */

/** The course+publication envelope every tutor-evidence event carries inline
 *  (the tutor-evidence base — lessonId is the OPTIONAL, nullable join since a
 *  conversation spans lessons). */
function evidenceEnvelope(envelope: TurnEnvelope): {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
} {
  return {
    courseId: envelope.courseId,
    publicationId: envelope.publicationId,
    version: envelope.version,
    lessonId: envelope.lessonId ?? null,
  };
}

/** Best-effort upsert of one built tutor-evidence event through the serverEmit
 *  discipline (onConflict client_event_id, ignoreDuplicates). Never throws. */
async function upsertEvent(admin: DB, event: TutorEvidenceServerEvent, userId: string): Promise<void> {
  try {
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, userId)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) console.error("[tutor] evidence emit failed", event.eventType, error.message);
  } catch (err) {
    console.error("[tutor] evidence emit failed", event.eventType, err);
  }
}

/**
 * Emit the turn's own tutor_inference payloads → the ONE analytics stream, then
 * fire the refold ONCE if ≥1 event landed. Access-gated: a NON-'ok' access
 * emits NOTHING (author preview / not enrolled never write evidence). Each id is
 * deterministic (`evidence:{turnId}:{i}`), so a retry is a no-op.
 */
export async function emitTutorEvidence(
  admin: DB,
  args: {
    access: TutorAccess;
    userId: string;
    envelope: TurnEnvelope;
    turnId: string;
    inferences: TutorInferencePayload[];
  }
): Promise<{ emitted: number }> {
  if (!emitsEvidence(args.access) || args.inferences.length === 0) return { emitted: 0 };

  const base = evidenceEnvelope(args.envelope);
  let emitted = 0;
  for (let i = 0; i < args.inferences.length; i += 1) {
    const inf = args.inferences[i];
    const event = buildTutorEvidenceEvent(
      {
        ...base,
        eventType: "tutor_inference",
        nodeId: inf.nodeId,
        metadata: inf,
      },
      { clientEventId: tutorEvidenceId(`evidence:${args.turnId}:${i}`) }
    );
    await upsertEvent(admin, event, args.userId);
    emitted += 1;
  }
  if (emitted > 0) {
    await sendTutorMasteryRefoldRequested({ userId: args.userId, courseId: args.envelope.courseId });
  }
  return { emitted };
}

/* ─────────────────────── discrete learner-signal endpoints ───────────────── */

/**
 * Record a graded practice answer → one practice_answer event (+ refold).
 * Access-gated (non-'ok' → no-op). Deterministic id
 * `practice:{practiceItemRef}:{ordinal}` so a retry no-ops. Returns whether an
 * event was written.
 */
export async function recordPracticeAnswer(
  admin: DB,
  args: {
    access: TutorAccess;
    userId: string;
    envelope: TurnEnvelope;
    nodeId: string;
    practiceItemRef: string;
    attemptOrdinal: number;
    evidenceCorrect: boolean;
  }
): Promise<{ emitted: boolean }> {
  if (!emitsEvidence(args.access)) return { emitted: false };
  const event = buildTutorEvidenceEvent(
    {
      ...evidenceEnvelope(args.envelope),
      eventType: "practice_answer",
      nodeId: args.nodeId,
      practiceItemRef: args.practiceItemRef,
      attemptOrdinal: args.attemptOrdinal,
      evidenceCorrect: args.evidenceCorrect,
    },
    { clientEventId: tutorEvidenceId(`practice:${args.practiceItemRef}:${args.attemptOrdinal}`) }
  );
  await upsertEvent(admin, event, args.userId);
  await sendTutorMasteryRefoldRequested({ userId: args.userId, courseId: args.envelope.courseId });
  return { emitted: true };
}

/**
 * Record a self-reported understanding → one self_report event (+ refold).
 * Access-gated. Deterministic id `selfreport:{stableKey}`.
 */
export async function recordSelfReport(
  admin: DB,
  args: {
    access: TutorAccess;
    userId: string;
    envelope: TurnEnvelope;
    nodeId: string;
    evidenceCorrect: boolean;
    stableKey: string;
  }
): Promise<{ emitted: boolean }> {
  if (!emitsEvidence(args.access)) return { emitted: false };
  const event = buildTutorEvidenceEvent(
    {
      ...evidenceEnvelope(args.envelope),
      eventType: "self_report",
      nodeId: args.nodeId,
      evidenceCorrect: args.evidenceCorrect,
    },
    { clientEventId: tutorEvidenceId(`selfreport:${args.stableKey}`) }
  );
  await upsertEvent(admin, event, args.userId);
  await sendTutorMasteryRefoldRequested({ userId: args.userId, courseId: args.envelope.courseId });
  return { emitted: true };
}

/**
 * Record a hint request → one hint_request event (+ refold). Access-gated.
 * Deterministic id `hint:{turnId ?? key}:{rung}`.
 */
export async function recordHintRequest(
  admin: DB,
  args: {
    access: TutorAccess;
    userId: string;
    envelope: TurnEnvelope;
    nodeId: string;
    hintRung: number;
    practiceItemRef?: string | null;
    key: string;
  }
): Promise<{ emitted: boolean }> {
  if (!emitsEvidence(args.access)) return { emitted: false };
  const event = buildTutorEvidenceEvent(
    {
      ...evidenceEnvelope(args.envelope),
      eventType: "hint_request",
      nodeId: args.nodeId,
      hintRung: args.hintRung,
      practiceItemRef: args.practiceItemRef ?? null,
    },
    { clientEventId: tutorEvidenceId(`hint:${args.key}:${args.hintRung}`) }
  );
  await upsertEvent(admin, event, args.userId);
  await sendTutorMasteryRefoldRequested({ userId: args.userId, courseId: args.envelope.courseId });
  return { emitted: true };
}

/* ─────────────────────────────── context ────────────────────────────────── */

export interface TutorContext {
  conceptNodes: LessonConceptNode[];
  conceptEdges: EdgeLike[];
  charterRow: Database["public"]["Tables"]["tutor_course_settings"]["Row"] | null;
}

/**
 * Load the course's concept graph (ACTIVE nodes → LessonConceptNode[], edges →
 * EdgeLike[]) + the tutor_course_settings row (the charter). One admin read wave;
 * the loop consumes these. A course with no graph resolves to empty arrays (the
 * loop still runs — grounding just finds no anchors).
 */
export async function loadTutorContext(admin: DB, courseId: string): Promise<TutorContext> {
  const [nodesRes, edgesRes, settingsRes] = await Promise.all([
    admin
      .from("concept_nodes")
      .select("id, title, description, anchors, status")
      .eq("course_id", courseId)
      .eq("status", "active"),
    admin
      .from("concept_edges")
      .select("source_node_id, target_node_id, kind")
      .eq("course_id", courseId),
    admin.from("tutor_course_settings").select("*").eq("course_id", courseId).maybeSingle(),
  ]);
  if (nodesRes.error) throw new Error(`loadTutorContext(nodes): ${nodesRes.error.message}`);
  if (edgesRes.error) throw new Error(`loadTutorContext(edges): ${edgesRes.error.message}`);

  const conceptNodes: LessonConceptNode[] = (nodesRes.data ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    description: n.description ?? "",
    anchors: n.anchors,
  }));
  const conceptEdges: EdgeLike[] = (edgesRes.data ?? []).map((e) => ({
    sourceNodeId: e.source_node_id,
    targetNodeId: e.target_node_id,
    kind: e.kind,
  }));
  return {
    conceptNodes,
    conceptEdges,
    charterRow: settingsRes.data ?? null,
  };
}

/* ─────────────────────────────── orchestration ──────────────────────────── */

export interface RunTutorTurnForRequestDeps {
  /** Learner-scoped client (own mastery/queue/thread reads inside the loop). */
  learnerClient: DB;
  /** Admin/service client — thread + transcript + evidence writes. */
  admin: DB;
  /** ALREADY POOLED model client (the route wraps it via withPooledModel). */
  model: ModelClient;
  /** Abort seam — threaded into the loop's model calls. */
  signal?: AbortSignal;
  /** Wall-clock seam (deterministic tests). */
  nowIso?: string;
  /** Optional snapshot loader override (int tests inject a fixture). */
  loadSnapshot?: (publicationId: string) => Promise<{ snapshot: import("@/lib/course/publish/schemas").PublicationSnapshot }>;
  /** A2 Wave 2 — the streaming resume-buffer id for THIS turn. When provided, the
   *  thread's active_stream_id is set BEFORE the model dispatch (so a refresh right
   *  after send can find the in-flight stream); the try/finally already clears it. */
  streamId?: string | null;
  /** A2 Wave 2 — the route's per-event hook. EVERY normalized stream event of the
   *  main call is forwarded here (a hook throw is swallowed — it never kills the
   *  turn). The route feeds these to the prose extractor + the wire tee. */
  onModelEvent?: (ev: ModelStreamEvent) => void;
}

export interface RunTutorTurnForRequestArgs {
  userId: string;
  envelope: TurnEnvelope & { version: number };
  learnerMessage: string;
  quizActive?: boolean;
  sessionFlags?: Record<string, unknown>;
  /** Optional pre-resolved access + context (the route resolves both up-front for
   *  the early-return typed errors; passing them avoids a re-read). */
  access?: TutorAccess;
  context?: TutorContext;
}

export interface RunTutorTurnForRequestResult {
  access: TutorAccessKind;
  turn: TutorTurnResult | null;
  threadId: string | null;
  persistedTurnIds: { learner: string | null; assistant: string | null };
  evidenceEmitted: number;
}

/**
 * The full request orchestration for one interactive turn:
 *   access → thread → persist learner turn → history → context → runTutorTurn →
 *   on ok: persist assistant turn + emit evidence → result.
 *
 * A non-'ok' access short-circuits with the kind and no writes (the route already
 * returns the typed JSON; this guards the service being called directly). An
 * aborted / failed turn persists NO assistant row + emits NO evidence (only a
 * COMPLETED ok turn does). The learner turn IS persisted before the model runs
 * (the message is real regardless of the model's fate).
 */
export async function runTutorTurnForRequest(
  deps: RunTutorTurnForRequestDeps,
  args: RunTutorTurnForRequestArgs
): Promise<RunTutorTurnForRequestResult> {
  const access = args.access ?? (await resolveTutorAccess(deps.admin, {
    userId: args.userId,
    courseId: args.envelope.courseId,
  }));

  const empty = (): RunTutorTurnForRequestResult => ({
    access: access.kind,
    turn: null,
    threadId: null,
    persistedTurnIds: { learner: null, assistant: null },
    evidenceEmitted: 0,
  });

  // Only an enrolled learner ('ok') runs the model + persists a transcript. An
  // author preview runs NOTHING here (the route returns a friendly message); a
  // non-enrolled caller is refused. This keeps evidence + persistence gated.
  if (access.kind !== "ok") return empty();

  // (1) thread (race-safe get-or-create).
  const threadId = await ensureThread(deps.admin, {
    userId: args.userId,
    courseId: args.envelope.courseId,
  });

  // (1a) A2 Wave 2 — record the in-flight stream id BEFORE the model dispatch, so a
  //      client that refreshes right after send can read active_stream_id and rejoin.
  //      Best-effort (never throws); the try/finally below clears BOTH columns on
  //      every exit path. Only set when the route provided a streamId (a non-stream
  //      caller leaves the column untouched).
  if (deps.streamId) {
    await setActiveStream(deps.admin, { threadId, streamId: deps.streamId });
  }

  // (2) persist the learner turn FIRST (the message is real whatever the model does).
  const learnerTurnId = await persistLearnerTurn(deps.admin, {
    threadId,
    userId: args.userId,
    envelope: args.envelope,
    content: args.learnerMessage,
  });

  // (3) history (the tail BEFORE this turn's learner row — replay it, then drop
  //     the row we just wrote so it isn't echoed as history).
  const allHistory = await loadThreadHistory(deps.admin, threadId);
  const historyTurns = allHistory.slice(0, -1); // drop the just-written learner row

  // (4) context (concept graph + charter) — passed in by the route, else loaded.
  const context =
    args.context ?? (await loadTutorContext(deps.admin, args.envelope.courseId));

  // (5) run the pure loop.
  const ctx: RunTutorTurnCtx = {
    userId: args.userId,
    courseId: args.envelope.courseId,
    publicationId: args.envelope.publicationId,
    version: args.envelope.version,
    lessonId: args.envelope.lessonId ?? undefined,
    blockId: args.envelope.blockId ?? undefined,
    slideId: args.envelope.slideId ?? undefined,
    quizActive: args.quizActive,
    charterRow: context.charterRow,
    historyTurns,
    learnerMessage: args.learnerMessage,
    sessionFlags: args.sessionFlags,
  };
  // The turn + all post-turn persistence run inside a try/finally so the thread's
  // in-flight state (active_stream_id + active_response_id) is ALWAYS cleared —
  // completion, error, AND abort (A2-11). The onModelEvent hook captures the
  // provider response id the instant `started` lands, BEFORE any output token
  // (A2-3), fire-and-forget through the best-effort writer.
  //
  // ORDERING (A2-11 hazard): the capture write and the finally's clear write both
  // target the SAME columns. On a turn that fails INSTANTLY after `started` (a
  // throwing/aborting model), the fire-and-forget capture could otherwise land
  // AFTER the clear and re-set active_response_id. So we retain the in-flight
  // capture promise and AWAIT it in the finally BEFORE clearing — making the clear
  // the guaranteed-last write, so both columns end NULL on every exit path.
  let captureInFlight: Promise<void> = Promise.resolve();
  try {
    const turn = await runTutorTurn(
      {
        learnerClient: deps.learnerClient,
        serviceClient: deps.admin,
        model: deps.model,
        loadSnapshot: deps.loadSnapshot,
        conceptNodes: context.conceptNodes,
        conceptEdges: context.conceptEdges,
        nowIso: deps.nowIso,
        signal: deps.signal,
        onModelEvent: (ev) => {
          // Capture the provider response id the moment it opens (before any output
          // token). A null id (provider didn't surface one) has nothing to persist.
          // Retain the promise so the finally can order the clear AFTER it.
          if (ev.type === "started" && ev.responseId) {
            captureInFlight = captureActiveResponseId(deps.admin, { threadId, responseId: ev.responseId });
          }
          // A2 Wave 2 — forward EVERY event to the route's hook (prose extractor +
          // wire tee). A hook throw is swallowed: an external observer must never
          // kill the turn.
          if (deps.onModelEvent) {
            try {
              deps.onModelEvent(ev);
            } catch {
              /* external hook is best-effort */
            }
          }
        },
      },
      ctx
    );

    // (6) ONLY a completed, ok turn persists an assistant row + emits evidence. An
    //     abort/error settles turn.ok=false → nothing assistant-side is written.
    if (!turn.ok || !turn.output) {
      return {
        access: access.kind,
        turn,
        threadId,
        persistedTurnIds: { learner: learnerTurnId, assistant: null },
        evidenceEmitted: 0,
      };
    }

    const assistantTurnId = await persistAssistantTurn(deps.admin, {
      threadId,
      userId: args.userId,
      envelope: args.envelope,
      content: turn.output.prose,
      grounding: buildGrounding(turn),
      rung: turn.rung,
      responseId: turn.responseId,
    });

    const evidence = await emitTutorEvidence(deps.admin, {
      access,
      userId: args.userId,
      envelope: args.envelope,
      turnId: assistantTurnId,
      inferences: turn.evidence,
    });

    return {
      access: access.kind,
      turn,
      threadId,
      persistedTurnIds: { learner: learnerTurnId, assistant: assistantTurnId },
      evidenceEmitted: evidence.emitted,
    };
  } finally {
    // Order the clear AFTER any in-flight capture so the clear is the LAST write to
    // these columns (A2-11): a turn that fails instantly after `started` must not
    // have its capture land after the clear. captureInFlight is a best-effort writer
    // that never rejects, but guard anyway. Then clear on EVERY exit path.
    await captureInFlight.catch(() => {});
    await clearActiveStream(deps.admin, { threadId });
  }
}

/** The grounding jsonb persisted on the assistant row — the Wave-3 output
 *  contract (cited anchors + grounded/supplemental span map + flags) PLUS the
 *  W3.5 session markers (persisted so the NEXT turn's derived session state sees
 *  which once-per-session behaviors already fired this session). */
function buildGrounding(turn: TutorTurnResult): Record<string, unknown> {
  const out = turn.output;
  const grounding: Record<string, unknown> = {
    citations: out?.citations ?? [],
    spans: out?.spans ?? [],
    flags: turn.groundingFlags,
  };
  if (turn.sessionMarkers.length > 0) grounding.sessionMarkers = turn.sessionMarkers;
  return grounding;
}
