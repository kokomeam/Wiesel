/**
 * TUTOR-1 Amendment A2 (A2-3 / A2-11) — the early chain-id capture INTEGRATION
 * suite (live Supabase + a hand-built blocking fake model; no OpenAI key needed).
 * Self-provisions throwaway users each run. Requires SUPABASE_SERVICE_ROLE_KEY
 * (or SUPABASE_SECRET_KEY) — the tutor threads/turns are service-role writes.
 *
 * Proves A2-3 end-to-end: the provider response id is captured onto
 * tutor_threads.active_response_id the moment `response.created` (the `started`
 * event) arrives — BEFORE the first output token — and the in-flight state is
 * ALWAYS cleared on settle (A2-11), for both an ABORT and a normal completion.
 *
 *   AC-A2.abort (capture-before-token + abort clears + chain intact):
 *     • a fake model emits `started` with "resp-int-abort", then BLOCKS on a
 *       test-controlled gate (no output token produced yet);
 *     • the test polls tutor_threads until active_response_id === "resp-int-abort"
 *       — proving the write landed BEFORE any output token;
 *     • the test releases the gate with an AbortError throw;
 *     • assert: NO assistant tutor_turns row persisted; active_response_id AND
 *       active_stream_id are NULL after settle (the finally cleared them);
 *     • a SECOND normal turn (instant valid output) completes fine, persists its
 *       assistant row with response_id set (the conversation chain is intact).
 *
 *   AC-A2.happy (positive capture + completion clears):
 *     • during a normal turn the started capture lands; after completion the
 *       in-flight state is cleared and the assistant row carries a response_id.
 *
 * Run (AFTER the tutor migrations): `npx tsx scripts/verify-tutor-stream-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; pin IPv4-first (this dev machine's
// Clash setup resets IPv6 TLS before the handshake). Harmless everywhere else.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) — this network drops
 *  connections sporadically mid-run. */
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};

import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import type {
  ModelClient,
  ModelStreamEvent,
  ModelTurnParams,
  ModelTurnResult,
} from "@/lib/ai/modelClient";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import {
  runTutorTurnForRequest,
  ensureThread,
  type TurnEnvelope,
} from "@/lib/tutor/runtime/service";
import {
  GROUNDED_OPEN,
  GROUNDED_CLOSE,
  type TurnOutput,
} from "@/lib/tutor/runtime/outputContract";
import {
  makeTutorWireWiringState,
  wireModelEvent,
} from "@/app/api/learn/tutor/route";
import {
  encodeWireEvent,
  type TutorWireEvent,
} from "@/lib/tutor/runtime/sseProtocol";
import { createInMemoryStreamBuffer } from "@/lib/tutor/runtime/streamBuffer";
import { followStream } from "@/lib/tutor/runtime/streamResume";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

type DB = SupabaseClient<Database>;

const LUNA = TUTOR_MODELS.tutor_turn.model;

function loadEnv(): { url: string; anon: string; service?: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string }> {
  const email = `tutor-stream-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email };
}

/** Minimal publishable fixture: one module → one lesson → one 2-slide deck. */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lesson = createLesson("Lesson A", 0);
  lesson.blocks = [deck];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  return {
    id: courseId,
    title,
    description: "Tutor stream-state integration fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string): Promise<void> {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

/** A plain snapshot loader (bypasses getCachedSnapshot's Next.js unstable_cache). */
function makeSnapshotLoader(admin: DB): (publicationId: string) => Promise<{ snapshot: PublicationSnapshot }> {
  return async (publicationId: string) => {
    const { data, error } = await admin
      .from("course_publications")
      .select("snapshot")
      .eq("id", publicationId)
      .single();
    if (error || !data) throw new Error(`snapshot load: ${error?.message ?? "not found"}`);
    return { snapshot: PublicationSnapshotSchema.parse((data as { snapshot: unknown }).snapshot) };
  };
}

/** A valid grounded structured turn output (its citation resolves in the snapshot),
 *  so a completed turn validates ok. */
function validTurnText(citation: { lessonId: string; blockId: string }): string {
  const out: TurnOutput = {
    proseWithSpanMarkers: `${GROUNDED_OPEN}A wash stays transparent when the binder holds little pigment.${GROUNDED_CLOSE}`,
    citations: [{ lessonId: citation.lessonId, blockId: citation.blockId, slideId: null }],
    rung: 2,
    evidence: [],
    practiceItems: undefined,
    escalationProposal: null,
  };
  return JSON.stringify(out);
}

/**
 * A blocking fake ModelClient: its runTurn emits `started` with `startedId` FIRST
 * (before any output token), resolves `onStarted()` so the driver knows the emit
 * happened, then AWAITS `gate` — the test releases it either by RESOLVING it (the
 * model then returns the valid turn) or by making it REJECT (an aborted turn). The
 * started emit is synchronous; the block is on the gate, so no output token is ever
 * produced until release.
 */
function blockingModel(opts: {
  startedId: string;
  gate: Promise<void>;
  finalText: string;
  onStarted?: () => void;
}): ModelClient {
  return {
    model: LUNA,
    async runTurn(
      _params: ModelTurnParams,
      onEvent: (ev: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      onEvent({ type: "started", responseId: opts.startedId });
      opts.onStarted?.();
      await opts.gate; // BLOCK until the test releases (resolve = complete, reject = abort)
      onEvent({ type: "text_delta", delta: "…" });
      return { text: opts.finalText, toolCalls: [], finishReason: "stop", responseId: opts.startedId };
    },
  };
}

/** An INSTANT fake model: emits `started` then returns the valid turn — no block. */
function instantModel(opts: { startedId: string; finalText: string }): ModelClient {
  return {
    model: LUNA,
    async runTurn(
      _params: ModelTurnParams,
      onEvent: (ev: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      onEvent({ type: "started", responseId: opts.startedId });
      onEvent({ type: "text_delta", delta: "…" });
      return { text: opts.finalText, toolCalls: [], finishReason: "stop", responseId: opts.startedId };
    },
  };
}

/**
 * A STREAMING fake model: emits `started`, then `text_delta` chunks (the caller's
 * slices of a valid TurnOutput JSON) with a real `gapMs` delay between each, then
 * returns the reassembled full text. Mirrors a real provider streaming the
 * structured JSON token-by-token so the prose extractor + wire wiring exercise the
 * true code path. `onDelta` fires (with a wall-clock ms stamp) as each chunk is
 * emitted so the test can measure first-delta timing vs settle. */
function streamingModel(opts: {
  startedId: string;
  chunks: string[];
  gapMs: number;
}): ModelClient {
  return {
    model: LUNA,
    async runTurn(
      _params: ModelTurnParams,
      onEvent: (ev: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      onEvent({ type: "started", responseId: opts.startedId });
      for (const chunk of opts.chunks) {
        await new Promise((r) => setTimeout(r, opts.gapMs));
        onEvent({ type: "text_delta", delta: chunk });
      }
      return {
        text: opts.chunks.join(""),
        toolCalls: [],
        finishReason: "stop",
        responseId: opts.startedId,
        usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10, reasoningTokens: 0 },
      };
    },
  };
}

/** A model that THROWS a NON-abort error (a genuine model failure). The loop catches
 *  it and settles ok:false (never throws into the route). Proves A2-11 clears the
 *  in-flight state on the error path too. */
function throwingModel(opts: { startedId: string }): ModelClient {
  return {
    model: LUNA,
    async runTurn(
      _params: ModelTurnParams,
      onEvent: (ev: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      onEvent({ type: "started", responseId: opts.startedId });
      throw new Error("simulated model transport failure");
    },
  };
}

/** Slice a string into `n` roughly-even chunks (≥1). */
function sliceIntoChunks(s: string, n: number): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Read the two in-flight columns for a thread. */
async function readThreadState(
  admin: DB,
  threadId: string
): Promise<{ active_response_id: string | null; active_stream_id: string | null }> {
  const { data, error } = await admin
    .from("tutor_threads")
    .select("active_response_id, active_stream_id")
    .eq("id", threadId)
    .single();
  if (error || !data) throw new Error(`readThreadState: ${error?.message ?? "not found"}`);
  return { active_response_id: data.active_response_id, active_stream_id: data.active_stream_id };
}

/** Count assistant tutor_turns rows on a thread. */
async function countAssistantRows(admin: DB, threadId: string): Promise<number> {
  const { count, error } = await admin
    .from("tutor_turns")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .eq("role", "assistant");
  if (error) throw new Error(`countAssistantRows: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:stream:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor stream itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await admin.from("learning_events").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll (only the learner) ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;

    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId })
      .select("*")
      .single();
    check("learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    const lessonId = doc.modules[0].lessons[0].id;
    const envelope: TurnEnvelope = {
      courseId,
      publicationId: publication.id,
      version: publication.version,
      lessonId,
    };
    const loadSnapshot = makeSnapshotLoader(admin);
    const citation = { lessonId, blockId: doc.modules[0].lessons[0].blocks[0].id };
    const turnJson = validTurnText(citation);

    // Pre-create the thread so we can poll it while the FIRST turn is still blocked
    // (runTutorTurnForRequest reuses this exact row — same (user, course) unique key).
    const threadId = await ensureThread(admin, { userId: learner.userId, courseId });
    const stateBefore = await readThreadState(admin, threadId);
    check(
      "fresh thread starts with NULL in-flight state",
      stateBefore.active_response_id === null && stateBefore.active_stream_id === null,
      JSON.stringify(stateBefore)
    );

    /* ═══════════════ AC-A2.abort — capture-before-token, abort clears ═══════════ */
    console.log("\n# AC-A2.abort — the started id is written BEFORE any output token; abort clears; chain intact");

    // The gate the fake model blocks on. We REJECT it to simulate an abort mid-turn.
    let rejectGate!: (reason: unknown) => void;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectGate = reject;
    });
    let startedSeen = false;
    const abortModel = blockingModel({
      startedId: "resp-int-abort",
      gate,
      finalText: turnJson,
      onStarted: () => {
        startedSeen = true;
      },
    });

    // Fire the turn WITHOUT awaiting — it will block inside the model on the gate.
    const abortPromise = runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: abortModel, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "This one is blocked, then aborted." }
    );

    // Poll tutor_threads until active_response_id lands. Because the model has
    // produced NO output token (it's blocked on the gate), a captured id here proves
    // the write happened BEFORE any output token.
    let captured: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      const st = await readThreadState(admin, threadId);
      if (st.active_response_id === "resp-int-abort") {
        captured = st.active_response_id;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    check("the fake model emitted `started` (model reached the block)", startedSeen);
    check(
      "active_response_id === 'resp-int-abort' captured BEFORE any output token",
      captured === "resp-int-abort",
      `captured=${captured}`
    );

    // Release the gate with an AbortError → the model rejects → the loop settles
    // ok:false (NEVER THROWS) → the finally clears the in-flight state.
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    rejectGate(abortErr);
    const abortResult = await abortPromise;

    check(
      "the aborted turn settles NOT-ok with no assistant row",
      abortResult.turn !== null && abortResult.turn.ok === false && abortResult.persistedTurnIds.assistant === null,
      JSON.stringify({ ok: abortResult.turn?.ok, error: abortResult.turn?.error })
    );

    const assistantAfterAbort = await countAssistantRows(admin, threadId);
    check("NO assistant tutor_turns row was persisted for the aborted turn", assistantAfterAbort === 0, String(assistantAfterAbort));

    const stateAfterAbort = await readThreadState(admin, threadId);
    check(
      "after abort settle: active_response_id AND active_stream_id are NULL (the finally cleared them)",
      stateAfterAbort.active_response_id === null && stateAfterAbort.active_stream_id === null,
      JSON.stringify(stateAfterAbort)
    );

    /* ═══════════════ AC-A2.happy — a normal turn completes + clears ════════════ */
    console.log("\n# AC-A2.happy — a normal turn captures then completes: state cleared, assistant row carries response_id");

    const normalModel = instantModel({ startedId: "resp-int-ok", finalText: turnJson });
    const normalResult = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: normalModel, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "Now a normal turn on the SAME thread." }
    );

    check(
      "the normal turn is ok + REUSES the same thread + persists an assistant row",
      normalResult.turn?.ok === true &&
        normalResult.threadId === threadId &&
        typeof normalResult.persistedTurnIds.assistant === "string",
      JSON.stringify({ ok: normalResult.turn?.ok, sameThread: normalResult.threadId === threadId, error: normalResult.turn?.error })
    );

    const assistantRow = await admin
      .from("tutor_turns")
      .select("role, response_id")
      .eq("id", normalResult.persistedTurnIds.assistant!)
      .single();
    check(
      "the assistant row carries response_id (the completed-turn chain — A2-3 positive)",
      !assistantRow.error && assistantRow.data?.role === "assistant" && assistantRow.data?.response_id === "resp-int-ok",
      String(assistantRow.error?.message ?? JSON.stringify(assistantRow.data))
    );

    const stateAfterOk = await readThreadState(admin, threadId);
    check(
      "after completion the in-flight state is cleared (both NULL)",
      stateAfterOk.active_response_id === null && stateAfterOk.active_stream_id === null,
      JSON.stringify(stateAfterOk)
    );

    // The conversation chain is intact: exactly ONE assistant row exists (the abort
    // wrote none, the normal turn wrote one).
    const assistantTotal = await countAssistantRows(admin, threadId);
    check("exactly ONE assistant row on the thread (chain intact across the abort)", assistantTotal === 1, String(assistantTotal));

    /* ═══════════════ A2-6 — streamed deltas arrive BEFORE settle ═══════════════ */
    console.log("\n# A2-6 — a streaming model emits 5 text_delta chunks; the first display delta lands well before settle");

    // A valid TurnOutput whose FIRST field is the prose (with grounded markers so the
    // extractor strips them). Sliced into 5 chunks streamed with 30ms gaps.
    const streamOut: TurnOutput = {
      proseWithSpanMarkers: `${GROUNDED_OPEN}Streaming works when tokens arrive incrementally.${GROUNDED_CLOSE}`,
      citations: [{ lessonId, blockId: doc.modules[0].lessons[0].blocks[0].id, slideId: null }],
      rung: 2,
      evidence: [],
      practiceItems: undefined,
      escalationProposal: null,
    };
    const streamJson = JSON.stringify(streamOut);
    const GAP = 30;
    const chunks = sliceIntoChunks(streamJson, 5);
    check("fixture sliced into 5 streamed chunks", chunks.length === 5, String(chunks.length));

    const streamModel = streamingModel({ startedId: "resp-stream-6", chunks, gapMs: GAP });

    // Drive the REAL wiring: an onModelEvent that runs wireModelEvent (prose extractor
    // → wire frames), timestamping the first text_delta frame. This is the exact
    // per-event pipeline the route uses.
    const wireState = makeTutorWireWiringState(Date.now);
    const wireFrames: TutorWireEvent[] = [];
    let firstDeltaAt: number | null = null;
    const dispatchAt6 = Date.now();
    const streamResult = await runTutorTurnForRequest(
      {
        learnerClient: learner.client,
        admin,
        model: streamModel,
        loadSnapshot,
        streamId: "sid-a2-6",
        onModelEvent: (ev) => {
          const before = wireFrames.length;
          wireModelEvent(wireState, ev, wireFrames);
          // The first text_delta frame produced marks the first display token.
          if (firstDeltaAt === null) {
            for (let i = before; i < wireFrames.length; i++) {
              if (wireFrames[i].type === "text_delta") {
                firstDeltaAt = Date.now();
                break;
              }
            }
          }
        },
      },
      { userId: learner.userId, envelope, learnerMessage: "Stream me a reply." }
    );
    const settledAt6 = Date.now();

    check("the streamed turn completed ok", streamResult.turn?.ok === true, JSON.stringify({ error: streamResult.turn?.error }));
    check("a model_started wire frame was produced", wireFrames.some((f) => f.type === "model_started"));
    check("at least one text_delta wire frame was produced", wireFrames.some((f) => f.type === "text_delta"));
    check("a first_token wire frame was produced exactly once", wireFrames.filter((f) => f.type === "first_token").length === 1);
    // The reassembled display prose (concat of text_delta frames) is the marker-stripped prose.
    const displayProse = wireFrames.filter((f) => f.type === "text_delta").map((f) => (f as { delta: string }).delta).join("");
    check(
      "concatenated deltas == the marker-stripped prose",
      displayProse === "Streaming works when tokens arrive incrementally.",
      JSON.stringify(displayProse)
    );
    // The first display delta preceded settle by AT LEAST the artificial gap span
    // (5 chunks × 30ms of gaps means settle is ≥ ~120ms after dispatch; the first
    // delta lands after only the first gap(s), so first-delta << settle).
    check(
      "first display delta landed measurably before settle (≥ one gap of margin)",
      firstDeltaAt !== null && settledAt6 - firstDeltaAt >= GAP,
      `firstDeltaAt=${firstDeltaAt} settledAt=${settledAt6} margin=${firstDeltaAt !== null ? settledAt6 - firstDeltaAt : "n/a"}`
    );
    check("first delta arrived after dispatch (sanity)", firstDeltaAt !== null && firstDeltaAt >= dispatchAt6);

    /* ═══════════════ A2-7 — the buffer tee is gap/dup-free ══════════════════════ */
    console.log("\n# A2-7 — teeing every wire frame to an in-memory buffer; a mid-stream client-kill snapshot then a read-from-0 equals the full sequence exactly");

    const buffer = createInMemoryStreamBuffer();
    const teeStreamId = "sid-a2-7";
    // The full ordered sequence of ENCODED frames we emitted (the source of truth).
    const emittedEncoded: string[] = [];
    let clientKillSnapshot: string[] | null = null;

    const teeState = makeTutorWireWiringState(Date.now);
    const wireFramesTee: TutorWireEvent[] = [];
    const teeModel = streamingModel({ startedId: "resp-stream-7", chunks, gapMs: GAP });

    // Mirror the route's emit: turn_started first, then per-event frames, then the
    // settled turn frames + done. We tee EVERY frame to the buffer as it is emitted.
    const emit = async (ev: TutorWireEvent) => {
      const framed = encodeWireEvent(ev);
      emittedEncoded.push(framed);
      await buffer.append(teeStreamId, framed);
      // Simulate a client disconnect midway: snapshot the buffer after the first delta.
      if (clientKillSnapshot === null && ev.type === "text_delta") {
        const snap = await buffer.read(teeStreamId, 0);
        clientKillSnapshot = snap.frames.slice();
      }
    };

    await emit({ type: "turn_started", streamId: teeStreamId, ts: new Date().toISOString() });
    const teeResult = await runTutorTurnForRequest(
      {
        learnerClient: learner.client,
        admin,
        model: teeModel,
        loadSnapshot,
        streamId: teeStreamId,
        onModelEvent: (ev) => {
          const before = wireFramesTee.length;
          wireModelEvent(teeState, ev, wireFramesTee);
          for (let i = before; i < wireFramesTee.length; i++) void emit(wireFramesTee[i]);
        },
      },
      { userId: learner.userId, envelope, learnerMessage: "Tee this reply." }
    );
    // Settle frames (the turn + turn_completed + done), teed too.
    if (teeResult.turn?.ok && teeResult.turn.output) {
      const out = teeResult.turn.output;
      await emit({
        type: "turn",
        payload: {
          prose: out.prose,
          spans: out.spans,
          citations: out.citations,
          rung: teeResult.turn.rung,
          practiceItems: out.practiceItems ?? [],
          escalationProposal: out.escalationProposal ?? null,
          escalationCandidateId: teeResult.turn.escalation?.candidateId ?? null,
          flags: teeResult.turn.groundingFlags,
        },
      });
      await emit({
        type: "turn_completed",
        finishReason: "stop",
        durationMs: 1,
        usage: {
          inputTokens: teeResult.turn.usage?.inputTokens ?? null,
          outputTokens: teeResult.turn.usage?.outputTokens ?? null,
          cachedTokens: teeResult.turn.usage?.cachedTokens ?? null,
        },
      });
    }
    await emit({ type: "done" });
    await buffer.finalize(teeStreamId);

    check("the teed turn completed ok", teeResult.turn?.ok === true, JSON.stringify({ error: teeResult.turn?.error }));
    const killSnap: string[] = clientKillSnapshot ?? [];
    check("a mid-stream client-kill snapshot was captured", killSnap.length > 0);
    check(
      "the client-kill snapshot is a strict PREFIX of the full sequence (no gap/dup up to the kill)",
      killSnap.length > 0 && killSnap.every((f, i) => f === emittedEncoded[i])
    );

    // Read the buffer from 0 after settle: it must EXACTLY equal the full emitted
    // sequence, in order, and report finalized:true.
    const finalRead = await buffer.read(teeStreamId, 0);
    check(
      "buffer read-from-0 equals the full emitted frame sequence EXACTLY (no gap/dup)",
      finalRead.frames.length === emittedEncoded.length &&
        finalRead.frames.every((f, i) => f === emittedEncoded[i]),
      `buffer=${finalRead.frames.length} emitted=${emittedEncoded.length}`
    );
    check("buffer reports finalized:true after finalize", finalRead.finalized === true);

    /* ══════════ GET-resume — followStream replay + tail against the buffer ═══════ */
    console.log("\n# GET-resume — followStream replays from `from` then follows the live tail to finalization (the resume LOGIC, unit-proven)");

    // Replay from index 0 of the just-finalized buffer: every frame arrives once, in
    // order, and the loop returns 'finalized' immediately (no tail poll needed).
    const replayed: string[] = [];
    const outcomeAll = await followStream(buffer, teeStreamId, {
      from: 0,
      pollMs: 5,
      deadlineMs: 5_000,
      onFrame: (f) => {
        replayed.push(f);
      },
    });
    check("followStream returns 'finalized' on a finalized buffer", outcomeAll === "finalized");
    check(
      "followStream replays the full sequence VERBATIM from 0",
      replayed.length === emittedEncoded.length && replayed.every((f, i) => f === emittedEncoded[i])
    );

    // Replay from a mid-index (resume after the client dropped): only the tail arrives.
    const fromIdx = Math.max(1, Math.floor(emittedEncoded.length / 2));
    const tailOnly: string[] = [];
    const outcomeTail = await followStream(buffer, teeStreamId, {
      from: fromIdx,
      pollMs: 5,
      deadlineMs: 5_000,
      onFrame: (f) => {
        tailOnly.push(f);
      },
    });
    check("followStream from a mid-index returns 'finalized'", outcomeTail === "finalized");
    check(
      "followStream from a mid-index replays ONLY the tail (no earlier frames, no dup)",
      tailOnly.length === emittedEncoded.length - fromIdx &&
        tailOnly.every((f, i) => f === emittedEncoded[fromIdx + i])
    );

    // A live-tail follow: a buffer that is NOT yet finalized delivers late-appended
    // frames on a subsequent poll, then finalizes.
    const liveBuf = createInMemoryStreamBuffer();
    const liveSid = "sid-live-tail";
    await liveBuf.append(liveSid, "data: A\n\n");
    const liveFrames: string[] = [];
    // Append a second frame + finalize AFTER the first poll has run.
    setTimeout(() => {
      void (async () => {
        await liveBuf.append(liveSid, "data: B\n\n");
        await liveBuf.finalize(liveSid);
      })();
    }, 20);
    const liveOutcome = await followStream(liveBuf, liveSid, {
      from: 0,
      pollMs: 10,
      deadlineMs: 2_000,
      onFrame: (f) => {
        liveFrames.push(f);
      },
    });
    check("live-tail follow returns 'finalized' after the late frame lands", liveOutcome === "finalized");
    check("live-tail follow delivered both frames in order (A then B)", liveFrames.join("") === "data: A\n\ndata: B\n\n");

    /* ═══════ A2-11(b) — a MODEL ERROR clears the in-flight state ════════════════ */
    console.log("\n# A2-11(b) — a thrown (non-abort) model error settles ok:false and clears active_stream_id + active_response_id");
    // Count assistant rows BEFORE the error turn — the two streaming turns above each
    // persisted one (A2-6, A2-7) on top of AC-A2.happy's; A2-12's claim is that the
    // ERROR turn adds NONE (append-only: only a completed ok turn writes an assistant
    // row), so the count must be UNCHANGED across it.
    const assistantBeforeErr = await countAssistantRows(admin, threadId);
    const errModel = throwingModel({ startedId: "resp-err-11b" });
    const errResult = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: errModel, loadSnapshot, streamId: "sid-11b" },
      { userId: learner.userId, envelope, learnerMessage: "This one throws." }
    );
    check(
      "the error turn settles NOT-ok with no assistant row",
      errResult.turn !== null && errResult.turn.ok === false && errResult.persistedTurnIds.assistant === null,
      JSON.stringify({ ok: errResult.turn?.ok, error: errResult.turn?.error })
    );
    const stateAfterErr = await readThreadState(admin, threadId);
    check(
      "after a model error: active_response_id AND active_stream_id are NULL (finally cleared)",
      stateAfterErr.active_response_id === null && stateAfterErr.active_stream_id === null,
      JSON.stringify(stateAfterErr)
    );
    const assistantAfterErr = await countAssistantRows(admin, threadId);
    check(
      "A2-12 — the error turn persisted NO assistant row (count unchanged across it)",
      assistantAfterErr === assistantBeforeErr,
      `before=${assistantBeforeErr} after=${assistantAfterErr}`
    );

    /* ═══════ A2-11 — setActiveStream landed the stream id before dispatch ════════ */
    // The blocking-abort turn above ran WITHOUT a streamId; the streaming turns pass
    // one. Confirm the streamId path set the column while a fresh blocking turn is in
    // flight (parallels the response-id capture proof but for active_stream_id).
    console.log("\n# A2-11 — active_stream_id is set BEFORE the model dispatch (visible mid-flight)");
    let rejectGate2!: (reason: unknown) => void;
    const gate2 = new Promise<void>((_res, rej) => {
      rejectGate2 = rej;
    });
    // Consume the gate's rejection defensively so a timing race never surfaces an
    // unhandled AbortError (the model's own `await gate` also consumes it; this is a
    // belt-and-braces second consumer that swallows).
    gate2.catch(() => {});
    const blockModel2 = blockingModel({ startedId: "resp-sid-set", gate: gate2, finalText: turnJson });
    const sidToSet = "sid-set-before-dispatch";
    const blockPromise2 = runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: blockModel2, loadSnapshot, streamId: sidToSet },
      { userId: learner.userId, envelope, learnerMessage: "Block so we can see active_stream_id set." }
    );
    let sidCaptured: string | null = null;
    for (let i = 0; i < 100; i++) {
      const st = await readThreadState(admin, threadId);
      if (st.active_stream_id === sidToSet) {
        sidCaptured = st.active_stream_id;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    check("active_stream_id was set to the provided streamId BEFORE dispatch completed", sidCaptured === sidToSet, `captured=${sidCaptured}`);
    const abortErr2 = new Error("The operation was aborted");
    abortErr2.name = "AbortError";
    rejectGate2(abortErr2);
    await blockPromise2;
    const stateAfterSid = await readThreadState(admin, threadId);
    check("A2-11(c) — after the abort, active_stream_id is cleared to NULL", stateAfterSid.active_stream_id === null && stateAfterSid.active_response_id === null, JSON.stringify(stateAfterSid));
  } finally {
    await cleanup();
    console.log("\n# cleaned up course + tutor rows (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
