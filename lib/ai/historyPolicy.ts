/**
 * History policy + bounded-input assembly.
 *
 * The agent loop used to replay the ENTIRE tool transcript every turn, so input
 * grew unbounded across a generation. The bounded policy instead sends, each turn:
 *   [ static system + tools ]            ← unchanged, cacheable (passed separately)
 *   [ developer: course/lesson context ] ← stable, cacheable
 *   [ developer: generation-state summary ] ← current TRUTH of the doc, compact
 *   [ last K chat messages ]             ← the instruction + recent conversation
 *   [ last K tool turn-groups ]          ← immediate working context, compacted
 * Older tool calls/outputs are dropped — the generation-state summary represents
 * what they built. DB persistence is untouched (full results are saved for the
 * change-set + cross-run history); bounding happens only at REPLAY time.
 */

import type { ModelInputItem } from "./modelClient";

export type HistoryPolicy =
  | { mode: "full" }
  | {
      mode: "bounded";
      /** How many recent TOOL turn-groups (one model turn's calls+outputs) to keep. */
      keepRecentToolEvents: number;
      /** How many recent chat (user/assistant) messages to keep. */
      keepRecentChatMessages: number;
      /** Cap each kept tool result at this many chars (compacted first). */
      maxToolResultChars: number;
      /** Cap the injected generation-state summary at this many chars. */
      maxStateSummaryChars: number;
      /** Inject the deterministic generation-state summary as a developer message. */
      includeGenerationState: boolean;
    };

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** The default policy from env. BOUNDED by default; `AI_HISTORY_POLICY=full` is
 *  the escape hatch (and the byte-identical legacy behavior). Tuned for GENERATE:
 *  state-heavy, small chat window. */
export function defaultHistoryPolicy(): HistoryPolicy {
  if ((process.env.AI_HISTORY_POLICY ?? "bounded").toLowerCase() === "full") return { mode: "full" };
  return {
    mode: "bounded",
    keepRecentToolEvents: num(process.env.AI_KEEP_RECENT_TOOL_EVENTS, 4),
    keepRecentChatMessages: num(process.env.AI_KEEP_RECENT_CHAT_MESSAGES, 3),
    maxToolResultChars: num(process.env.AI_MAX_TOOL_RESULT_CHARS, 4000),
    // Headroom so a ~12-slide deck's built-slide listing (which tells the model
    // what NOT to rebuild) + the remaining-spec line both survive uncapped. The
    // plan briefs themselves ride verbatim in the context message, never here.
    maxStateSummaryChars: num(process.env.AI_MAX_STATE_SUMMARY_CHARS, 12000),
    includeGenerationState: true,
  };
}

/** The EDIT path's policy: a LARGER chat window + tool-result cap (so a multi-turn
 *  edit keeps the user's recent intent, and a just-read block isn't truncated
 *  mid-content), and NO generation-state summary — edits are scoped to exactly
 *  what the user asks, grounding already comes from the context message's
 *  existing-blocks list, and an open-issues list would nudge unrelated "fixes".
 *  Inherits the global `full` override and the GENERATE tool-event/state caps.
 *  Env: AI_EDIT_KEEP_RECENT_CHAT_MESSAGES / AI_EDIT_MAX_TOOL_RESULT_CHARS. */
export function editHistoryPolicy(): HistoryPolicy {
  const base = defaultHistoryPolicy();
  if (base.mode === "full") return base;
  return {
    ...base,
    keepRecentChatMessages: num(process.env.AI_EDIT_KEEP_RECENT_CHAT_MESSAGES, 8),
    maxToolResultChars: num(process.env.AI_EDIT_MAX_TOOL_RESULT_CHARS, 12000),
    includeGenerationState: false,
  };
}

function isRoleItem(it: ModelInputItem): it is { role: "user" | "assistant" | "developer"; content: string } {
  return "role" in it;
}

/**
 * Compact one tool result at REPLAY time. Write tools already return tiny id
 * payloads (near no-op). The bulky ones are read tools — `get_deck` is reduced to
 * a slide skeleton (full content lives in the doc / one `get_slide`); anything
 * over the cap is truncated. DB keeps the full result for the change-set.
 */
export function compactToolResult(toolName: string | undefined, output: string, maxChars: number): string {
  if (toolName === "get_deck") {
    try {
      const data = JSON.parse(output) as unknown;
      const slides = Array.isArray(data)
        ? data
        : (data as { slides?: unknown[] } | null)?.slides;
      if (Array.isArray(slides)) {
        const lean = slides.map((s) => {
          const o = s as Record<string, unknown>;
          return { slideId: o.slideId ?? o.id, layout: o.layout };
        });
        return JSON.stringify({
          note: "compacted — full slide content omitted; call get_slide for one slide's exact content",
          slides: lean,
        });
      }
    } catch {
      /* fall through to generic truncation */
    }
  }
  return output.length <= maxChars ? output : output.slice(0, maxChars) + "…(truncated)";
}

function approxChars(items: ModelInputItem[]): number {
  let n = 0;
  for (const it of items) {
    if (isRoleItem(it)) n += it.content.length;
    else if (it.type === "function_call") n += it.name.length + it.arguments.length;
    else n += it.output.length;
  }
  return n;
}

export interface BoundedInputResult {
  input: ModelInputItem[];
  stats: {
    originalMessages: number;
    compactedMessages: number;
    originalApproxChars: number;
    compactedApproxChars: number;
    keptToolEvents: number;
    stateSummaryChars: number;
  };
}

export interface ScopedInputResult {
  input: ModelInputItem[];
  stats: { messages: number; approxChars: number; stateSummaryChars: number; toolEvents: number };
}

/**
 * Assemble the SCOPED model input for GENERATE / REPAIR: built FROM SCRATCH each
 * turn out of exactly three things —
 *   [ developer: course/lesson context + the full PLAN verbatim ]
 *   [ developer: deterministic generation-state (built / remaining specs) ]
 *   [ this run's own tool I/O ]            ← NOT cross-conversation history
 * and NOTHING else. The conversation transcript (which for a module build grew to
 * ~854 messages) is NEVER loaded, so it can never dilute or bury the plan, and
 * there is nothing to compact/summarize — the plan rides in the context message
 * intact, every turn. This is the fix for "the detailed plan does not survive →
 * the author works from a thin summary → coverage reads 0".
 *
 * `eventGroups` is THIS run's accumulation only (one entry per model turn). A bulky
 * read result (get_deck) is still trimmed — its content is already in the
 * generation-state summary — but write-tool I/O (tiny id payloads) passes verbatim.
 */
export function buildScopedAgentInput(args: {
  contextMessage: string | null;
  generationStateSummary?: string;
  eventGroups: ModelInputItem[][];
  maxToolResultChars: number;
}): ScopedInputResult {
  const out: ModelInputItem[] = [];
  if (args.contextMessage) out.push({ role: "developer", content: args.contextMessage });
  if (args.generationStateSummary) out.push({ role: "developer", content: args.generationStateSummary });

  const flat = args.eventGroups.flat();
  const nameByCallId = new Map<string, string>();
  for (const it of flat) if (!isRoleItem(it) && it.type === "function_call") nameByCallId.set(it.callId, it.name);

  let toolEvents = 0;
  for (const it of flat) {
    if (!isRoleItem(it) && it.type === "function_call_output") {
      toolEvents += 1;
      out.push({ ...it, output: compactToolResult(nameByCallId.get(it.callId), it.output, args.maxToolResultChars) });
    } else {
      out.push(it);
    }
  }

  return {
    input: out,
    stats: { messages: out.length, approxChars: approxChars(out), stateSummaryChars: args.generationStateSummary?.length ?? 0, toolEvents },
  };
}

/**
 * Assemble the bounded model input. `eventGroups` is this run's accumulation, one
 * entry per model turn (`[assistant-text?, ...function_call, ...function_call_output]`),
 * so slicing keeps `function_call`/`function_call_output` pairs intact.
 */
export function buildBoundedAgentInput(args: {
  contextMessage: string | null;
  generationStateSummary?: string;
  history: ModelInputItem[];
  eventGroups: ModelInputItem[][];
  keepRecentToolEvents: number;
  keepRecentChatMessages: number;
  maxToolResultChars: number;
}): BoundedInputResult {
  const { contextMessage, generationStateSummary, history, eventGroups } = args;

  const out: ModelInputItem[] = [];
  if (contextMessage) out.push({ role: "developer", content: contextMessage });
  if (generationStateSummary) out.push({ role: "developer", content: generationStateSummary });

  // Recent chat (the instruction + recent turns); drop stale tool items from
  // prior runs — the generation-state summary represents their effect.
  const chat = history.filter(isRoleItem).slice(-args.keepRecentChatMessages);
  out.push(...chat);

  // callId → tool name, for compacting outputs (the name lives on the call item).
  const nameByCallId = new Map<string, string>();
  for (const it of [...history, ...eventGroups.flat()]) {
    if (!isRoleItem(it) && it.type === "function_call") nameByCallId.set(it.callId, it.name);
  }

  const tail = eventGroups.slice(-args.keepRecentToolEvents).flat();
  let keptToolEvents = 0;
  for (const it of tail) {
    if (!isRoleItem(it) && it.type === "function_call_output") {
      keptToolEvents += 1;
      out.push({ ...it, output: compactToolResult(nameByCallId.get(it.callId), it.output, args.maxToolResultChars) });
    } else {
      out.push(it);
    }
  }

  const original = [
    ...(contextMessage ? [{ role: "developer" as const, content: contextMessage }] : []),
    ...history,
    ...eventGroups.flat(),
  ];
  return {
    input: out,
    stats: {
      originalMessages: original.length,
      compactedMessages: out.length,
      originalApproxChars: approxChars(original),
      compactedApproxChars: approxChars(out),
      keptToolEvents,
      stateSummaryChars: generationStateSummary?.length ?? 0,
    },
  };
}
