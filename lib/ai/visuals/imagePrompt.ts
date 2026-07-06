/**
 * Derive an AI-image-generation prompt from a structured VisualSpec (spec §9).
 * Used only by the (flag-gated) AI-generated path; kept pure so it's testable.
 * The prompt is deliberately strict — required elements, forbidden elements,
 * accuracy + style constraints, no decoration, no invented data — because an
 * image model is the LAST resort (precision-critical visuals go programmatic).
 */

import type { VisualSpec } from "./types";

const DEFAULT_STYLE =
  "Flat, minimal, high-contrast educational vector style; a light neutral background; one accent color; large legible sans-serif labels readable at slide size; no 3D, no gradients, no clip-art, no photos.";

export function imagePromptFromSpec(spec: VisualSpec): string {
  const role = spec.visualRole.replace(/_/g, " ");
  const lines = [
    `Create a clean, accurate, educational ${role} for a course slide.`,
    `Teaching purpose: ${spec.pedagogicalPurpose}`,
  ];
  if (spec.requiredElements.length) lines.push(`MUST include, correctly labeled: ${spec.requiredElements.join("; ")}.`);
  if (spec.forbiddenElements?.length) lines.push(`Do NOT include: ${spec.forbiddenElements.join("; ")}.`);
  if (spec.accuracyRequirements?.length) lines.push(`Accuracy requirements: ${spec.accuracyRequirements.join("; ")}.`);
  lines.push(`Style: ${spec.styleRequirements?.length ? spec.styleRequirements.join("; ") : DEFAULT_STYLE}`);
  lines.push(
    "Hard constraints: no decorative elements; no extra or duplicated labels; do not invent data, quantities, or relationships beyond what is specified; no misleading shapes or directions (a curve that should slope up must slope up). Aspect ratio 4:3, generous margins."
  );
  return lines.join("\n");
}
