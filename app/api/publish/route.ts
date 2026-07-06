/**
 * /api/publish — snapshot publishing for the studio.
 *   GET  ?courseId=…   → publish status: latest publication summary, pre-flight
 *                        report for the CURRENT draft, draft-vs-live diff, and
 *                        whether the draft has unpublished changes.
 *   POST { courseId, slug?, visibility? }
 *                      → run pre-flight (errors → 422 with the report), build
 *                        the snapshot (answer keys stripped server-side), and
 *                        publish via the transactional publish_course RPC.
 *   PATCH { courseId, update } (unpublish | restore | set_slug | set_visibility)
 *
 * Everything runs on the USER-SCOPED client — RLS is the authorization layer
 * (only the course author can read their draft rows or update publications).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { SupabaseClient } from "@supabase/supabase-js";
import { courseDocFromRows } from "@/lib/course/persistence";
import {
  PatchPublicationRequestSchema,
  PublishRequestSchema,
} from "@/lib/course/publish/schemas";
import {
  getPublishStatus,
  publishCourse,
  PublishServiceError,
  updatePublicationSettings,
} from "@/lib/course/publish/service";
import type { CourseDocument } from "@/lib/course/types";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

/** Load the author's draft as a CourseDocument (RLS scopes every read). */
async function loadDraftDoc(
  supabase: SupabaseClient<Database>,
  courseId: string
): Promise<CourseDocument | null> {
  const { data: course } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) return null;
  const [{ data: modules, error: modErr }, { data: lessons, error: lessonErr }, { data: blocks, error: blockErr }] =
    await Promise.all([
      supabase.from("modules").select("*").eq("course_id", courseId),
      supabase.from("lessons").select("*").eq("course_id", courseId),
      supabase.from("blocks").select("*").eq("course_id", courseId),
    ]);
  // A partial read must never publish a lossy tree.
  if (modErr || lessonErr || blockErr) return null;
  return courseDocFromRows(course, modules ?? [], lessons ?? [], blocks ?? []);
}

function errorResponse(error: unknown): Response {
  if (error instanceof PublishServiceError) {
    const status =
      error.code === "preflight_failed" ? 422
      : error.code === "slug_taken" ? 409
      : error.code === "invalid_slug" ? 400
      : error.code === "no_publication" || error.code === "already_live" ? 409
      : 500;
    return Response.json(
      { error: error.message, code: error.code, ...(error.report ? { report: error.report } : {}) },
      { status }
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "Publish request failed" },
    { status: 500 }
  );
}

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const courseId = new URL(req.url).searchParams.get("courseId");
  if (!courseId) return new Response("courseId is required", { status: 400 });

  const doc = await loadDraftDoc(supabase, courseId);
  if (!doc) return new Response("Course not found", { status: 404 });

  try {
    return Response.json(await getPublishStatus(supabase, doc));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const parsed = PublishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const doc = await loadDraftDoc(supabase, parsed.data.courseId);
  if (!doc) return new Response("Course not found", { status: 404 });

  try {
    const result = await publishCourse(supabase, doc, {
      slug: parsed.data.slug,
      visibility: parsed.data.visibility,
    });
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const parsed = PatchPublicationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const publication = await updatePublicationSettings(
      supabase,
      parsed.data.courseId,
      parsed.data.update
    );
    return Response.json({ publication });
  } catch (error) {
    return errorResponse(error);
  }
}
