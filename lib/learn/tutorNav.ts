/**
 * TUTOR-1 Amendment A4, Wave 4 — learner-facing navigation helpers (client-safe,
 * ZOD-FREE — the learn bundle stays schema-free).
 *
 *   • no INTERNAL IDs ever reach a learner (D-7 / A4-22): `hasInternalId` /
 *     `redactInternalIds` scrub UUIDs from any learner-facing string.
 *   • AT MOST ONE navigation affordance per message (A4-24): `primaryNavAffordance`
 *     picks the single best citation + its human LABEL (its destination name —
 *     never an id), so a "Go there" chip always names where it goes (D-8 / A4-23).
 */

import type { TutorCitation } from "@/lib/learn/tutorClientTypes";

/** A UUID (any version). We never render one to a learner. Fresh instance per use
 *  (a /g regex is stateful across `.test`). */
function uuidRe(): RegExp {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
}

/** Does the text contain an internal identifier (a UUID)? */
export function hasInternalId(text: string): boolean {
  return uuidRe().test(text);
}

/** Scrub UUIDs from a learner-facing string — replace each with a neutral phrase
 *  (defense in depth; the model is also instructed never to reveal ids). */
export function redactInternalIds(text: string): string {
  return text.replace(uuidRe(), "the referenced lesson");
}

/** The ONE navigation affordance a message renders (A4-24), or null when there is
 *  no citation to navigate to. `label` is the destination NAME (never an id):
 *  the server-resolved citation label, else a neutral fallback. */
export interface NavAffordance {
  citation: TutorCitation;
  /** The button text destination name (id-free). */
  label: string;
  /** True → an in-place "Show me" jump within the active lesson; false → navigate. */
  sameLesson: boolean;
}

export function primaryNavAffordance(
  citations: TutorCitation[],
  opts: { activeLessonId: string | null }
): NavAffordance | null {
  // The first citation with a real block anchor is the primary (server already
  // dropped unresolvable ones + deduped; we still guard blockId).
  const primary = citations.find((c) => !!c.blockId);
  if (!primary) return null;
  const rawLabel = typeof primary.label === "string" ? primary.label.trim() : "";
  // Never show an id-shaped label; fall back to a neutral destination name.
  const label = rawLabel && !hasInternalId(rawLabel) ? rawLabel : "the referenced passage";
  return { citation: primary, label, sameLesson: opts.activeLessonId != null && primary.lessonId === opts.activeLessonId };
}
