/**
 * Shared plumbing for the /api/marketing/social-posts REST surface. Routes
 * stay logic-free (the PRD's "no logic in routes" rule): auth + context here,
 * everything else in the tools/service layer. Every mutation flows through
 * executeMarketingTool → the gate — the REST surface is just the third caller
 * (hub UI and agent being the other two), which is also what gives REST
 * mutations revert-log entries and makes the daily revision budget countable.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import { MarketingToolError } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import {
  SocialGenerationError,
  SocialModelUnavailableError,
  SocialRateLimitError,
  SocialVersionConflictError,
} from "./errors";
import { SocialImageError } from "./images";
import type { SocialPipelineDeps } from "./generate";

export interface SocialRouteAuth {
  ctx: MarketingToolContext;
  deps: SocialPipelineDeps;
  ownerId: string;
}

/**
 * Resolve the signed-in creator + a course-scoped tool context. The marketing
 * suite is course-scoped (events + the gate ledger ride course_id), so a
 * creator with no course yet gets a friendly 400.
 */
export async function socialRouteAuth(
  courseId?: string | null
): Promise<SocialRouteAuth | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const course = await selectCourseForAuthor(supabase, user.id, courseId ?? null);
  if (!course) {
    return NextResponse.json(
      { error: "Create a course first — social posts are generated from course content." },
      { status: 400 }
    );
  }

  const ctx: MarketingToolContext = {
    supabase,
    courseId: course.id,
    campaignId: null,
    ownerId: user.id,
    ownerEmail: user.email ?? null,
    services: createMarketingServices(),
    model: isOpenAIConfigured() ? createOpenAIModelClient() : undefined,
    requestedBy: "user",
  };
  return {
    ctx,
    ownerId: user.id,
    deps: {
      supabase,
      ownerId: user.id,
      model: ctx.model,
      clock: ctx.services.clock,
      courseIdForEvents: course.id,
    },
  };
}

/**
 * Shared body-parse → tool-execute → respond wrapper for the per-post
 * operation routes (revise/tone/regenerate/variants/rewrite/status/
 * performance/image). Keeps each route file logic-free.
 */
export async function runSocialPostTool(
  req: Request,
  toolName: string,
  buildArgs: (body: Record<string, unknown>) => Record<string, unknown>,
  opts: { requireBody?: boolean } = {}
): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  if (opts.requireBody !== false) {
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }
  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  try {
    const { executeMarketingTool } = await import("@/lib/marketing/tools");
    const out = await executeMarketingTool(toolName, buildArgs(body), auth.ctx);
    return NextResponse.json({
      summary: out.summary,
      data: out.data ?? null,
      actionId: out.actionId,
      revertExpiresAt: out.revertExpiresAt ?? null,
    });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

/** Typed error → HTTP mapping (PRD §13: typed 409/429 the UI renders kindly). */
export function socialErrorResponse(err: unknown): NextResponse {
  if (err instanceof SocialVersionConflictError) {
    return NextResponse.json({ error: err.message, code: "version_conflict" }, { status: 409 });
  }
  if (err instanceof SocialRateLimitError) {
    return NextResponse.json(
      { error: err.message, code: "rate_limited", kind: err.kind, limit: err.limit },
      { status: 429 }
    );
  }
  if (err instanceof SocialGenerationError) {
    return NextResponse.json(
      { error: err.message, code: "generation_failed", stage: err.stage },
      { status: 502 }
    );
  }
  if (err instanceof SocialModelUnavailableError) {
    return NextResponse.json({ error: err.message, code: "model_unavailable" }, { status: 503 });
  }
  if (err instanceof SocialImageError) {
    return NextResponse.json({ error: err.message, code: "image_invalid" }, { status: 400 });
  }
  if (err instanceof MarketingToolError) {
    // The tools re-word version conflicts for the agent; surface those as 409.
    const conflict = err.message.startsWith("Version conflict");
    return NextResponse.json(
      { error: err.message, code: conflict ? "version_conflict" : "bad_request" },
      { status: conflict ? 409 : 400 }
    );
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return NextResponse.json({ error: message, code: "internal" }, { status: 500 });
}
