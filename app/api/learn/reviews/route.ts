/**
 * /api/learn/reviews — course-review submission + prompt state (Milestone 9).
 *
 * Everything runs on the USER-SCOPED client: the RPCs pin user_id to
 * auth.uid() themselves, and the eligibility gate lives in SQL (both inside
 * submit_course_review AND in the RLS write policies — a forged direct
 * insert fails identically). Reviews are direct human input: no change-set,
 * no approval flow.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { parseReviewPromptState, REVIEW_TEXT_MAX_CHARS } from "@/lib/learn/reviews";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const courseId = new URL(request.url).searchParams.get("courseId");
  if (!courseId) {
    return NextResponse.json({ error: "courseId is required" }, { status: 400 });
  }
  const { data, error } = await auth.supabase.rpc("review_prompt_state", {
    p_course_id: courseId,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ state: parseReviewPromptState(data) });
}

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("submit"),
    courseId: z.uuid(),
    rating: z.number().int().min(1).max(5),
    reviewText: z.string().max(REVIEW_TEXT_MAX_CHARS).nullable().optional(),
  }),
  z.object({ action: z.literal("dismiss"), courseId: z.uuid() }),
]);

export async function POST(request: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth.response;
    const body = await parseBody(request, BodySchema);
    if (!body.ok) return body.response;

    if (body.data.action === "dismiss") {
      const { data, error } = await auth.supabase.rpc("dismiss_review_prompt", {
        p_course_id: body.data.courseId,
      });
      if (error) throw error;
      return NextResponse.json({ dismissed: data === true });
    }

    const { data, error } = await auth.supabase.rpc("submit_course_review", {
      p_course_id: body.data.courseId,
      p_rating: body.data.rating,
      // The generated type can't express a nullable SQL text param.
      p_review_text: (body.data.reviewText ?? null) as unknown as string,
    });
    if (error) {
      if (/not eligible/.test(error.message)) {
        return NextResponse.json(
          { error: "Finish (most of) the course before reviewing it." },
          { status: 403 }
        );
      }
      if (/rating must be/.test(error.message)) {
        return NextResponse.json({ error: "Rating must be 1–5." }, { status: 400 });
      }
      throw error;
    }
    return NextResponse.json({ review: data });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
