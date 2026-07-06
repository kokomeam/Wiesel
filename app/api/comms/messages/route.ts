/**
 * /api/comms/messages — list + create learner-message drafts (Milestone 6).
 * Author-scoped: RLS on learner_messages enforces course ownership; no admin
 * client here (only approve_send needs it — see [id]/route.ts).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createDraft } from "@/lib/comms/service";
import { EmailBodySchema } from "@/lib/comms/types";
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
  const { data, error } = await auth.supabase
    .from("learner_messages")
    .select("*")
    .eq("course_id", courseId)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ messages: data ?? [] });
}

const CreateDraftSchema = z.object({
  courseId: z.string().min(1),
  userId: z.string().min(1),
  findingId: z.string().nullable().optional(),
  subject: z.string().min(1).max(300),
  body: EmailBodySchema,
});

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, CreateDraftSchema);
  if (!body.ok) return body.response;
  try {
    const message = await createDraft(auth.supabase, {
      courseId: body.data.courseId,
      userId: body.data.userId,
      findingId: body.data.findingId ?? null,
      subject: body.data.subject,
      body: body.data.body,
    });
    return NextResponse.json({ message });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
