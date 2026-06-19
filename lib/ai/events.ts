/**
 * The normalized agent → browser event protocol (streamed as SSE).
 *
 * ONE payload vocabulary drives BOTH the chat transcript and the editor's live
 * highlights / changes panel: each `tool_result` carries the affected block id
 * + a human-readable summary, so the model narrates what it changed AND the UI
 * renders highlights from the exact same data.
 */

import type { LessonOutline, ModuleSkeleton } from "./outline";

/** A planned artifact awaiting approval — a single lesson's full deck outline, or
 *  a whole module's COMPACT SKELETON (the lesson map; rich per-lesson contracts are
 *  planned lazily after approval). Transient: it round-trips back to
 *  /api/ai/agent/plan on approve, never persisted. */
export type PlanOutline =
  | { kind: "lesson"; lessonId: string; outline: LessonOutline }
  | { kind: "module"; skeleton: ModuleSkeleton };

export type AgentEvent =
  /** Sent once at the start so the client can persist/track the thread. */
  | { type: "conversation"; conversationId: string }
  /** Which phase of the content pipeline the agent is in (drives the sidebar
   *  indicator). `detail` carries per-lesson progress in a module build, e.g.
   *  "Linked lists (2/4)". Absent for the single-turn edit path's phase log.
   *  `validate` = checking the deck against the plan; `repair` = fixing hard
   *  failures; `review` = the optional light review. `critique_skipped` (with a
   *  `reason`) is emitted when the legacy CRITIQUE is disabled by config. */
  | {
      type: "phase";
      phase: "plan" | "generate" | "validate" | "repair" | "review" | "critique" | "critique_skipped";
      detail?: string;
      reason?: string;
    }
  /** A VALIDATION pass result — the calm progress lines ("Found 4 missing planned
   *  slides. Repairing…", "Removed 1 placeholder slide.", "Final validation
   *  passed."). `ok` true once the contract is satisfied. */
  | {
      type: "validation";
      ok: boolean;
      message: string;
      missingSlides: number;
      placeholdersRemoved: number;
      repaired: boolean;
      /** Set when the run stopped on a budget/turn cap before the contract was met. */
      incomplete?: boolean;
    }
  /** Deterministic lint warnings + optional light-review suggestions — surfaced as
   *  calm, OPTIONAL improvements (never block staging). */
  | {
      type: "quality_report";
      warnings: { code: string; message: string; slideId?: string }[];
      suggestions: { title: string; detail: string }[];
    }
  /** The PLAN phase produced an outline awaiting the creator's approval. */
  | { type: "plan_outline"; plan: PlanOutline }
  /** A fragment of the assistant's streaming chat message. */
  | { type: "assistant_delta"; text: string }
  /** The model began a tool call (args may still be streaming). */
  | { type: "tool_start"; toolCallId: string; tool: string }
  /** A tool finished — drives the "done" card AND the editor highlight. */
  | {
      type: "tool_result";
      toolCallId: string;
      tool: string;
      ok: boolean;
      /** One-line, human-readable description of what changed. */
      summary: string;
      blockId?: string;
      blockType?: string;
      lessonId?: string;
    }
  /** A DESTRUCTIVE action (delete a module/lesson) needs the user's explicit
   *  go-ahead. The agent is PAUSED until they confirm or cancel via the popup;
   *  the client echoes these fields back to /api/ai/agent/confirm to resume. */
  | {
      type: "confirmation_request";
      toolCallId: string;
      /** The placeholder tool message to finalize when the user decides. */
      toolMessageId: string;
      kind: "module" | "lesson";
      /** Human label for the dialog, e.g. "Module 2: Graphs". */
      label: string;
      /** The CoursePatch applied iff confirmed (re-validated server-side). */
      patch: unknown;
    }
  /** This turn's mutations were grouped into a reviewable change-set. */
  | { type: "change_set"; changeSetId: string; count: number; summary?: string }
  /** A very large job paused at a safe point and can be continued. */
  | { type: "checkpoint"; reason: string; completedSteps: number }
  /** The settled final assistant message for the turn (full text). */
  | { type: "assistant_message"; content: string }
  | { type: "error"; message: string }
  /** Terminal event for the stream. */
  | { type: "done" };

export type AgentEventType = AgentEvent["type"];

/** Encode one event as an SSE frame. */
export function encodeSSE(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Parse one SSE `data:` line into an AgentEvent (browser-side helper). */
export function decodeSSE(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  try {
    return JSON.parse(trimmed.slice(5).trim()) as AgentEvent;
  } catch {
    return null;
  }
}
