/**
 * Publication resolution for the /learn runtime.
 *
 * Visibility is enforced by RLS on the CALLER'S client: an anonymous visitor
 * only resolves live+public publications; a signed-in visitor also resolves
 * live+unlisted (link possession = knowing the slug). These helpers therefore
 * take the request-scoped client, never the admin client.
 *
 * Snapshots served to learners are RE-VALIDATED through the STRICT publish
 * schema on every read — belt-and-braces with publish-time stripping, so a
 * hypothetically corrupted snapshot containing answer keys fails CLOSED
 * (500 for everyone) instead of leaking.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  PublicationSnapshotSchema,
  type PublicationSnapshot,
} from "@/lib/course/publish/schemas";

type DB = SupabaseClient<Database>;

export type PublicationRow = Database["public"]["Tables"]["course_publications"]["Row"];

export type SlugResolution =
  | { kind: "found"; publication: PublicationRow }
  | { kind: "redirect"; slug: string }
  | { kind: "not_found" };

/** Resolve a /learn/[slug] URL: current live slug first, then redirect-safe
 *  lookup through previous_slugs (a renamed course keeps old links working). */
export async function resolveLivePublicationBySlug(
  supabase: DB,
  slug: string
): Promise<SlugResolution> {
  const current = await supabase
    .from("course_publications")
    .select("*")
    .eq("status", "live")
    .eq("slug", slug)
    .maybeSingle();
  if (current.error) throw current.error;
  if (current.data) return { kind: "found", publication: current.data };

  const renamed = await supabase
    .from("course_publications")
    .select("slug")
    .eq("status", "live")
    .contains("previous_slugs", [slug])
    .limit(1)
    .maybeSingle();
  if (renamed.error) throw renamed.error;
  if (renamed.data) return { kind: "redirect", slug: renamed.data.slug };

  return { kind: "not_found" };
}

/** The live publication of a course (RLS-scoped to the caller). */
export async function getLivePublicationByCourse(
  supabase: DB,
  courseId: string
): Promise<PublicationRow | null> {
  const { data, error } = await supabase
    .from("course_publications")
    .select("*")
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Strict parse of a publication row's snapshot (throws on any leak/corruption). */
export function parsePublicationSnapshot(row: PublicationRow): PublicationSnapshot {
  return PublicationSnapshotSchema.parse(row.snapshot);
}
