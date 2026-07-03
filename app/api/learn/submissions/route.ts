/**
 * Creator review surface for homework submissions.
 *   GET  ?courseId=…       — the course's submissions, newest first, with the
 *                            submitter's display name, block title (from the
 *                            live snapshot), and public file URLs. Author only.
 *   PATCH {submissionId}   — mark reviewed (user-scoped client: the RLS update
 *                            policy is author-only and the DB trigger makes
 *                            review status the only mutable column).
 * Student names come via the admin client (profiles are self-readable under
 * RLS), released only after the author check.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { LearnError } from "@/lib/learn/errors";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { getLivePublicationByCourse, parsePublicationSnapshot } from "@/lib/learn/resolve";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "course-assets";

const MarkReviewedSchema = z.object({
  submissionId: z.string().min(1),
});

export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { supabase, user } = auth;
  const courseId = new URL(request.url).searchParams.get("courseId");
  if (!courseId) {
    return NextResponse.json({ error: "courseId is required" }, { status: 400 });
  }

  try {
    const authored = await supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("author_id", user.id)
      .maybeSingle();
    if (authored.error) throw authored.error;
    if (!authored.data) throw new LearnError("not_found", "Course not found.");

    const admin = createAdminClient();
    const [subs, publication] = await Promise.all([
      admin
        .from("homework_submissions")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false })
        .limit(200),
      getLivePublicationByCourse(admin, courseId),
    ]);
    if (subs.error) throw subs.error;

    const blockTitles = new Map<string, string>();
    if (publication) {
      const snapshot = parsePublicationSnapshot(publication);
      for (const courseModule of snapshot.modules) {
        for (const lesson of courseModule.lessons) {
          for (const block of lesson.blocks) {
            if (block.type === "homework" || block.type === "exercise") {
              blockTitles.set(block.id, block.title ?? lesson.title);
            }
          }
        }
      }
    }

    const userIds = [...new Set((subs.data ?? []).map((s) => s.user_id))];
    const profiles =
      userIds.length > 0
        ? await admin.from("profiles").select("id, display_name").in("id", userIds)
        : { data: [] as { id: string; display_name: string | null }[], error: null };
    if (profiles.error) throw profiles.error;
    const nameById = new Map((profiles.data ?? []).map((p) => [p.id, p.display_name]));

    const submissions = (subs.data ?? []).map((row) => {
      const content = (row.content ?? {}) as { text?: string };
      return {
        id: row.id,
        blockId: row.block_id,
        blockTitle: blockTitles.get(row.block_id) ?? "Assignment",
        studentName: nameById.get(row.user_id) ?? "A learner",
        text: typeof content.text === "string" ? content.text : "",
        files: row.file_paths.map((path) => ({
          name: path.split("/").pop() ?? path,
          url: admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
        })),
        status: row.status,
        createdAt: row.created_at,
      };
    });

    return NextResponse.json({ submissions });
  } catch (error) {
    return learnErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, MarkReviewedSchema);
  if (!body.ok) return body.response;
  const { supabase } = auth;

  try {
    const updated = await supabase
      .from("homework_submissions")
      .update({ status: "reviewed" })
      .eq("id", body.data.submissionId)
      .select("id, status")
      .maybeSingle();
    if (updated.error) throw updated.error;
    if (!updated.data) throw new LearnError("not_found", "Submission not found.");
    return NextResponse.json({ submission: updated.data });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
