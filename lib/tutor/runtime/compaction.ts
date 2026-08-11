/**
 * TUTOR-1 Amendment A4, Wave 1 — thread COMPACTION (pure).
 *
 * A lesson thread that runs long is bounded for the MODEL by the L4 replay window
 * (HISTORY_MAX_TURNS newest turns). Compaction preserves the memory that window
 * drops: once a thread accumulates enough turns, the turns OLDER than the keep
 * window are summarized into `tutor_threads.compaction_summary` (a rolling
 * summary), and the fold cursor `compacted_through_turn` advances. The FULL
 * transcript stays in `tutor_turns` for DISPLAY — compaction only changes what the
 * model sees, never what the learner reads (A4-4).
 *
 * This module is PURE: thresholds, the fold plan, the summarizer prompt, and the
 * L4 assembly (summary + windowed replay). The IO — counting turns, the pooled
 * summarizer call, and the persist — lives in the service (`maybeCompactThread`),
 * which composes these.
 *
 * Env is read at CALL time (like `chainingEnabled`) so tests can flip thresholds.
 */

import { z } from "zod";

import {
  HISTORY_MAX_TURNS,
  serializeHistory,
  type HistoryTurn,
} from "./history";

/** The strict structured-output schema for the summarizer call. */
export const CompactionSummarySchema = z.object({
  summary: z.string().describe("The updated rolling summary of the folded turns."),
});
export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

/* ─────────────────────────────── config ─────────────────────────────────── */

export interface CompactionConfig {
  /** Compact once a thread reaches this many total turns. */
  turnThreshold: number;
  /** …OR once the transcript reaches this many characters (a secondary trigger
   *  for a few very long turns before the count threshold). */
  charThreshold: number;
  /** The newest N turns NEVER folded — they stay in the verbatim replay window.
   *  Pinned to HISTORY_MAX_TURNS so the fold boundary always sits at or before the
   *  window (folded turns are strictly older than anything the window shows). */
  keepRecent: number;
  /** Hard cap on the stored rolling summary (chars). Keeps L4 bounded. */
  summaryMaxChars: number;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Resolve the compaction config from env (call-time, test-flippable). */
export function compactionConfig(): CompactionConfig {
  return {
    turnThreshold: envInt("TUTOR_COMPACTION_TURN_THRESHOLD", 24),
    charThreshold: envInt("TUTOR_COMPACTION_CHAR_THRESHOLD", 24_000),
    keepRecent: envInt("TUTOR_COMPACTION_KEEP_RECENT", HISTORY_MAX_TURNS),
    summaryMaxChars: envInt("TUTOR_COMPACTION_SUMMARY_MAX_CHARS", 2_000),
  };
}

/* ─────────────────────────────── thresholds ─────────────────────────────── */

export interface CompactionState {
  /** Total turns currently on the thread (learner + assistant + instructor). */
  totalTurns: number;
  /** Total characters across those turns' content (the char trigger). */
  totalChars: number;
  /** The current fold cursor (count of oldest turns already summarized). */
  compactedThroughTurn: number;
}

/** The fold plan: the half-open range [foldFrom, foldTo) of turns (0-based,
 *  created_at asc) to add to the summary this pass. Null when nothing new is
 *  eligible. */
export interface CompactionPlan {
  foldFrom: number;
  foldTo: number;
}

/**
 * The fold plan for a thread: fold everything from the current cursor up to
 * `totalTurns - keepRecent`, so the newest `keepRecent` turns stay verbatim.
 * Returns null when that range is empty (nothing new to fold).
 */
export function compactionPlan(state: CompactionState, cfg = compactionConfig()): CompactionPlan | null {
  const foldFrom = Math.max(0, state.compactedThroughTurn);
  const foldTo = state.totalTurns - cfg.keepRecent;
  if (foldTo <= foldFrom) return null;
  return { foldFrom, foldTo };
}

/**
 * Should this thread compact now? Only when there is a NON-EMPTY fold range
 * (turns beyond the keep window that aren't summarized yet) AND the thread has
 * crossed either the turn or the char threshold. The fold-range guard means a
 * thread just under `keepRecent` turns never compacts, and a thread already
 * folded up to its window never re-compacts until new turns arrive.
 */
export function shouldCompact(state: CompactionState, cfg = compactionConfig()): boolean {
  const plan = compactionPlan(state, cfg);
  if (!plan) return false;
  return state.totalTurns >= cfg.turnThreshold || state.totalChars >= cfg.charThreshold;
}

/* ─────────────────────────────── summarizer ─────────────────────────────── */

/** The summarizer SYSTEM prompt — a rolling conversation summary. Deliberately
 *  content-preserving: goals, what's been explained, misconceptions surfaced, and
 *  open threads, so a compacted thread keeps continuity. */
export const COMPACTION_SYSTEM_PROMPT =
  "You maintain a rolling summary of a tutoring conversation so its older turns can be dropped from context without losing continuity. " +
  "Given the PRIOR SUMMARY (may be empty) and the OLDER TURNS being folded in, produce ONE updated summary that preserves: the learner's goal and questions, what the tutor has already explained, any misconceptions or difficulties surfaced, decisions or examples used, and any open/unresolved threads. " +
  "Write terse third-person notes (not a transcript), no preamble, no headings. Do NOT invent facts not present in the summary or turns. Keep it under the length the request specifies.";

/**
 * Build the summarizer INPUT from the prior summary + the turns being folded.
 * Pure — the caller runs the model over `{ system: COMPACTION_SYSTEM_PROMPT,
 * input: buildCompactionInput(...) }`.
 */
export function buildCompactionInput(args: {
  existingSummary: string | null;
  foldedTurns: HistoryTurn[];
  summaryMaxChars: number;
}): string {
  const prior = args.existingSummary?.trim() || "(none yet)";
  const lines = args.foldedTurns.map((t) => {
    const name = t.role === "learner" ? "Learner" : t.role === "instructor" ? "Instructor" : "Tutor";
    return `${name}: ${t.content}`;
  });
  return [
    `Keep the updated summary under ${args.summaryMaxChars} characters.`,
    "",
    "PRIOR SUMMARY:",
    prior,
    "",
    "OLDER TURNS TO FOLD IN (oldest first):",
    lines.join("\n\n"),
  ].join("\n");
}

/** Clamp a model-produced summary to the configured cap (defensive — the prompt
 *  asks for it, but a summary must never blow the L4 budget). */
export function clampSummary(summary: string, summaryMaxChars: number): string {
  const clean = summary.trim();
  return clean.length <= summaryMaxChars ? clean : `${clean.slice(0, summaryMaxChars - 1).trimEnd()}…`;
}

/* ─────────────────────────────── L4 assembly ────────────────────────────── */

/** The label that fronts the folded-summary block in the model's L4 replay. */
export const COMPACTION_SUMMARY_LABEL = "Earlier in this conversation (summary of older turns):";

/**
 * Assemble the L4 replay text: the compaction summary (when present) followed by
 * the windowed verbatim replay of the recent turns. With no summary this is
 * exactly `serializeHistory` — so a thread that never compacted is byte-identical
 * to the pre-A4 behavior. The summary block is budgeted first (capped small), and
 * the remaining budget drives the replay window.
 */
export function assembleReplayWithSummary(
  turns: HistoryTurn[],
  compactionSummary: string | null,
  budgetChars: number
): string {
  const summary = compactionSummary?.trim();
  if (!summary) return serializeHistory(turns, budgetChars);
  const block = `${COMPACTION_SUMMARY_LABEL}\n${summary}`;
  const replayBudget = Math.max(0, budgetChars - block.length - 2);
  const replay = serializeHistory(turns, replayBudget);
  return replay ? `${block}\n\n${replay}` : block;
}
