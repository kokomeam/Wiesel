/**
 * POST /api/learn/progress — report a learner action (lesson opened, slides
 * viewed, video progress, deck paged through, mark complete).
 *
 * The server recomputes status/pct from the fixed completion rule against the
 * LIVE publication — the client never supplies a status, a percent, or a
 * completion claim (learn_progress has no client write policies at all).
 * Authors previewing their course get a no-op snapshot: nothing is written,
 * so learner analytics never contain the creator's own walkthroughs.
 *
 * PERF-1 C1: the access pair and the NARROW live-meta lookup run as one
 * parallel wave, and the immutable snapshot comes from the publication cache
 * (no full-row fetch + strict re-parse per POST — diagnosis §A2).
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLearnerAccess } from "@/lib/learn/access";
import { LearnError } from "@/lib/learn/errors";
import { applyProgressAction } from "@/lib/learn/progressService";
import { getCachedSnapshot, getLivePublicationMetaByCourse } from "@/lib/learn/publicationCache";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { ProgressRequestSchema } from "@/lib/learn/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, ProgressRequestSchema);
  if (!body.ok) return body.response;
  const { supabase, user } = auth;
  const { courseId, action } = body.data;

  try {
    // Independent reads — one wave. Error precedence stays: enrollment first.
    const [access, meta] = await Promise.all([
      getLearnerAccess(supabase, user.id, courseId),
      getLivePublicationMetaByCourse(supabase, courseId),
    ]);
    if (!access) throw new LearnError("not_enrolled", "Enroll to track progress.");
    if (!meta) throw new LearnError("not_found", "This course isn't published.");

    if (access.role === "author") {
      return NextResponse.json({
        progress: {
          lessonId: action.lessonId,
          status: "not_started",
          pct: 0,
          courseCompleted: false,
        },
        preview: true,
      });
    }

    const { snapshot } = await getCachedSnapshot(meta.id);
    const admin = createAdminClient();
    const progress = await applyProgressAction(
      admin,
      {
        userId: user.id,
        courseId,
        publicationId: meta.id,
        version: meta.version,
        snapshot,
      },
      action
    );
    return NextResponse.json({ progress });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
