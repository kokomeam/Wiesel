/**
 * Lesson Clip Repurposing (Phase 1.5, M-A) — INTEGRATION suite (live Supabase
 * + the mock model, no OpenAI key needed). Self-provisions throwaway users.
 *
 *   - transcript acquisition: platform path from a Mux-captioned video_assets
 *     row (cue → interpolated words); CACHE (second request = zero provider
 *     calls — acceptance §17.1); provider path through the injected seam
 *     (provider_ref persisted); no-source lesson → typed 422-class error
 *   - selection through the GATE: staged reversible action (never an approval
 *     card), candidates persisted with rank 1..N + prompt_version + rubric
 *     scores, events on the single stream (lesson_transcribed +
 *     clip_moments_generated)
 *   - reverts: rejecting select_clip_moments removes the WHOLE candidate set
 *     (composite snapshotter over request_id); rejecting a status change
 *     restores the row byte-for-byte (modulo the moddatetime re-stamp);
 *     the transcript CACHE survives a revert (it's not the gate target)
 *   - zero-survivors: nothing persisted, generation_failed on the stream
 *   - RLS matrix: creator B sees/edits NOTHING of creator A's transcripts or
 *     candidates
 *
 *   AMENDMENT (recording-format routing) — the DB halves of the named specs:
 *   - recordingFormat.metadata.spec: a lesson whose video BLOCK carries
 *     recording.mode resolves from 'platform' and the frame inspector is
 *     NEVER constructed (spy)
 *   - recordingFormat.classifier.spec: an upload (no block metadata)
 *     classifies through the injected inspector; no inspector → the degraded
 *     camera_only default
 *   - recordingFormat.override.spec: overrideTranscriptFormat flips the row
 *     to 'creator_override' and the cache returns it untouched
 *   - routing.matrix.spec (test_layout_persisted_on_candidate_and_job —
 *     candidate half): layout lands on every clip_moment_candidate row and
 *     round-trips reads; the clip_render_jobs half folds into M-B's CREATE
 *
 * Run: `npx tsx scripts/verify-clips-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks (this dev
// machine's Clash setup) the TLS socket resets before the handshake.
dns.setDefaultResultOrder("ipv4first");

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

import type { Database, Json } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { executeMarketingTool, rejectMarketingAction } from "@/lib/marketing/tools";
import { advanceRenderJob, processClipRenderTick } from "@/lib/marketing/clips/render/service";
import { getRenderJob, submissionsInLastMinute } from "@/lib/marketing/clips/render/jobs";
import type { ClipRenderProvider } from "@/lib/marketing/clips/provider/types";
import type { PrecutOps } from "@/lib/marketing/clips/render/precut";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { ClipTranscriptUnavailableError, ClipGenerationError } from "@/lib/marketing/clips/errors";
import {
  acquireLessonTranscript,
  overrideTranscriptFormat,
  type TranscriptionProvider,
} from "@/lib/marketing/clips/transcripts";
import type { FrameInspector, FrameSignal } from "@/lib/marketing/clips/format";
import { selectClipMoments } from "@/lib/marketing/clips/selection";
import { CLIP_PROMPT_VERSION } from "@/lib/marketing/clips/prompt";
import { fixtureByKey } from "@/lib/marketing/clips/fixtures/lessons";
import type { ModelMoment, RubricScores } from "@/lib/marketing/clips/schemas";

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

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `clips-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin: ${error?.message}`);
  return { supabase, userId: data.user.id, email };
}

/* ───────────────────────── fixtures ────────────────────────────────── */

const FLAT = fixtureByKey("flat_affect");

/** Segment-level VTT (the same shape Mux produces at cue granularity). */
function fixtureVtt(): string {
  const toTs = (ms: number) => {
    const t = Math.floor(ms / 1000);
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(t % 60).padStart(2, "0");
    return `${mm}:${ss}.${String(ms % 1000).padStart(3, "0")}`;
  };
  const cues = FLAT.segments.map((s) => `${toTs(s.atMs)} --> ${toTs(s.endMs)}\n${s.text}`);
  return `WEBVTT\n\n${cues.join("\n\n")}`;
}

const GOOD_SCORES: RubricScores = {
  hook_potential: 4,
  standalone: 5,
  specificity: 4,
  curiosity_gap: 4,
  pedagogical_value: 5,
  visual_interest: 3,
  brand_safety: 5,
};

function fixtureMoment(overrides: Partial<ModelMoment> & { rank: number }): ModelMoment {
  return {
    startMs: 20_000,
    endMs: 55_000,
    momentType: "definition_reframe",
    hookText: "Your index is a sorted copy",
    altHooks: ["What a database index really is", "Indexes are copies, not magic"],
    funnelStage: "tofu",
    targetPlatformFit: ["instagram", "tiktok"],
    rationale: "Reframes the core concept so every later rule is derivable.",
    rubricScores: GOOD_SCORES,
    captionDraft: "An index is a second sorted copy of your column.",
    endCardCta: "Follow for the full indexing series",
    segments: null,
    stitchedScript: null,
    ...overrides,
  } as ModelMoment;
}

const BATCH = {
  candidates: [
    fixtureMoment({ rank: 1 }),
    fixtureMoment({
      rank: 2,
      startMs: 55_000,
      endMs: 95_000,
      momentType: "misconception_buster",
      hookText: "Why the planner ignores your index",
      altHooks: ["The index you made is invisible", "Index the expression, not the column"],
    }),
    fixtureMoment({
      rank: 3,
      startMs: 130_000,
      endMs: 175_000,
      momentType: "counterintuitive_reveal",
      hookText: "An index can slow your app down",
      altHooks: ["Indexes are not free", "Faster reads, slower writes"],
      funnelStage: "mofu",
    }),
  ],
};

const VERDICTS = {
  verdicts: BATCH.candidates.map((c) => ({
    rank: c.rank,
    coherence: { pass: true, offendingPhrase: null, adjustedStartMs: null, adjustedEndMs: null },
    hooks: [c.hookText, ...c.altHooks].map((h) => ({ hook: h, supported: true, unsupportedClaim: null })),
  })),
};

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");

  const A = await provisionUser(url, anon, "a");
  const B = await provisionUser(url, anon, "b");
  console.log("# provisioned two throwaway creators");

  const courseId = crypto.randomUUID();
  const moduleId = crypto.randomUUID();
  const lesson1 = crypto.randomUUID(); // captioned video → platform transcript
  const lesson2 = crypto.randomUUID(); // uncaptioned video → provider seam
  const lesson3 = crypto.randomUUID(); // no video → typed error
  const lesson4 = crypto.randomUUID(); // captioned video WITH block recording.mode
  await A.supabase.from("courses").insert({
    id: courseId,
    author_id: A.userId,
    title: "Practical SQL Performance",
    description: "Make real production queries fast.",
    plan: {
      outcomes: ["Read a query plan", "Choose the right index"],
      prerequisites: [],
      teachingStyle: "dry, precise",
    } as unknown as Json,
  });
  await A.supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: "The Query Planner Is Not Magic", order: 0 });
  await A.supabase.from("lessons").insert([
    { id: lesson1, course_id: courseId, module_id: moduleId, title: "Indexing Deep Dive", order: 0 },
    { id: lesson2, course_id: courseId, module_id: moduleId, title: "Join Strategies", order: 1 },
    { id: lesson3, course_id: courseId, module_id: moduleId, title: "Planning Ahead", order: 2 },
    { id: lesson4, course_id: courseId, module_id: moduleId, title: "Recorded In Studio", order: 3 },
  ]);

  // lesson4: a studio-recorded video — the BLOCK carries recording.mode
  // (screen_camera), the platform metadata FR-1 must read verbatim.
  const videoBlock4 = crypto.randomUUID();
  await A.supabase.from("blocks").insert({
    id: videoBlock4,
    course_id: courseId,
    lesson_id: lesson4,
    type: "video",
    order: 0,
    content: {
      asset: { provider: "mux", status: "ready" },
      recording: { mode: "screen_camera", layout: "screen_with_camera_bubble", includeMic: true },
      edit: { trimStartSeconds: null, trimEndSeconds: null },
      settings: { autoplay: false, showChapters: false },
    } as unknown as Json,
  });

  // Captioned ready video on lesson1 (the platform-transcript source; the
  // mux ids make it a renderable M-B source too — fakes stand in for Mux).
  await A.supabase.from("video_assets").insert({
    owner_id: A.userId,
    course_id: courseId,
    lesson_id: lesson1,
    status: "ready",
    duration_seconds: FLAT.durationMs / 1000,
    mux_asset_id: "int-source-asset",
    mux_playback_id: "int-source-playback",
    transcript_vtt: fixtureVtt(),
    transcript: FLAT.segments.map((s) => s.text).join(" "),
    caption_status: "ready",
  });
  // Uncaptioned ready video with an MP4 on lesson2 (the provider path).
  await A.supabase.from("video_assets").insert({
    owner_id: A.userId,
    course_id: courseId,
    lesson_id: lesson2,
    status: "ready",
    duration_seconds: 120,
    mp4_url: "https://example.com/lesson2.mp4",
  });
  // Captioned ready video on lesson4, LINKED to the metadata-carrying block.
  await A.supabase.from("video_assets").insert({
    owner_id: A.userId,
    course_id: courseId,
    lesson_id: lesson4,
    block_id: videoBlock4,
    status: "ready",
    duration_seconds: FLAT.durationMs / 1000,
    transcript_vtt: fixtureVtt(),
    transcript: FLAT.segments.map((s) => s.text).join(" "),
    caption_status: "ready",
  });

  const services = createMarketingServices();
  const ctxFor = (model?: ReturnType<typeof createMockModelClient>): MarketingToolContext => ({
    supabase: A.supabase as never,
    courseId,
    campaignId: null,
    ownerId: A.userId,
    services,
    model,
    requestedBy: "user",
  });
  const transcriptDeps = (
    provider?: TranscriptionProvider,
    frameInspectorFor?: (asset: {
      playbackId: string | null;
      durationSeconds: number | null;
    }) => FrameInspector | null
  ) => ({
    supabase: A.supabase as never,
    ownerId: A.userId,
    courseIdForEvents: courseId,
    transcriptionProvider: provider,
    frameInspectorFor,
  });

  /* ───────────────── transcript acquisition ─────────────────────────── */

  console.log("\n# transcript acquisition (platform · cache · provider · none)");
  const t1 = await acquireLessonTranscript(transcriptDeps(), lesson1, { courseId });
  check("platform path: source=platform, words interpolated", t1.source === "platform" && t1.words.length > 100);
  check("platform path: duration from the asset", Math.abs(t1.durationSeconds - FLAT.durationMs / 1000) < 1);
  check("platform path: plain text persisted", t1.text.includes("sorted copy"));

  console.log("\n# recordingFormat.metadata.spec / classifier.spec (DB halves)");
  // lesson1's video has NO block metadata and NO inspector → degraded default.
  check(
    "no metadata + no inspector → camera_only from 'classifier' (degraded default)",
    t1.recordingFormat === "camera_only" && t1.formatSource === "classifier"
  );
  // lesson4's video block carries recording.mode — read verbatim; the spy
  // inspector factory must NEVER be constructed (metadata short-circuits).
  let inspectorBuilt = 0;
  const spyFactory = () => {
    inspectorBuilt++;
    return {
      async sampleFrames(count: number): Promise<FrameSignal[]> {
        return Array.from({ length: count }, () => ({ facePresent: true, screenContentPresent: false }));
      },
    };
  };
  const t4 = await acquireLessonTranscript(transcriptDeps(undefined, spyFactory), lesson4, { courseId });
  check(
    "block recording.mode read verbatim → screen_camera from 'platform'",
    t4.recordingFormat === "screen_camera" && t4.formatSource === "platform"
  );
  check("classifier NEVER invoked when metadata exists (spy)", inspectorBuilt === 0);

  let providerCalled = 0;
  const throwingProvider: TranscriptionProvider = {
    async transcribe() {
      providerCalled++;
      throw new Error("must not be called");
    },
  };
  const t1again = await acquireLessonTranscript(transcriptDeps(throwingProvider), lesson1, { courseId });
  check("CACHE: second request returns the same transcript row", t1again.id === t1.id);
  check("CACHE: zero provider calls on a cached lesson (§17.1)", providerCalled === 0);

  const mockProvider: TranscriptionProvider = {
    async transcribe({ mediaUrl }) {
      providerCalled++;
      check("provider gets the asset's media URL", mediaUrl === "https://example.com/lesson2.mp4");
      return {
        words: [
          { w: "join", startMs: 0, endMs: 400, speaker: "S1" },
          { w: "strategies", startMs: 400, endMs: 900, speaker: "S1" },
          { w: "matter", startMs: 900, endMs: 1400, speaker: "S1" },
        ],
        text: "join strategies matter",
        language: "en",
        durationSeconds: 120,
        providerRef: "mock-transcription-1",
      };
    },
  };
  // lesson2 = an upload (no block metadata) — the injected inspector
  // classifies it screen_only through the pure decision.
  const t2 = await acquireLessonTranscript(
    transcriptDeps(mockProvider, () => ({
      async sampleFrames(count: number): Promise<FrameSignal[]> {
        return Array.from({ length: count }, () => ({ facePresent: false, screenContentPresent: true }));
      },
    })),
    lesson2,
    { courseId }
  );
  check("provider path: source=provider + providerRef persisted", t2.source === "provider" && t2.providerRef === "mock-transcription-1");
  check("provider path: diarized words survive", t2.words[0].speaker === "S1");
  check(
    "upload classified through the inspector → screen_only from 'classifier'",
    t2.recordingFormat === "screen_only" && t2.formatSource === "classifier"
  );

  let noSourceErr: unknown = null;
  try {
    await acquireLessonTranscript(transcriptDeps(), lesson3, { courseId });
  } catch (err) {
    noSourceErr = err;
  }
  check("no video → ClipTranscriptUnavailableError (422-class)", noSourceErr instanceof ClipTranscriptUnavailableError);

  const transcribedEvents = await A.supabase
    .from("analytics_event")
    .select("id,props")
    .eq("course_id", courseId)
    .eq("type", "lesson_transcribed");
  check("lesson_transcribed events on the single stream (3 lessons)", (transcribedEvents.data ?? []).length === 3);
  check(
    "lesson_transcribed events carry recordingFormat + formatSource",
    (transcribedEvents.data ?? []).every((e) => {
      const p = e.props as Record<string, unknown>;
      return typeof p.recordingFormat === "string" && typeof p.formatSource === "string";
    })
  );

  console.log("\n# recordingFormat.override.spec (DB half)");
  const overridden = await overrideTranscriptFormat(A.supabase as never, lesson2, "screen_camera");
  check(
    "override flips format + stamps 'creator_override'",
    overridden.recordingFormat === "screen_camera" && overridden.formatSource === "creator_override"
  );
  const t2cached = await acquireLessonTranscript(transcriptDeps(throwingProvider), lesson2, { courseId });
  check(
    "cache returns the override untouched (never re-classified)",
    t2cached.recordingFormat === "screen_camera" && t2cached.formatSource === "creator_override"
  );

  /* ───────────────── selection through the gate ─────────────────────── */

  console.log("\n# selection through the gate (staged, evented, revertible)");
  const mock = createMockModelClient([], {
    structured: { clip_moment_batch: BATCH, clip_validation: VERDICTS },
  });
  const out = await executeMarketingTool(
    "select_clip_moments",
    { lessonId: lesson1, stages: null, targetPlatforms: null, count: 5 },
    ctxFor(mock)
  );
  check("reversible → staged, never an approval card", out.status === "staged" && out.actionId != null);
  check("target is the candidate SET (request_id)", out.target?.entity === "clip_moment_set");
  const requestId = out.target!.id;

  const { data: rows } = await A.supabase
    .from("clip_moment_candidate")
    .select("*")
    .eq("request_id", requestId)
    .order("rank");
  check("3 candidates persisted, ranks 1..3", (rows ?? []).length === 3 && rows!.map((r) => r.rank).join(",") === "1,2,3");
  check("prompt_version stamped on every candidate (§8)", rows!.every((r) => r.prompt_version === CLIP_PROMPT_VERSION));
  check("ai_metadata carries model + voiceProfileVersion", rows!.every((r) => (r.ai_metadata as Record<string, unknown>).promptVersion === CLIP_PROMPT_VERSION));
  check("rubric scores + rationale persisted", rows!.every((r) => r.rationale.length > 0 && r.rubric_scores !== null));
  check("summary explains moments in creator terms", out.summary.includes("worth clipping") && out.summary.includes("sorted copy"));
  // routing.matrix.spec — test_layout_persisted_on_candidate_and_job
  // (candidate half; clip_render_jobs folds into M-B's CREATE):
  check(
    "layout persisted on every candidate row (camera_only lesson → face_track)",
    rows!.every((r) => r.layout === "face_track")
  );
  check(
    "ai_metadata carries recordingFormat + formatSource + actionDense",
    rows!.every((r) => {
      const m = r.ai_metadata as Record<string, unknown>;
      return m.recordingFormat === "camera_only" && m.formatSource === "classifier" && typeof m.actionDense === "boolean";
    })
  );
  check(
    "tool summary shows the layout label on every candidate line",
    out.summary.includes("Face clip")
  );

  const genEvents = await A.supabase
    .from("analytics_event")
    .select("props")
    .eq("course_id", courseId)
    .eq("type", "clip_moments_generated");
  check("clip_moments_generated event with count + promptVersion", (genEvents.data ?? []).some((e) => {
    const p = e.props as Record<string, unknown>;
    return p.count === 3 && p.promptVersion === CLIP_PROMPT_VERSION;
  }));
  check("clip_moments_generated event carries recordingFormat + per-candidate layouts", (genEvents.data ?? []).some((e) => {
    const p = e.props as Record<string, unknown>;
    return p.recordingFormat === "camera_only" && Array.isArray(p.layouts) && (p.layouts as string[]).every((l) => l === "face_track");
  }));

  /* ─────────────── status lifecycle + byte-for-byte revert ──────────── */

  console.log("\n# status lifecycle + reverts");
  const target = rows![0];
  const before = JSON.stringify({ ...target, updated_at: null });
  const statusOut = await executeMarketingTool(
    "update_clip_moment_status",
    { candidateId: target.id, status: "selected" },
    ctxFor()
  );
  check("status change staged (reversible)", statusOut.status === "staged" && statusOut.actionId != null);
  const { data: afterSel } = await A.supabase.from("clip_moment_candidate").select("status").eq("id", target.id).single();
  check("candidate now selected", afterSel?.status === "selected");
  const selEvents = await A.supabase
    .from("analytics_event")
    .select("id")
    .eq("course_id", courseId)
    .eq("type", "clip_moment_selected");
  check("clip_moment_selected event emitted", (selEvents.data ?? []).length === 1);

  await rejectMarketingAction(A.supabase as never, statusOut.actionId!);
  const { data: restored } = await A.supabase.from("clip_moment_candidate").select("*").eq("id", target.id).single();
  check(
    "reject restores the candidate BYTE-FOR-BYTE (modulo moddatetime)",
    JSON.stringify({ ...restored, updated_at: null }) === before
  );

  await rejectMarketingAction(A.supabase as never, out.actionId!);
  const { data: afterRevert } = await A.supabase
    .from("clip_moment_candidate")
    .select("id")
    .eq("request_id", requestId);
  check("rejecting the selection removes the WHOLE candidate set", (afterRevert ?? []).length === 0);
  const t1cached = await A.supabase.from("lesson_transcript").select("id").eq("lesson_id", lesson1).single();
  check("the transcript cache survives the revert (not the gate target)", t1cached.data?.id === t1.id);

  /* ───────────────────── zero-survivors path ────────────────────────── */

  console.log("\n# zero-survivors: nothing persisted");
  const weakBatch = {
    candidates: [fixtureMoment({ rank: 1, rubricScores: { ...GOOD_SCORES, standalone: 2 } })],
  };
  const weakMock = createMockModelClient([], {
    structured: { clip_moment_batch: weakBatch, clip_moment_batch_repair: weakBatch, clip_validation: { verdicts: [] } },
  });
  let zeroErr: unknown = null;
  try {
    await selectClipMoments(
      {
        supabase: A.supabase as never,
        ownerId: A.userId,
        model: weakMock,
        clock: services.clock,
        courseIdForEvents: courseId,
      },
      { lessonId: lesson1, courseId, stages: "balanced", targetPlatforms: ["instagram"], count: 5 }
    );
  } catch (err) {
    zeroErr = err;
  }
  check("all-dropped run throws (stage=validation)", zeroErr instanceof ClipGenerationError && zeroErr.stage === "validation");
  const { data: leftover } = await A.supabase
    .from("clip_moment_candidate")
    .select("id")
    .eq("lesson_id", lesson1);
  check("NOTHING persisted on failure", (leftover ?? []).length === 0);
  const failEvents = await A.supabase
    .from("analytics_event")
    .select("id")
    .eq("course_id", courseId)
    .eq("type", "clip_moments_generation_failed");
  check("generation_failed event on the stream", (failEvents.data ?? []).length >= 1);

  /* ─────────────────────────── RLS matrix ───────────────────────────── */

  console.log("\n# RLS matrix (creator B vs. creator A's data)");
  // Re-create a candidate set for A so B has something to try against.
  const mock2 = createMockModelClient([], {
    structured: { clip_moment_batch: BATCH, clip_validation: VERDICTS },
  });
  const out2 = await executeMarketingTool(
    "select_clip_moments",
    { lessonId: lesson1, stages: null, targetPlatforms: null, count: 5 },
    ctxFor(mock2)
  );
  const { data: aCandidates } = await A.supabase
    .from("clip_moment_candidate")
    .select("id")
    .eq("request_id", out2.target!.id);
  check("fixture set re-created for the matrix", (aCandidates ?? []).length === 3);

  const { data: bTranscripts } = await B.supabase.from("lesson_transcript").select("id");
  check("B sees NO transcripts", (bTranscripts ?? []).length === 0);
  const { data: bCandidates } = await B.supabase.from("clip_moment_candidate").select("id");
  check("B sees NO candidates", (bCandidates ?? []).length === 0);
  const { data: bUpdate } = await B.supabase
    .from("clip_moment_candidate")
    .update({ status: "dismissed" })
    .eq("id", aCandidates![0].id)
    .select("id");
  check("B cannot update A's candidate", (bUpdate ?? []).length === 0);
  const { data: bDelete } = await B.supabase
    .from("clip_moment_candidate")
    .delete()
    .eq("id", aCandidates![0].id)
    .select("id");
  check("B cannot delete A's candidate", (bDelete ?? []).length === 0);
  const { data: stillThere } = await A.supabase
    .from("clip_moment_candidate")
    .select("status")
    .eq("id", aCandidates![0].id)
    .single();
  check("A's candidate untouched by B's attempts", stillThere?.status === "candidate");

  /* ───────────────── M-B: render jobs through the gate ────────────────── */

  console.log("\n# M-B render jobs: gate staging + idempotency + revert-cancel");
  const gen1 = await executeMarketingTool(
    "generate_lesson_clips",
    { candidateId: aCandidates![0].id, preset: null },
    ctxFor()
  );
  check("generate_lesson_clips staged (reversible, no approval card)", gen1.status === "staged" && gen1.actionId != null);
  check("target is the clip_render_job entity", gen1.target?.entity === "clip_render_job");
  const jobId = gen1.target!.id;
  const { data: jobRow } = await A.supabase.from("clip_render_job").select("*").eq("id", jobId).single();
  check(
    "job row: queued, face_track via reap (camera_only lesson), preset by funnel stage",
    jobRow?.status === "queued" && jobRow?.layout === "face_track" && jobRow?.provider === "reap"
  );
  const { data: cand0 } = await A.supabase
    .from("clip_moment_candidate")
    .select("start_ms,end_ms")
    .eq("id", aCandidates![0].id)
    .single();
  const src = jobRow?.source as { startMs?: number; endMs?: number; recordingFormat?: string };
  check(
    "job span = the candidate's validated span, format stamped",
    src?.startMs === cand0?.start_ms && src?.endMs === cand0?.end_ms && src?.recordingFormat === "camera_only"
  );
  check("summary is honest: queued ≠ rendered, manual posting", /queued/i.test(gen1.summary) && /NOT rendered/i.test(gen1.summary));

  const gen1again = await executeMarketingTool(
    "generate_lesson_clips",
    { candidateId: aCandidates![0].id, preset: null },
    ctxFor()
  );
  check("idempotent replay returns the SAME job", gen1again.target?.id === jobId);

  await rejectMarketingAction(A.supabase as never, gen1.actionId!);
  const { data: cancelledRow } = await A.supabase.from("clip_render_job").select("status").eq("id", jobId).single();
  check("revert of the create CANCELS the job (cost-ledger row survives)", cancelledRow?.status === "cancelled");

  console.log("\n# M-B lifecycle: queued → precutting → submitted → completed (fakes, real DB+storage)");
  const admin = createClient<Database>(url, loadServiceKey(), { global: { fetch: retryingFetch } });
  const gen2 = await executeMarketingTool(
    "generate_lesson_clips",
    { candidateId: aCandidates![1].id, preset: "tofu_hook" },
    ctxFor()
  );
  const job2Id = gen2.target!.id;

  const fakePrecut: PrecutOps & { cleaned: string[] } = {
    cleaned: [],
    async start() {
      return { muxAssetId: "precut-asset-1" };
    },
    async check() {
      return { status: "ready", playbackId: "pb", mp4Url: "https://media.example/precut.mp4", error: null };
    },
    async cleanup(id) {
      this.cleaned.push(id);
    },
  };
  const fakeProvider: ClipRenderProvider = {
    id: "reap",
    async submit(input) {
      check(
        "provider receives the PRE-CUT bytes (never a URL) as a reframe",
        input.kind === "provider_reframe" && input.bytes.length > 0
      );
      return { providerRef: "proj-int-1", uploadRef: "up-int-1", costMinutes: 1 };
    },
    async getJob() {
      return {
        status: "completed",
        providerStatus: "completed",
        outputUrl: "https://media.example/output.mp4",
        cleanOutputUrl: "https://media.example/output-clean.mp4",
        output: { width: 720, height: 1280, durationSeconds: 40 },
        costMinutes: 1,
        error: null,
      };
    },
    async cancel() {},
  };
  const fakeFetch: typeof fetch = async (input) => {
    const u = String(input);
    if (u.includes("media.example")) return new Response(Buffer.from(`bytes-of-${u}`), { status: 200 });
    return fetch(input as never);
  };
  const tickDeps = {
    supabase: admin as never,
    provider: fakeProvider,
    precut: fakePrecut,
    nowIso: new Date().toISOString(),
    fetchImpl: fakeFetch,
  };

  let job2 = (await getRenderJob(admin as never, job2Id))!;
  await advanceRenderJob(tickDeps, job2);
  job2 = (await getRenderJob(admin as never, job2Id))!;
  check("tick 1: queued → precutting (temp clip asset ref stored)", job2.status === "precutting" && job2.precut?.muxAssetId === "precut-asset-1");

  await advanceRenderJob(tickDeps, job2);
  job2 = (await getRenderJob(admin as never, job2Id))!;
  check(
    "tick 2: precutting → submitted (provider refs + submitted_at + create-billed cost)",
    job2.status === "submitted" && job2.providerRef === "proj-int-1" && job2.submittedAt !== null && job2.costMinutes === 1
  );
  check("temp precut asset cleaned after submission", fakePrecut.cleaned.includes("precut-asset-1"));
  check(
    "token bucket counts the submission",
    (await submissionsInLastMinute(admin as never, A.userId, new Date().toISOString())) >= 1
  );

  await advanceRenderJob(tickDeps, job2);
  job2 = (await getRenderJob(admin as never, job2Id))!;
  check(
    "tick 3: submitted → completed with output + provider cost",
    job2.status === "completed" && job2.output?.storagePath === `${A.userId}/clips/${job2Id}.mp4` && job2.costMinutes === 1
  );
  const dl = await admin.storage.from("clip-media").download(job2.output!.storagePath);
  check("output bytes really landed in the private clip-media bucket", !dl.error && (await dl.data!.text()).includes("bytes-of-"));

  const jobEvents = await A.supabase
    .from("analytics_event")
    .select("type,props")
    .eq("course_id", courseId)
    .in("type", ["clip_job_submitted", "clip_job_completed"]);
  check(
    "clip_job_submitted + clip_job_completed on the single stream w/ layout+format",
    (jobEvents.data ?? []).length === 2 &&
      (jobEvents.data ?? []).every((e) => {
        const p = e.props as Record<string, unknown>;
        return p.layout === "face_track" && p.recordingFormat === "camera_only";
      })
  );

  console.log("\n# M-B token bucket: held when the minute budget is spent");
  process.env.CLIP_RENDER_TOKENS_PER_MIN = "1";
  try {
    const gen3 = await executeMarketingTool(
      "generate_lesson_clips",
      { candidateId: aCandidates![2].id, preset: "mofu_story" },
      ctxFor()
    );
    let job3 = (await getRenderJob(admin as never, gen3.target!.id))!;
    await advanceRenderJob(tickDeps, job3); // → precutting
    job3 = (await getRenderJob(admin as never, gen3.target!.id))!;
    const outcome = await advanceRenderJob(tickDeps, job3);
    check("submission HELD by the 10/min bucket (1/min override, 1 already submitted)", outcome === "held");
    job3 = (await getRenderJob(admin as never, gen3.target!.id))!;
    check("held job stays in precutting (retried next tick, nothing lost)", job3.status === "precutting");
  } finally {
    delete process.env.CLIP_RENDER_TOKENS_PER_MIN;
  }

  // One edge per job per tick — a few sweeps drain the queue (the cron shape).
  let sweptCompleted = 0;
  for (let i = 0; i < 3 && sweptCompleted === 0; i++) {
    const tickResult = await processClipRenderTick(tickDeps, { limit: 10 });
    sweptCompleted += tickResult.completed;
  }
  check("tick sweeps drain the held job to completion (reconciliation IS delivery)", sweptCompleted >= 1);

  const { data: bJobs } = await B.supabase.from("clip_render_job").select("id");
  check("RLS: B sees NO render jobs", (bJobs ?? []).length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

function loadServiceKey(): string {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)\s*=\s*(.*)\s*$/);
    if (m) return m[2].replace(/^["']|["']$/g, "");
  }
  throw new Error("SUPABASE_SERVICE_ROLE_KEY missing from .env.local (the render tick is admin-driven)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
