/**
 * Visual ROUTER (spec §4) — decides the correct SOURCE/type for a needed visual,
 * in strict priority order:
 *
 *   1. programmatic diagram/chart  (preferred — accurate by construction)
 *   2. AI-generated diagram        (only when enabled AND not precision-critical)
 *   3. web-sourced image           (reserved; off by default; needs licensing)
 *   4. manual placeholder          (human authoring / review)
 *
 * Pure + deterministic, so the planner and the (future) pipeline can both consult
 * it and the test suite can pin the priority logic. The LIVE path is programmatic:
 * for almost every teaching visual a typed diagram renders it accurately, which is
 * exactly why image generation is OFF by default.
 */

import { matchDiagramTemplate } from "@/lib/course/diagram/catalog";
import type { DiagramKind, VisualRole } from "@/lib/course/diagram/types";
import { AI_VISUALS } from "./config";
import type { VisualSourceType } from "./types";

/** Roles that map to a canonical diagram kind even without an exact template. */
const ROLE_TO_KIND: Partial<Record<VisualRole, DiagramKind>> = {
  graph: "coordinate_plot",
  chart: "bar_chart",
  data_chart: "bar_chart",
  flowchart: "flowchart",
  timeline: "number_line",
  tree_or_graph: "graph_diagram",
  process: "flowchart",
  concept_map: "graph_diagram",
  system_map: "graph_diagram",
  spatial_example: "coordinate_plot",
  // worked_example / code_trace / concept_diagram / comparison → no single kind.
};

export interface RouteInput {
  role: VisualRole;
  /** Free text (title + teaching goal + expectedVisualType) for template matching. */
  topicText: string;
  mustBeAccurate?: boolean;
}

export interface VisualDecision {
  source: VisualSourceType;
  /** A catalog template id when the topic matched one (the accurate path). */
  templateId?: string;
  /** A diagram kind to author when the role maps to one without an exact template. */
  diagramKind?: DiagramKind;
  /** Whether the system can produce this NOW (vs a disabled/human path). */
  canRender: boolean;
  reason: string;
}

export function routeVisual(input: RouteInput): VisualDecision {
  if (!AI_VISUALS.enabled) {
    return { source: "upload", canRender: false, reason: "Visuals are disabled (AI_VISUALS_ENABLED=false)." };
  }

  // 1. PROGRAMMATIC — preferred, and the only ACCURATE path. Exact template first.
  if (AI_VISUALS.programmaticDiagrams) {
    const match = matchDiagramTemplate(input.topicText);
    if (match) {
      return {
        source: "programmatic",
        templateId: match.template.id,
        diagramKind: match.template.kind,
        canRender: true,
        reason: `A programmatic "${match.template.name}" diagram renders this accurately.`,
      };
    }
    const kind = ROLE_TO_KIND[input.role];
    if (kind) {
      return {
        source: "programmatic",
        diagramKind: kind,
        canRender: true,
        reason: `A programmatic ${kind.replace(/_/g, " ")} diagram fits this ${input.role} visual.`,
      };
    }
  }

  // 2. AI-GENERATED — only when enabled AND not accuracy-critical (an image model
  //    can't be trusted for exact labels/values; those MUST be programmatic).
  if (AI_VISUALS.imageGeneration && !input.mustBeAccurate) {
    return { source: "ai_generated", canRender: true, reason: "No programmatic template fits; an AI-generated diagram is acceptable for this conceptual visual." };
  }

  // 3. WEB — reserved (licensing/attribution). Off by default.
  if (AI_VISUALS.webImageSearch) {
    return { source: "web", canRender: false, reason: "Reserved for a licensed/open web image; requires review before insertion." };
  }

  // 4. MANUAL — no programmatic fit and generation disabled → human placeholder.
  return {
    source: "upload",
    canRender: false,
    reason: input.mustBeAccurate
      ? "Accuracy-critical and no programmatic template fits — needs a programmatic diagram or human authoring (image generation is disabled)."
      : "No programmatic template fits and image generation is disabled — staged as a manual placeholder for human review.",
  };
}
