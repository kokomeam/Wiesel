/**
 * The router-facing VisualSpec + VisualAsset (spec §3, §7). These are the FULL,
 * id-bearing records the visual pipeline routes, generates/fetches, validates,
 * stores, and inserts — distinct from the trimmed `VisualSpec` that travels on a
 * `diagram` slide (lib/course/diagram/types). For the LIVE programmatic path the
 * diagram IS the asset (it rides in the slide content), so these types primarily
 * structure the (flag-gated) AI-generated / web-sourced / uploaded paths and give
 * the whole pipeline a stable shape to grow into.
 */

import type { VisualPlacement, VisualRole } from "@/lib/course/diagram/types";

export type { VisualPlacement, VisualRole, VisualSourceType } from "@/lib/course/diagram/types";

/** The concrete kind of visual asset (spec §3 `VisualSpec.type`). */
export type VisualType =
  | "programmatic_diagram"
  | "programmatic_chart"
  | "ai_generated_diagram"
  | "ai_generated_illustration"
  | "web_sourced_image"
  | "user_uploaded_image";

export type VisualValidationStatus = "pending" | "passed" | "warning" | "failed";

/** AI envelope mirroring the document model's AIMeta, scoped to a visual. */
export interface VisualAIMeta {
  purpose: string;
  editable: boolean;
  allowedActions: string[];
  semanticTags: string[];
}

/** The full structured visual spec — the source of truth for generating,
 *  validating, editing, and placing a visual (spec §3). */
export interface VisualSpec {
  id: string;
  courseId: string;
  lessonId: string;
  deckBlockId: string;
  slideId: string;
  slideSpecId: string;

  type: VisualType;
  visualRole: VisualRole;

  title: string;
  pedagogicalPurpose: string;
  requiredElements: string[];
  forbiddenElements?: string[];
  accuracyRequirements?: string[];
  styleRequirements?: string[];
  placement: VisualPlacement;

  caption?: string;
  altText: string;

  /** AI-image path: the prompt derived from this spec. */
  generationPrompt?: string;
  /** Programmatic path: the diagram template id (lib/course/diagram/catalog). */
  programmaticTemplateId?: string;
  /** Web path: the search query. */
  sourceQuery?: string;

  validation: { required: boolean; mustPassBeforeInsert: boolean };
  ai: VisualAIMeta;
}

/** A produced/located visual asset (spec §7). For programmatic diagrams the
 *  "asset" is the typed diagram embedded in the slide; this record is used by the
 *  image / web / upload paths and to track validation + licensing. */
export interface VisualAsset {
  id: string;
  courseId: string;
  lessonId: string;
  deckBlockId: string;
  slideId: string;
  slideSpecId: string;

  source: "programmatic" | "ai_generated" | "web" | "upload";
  type: "diagram" | "graph" | "chart" | "illustration" | "screenshot" | "photo";

  url: string;
  storagePath?: string;
  mimeType: string;
  width?: number;
  height?: number;

  visualSpec: VisualSpec;
  altText: string;
  caption?: string;

  license?: {
    type: "generated" | "public_domain" | "creative_commons" | "licensed" | "unknown";
    attribution?: string;
    sourceUrl?: string;
  };

  validationStatus: VisualValidationStatus;
  validationIssues?: string[];

  createdAt: string;
  updatedAt: string;
}
