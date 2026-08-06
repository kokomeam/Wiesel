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
