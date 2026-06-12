/**
 * THE LLM SEAM.
 *
 * `requestAIPatches` is the single function the editor calls to turn a
 * natural-language command into course patches. Today it delegates to the
 * deterministic rule table in rules.ts after a short artificial delay.
 *
 * To wire a real LLM, replace the body with:
 *
 *   const res = await fetch("/api/ai/command", {
 *     method: "POST",
 *     body: JSON.stringify({
 *       prompt: req.prompt,
 *       selection: req.selection,
 *       manifest: componentManifest,   // what components/actions exist
 *       doc: req.doc,                  // or a trimmed slice around the selection
 *     }),
 *   });
 *   const patches = z.array(CoursePatchSchema).parse(await res.json());
 *
 * Nothing else changes: callers already treat the response as untrusted —
 * every patch is re-validated by the store before it is applied.
 */

import { buildResponse, type AICommandRequest, type AICommandResponse } from "./rules";

export type { AICommandRequest, AICommandResponse };

const THINKING_MS = 450;

export async function requestAIPatches(
  req: AICommandRequest
): Promise<AICommandResponse> {
  await new Promise((resolve) => setTimeout(resolve, THINKING_MS));
  return buildResponse(req);
}
