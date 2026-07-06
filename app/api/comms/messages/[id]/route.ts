/**
 * /api/comms/messages/[id] — edit a draft (PATCH) or approve-and-send (POST).
 *
 * approve_send is the ONE human-initiated path into the send seam: the caller
 * must be able to SEE the message under author-only RLS (the ownership gate),
 * then `approveAndSend` runs on the admin client (it reads auth.users +
 * enrollments) and RE-CHECKS comms_opt_out at send time. There is no other
 * route to `provider.send` anywhere.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { approveAndSend, updateDraft } from "@/lib/comms/service";
import { EmailBodySchema } from "@/lib/comms/types";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  subject: z.string().min(1).max(300).optional(),
  body: EmailBodySchema.optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, PatchSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  try {
    const message = await updateDraft(auth.supabase, id, body.data);
    return NextResponse.json({ message });
  } catch (error) {
    return learnErrorResponse(error);
  }
}

const ActionSchema = z.object({ action: z.literal("approve_send") });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, ActionSchema);
  if (!body.ok) return body.response;
  const { id } = await params;

  // Ownership gate: author-only RLS — if the caller can't see it, 404.
  const visible = await auth.supabase
    .from("learner_messages")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (visible.error) {
    return NextResponse.json({ error: visible.error.message }, { status: 500 });
  }
  if (!visible.data) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  const outcome = await approveAndSend(createAdminClient(), id);
  if (!outcome.ok) {
    const status =
      outcome.reason === "opted_out" || outcome.reason === "bad_status" ? 409 : 502;
    return NextResponse.json(
      { error: outcome.reason, detail: outcome.detail ?? null },
      { status }
    );
  }
  return NextResponse.json({ message: outcome.message });
}
