/**
 * Transcript acquisition (Phase 1.5 PRD §6 stage 1, §12.1) — the ONE place a
 * lesson becomes a word-timestamped transcript.
 *
 * Source order:
 *   1. CACHE — an existing lesson_transcript row (second request = zero
 *      provider/model spend; acceptance §17.1).
 *   2. PLATFORM — the lesson's Mux-captioned video (`video_assets.transcript_vtt`).
 *      Mux cues are CUE-level (a few words per ~2-5s cue), not word-level, so
 *      word timings are interpolated inside each cue proportional to word
 *      length. That precision is plenty for 20-90s moment selection; frame-
 *      accurate caption timing is the RENDER provider's job (§9), never ours.
 *      No diarization on this path (speaker: null).
 *   3. PROVIDER — the injectable TranscriptionProvider seam. M-B's Reap
 *      adapter implements it (submit + poll hidden behind one promise); tests
 *      inject a mock. Absent both sources → typed error.
 *
 * Rendering helpers (renderTranscriptForPrompt / chunkTranscript) live here
 * too so the selection engine and the eval harness share one anchor format.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { parseVtt, plainTextFromVtt, type CaptionCue } from "@/lib/video/captions";
import { hlsUrl } from "@/lib/video/playbackUrls";
import { ClipTranscriptUnavailableError } from "./errors";
import { resolveRecordingFormat, type FrameInspector } from "./format";
import {
  RecordingFormatSchema,
  type FormatSource,
  type LessonTranscript,
  type RecordingFormat,
  type TranscriptWord,
} from "./schemas";
import { emitClipEvent } from "./events";

type DB = SupabaseClient<Database>;

/* ─────────────────── words from cue-level VTT (pure) ──────────────────── */

/**
 * Interpolate word-level timings inside each cue, weighted by word length
 * (+1 for the trailing space) — closer to real speech than an even split.
 * Ends are clamped to the cue so words never overlap the next cue.
 */
export function wordsFromVttCues(cues: CaptionCue[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let prevText = "";
  for (const cue of cues) {
    if (cue.text === prevText) continue; // rolling-caption artifact (same rule as plainTextFromVtt)
    prevText = cue.text;
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const cueStartMs = Math.round(cue.start * 1000);
    const cueEndMs = Math.round(cue.end * 1000);
    const spanMs = Math.max(cueEndMs - cueStartMs, tokens.length); // ≥1ms per word
    const totalWeight = tokens.reduce((s, t) => s + t.length + 1, 0);
    let cursorMs = cueStartMs;
    for (const [i, t] of tokens.entries()) {
      const sliceMs = i === tokens.length - 1
        ? cueEndMs - cursorMs
        : Math.round((spanMs * (t.length + 1)) / totalWeight);
      const endMs = Math.min(cueEndMs, cursorMs + Math.max(sliceMs, 1));
      words.push({ w: t, startMs: cursorMs, endMs, speaker: null });
      cursorMs = endMs;
    }
  }
  return words;
}

/* ────────────────────── the provider seam (M-B fills) ─────────────────── */

export interface ProviderTranscriptResult {
  words: TranscriptWord[];
  text: string;
  language: string;
  durationSeconds: number;
  /** The provider's job/transcription id, persisted for audit. */
  providerRef: string | null;
}

/**
 * The transcription slice of the ClipRenderProvider (§9.2). M-A defines the
 * seam and uses it via injection; the Reap adapter (M-B, gated on Task 0)
 * implements it by wrapping /create-transcription + status polling in one
 * promise. Tests inject a deterministic mock.
 */
export interface TranscriptionProvider {
  transcribe(input: { mediaUrl: string }): Promise<ProviderTranscriptResult>;
}

/* ─────────────────────────── acquisition ──────────────────────────────── */

export interface TranscriptDeps {
  supabase: DB;
  ownerId: string;
  courseIdForEvents: string;
  /** Absent ⇒ platform-only acquisition (typed error if no captioned video). */
  transcriptionProvider?: TranscriptionProvider;
  /**
   * FR-1 classifier seam: builds a FrameInspector for the lesson's video
   * asset (external uploads have no recording metadata). Absent/null ⇒ the
   * degraded default (camera_only, source 'classifier'). NEVER invoked when
   * block metadata exists — resolveRecordingFormat short-circuits first.
   */
  frameInspectorFor?: (asset: {
    playbackId: string | null;
    durationSeconds: number | null;
  }) => FrameInspector | null;
}

type TranscriptRow = Database["public"]["Tables"]["lesson_transcript"]["Row"];

export function rowToTranscript(row: TranscriptRow): LessonTranscript {
  return {
    id: row.id,
    creatorId: row.creator_id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    source: row.source as LessonTranscript["source"],
    language: row.language,
    durationSeconds: Number(row.duration_seconds),
    words: (row.words as unknown as TranscriptWord[]) ?? [],
    text: row.text,
    providerRef: row.provider_ref,
    recordingFormat: row.recording_format as RecordingFormat,
    formatSource: row.format_source as FormatSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getLessonTranscript(supabase: DB, lessonId: string): Promise<LessonTranscript | null> {
  const { data, error } = await supabase
    .from("lesson_transcript")
    .select("*")
    .eq("lesson_id", lessonId)
    .maybeSingle();
  if (error) throw new Error(`lesson_transcript read: ${error.message}`);
  return data ? rowToTranscript(data) : null;
}

interface VideoAssetSource {
  id: string;
  blockId: string | null;
  playbackId: string | null;
  transcriptVtt: string | null;
  transcriptText: string | null;
  durationSeconds: number | null;
  mediaUrl: string | null;
}

/** The lesson's best transcript-bearing (or transcribable) video: prefer a
 *  captioned asset, longest duration first (the primary lecture recording). */
async function findLessonVideoAsset(supabase: DB, lessonId: string): Promise<VideoAssetSource | null> {
  const { data, error } = await supabase
    .from("video_assets")
    .select("id,block_id,transcript,transcript_vtt,duration_seconds,mp4_url,mux_playback_id,status")
    .eq("lesson_id", lessonId)
    .eq("status", "ready")
    .order("duration_seconds", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`video_assets read: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return null;
  const withCaptions = rows.find((r) => r.transcript_vtt);
  const row = withCaptions ?? rows[0];
  return {
    id: row.id,
    blockId: row.block_id,
    playbackId: row.mux_playback_id,
    transcriptVtt: row.transcript_vtt,
    transcriptText: row.transcript,
    durationSeconds: row.duration_seconds,
    mediaUrl: row.mp4_url ?? (row.mux_playback_id ? hlsUrl(row.mux_playback_id) : null),
  };
}

/**
 * FR-1 metadata read: the recording format the platform already stores —
 * `VideoLessonBlock.recording.mode` in the block's content jsonb (the
 * literals equal RECORDING_FORMATS verbatim). Studio recordings always carry
 * it; external uploads never do (the upload path skips mode selection).
 */
async function readBlockRecordingMode(supabase: DB, blockId: string | null): Promise<string | null> {
  if (!blockId) return null;
  const { data, error } = await supabase.from("blocks").select("content").eq("id", blockId).maybeSingle();
  if (error) throw new Error(`blocks read (recording mode): ${error.message}`);
  const content = data?.content as { recording?: { mode?: unknown } } | null;
  const mode = content?.recording?.mode;
  return typeof mode === "string" ? mode : null;
}

async function persistTranscript(
  deps: TranscriptDeps,
  lessonId: string,
  courseId: string | null,
  input: {
    source: "platform" | "provider";
    language: string;
    durationSeconds: number;
    words: TranscriptWord[];
    text: string;
    providerRef: string | null;
    recordingFormat: RecordingFormat;
    formatSource: FormatSource;
  }
): Promise<LessonTranscript> {
  const { data, error } = await deps.supabase
    .from("lesson_transcript")
    .upsert(
      {
        creator_id: deps.ownerId,
        course_id: courseId,
        lesson_id: lessonId,
        source: input.source,
        language: input.language,
        duration_seconds: input.durationSeconds,
        words: input.words as unknown as Json,
        text: input.text,
        provider_ref: input.providerRef,
        recording_format: input.recordingFormat,
        format_source: input.formatSource,
      },
      { onConflict: "lesson_id" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`lesson_transcript write: ${error.message}`);
  const transcript = rowToTranscript(data);
  await emitClipEvent(deps.supabase, deps.courseIdForEvents, "lesson_transcribed", {
    lessonId,
    transcriptId: transcript.id,
    source: input.source,
    durationSeconds: input.durationSeconds,
    wordCount: input.words.length,
    recordingFormat: input.recordingFormat,
    formatSource: input.formatSource,
  });
  return transcript;
}

/**
 * FR-1 creator override: pin a transcript's recording format by hand
 * (misclassified external upload, or an edge the teacher knows better).
 * format_source becomes 'creator_override'; acquisition never re-classifies
 * over it (the cache path returns the row as-is).
 */
export async function overrideTranscriptFormat(
  supabase: DB,
  lessonId: string,
  format: RecordingFormat
): Promise<LessonTranscript> {
  const parsed = RecordingFormatSchema.parse(format); // throws on a bad value
  const { data, error } = await supabase
    .from("lesson_transcript")
    .update({ recording_format: parsed, format_source: "creator_override" })
    .eq("lesson_id", lessonId)
    .select("*")
    .single();
  if (error) throw new Error(`lesson_transcript format override: ${error.message}`);
  return rowToTranscript(data);
}

/**
 * Acquire the lesson's transcript: cache → platform captions → provider.
 * Throws ClipTranscriptUnavailableError when no source exists (the creator-
 * facing message explains both remedies).
 */
export async function acquireLessonTranscript(
  deps: TranscriptDeps,
  lessonId: string,
  opts: { courseId?: string | null } = {}
): Promise<LessonTranscript> {
  const cached = await getLessonTranscript(deps.supabase, lessonId);
  if (cached) return cached; // classification ran once; overrides survive

  const courseId = opts.courseId ?? deps.courseIdForEvents ?? null;
  const asset = await findLessonVideoAsset(deps.supabase, lessonId);

  // FR-1: format resolution — metadata short-circuits; the classifier
  // (frame inspector) runs ONLY when the block carries no recording.mode
  // (i.e. an external upload).
  const resolveFormat = async () => {
    if (!asset) return { format: "camera_only" as RecordingFormat, source: "classifier" as FormatSource };
    const metadataMode = await readBlockRecordingMode(deps.supabase, asset.blockId);
    const inspector =
      metadataMode === null
        ? (deps.frameInspectorFor?.({
            playbackId: asset.playbackId,
            durationSeconds: asset.durationSeconds,
          }) ?? null)
        : null; // never even constructed when metadata exists
    const resolution = await resolveRecordingFormat({ metadataMode, frameInspector: inspector });
    return { format: resolution.format, source: resolution.source };
  };

  if (asset?.transcriptVtt) {
    const cues = parseVtt(asset.transcriptVtt);
    const words = wordsFromVttCues(cues);
    if (words.length > 0) {
      const lastEndMs = words[words.length - 1].endMs;
      const fmt = await resolveFormat();
      return persistTranscript(deps, lessonId, courseId, {
        source: "platform",
        language: "en",
        durationSeconds: asset.durationSeconds ?? Math.ceil(lastEndMs / 1000),
        words,
        text: asset.transcriptText ?? plainTextFromVtt(asset.transcriptVtt),
        providerRef: null,
        recordingFormat: fmt.format,
        formatSource: fmt.source,
      });
    }
  }

  if (deps.transcriptionProvider && asset?.mediaUrl) {
    const result = await deps.transcriptionProvider.transcribe({ mediaUrl: asset.mediaUrl });
    const fmt = await resolveFormat();
    return persistTranscript(deps, lessonId, courseId, {
      source: "provider",
      language: result.language,
      durationSeconds: result.durationSeconds,
      words: result.words,
      text: result.text,
      providerRef: result.providerRef,
      recordingFormat: fmt.format,
      formatSource: fmt.source,
    });
  }

  throw new ClipTranscriptUnavailableError(
    lessonId,
    asset
      ? "its video has no captions yet and no transcription provider is configured"
      : "it has no ready video recording"
  );
}

/* ──────────────── prompt rendering + chunking (pure) ──────────────────── */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function msToClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** ~12s of words per anchored line — enough resolution for ±8s adjustments. */
const LINE_SPAN_MS = 12_000;

/**
 * Render words as timestamp-anchored lines the model can cite spans from:
 *   `[04:32 · 272000ms] …words…`
 * Speaker changes (diarized provider transcripts) start a new line with the
 * speaker tag so multi-speaker fixtures keep attribution.
 */
export function renderTranscriptForPrompt(words: TranscriptWord[]): string {
  if (words.length === 0) return "(empty transcript)";
  const lines: string[] = [];
  let lineStart = words[0].startMs;
  let lineSpeaker = words[0].speaker;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const tag = lineSpeaker ? ` ${lineSpeaker}:` : "";
    lines.push(`[${msToClock(lineStart)} · ${lineStart}ms]${tag} ${buf.join(" ")}`);
    buf = [];
  };
  for (const w of words) {
    const speakerChanged = w.speaker !== lineSpeaker;
    if (speakerChanged || w.startMs - lineStart >= LINE_SPAN_MS) {
      flush();
      lineStart = w.startMs;
      lineSpeaker = w.speaker;
    }
    buf.push(w.w);
  }
  flush();
  return lines.join("\n");
}

export interface TranscriptChunk {
  startMs: number;
  endMs: number;
  rendered: string;
}

/**
 * Split an over-budget transcript into anchored chunks for the sequential
 * map step (§7.5). Chunk boundaries fall on line boundaries so no anchor is
 * ever split; each chunk overlaps nothing (spans are disjoint).
 */
export function chunkTranscript(words: TranscriptWord[], maxTokensPerChunk: number): TranscriptChunk[] {
  if (words.length === 0) return [];
  const maxChars = maxTokensPerChunk * CHARS_PER_TOKEN;
  const chunks: TranscriptChunk[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let chars = 0;
    while (end < words.length && chars <= maxChars) {
      chars += words[end].w.length + 1;
      end += 1;
    }
    const slice = words.slice(start, end);
    chunks.push({
      startMs: slice[0].startMs,
      endMs: slice[slice.length - 1].endMs,
      rendered: renderTranscriptForPrompt(slice),
    });
    start = end;
  }
  return chunks;
}

/** The §7.2 span's transcript text — validation + hook-integrity read this. */
export function transcriptSlice(words: TranscriptWord[], startMs: number, endMs: number): string {
  return words
    .filter((w) => w.startMs < endMs && w.endMs > startMs)
    .map((w) => w.w)
    .join(" ");
}

/* ───────────────── sentence-boundary snapping (pure) ──────────────────── */

const SENTENCE_END_RE = /[.?!]["'”’)\]]*$/;

/**
 * Snap a span to sentence edges. Model-cited boundaries are interpolated
 * guesses off 12s anchors — a start that lands 1.5s early drags in the tail
 * of the previous sentence ("…roll the tip. Blooms are…" → the coherence
 * checker rightly fails "tip."). Deterministic normalization the model
 * shouldn't have to get right (found by the live eval, clips-v1 → v2):
 *   - start snaps to the NEAREST sentence start within ±toleranceMs
 *   - end snaps to the nearest sentence end within ±toleranceMs, else
 *     EXTENDS to the next sentence end within +extendMs (never truncates a
 *     closing thought)
 * Returns the original span when no snap point is in range or the snap would
 * invert the span.
 */
export function snapToSentenceBounds(
  words: TranscriptWord[],
  startMs: number,
  endMs: number,
  opts: { toleranceMs?: number; extendMs?: number } = {}
): { startMs: number; endMs: number } {
  const tolerance = opts.toleranceMs ?? 4_000;
  const extend = opts.extendMs ?? 8_000;
  if (words.length === 0) return { startMs, endMs };

  const sentenceStarts: number[] = [];
  const sentenceEnds: number[] = [];
  for (const [i, w] of words.entries()) {
    if (i === 0 || SENTENCE_END_RE.test(words[i - 1].w)) sentenceStarts.push(w.startMs);
    if (SENTENCE_END_RE.test(w.w)) sentenceEnds.push(w.endMs);
  }
  if (sentenceStarts.length === 0 || sentenceEnds.length === 0) return { startMs, endMs };

  const nearest = (points: number[], target: number, within: number): number | null => {
    let best: number | null = null;
    for (const p of points) {
      if (Math.abs(p - target) > within) continue;
      if (best === null || Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    return best;
  };

  const snappedStart = nearest(sentenceStarts, startMs, tolerance) ?? startMs;
  let snappedEnd = nearest(sentenceEnds, endMs, tolerance);
  if (snappedEnd === null) {
    // extend forward to complete the closing sentence
    snappedEnd = sentenceEnds.find((p) => p > endMs && p - endMs <= extend) ?? endMs;
  }
  if (snappedEnd <= snappedStart) return { startMs, endMs };
  return { startMs: snappedStart, endMs: snappedEnd };
}
