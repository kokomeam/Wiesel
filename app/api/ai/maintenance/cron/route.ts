/**
 * POST /api/ai/maintenance/cron — drain ONE queued maintenance run.
 *
 * pg_cron queues agent_runs rows weekly (in-DB — it can't reach HTTP); this
 * route executes them. Guarded by `Authorization: Bearer ${CRON_SECRET}` (the
 * Mux-webhook shared-secret pattern — no user session): production wires an
 * external cron/scheduler at it; dev drives it with curl. One run per
 * invocation keeps it inside serverless timeouts — invoke repeatedly (or watch
 * `remainingQueued`) to drain a backlog.
 *
 * The run executes with the ADMIN client (author-only RLS on the agent tables
 * doesn't apply; ownerId is resolved from the course row) and the real OpenAI
 * client. The creator simply opens the studio to a ready report + staged,
 * evidence-annotated proposals. NO sends happen here — the comms seam is never
 * imported by the maintenance path.
 */

import { NextResponse } from "next/server";
import { runMaintenanceRun } from "@/lib/ai/maintenance";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
  }

  const admin = createAdminClient();

  // Oldest queued run; runMaintenanceRun's status-guarded claim is the actual
  // optimistic lock (a racing drainer loses the update and errors out cleanly).
  const { data: queued, error } = await admin
    .from("agent_runs")
    .select("id, course_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!queued) {
    return NextResponse.json({ processed: 0, remainingQueued: 0 });
  }

  const course = await admin
    .from("courses")
    .select("author_id")
    .eq("id", queued.course_id)
    .single();
  if (course.error) {
    return NextResponse.json({ error: course.error.message }, { status: 500 });
  }

  let outcome: { status: string; findings: number; changeSets: number; drafts: number };
  try {
    const result = await runMaintenanceRun({
      supabase: admin,
      model: createOpenAIModelClient(),
      courseId: queued.course_id,
      ownerId: course.data.author_id,
      trigger: "scheduled",
      runId: queued.id,
      emit: () => {}, // headless — progress lives in agent_runs
    });
    outcome = result;
  } catch (err) {
    // A racing drainer already claimed it (or the run failed before start).
    return NextResponse.json({
      processed: 0,
      raced: true,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const { count } = await admin
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  return NextResponse.json({
    processed: 1,
    runId: queued.id,
    outcome,
    remainingQueued: count ?? 0,
  });
}
