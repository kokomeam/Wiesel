/**
 * POST /api/analytics/ingest — the ONE batch endpoint for client-reported
 * engagement events (Milestone 3).
 *
 * Trust model: the user-scoped client calls the SECURITY DEFINER
 * `ingest_learning_events` RPC, which enforces IN THE DATABASE: user_id
 * pinned to auth.uid() (nothing identity-shaped is trusted from the payload),
 * every event's course enrolled-or-authored, and every publication belonging
 * to its claimed course. The RPC exists because Postgres also applies the
 * SELECT policy to `on conflict` inserts — and students deliberately read
 * none — so a plain RLS upsert can never be idempotent here; the table's
 * insert policy remains as defense-in-depth for non-RPC paths.
 *
 * Idempotency: the RPC inserts with `on conflict (client_event_id) do
 * nothing` — replaying a batch (retry after a false-negative, double flush)
 * changes nothing.
 *
 * Rate limiting is BEST-EFFORT per server instance (an in-memory sliding
 * window; serverless cold starts reset it, instances don't share it). That's
 * an abuse damper, not a quota — a healthy client sends ~1 batch per 10s.
 * Upgrade path if a hard limit is ever needed: count-in-window query on
 * learning_events (user_id, course_id, server_ts is indexed) or Redis.
 */

import { NextResponse } from "next/server";
import { AnalyticsBatchSchema, mapEventToColumns } from "@/lib/analytics/events";
import type { Json } from "@/lib/database.types";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 10_000;
const MAX_BATCHES_PER_WINDOW = 20;
const recentByUser = new Map<string, number[]>();

function isRateLimited(userId: string, now: number): boolean {
  const stamps = (recentByUser.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_BATCHES_PER_WINDOW) {
    recentByUser.set(userId, stamps);
    return true;
  }
  stamps.push(now);
  recentByUser.set(userId, stamps);
  if (recentByUser.size > 1_000) {
    // Occasional sweep so idle users don't accumulate forever.
    for (const [key, times] of recentByUser) {
      if (times.every((t) => now - t >= WINDOW_MS)) recentByUser.delete(key);
    }
  }
  return false;
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth.response;

    const body = await parseBody(request, AnalyticsBatchSchema);
    if (!body.ok) return body.response;

    if (isRateLimited(auth.user.id, Date.now())) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // The RPC pins user_id itself; the mapped rows' user_id is informational.
    const rows = body.data.events.map((e) => mapEventToColumns(e, auth.user.id));
    const { data: accepted, error } = await auth.supabase.rpc(
      "ingest_learning_events",
      { p_events: rows as unknown as Json }
    );
    if (error) {
      // The RPC raises on scope violations (not enrolled / wrong publication).
      if (/not enrolled|publication does not belong|not authenticated/.test(error.message)) {
        return NextResponse.json({ error: "Events were not accepted" }, { status: 403 });
      }
      throw error;
    }
    return NextResponse.json({ accepted: accepted ?? 0 });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
