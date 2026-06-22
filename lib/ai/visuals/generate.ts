/**
 * The visual-GENERATION seam (spec §16–17, Phase 3). The LIVE path is
 * programmatic: a `diagram` slide is authored directly through the slide tools, so
 * its "asset" is the typed diagram in the slide content — no external call, no
 * storage, no blob URL. This module structures the OTHER paths (AI-generated /
 * web / upload), which are flag-gated OFF by default:
 *
 *  - `imageModelClient` is a PROVIDER-AGNOSTIC seam (like ModelClient). No SDK is
 *    imported here; a caller injects a client when AI_IMAGE_GENERATION_ENABLED.
 *  - With generation disabled (the default) — or no client, or an accuracy-critical
 *    spec — `generateVisualAsset` returns a MANUAL PLACEHOLDER asset flagged for
 *    human review. It is never counted as a satisfied required visual.
 *
 * Background/job execution (so several slow image calls don't block the agent
 * route) is the intended extension point: a caller can run these off the request
 * and patch the slide when an asset completes. Pure given a `now` timestamp.
 */

import { AI_VISUALS } from "./config";
import { imagePromptFromSpec } from "./imagePrompt";
import type { VisualAsset, VisualSpec, VisualValidationStatus } from "./types";

/** Provider-agnostic image client. Injected only on the enabled path. */
export interface ImageModelClient {
  generateImage(prompt: string, opts?: { aspectRatio?: string }): Promise<{ url: string; mimeType: string; width?: number; height?: number } | null>;
}

function assetBase(spec: VisualSpec, now: string): Omit<VisualAsset, "source" | "type" | "url" | "validationStatus"> {
  return {
    id: spec.id,
    courseId: spec.courseId,
    lessonId: spec.lessonId,
    deckBlockId: spec.deckBlockId,
    slideId: spec.slideId,
    slideSpecId: spec.slideSpecId,
    mimeType: "image/svg+xml",
    visualSpec: spec,
    altText: spec.altText,
    caption: spec.caption,
    createdAt: now,
    updatedAt: now,
  };
}

/** The placeholder produced when no asset can be generated now — a stable record
 *  the editor surfaces as "visual pending — needs you" (spec §16: a pending
 *  placeholder is clearly informed and NOT counted as a completed required visual). */
export function manualPlaceholderAsset(spec: VisualSpec, now: string, reason: string): VisualAsset {
  return {
    ...assetBase(spec, now),
    source: "upload",
    type: "illustration",
    url: "",
    mimeType: "",
    validationStatus: "pending",
    validationIssues: [reason],
  };
}

/**
 * Produce a visual asset for the AI-generated / web path. Returns a manual
 * placeholder when generation is disabled, no client is supplied, or the spec is
 * accuracy-critical (which must be programmatic, not image-generated). On the
 * enabled path the generated asset is marked `warning` (it still needs vision
 * validation — spec §10 — which is not implemented yet, so an accuracy-sensitive
 * visual stays flagged for human review rather than silently trusted).
 */
export async function generateVisualAsset(
  spec: VisualSpec,
  opts: { now: string; client?: ImageModelClient | null }
): Promise<VisualAsset> {
  const accuracyCritical = !!spec.accuracyRequirements?.length;
  if (!AI_VISUALS.enabled || !AI_VISUALS.imageGeneration) {
    return manualPlaceholderAsset(spec, opts.now, "Image generation is disabled — author a programmatic diagram or add the visual manually.");
  }
  if (accuracyCritical && AI_VISUALS.accuracyCriticalValidate) {
    return manualPlaceholderAsset(spec, opts.now, "Accuracy-critical visual — use a programmatic diagram instead of an AI image.");
  }
  if (!opts.client) {
    return manualPlaceholderAsset(spec, opts.now, "No image model client is configured.");
  }

  const prompt = imagePromptFromSpec(spec);
  const result = await opts.client.generateImage(prompt, { aspectRatio: "4:3" });
  if (!result) {
    return manualPlaceholderAsset(spec, opts.now, "Image generation returned nothing.");
  }
  // Without vision validation we cannot confirm the required elements appear, so a
  // generated diagram is a WARNING (needs human review), never silently "passed".
  const status: VisualValidationStatus = "warning";
  return {
    ...assetBase(spec, opts.now),
    source: "ai_generated",
    type: "illustration",
    url: result.url,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    license: { type: "generated" },
    validationStatus: status,
    validationIssues: ["AI-generated — vision validation not yet implemented; review the visual for accuracy."],
  };
}
