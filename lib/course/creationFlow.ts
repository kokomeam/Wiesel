/**
 * Guided creation flow — a familiar Plan → Create → Publish progression with a
 * live checklist, derived purely from the CourseDocument. Pure + render-safe
 * (no id generation, no store access).
 *
 * IMPORTANT: nothing here gates a *learner*. The only readiness signal is
 * `readyToPublish`, which gates the creator's Publish action — never a learner's
 * progress through the course.
 */

import type { CourseDocument } from "./types";

export type FlowPhase = "plan" | "create" | "publish";

export interface ChecklistItem {
  id: string;
  label: string;
  phase: FlowPhase;
  done: boolean;
}

export interface CreationFlowState {
  items: ChecklistItem[];
  /** Earliest phase with an unfinished item, or "publish" when all are done. */
  phase: FlowPhase;
  doneCount: number;
  total: number;
  /** Publish minimums: a course title and ≥1 lesson with content. */
  readyToPublish: boolean;
}

const PHASE_ORDER: FlowPhase[] = ["plan", "create", "publish"];

export const PHASE_META: Record<FlowPhase, { label: string; hint: string }> = {
  plan: { label: "Plan", hint: "Outline & goals" },
  create: { label: "Create content", hint: "Slides, lessons, checks" },
  publish: { label: "Publish", hint: "Review & go live" },
};

export function computeCreationFlow(doc: CourseDocument): CreationFlowState {
  const lessons = doc.modules.flatMap((m) => m.lessons);
  const hasTitle = doc.title.trim().length > 0;
  const hasDescription = !!doc.description && doc.description.trim().length > 0;
  const hasModuleWithLesson = doc.modules.some((m) => m.lessons.length > 0);
  const hasContent = lessons.some((l) => l.blocks.length > 0);
  const hasKnowledgeCheck = lessons.some((l) => l.blocks.some((b) => b.type === "quiz"));

  const readyToPublish = hasTitle && hasContent;

  const items: ChecklistItem[] = [
    { id: "title", label: "Name your course", phase: "plan", done: hasTitle },
    { id: "describe", label: "Write a short description", phase: "plan", done: hasDescription },
    { id: "outline", label: "Build your outline", phase: "plan", done: hasModuleWithLesson },
    { id: "content", label: "Add lesson content", phase: "create", done: hasContent },
    {
      id: "knowledge-check",
      label: "Add a knowledge check",
      phase: "create",
      done: hasKnowledgeCheck,
    },
    { id: "publish", label: "Ready to publish", phase: "publish", done: readyToPublish },
  ];

  let phase: FlowPhase = "publish";
  for (const p of PHASE_ORDER) {
    if (items.some((i) => i.phase === p && !i.done)) {
      phase = p;
      break;
    }
  }

  return {
    items,
    phase,
    doneCount: items.filter((i) => i.done).length,
    total: items.length,
    readyToPublish,
  };
}
