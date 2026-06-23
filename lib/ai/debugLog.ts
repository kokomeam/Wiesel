/**
 * Diagnostic logging for the content agent's hard-to-see failure paths — slide
 * rejections ("missing content"), truncated tool-call JSON, and reference-
 * resolution failures (get_block "not found"). These paths previously only
 * surfaced a SUMMARIZED string to the model (never the raw Zod error / payload /
 * finish_reason server-side), so the actual cause was invisible in telemetry.
 *
 * ON by default so we capture the data going forward; set `AI_DEBUG_AGENT=false`
 * to silence. Each call is one structured JSON line (grep the `tag`).
 */

const ENABLED = process.env.AI_DEBUG_AGENT !== "false";

export function debugAgent(tag: string, payload: Record<string, unknown>): void {
  if (!ENABLED) return;
  try {
    console.log(JSON.stringify({ tag, ...payload }));
  } catch {
    /* never let a debug log throw */
  }
}

/** A length-capped JSON preview of a value (so a log line stays bounded but shows
 *  enough to see whether fields are empty/malformed/cut off mid-JSON). */
export function previewJson(value: unknown, max = 1200): { preview: string; length: number } {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return { preview: s.length > max ? `${s.slice(0, max)}…(+${s.length - max} more)` : s, length: s.length };
}
