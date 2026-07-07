/**
 * GET /api/marketing/social-posts — the content queue. Filters: status,
 * platform, courseId, funnelStage, batchId; cursor pagination (updated_at).
 * RLS scopes everything to the signed-in creator.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listBatches, listSocialPosts } from "@/lib/marketing/social/repository";
import type { ListPostsFilter } from "@/lib/marketing/social/repository";
import { socialErrorResponse } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  try {
    const filter: ListPostsFilter = {
      status: q("status") as ListPostsFilter["status"],
      platform: q("platform") as ListPostsFilter["platform"],
      courseId: q("courseId"),
      funnelStage: q("funnelStage"),
      batchId: q("batchId"),
      includeDeleted: q("includeDeleted") === "true",
    };
    const page = await listSocialPosts(supabase, filter, {
      cursor: q("cursor"),
      limit: q("limit") ? Number(q("limit")) : undefined,
    });
    const batches = q("withBatches") === "true" ? await listBatches(supabase) : undefined;
    return NextResponse.json({ ...page, batches });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
