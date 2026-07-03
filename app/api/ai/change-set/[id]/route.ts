/**
 * POST /api/ai/change-set/[id] — accept or reject a pending change-set.
 *   { "action": "accept" } → resolve; the agent's edits stay (already persisted).
 *   { "action": "reject" } → replay the inverse through the patch pipeline,
 *                            restoring each block's pre-turn state.
 * RLS guarantees the caller can only touch their own course's change-sets.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id } = await params;
  let action: string | undefined;
  try {
    action = (await req.json())?.action;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  try {
    if (action === "accept") {
      await acceptChangeSet(supabase, id);
    } else if (action === "reject") {
      await rejectChangeSet(supabase, id, user.id);
    } else {
      return new Response('action must be "accept" or "reject"', { status: 400 });
    }
    // Maintenance-run findings track their proposal's fate: accept → accepted,
    // reject → dismissed (the underlying problem may re-file if it recurs).
    // Best-effort — a finding-status failure must not fail the resolution.
    const { error: findingErr } = await supabase
      .from("agent_findings")
      .update({ status: action === "accept" ? "accepted" : "dismissed" })
      .eq("change_set_id", id)
      .eq("status", "proposed");
    if (findingErr) console.error("[maintenance] finding transition failed", findingErr.message);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Failed", { status: 500 });
  }

  return Response.json({ ok: true });
}
