/**
 * The single place `data-ai-*` attributes are constructed.
 *
 * Every meaningful editor element spreads `aiAttrs(...)` so an AI agent can
 * inspect the DOM alone and recover the course structure: what each node is,
 * its stable id, its parent, and which patch actions may target it.
 * Action lists and purposes default from the component manifest so callers
 * never hand-type them.
 */

import { componentManifest, type ComponentTypeName } from "./manifest";

export interface AIAttrInput {
  /** Coarse role in the editor, e.g. "course-outline-item", "lesson-block". */
  component: string;
  /** Manifest type name, e.g. "lesson", "quiz", "slide". */
  type: ComponentTypeName;
  id: string;
  parentId?: string;
  order?: number;
  /** Overrides the manifest description. */
  purpose?: string;
  /** Accessible name, e.g. `Quiz block: Two Pointers Basics`. */
  label: string;
  /** Set true for natively interactive elements (button etc.) that already
   *  have an implicit role — skips the role="group" fallback. */
  interactive?: boolean;
}

export interface ToolAttrInput {
  /** Stable tool id, e.g. "insert-image", "toggle-inspector". */
  tool: string;
  /** Patch action (or UI verb) the tool performs, e.g. "ADD_SLIDE_ELEMENT". */
  action: string;
  /** What the tool operates on, e.g. "slide", "slide_element", "panel". */
  targetType?: string;
  /** Accessible name, e.g. "Insert image into selected slide". */
  label: string;
}

/** Machine-readable attributes for toolbar buttons, tabs, and panel toggles —
 *  the interactive chrome, as opposed to document nodes (use aiAttrs). */
export function toolAttrs(t: ToolAttrInput) {
  return {
    "data-ai-tool": t.tool,
    "data-ai-action": t.action,
    ...(t.targetType !== undefined && { "data-ai-target-type": t.targetType }),
    "aria-label": t.label,
  };
}

export function aiAttrs(n: AIAttrInput) {
  const entry = componentManifest[n.type];
  return {
    "data-ai-component": n.component,
    "data-ai-type": n.type,
    "data-ai-id": n.id,
    ...(n.parentId !== undefined && { "data-ai-parent-id": n.parentId }),
    "data-ai-actions": entry.allowedActions.join(","),
    "data-ai-purpose": n.purpose ?? entry.description,
    ...(n.order !== undefined && { "data-ai-order": String(n.order) }),
    "aria-label": n.label,
    ...(!n.interactive && { role: "group" as const }),
  };
}
