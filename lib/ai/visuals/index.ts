/**
 * Visual pipeline (spec §1–§20). The LIVE path is programmatic diagrams
 * (lib/course/diagram + the add_diagram tool); this package holds the
 * pipeline ARCHITECTURE: config flags, the full VisualSpec/VisualAsset records,
 * the source router, the image-prompt builder, and the flag-gated generation
 * seam (AI-image / web / upload — OFF by default).
 */

export { AI_VISUALS, type AiVisualsConfig } from "./config";
export type { VisualAsset, VisualSpec, VisualType, VisualValidationStatus, VisualAIMeta } from "./types";
export { routeVisual, type RouteInput, type VisualDecision } from "./router";
export { imagePromptFromSpec } from "./imagePrompt";
export { generateVisualAsset, manualPlaceholderAsset, type ImageModelClient } from "./generate";
