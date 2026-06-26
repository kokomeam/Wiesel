/**
 * Public ingest endpoint — the ONE write path for anonymous landing-page
 * visitors (lead form submits, free-lesson captures, pageview beacons).
 *
 * Node runtime, service-role client (server-only key). Every write is validated
 * + scoped to a PUBLISHED page inside lib/marketing/ingest.ts. Returns 503 when
 * the service-role key isn't configured so the page degrades gracefully.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { captureLead, recordPageView } from "@/lib/marketing/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("page_view"),
    slug: z.string().min(1).max(120),
    anonymousId: z.string().max(64).nullish(),
    referrer: z.string().max(500).nullish(),
  }),
  z.object({
    type: z.literal("lead"),
    slug: z.string().min(1).max(120),
    email: z.string().min(1).max(254),
    name: z.string().max(120).nullish(),
    anonymousId: z.string().max(64).nullish(),
    freeLesson: z.boolean().nullish(),
    consentText: z.string().max(400).nullish(),
  }),
]);

export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Lead capture is temporarily unavailable. (Server-side: SUPABASE_SERVICE_ROLE_KEY isn't loaded — add it to .env.local and restart the dev server.)",
      },
      { status: 503 }
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.message }, { status: 400 });
  }

  const admin = createAdminClient();
  const body = parsed.data;

  if (body.type === "page_view") {
    const res = await recordPageView(admin, {
      slug: body.slug,
      anonymousId: body.anonymousId ?? null,
      referrer: body.referrer ?? null,
    });
    return NextResponse.json(res, { status: res.ok ? 200 : 404 });
  }

  const res = await captureLead(admin, {
    slug: body.slug,
    email: body.email,
    name: body.name ?? null,
    anonymousId: body.anonymousId ?? null,
    freeLesson: body.freeLesson ?? false,
    consentText: body.consentText ?? null,
  });
  // 422 for a bad email, 404 for an unpublished page — both are client-correctable.
  const status = res.ok ? 200 : res.error === "Invalid email" ? 422 : 404;
  return NextResponse.json(res, { status });
}
