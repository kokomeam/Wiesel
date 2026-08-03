/**
 * /api/comms/messages — list + create learner-message drafts (Milestone 6).
 * Author-scoped: RLS on learner_messages enforces course ownership. The GET
 * additionally returns suppression state (M7) for exactly the learners whose
 * messages the caller can already see — comms_suppressions itself is
 * server-only (zero RLS policies), so this author-gated route is the ONLY
 * window creators get into it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createDraft, getSuppressions } from "@/lib/comms/service";
import { EmailBodySchema } from "@/lib/comms/types";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

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
    .order("created_at", { ascending: false })
    // PERF-1 D2: the review panel is an INBOX, not an archive — bound the
    // list to the 200 newest messages (was unbounded; diagnosis A6 #16).
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = data ?? [];
  let suppressions: Record<string, string> = {};
  if (isAdminConfigured() && messages.length > 0) {
    try {
      suppressions = await getSuppressions(
        createAdminClient(),
        messages.map((m) => m.user_id)
      );
    } catch (err) {
      // Suppression state is advisory in the LIST (the send seam re-checks it
      // authoritatively) — degrade to none rather than failing the list.
      console.error("[comms] suppression lookup failed", err);
    }
  }
  return NextResponse.json({ messages, suppressions });
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
