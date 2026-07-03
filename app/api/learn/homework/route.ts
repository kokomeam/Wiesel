/**
 * POST /api/learn/homework — submit homework (text and/or uploaded files).
 *
 * Inserts with the USER-SCOPED client so RLS does the enforcement (own
 * user_id + active enrollment + publication belongs to the course). The
 * server additionally verifies the block is a homework/exercise block in the
 * publication's snapshot and that every file path sits under the caller's own
 * uid folder (the storage policies enforce the same on upload — this guards
 * against submitting SOMEONE ELSE'S uploaded object paths).
 */

import { NextResponse } from "next/server";
import { emitServerEvent } from "@/lib/analytics/serverEmit";
import { LearnError } from "@/lib/learn/errors";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { HomeworkSubmissionRequestSchema } from "@/lib/learn/schemas";
import { parsePublicationSnapshot, type PublicationRow } from "@/lib/learn/resolve";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The block must be a homework/exercise block in the snapshot; returns its
 *  lesson id (analytics context) or null when not submittable. */
function locateSubmittableBlock(
  row: PublicationRow,
  blockId: string
): { lessonId: string } | null {
  const snapshot = parsePublicationSnapshot(row);
  for (const courseModule of snapshot.modules) {
    for (const lesson of courseModule.lessons) {
      const block = lesson.blocks.find((b) => b.id === blockId);
      if (block) {
        return block.type === "homework" || block.type === "exercise"
          ? { lessonId: lesson.id }
          : null;
      }
    }
  }
  return null;
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, HomeworkSubmissionRequestSchema);
  if (!body.ok) return body.response;
  const { supabase, user } = auth;
  const { publicationId, blockId, text, filePaths } = body.data;

  try {
    for (const path of filePaths) {
      if (!path.startsWith(`${user.id}/`)) {
        throw new LearnError("invalid_request", "File paths must be your own uploads.");
      }
    }

    // RLS-scoped read: resolves only if the caller may see this publication.
    const publication = await supabase
      .from("course_publications")
      .select("*")
      .eq("id", publicationId)
      .maybeSingle();
    if (publication.error) throw publication.error;
    if (!publication.data) throw new LearnError("not_found", "Publication not found.");
    const location = locateSubmittableBlock(publication.data, blockId);
    if (!location) {
      throw new LearnError("not_found", "That assignment isn't part of this publication.");
    }

    const inserted = await supabase
      .from("homework_submissions")
      .insert({
        publication_id: publicationId,
        course_id: publication.data.course_id,
        block_id: blockId,
        user_id: user.id,
        content: { text },
        file_paths: filePaths,
      })
      .select("id, status, created_at")
      .single();
    if (inserted.error) {
      // RLS rejects non-enrolled submitters (42501).
      if (inserted.error.code === "42501") {
        throw new LearnError("not_enrolled", "Enroll in this course to submit work.");
      }
      throw inserted.error;
    }

    // Server-emitted analytics event (hybrid model), keyed by the submission
    // id so a retried request can't double-count. Never throws.
    await emitServerEvent(
      createAdminClient(),
      user.id,
      {
        publicationId,
        version: publication.data.version,
        courseId: publication.data.course_id,
        lessonId: location.lessonId,
      },
      { eventType: "homework_submitted", blockId },
      inserted.data.id
    );

    return NextResponse.json({ submission: inserted.data });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
