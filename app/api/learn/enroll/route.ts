/**
 * POST /api/learn/enroll — enroll the signed-in user in a course.
 *
 * Runs on the USER-SCOPED client: RLS is the authorization layer (insert
 * requires user_id = auth.uid() AND a live publication). Re-enrolling after a
 * drop re-activates the existing row. Idempotent: enrolling twice returns the
 * current enrollment.
 */

import { NextResponse } from "next/server";
import { EnrollRequestSchema } from "@/lib/learn/schemas";
import { getEnrollment } from "@/lib/learn/access";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { recordClipEnrollment } from "@/lib/marketing/clips/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, EnrollRequestSchema);
  if (!body.ok) return body.response;
  const { supabase, user } = auth;
  const { courseId, refCode } = body.data;

  try {
    const existing = await getEnrollment(supabase, user.id, courseId);
    if (existing) {
      if (existing.status === "dropped") {
        const revived = await supabase
          .from("enrollments")
          .update({ status: "active" })
          .eq("id", existing.id)
          .select("*")
          .single();
        if (revived.error) throw revived.error;
        return NextResponse.json({ enrollment: revived.data });
      }
      return NextResponse.json({ enrollment: existing });
    }

    const inserted = await supabase
      .from("enrollments")
      .insert({ course_id: courseId, user_id: user.id })
      .select("*")
      .single();
    if (inserted.error) {
      // RLS blocks enrollment when there's no live publication (42501) —
      // surface that as "not found" rather than a bare permission error.
      if (inserted.error.code === "42501") {
        return NextResponse.json(
          { error: "This course isn't open for enrollment." },
          { status: 404 }
        );
      }
      throw inserted.error;
    }
    // M-D clip attribution — best-effort, never blocks the enrollment.
    if (refCode) await recordClipEnrollment(courseId, refCode).catch(() => {});
    return NextResponse.json({ enrollment: inserted.data });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
