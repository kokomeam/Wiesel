/**
 * Immutable-publication cache (PERF-1 C1/B5).
 *
 * A live publication's `snapshot`/`version`/`content_hash` are DB-trigger
 * immutable, which makes them perfectly cacheable with NO invalidation story:
 * a cache entry keyed by publication id can never go stale. Before this
 * module, the full snapshot jsonb was re-fetched AND re-Zod-parsed on every
 * lesson view, every progress/homework POST, every analytics tab, and the
 * student home (diagnosis A6 #2) — the single most re-fetched payload in the
 * system.
 *
 * SECURITY MODEL (unchanged): authorization stays with the CALLER. Callers
 * must first resolve the publication through their own RLS-scoped client
 * (`resolveLivePublicationMeta` below — a NARROW query that never touches the
 * snapshot column), and only then load the immutable body by id from this
 * cache. The cache itself reads with the admin client but returns only fields
 * the caller's RLS query already proved the caller may see, minus the mutable
 * ones (status/visibility/slug), which must ALWAYS come from the live narrow
 * query.
 */

import { unstable_cache } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PublicationSnapshotSchema,
  type PublicationSnapshot,
} from "@/lib/course/publish/schemas";

type DB = SupabaseClient<Database>;

/** The mutable envelope — always read fresh, RLS-scoped, snapshot-free.
 *  (published_at is actually trigger-immutable, but it's a scalar the landing
 *  page renders — riding the narrow meta query keeps it one round trip.) */
export interface PublicationMeta {
  id: string;
  course_id: string;
  version: number;
  slug: string;
  status: string;
  visibility: string;
  content_hash: string;
  published_at: string;
}

const META_COLUMNS =
  "id, course_id, version, slug, status, visibility, content_hash, published_at";

export type MetaResolution =
  | { kind: "found"; meta: PublicationMeta }
  | { kind: "redirect"; slug: string }
  | { kind: "not_found" };

/**
 * Narrow, RLS-scoped slug resolution (mirror of `resolveLivePublicationBySlug`
 * without the snapshot bytes). Anonymous callers resolve live+public only;
 * signed-in callers also resolve unlisted — exactly as before.
 */
export async function resolveLivePublicationMeta(
  supabase: DB,
  slug: string
): Promise<MetaResolution> {
  const current = await supabase
    .from("course_publications")
    .select(META_COLUMNS)
    .eq("status", "live")
    .eq("slug", slug)
    .maybeSingle();
  if (current.error) throw current.error;
  if (current.data) return { kind: "found", meta: current.data as PublicationMeta };

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

/** Narrow, RLS-scoped live-publication lookup by course (meta only). */
export async function getLivePublicationMetaByCourse(
  supabase: DB,
  courseId: string
): Promise<PublicationMeta | null> {
  const { data, error } = await supabase
    .from("course_publications")
    .select(META_COLUMNS)
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();
  if (error) throw error;
  return (data as PublicationMeta) ?? null;
}

interface ImmutableBody {
  id: string;
  course_id: string;
  version: number;
  content_hash: string;
  snapshot: unknown;
}

/**
 * The immutable body, cached forever in the Next data cache keyed by
 * publication id. `revalidate: false` is CORRECT here — the DB trigger rejects
 * any update to snapshot/version/content_hash, so this entry cannot go stale.
 * Unpublish/visibility/slug changes only affect the meta, which is never
 * cached.
 */
const fetchImmutableBody = (publicationId: string) =>
  unstable_cache(
    async (): Promise<ImmutableBody | null> => {
      const admin = createAdminClient();
      const { data, error } = await admin
        .from("course_publications")
        .select("id, course_id, version, content_hash, snapshot")
        .eq("id", publicationId)
        .maybeSingle();
      if (error) throw error;
      return (data as ImmutableBody) ?? null;
    },
    ["publication-body", publicationId],
    { revalidate: false, tags: [`publication-body-${publicationId}`] }
  )();

/**
 * Per-process memo of the PARSED snapshot (the strict Zod parse of a large
 * course is real CPU — diagnosis A6 #2). Keyed by publication id; bounded LRU.
 * Safe because the parse input is immutable.
 */
const PARSE_CACHE_MAX = 32;
const parsedCache = new Map<string, PublicationSnapshot>();

function memoParse(publicationId: string, snapshot: unknown): PublicationSnapshot {
  const hit = parsedCache.get(publicationId);
  if (hit) {
    // refresh LRU position
    parsedCache.delete(publicationId);
    parsedCache.set(publicationId, hit);
    return hit;
  }
  const parsed = PublicationSnapshotSchema.parse(snapshot);
  parsedCache.set(publicationId, parsed);
  if (parsedCache.size > PARSE_CACHE_MAX) {
    const oldest = parsedCache.keys().next().value;
    if (oldest !== undefined) parsedCache.delete(oldest);
  }
  return parsed;
}

/**
 * The cached, parsed, immutable snapshot for a publication the caller has
 * ALREADY resolved through an RLS-scoped meta query. Throws if the id is
 * unknown (meta and body can only disagree if the row was hard-deleted
 * between the two reads).
 */
export async function getCachedSnapshot(publicationId: string): Promise<{
  courseId: string;
  version: number;
  contentHash: string;
  snapshot: PublicationSnapshot;
}> {
  const body = await fetchImmutableBody(publicationId);
  if (!body) throw new Error(`publication ${publicationId} not found`);
  return {
    courseId: body.course_id,
    version: body.version,
    contentHash: body.content_hash,
    snapshot: memoParse(body.id, body.snapshot),
  };
}

/** Test seam: clear the per-process parse memo. */
export function __clearParsedSnapshotCache() {
  parsedCache.clear();
}
