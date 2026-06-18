/**
 * Deterministic mock ModelClient.
 *
 * Runs with NO API key, so the entire agent stack — loop, tools, change-set
 * staging, SSE streaming — is testable end-to-end without OpenAI. A test
 * supplies a `script` of turns (assistant text + the tool calls to emit); the
 * mock plays them in order and, once exhausted, returns a final text turn with
 * no tool calls (which ends the loop). Text is streamed word-by-word so the
 * streaming path is genuinely exercised.
 */

import type {
  ModelClient,
  ModelStreamEvent,
  ModelToolCall,
  ModelTurnParams,
  ModelTurnResult,
} from "../modelClient";

/** One scripted turn. `arguments` may be an object (stringified for you) or a
 *  raw JSON string (to test malformed input). */
export interface MockTurn {
  text?: string;
  toolCalls?: { name: string; arguments: unknown }[];
}

export interface MockOptions {
  model?: string;
  /** Text returned once the script is exhausted (the final, no-tool turn). */
  finalText?: string;
}

/** A mock client that also records every call's params — lets tests assert the
 *  per-phase reasoning effort + responseFormat the loop passed, with no key. */
export interface MockModelClient extends ModelClient {
  getCalls(): ModelTurnParams[];
}

let callSeq = 0;

function chunkWords(text: string): string[] {
  if (!text) return [];
  return text.match(/\S+\s*/g) ?? [text];
}

export function createMockModelClient(
  script: MockTurn[] = [],
  opts: MockOptions = {}
): MockModelClient {
  let turnIndex = 0;
  const model = opts.model ?? "mock-model";
  const calls: ModelTurnParams[] = [];

  return {
    model,
    getCalls: () => calls,
    async runTurn(
      params: ModelTurnParams,
      onEvent: (event: ModelStreamEvent) => void
    ): Promise<ModelTurnResult> {
      calls.push(params);
      const turn = script[turnIndex++];
      const text = turn?.text ?? (turn ? "" : opts.finalText ?? "All set — review the changes when you're ready.");

      for (const chunk of chunkWords(text)) {
        onEvent({ type: "text_delta", delta: chunk });
      }

      const toolCalls: ModelToolCall[] = (turn?.toolCalls ?? []).map((tc) => ({
        callId: `mock-call-${++callSeq}`,
        name: tc.name,
        arguments:
          typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
      }));
      for (const call of toolCalls) onEvent({ type: "tool_call", call });

      return {
        text,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      };
    },
  };
}
