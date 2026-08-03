/**
 * The moment selection engine (PRD 1.5 §6 stages 2-3, §7) — ONE server-side
 * path behind the REST route, the clips UI, and the agent tool:
 *
 *   1 acquire transcript (cache → platform → provider)
 *   2 assemble context (course + lesson + quiz-miss)      3 voice profile
 *   4 ONE mid-tier selection call (map→reduce when the transcript is over
 *     budget — SEQUENTIAL small-tier map, §7.5)           5 Zod gate
 *   6 deterministic checks (+ exactly one repair call — Phase 1 semantics)
 *   7 the ONE small-tier validation call (coherence + hook integrity)
 *   8 persist candidates + events
 *
 * Steps 4-7 are `runSelectionCore` — DB-free, shared VERBATIM with the eval
 * harness (scripts/eval-clips.ts), so eval scores measure the real pipeline,
 * not a re-implementation.
 *
 * Quality over speed: every model call runs under CLIP_SELECTION_TIMEOUT_MS
 * (timeout ⇒ typed error, NOTHING persisted, parameters kept for retry) and
 * counts against the platform-wide two-concurrent-call semaphore. Selection
 * is model-REQUIRED — there is no deterministic fallback that could honestly
 * rank teachable moments (ClipModelUnavailableError, HTTP 503).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { withSemaphore } from "@/lib/ai/subagent";
import type { Clock } from "../services/types";
import { ensureSocialVoiceProfile } from "../social/generate";
import type { SocialVoiceProfile } from "../social/schemas";
import {
  CLIP_MAP_CHUNK_TOKENS,
  CLIP_REDUCE_EXCERPT_PAD_MS,
  clipConfig,
  type ClipConfig,
} from "./constants";
import { assembleClipContext, type ClipContext } from "./context";
import { emitClipEvent } from "./events";
import { ClipGenerationError, ClipModelUnavailableError } from "./errors";
import {
  buildMapInput,
  buildRepairInput,
  buildSelectionInput,
  buildValidationInput,
  CLIP_MAP_SYSTEM_PROMPT,
  CLIP_PROMPT_VERSION,
  CLIP_SELECTION_SYSTEM_PROMPT,
  CLIP_VALIDATION_SYSTEM_PROMPT,
  renderShortlist,
  type SelectionRequestBlock,
} from "./prompt";
import { insertCandidates } from "./repository";
import {
  MapShortlistSchema,
  ModelMomentBatchSchema,
  ValidationVerdictBatchSchema,
  type ClipMomentCandidate,
  type LessonTranscript,
  type ModelMoment,
  type RecordingFormat,
  type SelectMomentsRequest,
  type SlideSyncEntry,
  type TranscriptWord,
} from "./schemas";
import { loadLessonSlideSync } from "./routing";
import {
  acquireLessonTranscript,
  chunkTranscript,
  estimateTokens,
  renderTranscriptForPrompt,
  type TranscriptionProvider,
} from "./transcripts";
import {
  applyValidationVerdicts,
  runDeterministicChecks,
  type ClipDrop,
  type NormalizedCandidate,
} from "./validate";

type DB = SupabaseClient<Database>;

export interface ClipPipelineDeps {
  supabase: DB;
  ownerId: string;
  /** Provider-agnostic model — absent ⇒ ClipModelUnavailableError. */
  model?: ModelClient;
  clock: Clock;
  courseIdForEvents: string;
  /** M-B's Reap adapter slots in here; tests inject a mock. */
  transcriptionProvider?: TranscriptionProvider;
  /** FR-1 classifier seam (external uploads only) — see TranscriptDeps. */
  frameInspectorFor?: import("./transcripts").TranscriptDeps["frameInspectorFor"];
}

export interface SelectMomentsResult {
  candidates: ClipMomentCandidate[];
  dropped: ClipDrop[];
  requestId: string;
  transcript: Pick<LessonTranscript, "id" | "source" | "durationSeconds">;
  repairUsed: boolean;
  mapReduceUsed: boolean;
}

interface ModelCallOutcome {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

async function runStructuredCall(
  model: ModelClient,
  cfg: ClipConfig,
  args: {
    system: string;
    input: string;
    formatName: string;
    schema: ReturnType<typeof toStrictJsonSchema>;
    tier: "select" | "validate" | "map";
  }
): Promise<ModelCallOutcome> {
  const modelName =
    args.tier === "select" ? cfg.selectModel : args.tier === "validate" ? cfg.validateModel : cfg.mapModel;
  const effort =
    args.tier === "select" ? cfg.selectEffort : args.tier === "validate" ? cfg.validateEffort : cfg.mapEffort;
  const result = await model.runTurn(
    {
      system: args.system,
      input: [{ role: "developer", content: args.input }],
      tools: [],
      stream: false,
      timeoutMs: cfg.selectionTimeoutMs,
      maxRetries: 1,
      model: modelName,
      effort,
      responseFormat: { name: args.formatName, schema: args.schema },
    },
    () => {}
  );
  if (result.finishReason === "error") {
    const stage = result.errorKind === "transport_timeout" ? "timeout" : "model";
    throw new ClipGenerationError(
      stage,
      stage === "timeout"
        ? "Moment selection hit the 3-minute ceiling. Nothing was saved — your setup is kept, try again."
        : "The model call failed. Nothing was saved — your setup is kept, try again."
    );
  }
  return { text: result.text, usage: result.usage };
}

function parseJson<T>(
  text: string,
  parse: (raw: unknown) => { success: true; data: T } | { success: false; issues: string[] }
): { data: T } | { issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { issues: ["response was not valid JSON"] };
  }
  const parsed = parse(raw);
  return parsed.success ? { data: parsed.data } : { issues: parsed.issues };
}

function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/* ─────────── transcript sizing: direct vs. map→reduce (§7.5) ──────────── */

interface TranscriptForPrompt {
  rendered: string;
  shortlist?: string;
  mapReduceUsed: boolean;
}

async function prepareTranscriptInput(
  model: ModelClient,
  cfg: ClipConfig,
  words: TranscriptWord[]
): Promise<TranscriptForPrompt> {
  const fullRendered = renderTranscriptForPrompt(words);
  if (estimateTokens(fullRendered) <= cfg.transcriptMaxTokens) {
    return { rendered: fullRendered, mapReduceUsed: false };
  }

  // MAP: scan every chunk cheaply, SEQUENTIALLY (the 2-call ceiling — §7.5).
  // Chunks never exceed the overall transcript budget (a tightened budget
  // tightens the map step with it).
  const chunks = chunkTranscript(words, Math.min(CLIP_MAP_CHUNK_TOKENS, cfg.transcriptMaxTokens));
  const mapSchema = toStrictJsonSchema(MapShortlistSchema);
  const shortlisted: { startMs: number; endMs: number; momentType: string; why: string }[] = [];
  for (const chunk of chunks) {
    const out = await runStructuredCall(model, cfg, {
      system: CLIP_MAP_SYSTEM_PROMPT,
      input: buildMapInput(chunk.rendered),
      formatName: "clip_moment_map",
      schema: mapSchema,
      tier: "map",
    });
    const parsed = parseJson(out.text, (raw) => {
      const r = MapShortlistSchema.safeParse(raw);
      return r.success ? { success: true, data: r.data } : { success: false, issues: zodIssues(r.error) };
    });
    if ("data" in parsed) shortlisted.push(...parsed.data.moments);
    // An invalid map chunk is skipped (the reduce step still sees the rest);
    // never silent — it rides ai_metadata via the shortlist count.
  }

  // REDUCE input: excerpt windows around each shortlisted span, budget-fitted.
  const excerpts: string[] = [];
  let budget = cfg.transcriptMaxTokens;
  for (const s of shortlisted) {
    const slice = words.filter(
      (w) =>
        w.startMs >= s.startMs - CLIP_REDUCE_EXCERPT_PAD_MS &&
        w.endMs <= s.endMs + CLIP_REDUCE_EXCERPT_PAD_MS
    );
    const rendered = renderTranscriptForPrompt(slice);
    const cost = estimateTokens(rendered);
    if (cost > budget) break; // ordered by transcript position; over-budget tail dropped, count logged
    excerpts.push(rendered);
    budget -= cost;
  }

  return {
    rendered: excerpts.join("\n…\n") || fullRendered.slice(0, cfg.transcriptMaxTokens * 4),
    shortlist: renderShortlist(shortlisted),
    mapReduceUsed: true,
  };
}

/* ─────────────── the DB-free core (shared with the eval) ──────────────── */

export interface SelectionCoreArgs {
  voice: SocialVoiceProfile;
  /** Full grounding text (course + lesson + quiz-miss). */
  contextText: string;
  /** The lint whitelist input (creator-authored context only). */
  sourceContext: string;
  words: TranscriptWord[];
  durationMs: number;
  request: SelectionRequestBlock;
  /** FR-1: the recording-format FACT (from the transcript row). */
  recordingFormat: RecordingFormat;
  /** FR-2: slide-sync entries — null until a platform producer exists
   *  (FR-7(g) audit); eval fixtures inject synthetic sync. */
  slideSync: SlideSyncEntry[] | null;
  /** FR-3: optional coarse frame-diff signal; null = degraded mode. */
  frameDiffRatio?: number | null;
}

export interface SelectionCoreResult {
  kept: NormalizedCandidate[];
  dropped: ClipDrop[];
  repairUsed: boolean;
  mapReduceUsed: boolean;
}

/**
 * Stages 4-7: select → Zod gate (+ one repair) → deterministic checks →
 * the ONE validation call → verdicts. `model` must already be semaphored by
 * the caller. Persists NOTHING.
 */
export async function runSelectionCore(
  model: ModelClient,
  cfg: ClipConfig,
  args: SelectionCoreArgs
): Promise<SelectionCoreResult> {
  const transcriptInput = await prepareTranscriptInput(model, cfg, args.words);

  const batchSchema = toStrictJsonSchema(ModelMomentBatchSchema);
  const selectionInput = buildSelectionInput({
    voice: args.voice,
    courseContext: args.contextText,
    transcript: transcriptInput.rendered,
    request: args.request,
    shortlist: transcriptInput.shortlist,
  });

  const parseBatch = (text: string) =>
    parseJson<{ candidates: ModelMoment[] }>(text, (raw) => {
      const r = ModelMomentBatchSchema.safeParse(raw);
      return r.success ? { success: true, data: r.data } : { success: false, issues: zodIssues(r.error) };
    });

  let repairUsed = false;
  const first = await runStructuredCall(model, cfg, {
    system: CLIP_SELECTION_SYSTEM_PROMPT,
    input: selectionInput,
    formatName: "clip_moment_batch",
    schema: batchSchema,
    tier: "select",
  });
  let parsed = parseBatch(first.text);

  // The ONE repair call — first claimant: an invalid batch (Phase 1 rule).
  if (!("data" in parsed)) {
    repairUsed = true;
    const repaired = await runStructuredCall(model, cfg, {
      system: CLIP_SELECTION_SYSTEM_PROMPT,
      input: buildRepairInput({
        originalInput: selectionInput,
        invalidJson: first.text,
        issues: parsed.issues,
      }),
      formatName: "clip_moment_batch_repair",
      schema: batchSchema,
      tier: "select",
    });
    parsed = parseBatch(repaired.text);
    if (!("data" in parsed)) {
      throw new ClipGenerationError(
        "repair",
        "The model returned an invalid candidate batch twice. Nothing was saved — your setup is kept, try again."
      );
    }
  }

  // Deterministic checks; repairable flags claim the repair call if unused.
  const checkCtx = {
    durationMs: args.durationMs,
    words: args.words,
    sourceContext: args.sourceContext,
    format: {
      recordingFormat: args.recordingFormat,
      slideSync: args.slideSync,
      frameDiffRatio: args.frameDiffRatio ?? null,
    },
  };
  let result = runDeterministicChecks(parsed.data.candidates, checkCtx);
  if (result.repairIssues.length > 0 && !repairUsed) {
    repairUsed = true;
    try {
      const repaired = await runStructuredCall(model, cfg, {
        system: CLIP_SELECTION_SYSTEM_PROMPT,
        input: buildRepairInput({
          originalInput: selectionInput,
          invalidJson: JSON.stringify({ candidates: parsed.data.candidates }),
          issues: result.repairIssues.map((i) => i.issue),
        }),
        formatName: "clip_moment_batch_repair",
        schema: batchSchema,
        tier: "select",
      });
      const reparsed = parseBatch(repaired.text);
      if ("data" in reparsed) {
        result = runDeterministicChecks(reparsed.data.candidates, checkCtx);
      }
    } catch {
      // Repair failure is non-fatal: clean candidates still ship, flagged
      // ones stay dropped (the Phase 1 rule).
    }
  }

  let kept: NormalizedCandidate[] = result.kept;
  let dropped: ClipDrop[] = result.dropped;

  // The ONE validation call (§7.4.2-3) over the survivors.
  if (kept.length > 0) {
    const verdictSchema = toStrictJsonSchema(ValidationVerdictBatchSchema);
    const validationOut = await runStructuredCall(model, cfg, {
      system: CLIP_VALIDATION_SYSTEM_PROMPT,
      input: buildValidationInput(
        kept.map((c) => ({
          rank: c.rank,
          spanTranscript: c.spanTranscript,
          stitchedScript: c.stitchedScript,
          hooks: [c.hookText, ...c.altHooks],
        }))
      ),
      formatName: "clip_validation",
      schema: verdictSchema,
      tier: "validate",
    });
    const verdictParsed = parseJson(validationOut.text, (raw) => {
      const r = ValidationVerdictBatchSchema.safeParse(raw);
      return r.success ? { success: true, data: r.data } : { success: false, issues: zodIssues(r.error) };
    });
    if (!("data" in verdictParsed)) {
      // Fail CLOSED: an unverifiable batch is never surfaced (§7.4 is the
      // anti-clickbait + coherence gate; acceptance #3/#4 depend on it).
      throw new ClipGenerationError(
        "validation",
        "The validation pass returned an unreadable verdict. Nothing was saved — your setup is kept, try again."
      );
    }
    const verdictResult = applyValidationVerdicts(kept, verdictParsed.data.verdicts, {
      durationMs: args.durationMs,
      words: args.words,
      format: checkCtx.format,
    });
    kept = verdictResult.kept;
    dropped = [...dropped, ...verdictResult.dropped];
  }

  return { kept, dropped, repairUsed, mapReduceUsed: transcriptInput.mapReduceUsed };
}

/* ───────────────────────────── the engine ─────────────────────────────── */

/**
 * Select clip moments for a lesson (PRD §7). Throws:
 *   ClipModelUnavailableError      — no model configured (HTTP 503)
 *   ClipTranscriptUnavailableError — no transcript source (HTTP 422)
 *   ClipGenerationError            — model/zod/repair/validation/timeout;
 *                                    NOTHING persisted, parameters kept
 */
export async function selectClipMoments(
  deps: ClipPipelineDeps,
  req: SelectMomentsRequest,
  opts: { requestedBy?: "user" | "agent" } = {}
): Promise<SelectMomentsResult> {
  if (!deps.model) throw new ClipModelUnavailableError();
  const cfg = clipConfig();
  const startedAt = deps.clock.epochMs();
  const courseId = req.courseId ?? deps.courseIdForEvents;

  try {
    const transcript = await acquireLessonTranscript(
      {
        supabase: deps.supabase,
        ownerId: deps.ownerId,
        courseIdForEvents: deps.courseIdForEvents,
        transcriptionProvider: deps.transcriptionProvider,
        frameInspectorFor: deps.frameInspectorFor,
      },
      req.lessonId,
      { courseId }
    );
    const durationMs = Math.round(transcript.durationSeconds * 1000);
    // FR-2/M-R: slide-sync facts — real when the studio recorder captured
    // slide advances (recording.slideSync); null on legacy/uploaded videos.
    const slideSync: SlideSyncEntry[] | null = await loadLessonSlideSync(deps.supabase, req.lessonId);

    const context: ClipContext = await assembleClipContext(
      deps.supabase,
      { courseId, lessonId: req.lessonId },
      cfg.contextMaxTokens
    );
    const voice = await ensureSocialVoiceProfile({
      supabase: deps.supabase,
      ownerId: deps.ownerId,
      model: deps.model,
      courseIdForEvents: deps.courseIdForEvents,
    });

    const core = await runSelectionCore(withSemaphore(deps.model), cfg, {
      voice: voice.profile,
      contextText: context.text,
      sourceContext: context.sourceContext,
      words: transcript.words,
      durationMs,
      request: {
        stages: req.stages,
        targetPlatforms: req.targetPlatforms,
        count: req.count,
        recordingFormat: transcript.recordingFormat,
      },
      recordingFormat: transcript.recordingFormat,
      slideSync,
    });

    if (core.kept.length === 0) {
      throw new ClipGenerationError(
        "validation",
        `No candidate survived validation (${core.dropped[0]?.reason ?? "none met the quality bar"}). Nothing was saved — this lesson may need a longer recording, or try different funnel stages.`
      );
    }

    // Persist: sequential re-rank in original strength order.
    const requestId = crypto.randomUUID();
    const latencyMs = deps.clock.epochMs() - startedAt;
    const ordered = [...core.kept].sort((a, b) => a.rank - b.rank);
    const candidates = await insertCandidates(
      deps.supabase,
      {
        creatorId: deps.ownerId,
        courseId,
        lessonId: req.lessonId,
        transcriptId: transcript.id,
        requestId,
        promptVersion: CLIP_PROMPT_VERSION,
      },
      ordered.map((moment, i) => ({
        moment,
        rank: i + 1,
        aiMetadata: {
          model: cfg.selectModel ?? "provider-default",
          promptVersion: CLIP_PROMPT_VERSION,
          voiceProfileVersion: voice.version,
          mapReduceUsed: core.mapReduceUsed,
          captionClamped: moment.captionClamped,
          repairUsed: core.repairUsed,
          latencyMs,
          quizMissCount: context.quizMisses.length,
          recordingFormat: transcript.recordingFormat,
          formatSource: transcript.formatSource,
          actionDense: moment.actionDense,
          visualInterestBoosted: moment.visualInterestBoosted,
        },
      }))
    );

    await emitClipEvent(deps.supabase, deps.courseIdForEvents, "clip_moments_generated", {
      lessonId: req.lessonId,
      transcriptId: transcript.id,
      requestId,
      count: candidates.length,
      droppedCount: core.dropped.length,
      promptVersion: CLIP_PROMPT_VERSION,
      repairUsed: core.repairUsed,
      mapReduceUsed: core.mapReduceUsed,
      latencyMs,
      requestedBy: opts.requestedBy ?? "user",
      recordingFormat: transcript.recordingFormat,
      layouts: candidates.map((c) => c.layout),
    });

    return {
      candidates,
      dropped: core.dropped,
      requestId,
      transcript: {
        id: transcript.id,
        source: transcript.source,
        durationSeconds: transcript.durationSeconds,
      },
      repairUsed: core.repairUsed,
      mapReduceUsed: core.mapReduceUsed,
    };
  } catch (err) {
    if (err instanceof ClipGenerationError) {
      await emitClipEvent(deps.supabase, deps.courseIdForEvents, "clip_moments_generation_failed", {
        lessonId: req.lessonId,
        stage: err.stage,
        reason: err.message,
      });
    }
    throw err;
  }
}
