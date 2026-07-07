/**
 * CTA destination resolution — where an email's button actually sends people.
 *
 * The rule (standard practice for mailing-list traffic): subscribers are
 * already-captured leads, so the CTA points at the CONVERSION surface — the
 * course's public preview/enroll page (`/learn/{slug}`) — whenever the course
 * has a LIVE publication. The campaign's landing page (`/p/{slug}`) is a
 * lead-CAPTURE page: sending list members back to an opt-in form is circular,
 * so it stays the destination only pre-publish. `{{freeLessonUrl}}` keeps
 * pointing at the landing page (that's where the free-lesson offer lives).
 *
 * Resolution happens at SEND time (scheduler) and at compliance-review time
 * with this same function — so publishing a course upgrades every queued
 * send's destination without regenerating any copy, and generation-time
 * template hrefs (ctaPath) and the {{ctaUrl}} merge var can never disagree.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { listLandingPages } from "./persistence";
import { publicUrl } from "./tokens";

type DB = SupabaseClient<Database>;

/** `/learn/{slug}` for the course's LIVE publication, else null. */
export async function coursePreviewPath(supabase: DB, courseId: string): Promise<string | null> {
  const { data } = await supabase
    .from("course_publications")
    .select("slug")
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();
  return data ? `/learn/${data.slug}` : null;
}

/** `/p/{slug}` for the campaign's landing page (published preferred), else null. */
export async function campaignLandingPath(supabase: DB, campaignId: string | null): Promise<string | null> {
  if (!campaignId) return null;
  const pages = await listLandingPages(supabase, campaignId);
  const page = pages.find((p) => p.status === "published") ?? pages[0];
  return page ? `/p/${page.slug}` : null;
}

export interface CtaDestinations {
  /** Relative path for template button hrefs (course preview > landing page). */
  ctaPath: string | null;
  /** Absolute URL — the {{ctaUrl}} merge var (emails need absolute links). */
  ctaUrl: string | null;
  /** Absolute URL — the {{freeLessonUrl}} merge var (always the capture page). */
  freeLessonUrl: string | null;
}

export async function resolveCtaDestinations(
  supabase: DB,
  args: { courseId: string; campaignId: string | null }
): Promise<CtaDestinations> {
  const preview = await coursePreviewPath(supabase, args.courseId);
  const landing = await campaignLandingPath(supabase, args.campaignId);
  const ctaPath = preview ?? landing;
  return {
    ctaPath,
    ctaUrl: ctaPath ? publicUrl(ctaPath) : null,
    freeLessonUrl: landing ? publicUrl(landing) : null,
  };
}

export interface SiteUrlFinding {
  severity: "blocking" | "warning";
  detail: string;
}

/**
 * Site-URL sanity — the failure class where EVERY emailed link 404s because
 * the base URL bakes in wrong at send time (observed live: NEXT_PUBLIC_SITE_URL
 * set to the Vercel DASHBOARD path, producing vercel.com/... links). Checked
 * as part of the launch compliance review so it blocks BEFORE a send.
 */
export function siteUrlFinding(): SiteUrlFinding | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "";
  if (!raw.trim()) {
    return {
      severity: "blocking",
      detail:
        "NEXT_PUBLIC_SITE_URL is not set — every link in every email (CTA, unsubscribe, consent) would be relative and dead in a mail client.",
    };
  }
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return {
      severity: "blocking",
      detail: `NEXT_PUBLIC_SITE_URL ("${raw}") is not a valid absolute URL — emailed links would be broken.`,
    };
  }
  if (host === "vercel.com" || host.endsWith(".vercel.com")) {
    return {
      severity: "blocking",
      detail: `NEXT_PUBLIC_SITE_URL points at ${host} — that's the Vercel dashboard, never your app. Set it to your deployment domain (e.g. https://your-app.vercel.app or your custom domain).`,
    };
  }
  if (host === "localhost" || host === "127.0.0.1") {
    return {
      severity: "warning",
      detail:
        "NEXT_PUBLIC_SITE_URL is localhost — emailed links only work on this machine. Fine for dev tests; set the real domain before a production launch.",
    };
  }
  return null;
}
