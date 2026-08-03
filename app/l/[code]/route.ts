/**
 * /l/{code} — the clip posting-kit short link (M-D). PUBLIC (code possession
 * is the capability; no auth, no anon RLS — the service role reads the row).
 *
 * Behavior:
 *   - counts the click + drops a `short_link_click` event (course-scoped)
 *   - RE-RESOLVES the destination at CLICK time: if the course has gone LIVE
 *     since the link was minted, a /p/{slug} destination upgrades to
 *     /learn/{slug} (the email-CTA lesson — send/click time beats bake time)
 *   - threads `?ref={code}` onto the destination so enrollment attribution
 *     can trace the clip (recordClipEnrollment reads it back)
 *   - unknown code → the homepage (a dead short link is worse than a soft
 *     landing; no 404 oracle for code guessing)
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { coursePreviewPath } from "@/lib/marketing/ctaDestination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const url = new URL(req.url);
  if (!isAdminConfigured() || !/^[a-z2-9]{4,12}$/.test(code)) {
    return NextResponse.redirect(new URL("/", url.origin), { status: 302 });
  }
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("short_link")
    .select("id, course_id, destination, clicks")
    .eq("code", code)
    .maybeSingle();
  if (!link) return NextResponse.redirect(new URL("/", url.origin), { status: 302 });

  // Click-time destination upgrade (publishing beats the baked path).
  let destination = link.destination;
  if (link.course_id && destination.startsWith("/p/")) {
    const live = await coursePreviewPath(admin, link.course_id);
    if (live) destination = live;
  }

  await admin.from("short_link").update({ clicks: (link.clicks ?? 0) + 1 }).eq("id", link.id);
  if (link.course_id) {
    await admin.from("analytics_event").insert({
      course_id: link.course_id,
      type: "short_link_click",
      source: "clip_short_link",
      props: { code, destination },
    });
  }

  const redirectTo = new URL(destination, url.origin);
  redirectTo.searchParams.set("ref", code);
  return NextResponse.redirect(redirectTo, { status: 302 });
}
