/**
 * The LIVE image-generation prompt builder + intent hash + reference verification.
 *
 * This is the path the `add_image` tool actually uses (via the VisualGenContext in
 * agentLoop.ts) — distinct from the dead router scaffolding in imagePrompt.ts. Two
 * parts (spec §9, refined 2026-06-25):
 *   (a) a SHARED STYLE PREAMBLE prepended to every image so a course looks cohesive
 *       AND every image reads as a clean, academic TEXTBOOK figure — the standard,
 *       conventional way the concept is taught, never decorative art.
 *   (b) a PER-IMAGE spec by visualWeight: a `reference` image emits the axes /
 *       labels / annotations verbatim (quoted) so the figure is accurate; a
 *       `supporting` image gets a looser-but-still-academic conceptual prompt.
 *
 * `imageIntentHash` freezes an accepted asset: regeneration only happens when the
 * intent actually changes (not on an unrelated bullet edit).
 *
 * Pure (no SDK, no React); `verifyReferenceImage` takes an injected ModelClient.
 */

import type { GeneratedImage, JsonSchema, ModelClient } from "../modelClient";
import type { VisualWeight } from "./config";

/** The shared style preamble — prepended to EVERY generated image. Frames the
 *  image as a clean academic textbook figure (refinement: textbook, not art). */
export const STYLE_PREAMBLE =
  "A clean, flat, modern educational diagram in the style of a premium textbook — a clear, academic teaching figure that depicts the concept the STANDARD, conventional way it is taught (a labeled diagram, a standard chart, an academic figure), NOT a decorative or stylized scene. " +
  "Minimal vector illustration, generous whitespace. No photorealism, no 3D, no drop shadows, no decorative background. Crisp thin lines. " +
  "Limited palette: warm orange, slate blue, and charcoal text on a light ground. All text large, legible, sans-serif, spelled EXACTLY as specified. " +
  "Even margins so nothing is clipped at the edges. Do not add any text beyond the labels listed.";

/** Self-contained builder input (the add_image tool maps its args → this; the
 *  PLAN's structured imageSpec is relayed here for a reference image). */
export interface ImagePromptSpec {
  visualWeight: VisualWeight;
  /** The model's scene / description of what to draw. */
  prompt: string;
  /** Reference-only: the structured figure spec for an accurate textbook figure. */
  subject?: string;
  requiredLabels?: string[];
  axes?: { x?: string; y?: string };
  annotations?: string[];
}

/** Build the full gpt-image-2 prompt: shared preamble + the per-weight spec. */
export function buildImagePrompt(spec: ImagePromptSpec): string {
  const lines: string[] = [STYLE_PREAMBLE, ""];
  const scene = spec.prompt.trim();
  if (spec.visualWeight === "reference") {
    lines.push(`Subject: ${spec.subject?.trim() || scene || "an educational figure"}.`);
    const labels = (spec.requiredLabels ?? []).map((l) => l.trim()).filter(Boolean);
    if (labels.length) lines.push(`Required labels, render EXACTLY (verbatim): ${labels.map((l) => `"${l}"`).join(", ")}.`);
    if (spec.axes?.x) lines.push(`X axis: "${spec.axes.x.trim()}".`);
    if (spec.axes?.y) lines.push(`Y axis: "${spec.axes.y.trim()}".`);
    const ann = (spec.annotations ?? []).map((a) => a.trim()).filter(Boolean);
    if (ann.length) lines.push(`Show, clearly: ${ann.join("; ")}.`);
    if (scene && scene !== spec.subject?.trim()) lines.push(scene);
    lines.push("Add NO text beyond the labels listed above; spell each EXACTLY.");
  } else {
    lines.push(
      `A clean, textbook-style conceptual figure representing ${spec.subject?.trim() || scene || "the concept"} the standard way it is taught. Minimal or no text.`
    );
    if (scene && scene !== spec.subject?.trim()) lines.push(scene);
  }
  return lines.join("\n");
}

/** A stable, dependency-free string hash (cyrb53) — for the intent freeze. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Hash of the VISUAL INTENT an image was generated from. Stored on the slide so an
 *  unrelated text edit never regenerates a different picture (freeze-on-accept):
 *  regeneration is warranted only when this hash changes. */
export function imageIntentHash(spec: ImagePromptSpec): string {
  const norm = {
    w: spec.visualWeight,
    p: spec.prompt.trim(),
    s: spec.subject?.trim() ?? "",
    l: (spec.requiredLabels ?? []).map((l) => l.trim()).filter(Boolean),
    x: spec.axes?.x?.trim() ?? "",
    y: spec.axes?.y?.trim() ?? "",
    a: (spec.annotations ?? []).map((a) => a.trim()).filter(Boolean),
  };
  return cyrb53(JSON.stringify(norm));
}

const LABEL_VERDICT_SCHEMA: { name: string; schema: JsonSchema } = {
  name: "label_check",
  schema: {
    type: "object",
    properties: {
      ok: { type: "boolean", description: "True only if EVERY required label is clearly present and legible." },
      missing: { type: "array", items: { type: "string" }, description: "Required labels that are missing or illegible." },
    },
    required: ["ok", "missing"],
    additionalProperties: false,
  },
};

/**
 * Vision-verify a REFERENCE image's required labels are present + legible. Returns
 * true to ACCEPT (incl. when there's nothing to check or the verifier is
 * unavailable/errors — we never punish a good image for a verifier outage); false
 * only when the vision model affirmatively reports a missing/illegible label.
 */
export async function verifyReferenceImage(
  model: Pick<ModelClient, "inspectImage">,
  image: GeneratedImage,
  requiredLabels: string[],
  signal?: AbortSignal
): Promise<boolean> {
  const labels = requiredLabels.map((l) => l.trim()).filter(Boolean);
  if (labels.length === 0 || !model.inspectImage) return true;
  const instruction =
    "You are checking a generated educational figure for a course slide. " +
    `These text labels MUST appear, spelled exactly and legibly: ${labels.map((l) => `"${l}"`).join(", ")}. ` +
    "Respond ONLY as JSON {ok, missing} — ok=true only when EVERY required label is clearly present.";
  const res = await model.inspectImage({
    base64: image.base64,
    mimeType: image.mimeType,
    instruction,
    responseFormat: LABEL_VERDICT_SCHEMA,
    signal,
  });
  if (!res) {
    // Fail OPEN (accept), but surface it — a silently-broken verifier would disable
    // label-checking unnoticed.
    console.warn(JSON.stringify({ tag: "ai_visual_verify", outcome: "verifier_unavailable", labels: labels.length }));
    return true;
  }
  try {
    const v = JSON.parse(res.text) as { ok?: unknown };
    return v?.ok === true;
  } catch {
    console.warn(JSON.stringify({ tag: "ai_visual_verify", outcome: "unparseable_verdict", labels: labels.length }));
    return true; // unparseable verdict → don't block
  }
}
