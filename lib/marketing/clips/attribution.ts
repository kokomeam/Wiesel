/**
 * Clip enrollment attribution (M-D) — the refCode thread: /l/{code} stamps
 * `?ref={code}` on the destination; the EnrollButton carries it into
 * POST /api/learn/enroll; this records an ATTRIBUTED enrollment event
 * (source 'clip_short_link', props carry the code + kit/post lineage when
 * resolvable). Admin client — the enroll route runs user-scoped and
 * analytics_event has no learner insert policy; this is the same
 * server-emit pattern as lib/analytics/serverEmit.ts. Best-effort by
 * contract: a missing/foreign code records nothing and never throws into
 * the enrollment path.
 */

import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import type { Json } from "@/lib/database.types";

export async function recordClipEnrollment(courseId: string, refCode: string): Promise<void> {
  if (!isAdminConfigured() || !/^[a-z2-9]{4,12}$/.test(refCode)) return;
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("short_link")
    .select("id, course_id, creator_id")
    .eq("code", refCode)
    .maybeSingle();
  // Only attribute when the code belongs to THIS course (a stale ref from
  // another course's clip must not claim credit).
  if (!link || link.course_id !== courseId) return;

  const { data: kit } = await admin
    .from("posting_kit")
    .select("id, post_id")
    .eq("short_link_id", link.id)
    .maybeSingle();

  await admin.from("analytics_event").insert({
    course_id: courseId,
    type: "enrollment",
    source: "clip_short_link",
    props: {
      refCode,
      shortLinkId: link.id,
      kitId: kit?.id ?? null,
      postId: kit?.post_id ?? null,
      attributed: true,
    } as Json,
  });
}
