"use server";

/**
 * Creator Tutor Console server actions (TUTOR-1 Wave 5, P5.1).
 *
 *   setTutorEnabledAction        — flip tutor_course_settings.enabled. The tutor
 *                                  is ON BY DEFAULT (no row ⇒ enabled), so this is
 *                                  an opt-OUT switch: enabling and disabling both
 *                                  just upsert the row — NEITHER is gated on a
 *                                  concept graph. The graph is a quality
 *                                  enhancement, not a prerequisite.
 *   requestGraphExtractionAction — fire the Wave-1 tutor/graph.extraction.requested
 *                                  event for the course's LIVE publication.
 *   saveCharterAction            — apply a charter patch via applyCharterChange,
 *                                  re-validating the six enums server-side.
 *
 * Every action author-gates: it loads the course under the USER-scoped client
 * and checks author_id === the caller (RLS is the backstop, but the explicit
 * gate keeps a non-author from ever reaching a write path). The result types are
 * discriminated so the client can branch (error) without throwing.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { resolveLivePublicationMeta } from "@/lib/learn/publicationCache";
import {
  applyCharterChange,
  TutorCharterSchema,
  type TutorCharterPatch,
} from "@/lib/tutor/runtime/charter";

export type SetEnabledResult =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export type RequestExtractionResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveCharterResult =
  | { ok: true; versionId: string }
  | { ok: false; error: string };

/** Author-gate: the caller must be signed in AND the course's author. Returns
 *  the user id on success, or throws a redirect / returns null for a non-author.
 *  (RLS already blocks a non-author write; this is the explicit belt.) */
async function requireAuthor(
  courseId: string
): Promise<{ userId: string } | { forbidden: true }> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?redirectTo=/studio/${courseId}/tutor`);
  const supabase = await createClient();
  const { data } = await supabase
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (!data || data.author_id !== user.id) return { forbidden: true };
  return { userId: user.id };
}

/**
 * Enable / disable the tutor for a course.
 *
 * The tutor is ON BY DEFAULT: a course with no tutor_course_settings row (or a row
 * whose enabled !== false) has a live tutor. This action is therefore an opt-OUT
 * switch — enabling and disabling both simply upsert the row, and NEITHER is gated
 * on a concept graph. The tutor answers lesson-grounded from the published snapshot
 * with or without a graph; the graph is a quality enhancement (mastery scaffolding),
 * not a prerequisite for the tutor to appear or answer.
 */
export async function setTutorEnabledAction(
  courseId: string,
  enabled: boolean
): Promise<SetEnabledResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();

  // Upsert the settings row (course_id is the PK — a course may have no row yet).
  const { error } = await supabase
    .from("tutor_course_settings")
    .upsert({ course_id: courseId, enabled }, { onConflict: "course_id" });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/studio/${courseId}/tutor`);
  return { ok: true, enabled };
}

/**
 * Request a concept-graph extraction for the course's LIVE publication. Resolves
 * the live publication (extraction runs against a published version), mints a
 * runId, and fires the best-effort Wave-1 event (a lost send is reconciled by
 * the publish hook / a later run). The durable function stages a change-set the
 * graph tab reviews. Extraction is a QUALITY enhancement — it adds mastery-aware
 * guidance; the tutor is already enabled/answering without it.
 */
export async function requestGraphExtractionAction(
  courseId: string
): Promise<RequestExtractionResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };
  const supabase = await createClient();

  // The course's LIVE publication (extraction runs against a published version).
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) return { ok: false, error: "Course not found." };

  const { data: pub } = await supabase
    .from("course_publications")
    .select("id, slug")
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();
  if (!pub) {
    return {
      ok: false,
      error: "Publish this course first — the concept graph is extracted from the live version.",
    };
  }
  // Confirm it resolves (defensive; also warms the meta cache the graph tab reads).
  await resolveLivePublicationMeta(supabase, pub.slug).catch(() => null);

  const runId = crypto.randomUUID();
  // Lazy import: keep the Inngest SDK out of the action's static import graph.
  const events = await import("@/lib/inngest/tutorGraphEvents");
  await events.sendTutorExtractionRequested({
    courseId,
    publicationId: pub.id,
    runId,
  });

  revalidatePath(`/studio/${courseId}/tutor`);
  return { ok: true };
}

/**
 * Save a charter patch. The six enums are re-validated server-side (never trust
 * the client) through TutorCharterSchema.partial() — an out-of-vocabulary value
 * is rejected here, before applyCharterChange writes a version row + repoints the
 * settings pointer. Returns the new version id.
 */
export async function saveCharterAction(
  courseId: string,
  patch: TutorCharterPatch
): Promise<SaveCharterResult> {
  const gate = await requireAuthor(courseId);
  if ("forbidden" in gate) return { ok: false, error: "Not the course author." };

  // Re-validate the SIX enums (+ tone_notes ≤500) server-side. partial() so a
  // patch may carry any subset; a bad value throws before we touch the DB.
  const parsed = TutorCharterSchema.partial().safeParse(patch);
  if (!parsed.success) {
    return { ok: false, error: "Invalid charter value." };
  }

  const supabase = await createClient();
  try {
    const { versionId } = await applyCharterChange(
      supabase,
      courseId,
      gate.userId,
      parsed.data
    );
    revalidatePath(`/studio/${courseId}/tutor`);
    return { ok: true, versionId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save the charter.",
    };
  }
}
