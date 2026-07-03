/**
 * Publishing service — the server-side orchestration over the pure publish
 * modules. Takes a USER-SCOPED Supabase client (RLS enforced end-to-end); the
 * only privileged step is the `publish_course` SECURITY DEFINER RPC, which
 * re-verifies authorship itself and is the single transaction that writes the
 * publication + answer keys.
 *
 * Shared by the /api/publish route and the integration tests (which call these
 * functions directly with a signed-in client).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { CourseDocument } from "@/lib/course/types";
import { summarizePublishDiff } from "./diff";
import { computeContentHash } from "./hash";
import { runPublishPreflight } from "./preflight";
import {
  PublicationSnapshotSchema,
  PublicationStatusSchema,
  PublicationVisibilitySchema,
  PublishRpcResultSchema,
  type PreflightReport,
  type PublicationSettingsUpdate,
  type PublicationSnapshot,
  type PublicationSummary,
  type PublicationVisibility,
  type PublishDiffSummary,
} from "./schemas";
import { buildPublicationSnapshot, findAnswerKeyLeaks } from "./snapshot";
import { isValidSlug, slugifyTitle, suffixedSlug } from "./slug";

type Client = SupabaseClient<Database>;
type PublicationRow = Database["public"]["Tables"]["course_publications"]["Row"];

export class PublishServiceError extends Error {
  constructor(
    public readonly code:
      | "preflight_failed"
      | "invalid_slug"
      | "slug_taken"
      | "no_publication"
      | "already_live"
      | "publish_failed",
    message: string,
    public readonly report?: PreflightReport
  ) {
    super(message);
    this.name = "PublishServiceError";
  }
}

export function rowToSummary(row: PublicationRow): PublicationSummary {
  return {
    id: row.id,
    courseId: row.course_id,
    version: row.version,
    slug: row.slug,
    previousSlugs: row.previous_slugs,
    visibility: PublicationVisibilitySchema.parse(row.visibility),
    status: PublicationStatusSchema.parse(row.status),
    contentHash: row.content_hash,
    publishedAt: row.published_at,
  };
}

/** Latest publication row (any status) for a course, or null. */
export async function getLatestPublication(
  client: Client,
  courseId: string
): Promise<PublicationRow | null> {
  const { data, error } = await client
    .from("course_publications")
    .select("*")
    .eq("course_id", courseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load publication: ${error.message}`);
  return data;
}

function parseSnapshot(row: PublicationRow | null): PublicationSnapshot | null {
  if (!row) return null;
  const parsed = PublicationSnapshotSchema.safeParse(row.snapshot);
  return parsed.success ? parsed.data : null;
}

export interface PublishStatus {
  publication: PublicationSummary | null;
  preflight: PreflightReport;
  /** Diff of the CURRENT DRAFT vs the latest publication. */
  diff: PublishDiffSummary;
  /** Hash the draft WOULD publish as — ≠ publication.contentHash ⇒ unpublished changes. */
  draftContentHash: string;
  draftChanged: boolean;
}

/** Everything the publish UI needs in one call. */
export async function getPublishStatus(
  client: Client,
  doc: CourseDocument
): Promise<PublishStatus> {
  const latest = await getLatestPublication(client, doc.id);
  const { snapshot, answerKeys } = buildPublicationSnapshot(doc);
  const draftContentHash = await computeContentHash(snapshot, answerKeys);
  return {
    publication: latest ? rowToSummary(latest) : null,
    preflight: runPublishPreflight(doc),
    diff: summarizePublishDiff(parseSnapshot(latest), snapshot),
    draftContentHash,
    draftChanged: !latest || latest.status !== "live" || latest.content_hash !== draftContentHash,
  };
}

/** Only LIVE rows contend for a slug (partial unique index), and live rows are
 *  readable by any authenticated user — so collision checking against live
 *  slugs is both sufficient and RLS-visible. */
async function resolveNewSlug(
  client: Client,
  courseId: string,
  requested: string | undefined,
  title: string
): Promise<string> {
  const base = requested ?? slugifyTitle(title);
  if (!isValidSlug(base)) {
    throw new PublishServiceError(
      "invalid_slug",
      "Slugs are lowercase letters/numbers separated by hyphens."
    );
  }
  const { data, error } = await client
    .from("course_publications")
    .select("slug, course_id")
    .eq("status", "live")
    .like("slug", `${base}%`);
  if (error) throw new Error(`Failed to check slug availability: ${error.message}`);
  const taken = new Set(
    (data ?? []).filter((r) => r.course_id !== courseId).map((r) => r.slug)
  );
  const resolved = suffixedSlug(base, taken);
  if (requested && resolved !== requested) {
    throw new PublishServiceError(
      "slug_taken",
      `“${requested}” is already used by another live course.`
    );
  }
  return resolved;
}

export interface PublishResult {
  publication: PublicationSummary;
  diff: PublishDiffSummary;
  /** True when the live publication already matched the draft (no new version). */
  alreadyCurrent: boolean;
}

export async function publishCourse(
  client: Client,
  doc: CourseDocument,
  opts: { slug?: string; visibility?: PublicationVisibility } = {}
): Promise<PublishResult> {
  const preflight = runPublishPreflight(doc);
  if (!preflight.ok) {
    throw new PublishServiceError(
      "preflight_failed",
      "The course has issues that block publishing.",
      preflight
    );
  }

  const { snapshot, answerKeys } = buildPublicationSnapshot(doc);

  // Belt and braces: the snapshot must parse as answer-free (the quiz schema
  // is strict) and a deep scan must find zero key leaks.
  PublicationSnapshotSchema.parse(snapshot);
  const leaks = findAnswerKeyLeaks(snapshot);
  if (leaks.length > 0) {
    throw new PublishServiceError(
      "publish_failed",
      `Refusing to publish: answer-key fields leaked into the snapshot (${leaks[0]}).`
    );
  }

  const contentHash = await computeContentHash(snapshot, answerKeys);
  const latest = await getLatestPublication(client, doc.id);
  const prevSnapshot = parseSnapshot(latest);

  // Identical republish → keep the current version (no empty version bump).
  if (
    latest &&
    latest.status === "live" &&
    latest.content_hash === contentHash &&
    (!opts.visibility || opts.visibility === latest.visibility)
  ) {
    return {
      publication: rowToSummary(latest),
      diff: summarizePublishDiff(prevSnapshot, snapshot),
      alreadyCurrent: true,
    };
  }

  // First publish chooses the slug; republish inherits it inside the RPC.
  const slug = latest ? undefined : await resolveNewSlug(client, doc.id, opts.slug, doc.title);

  const { data, error } = await client.rpc("publish_course", {
    p_course_id: doc.id,
    p_snapshot: snapshot as unknown as Json,
    p_answer_keys: answerKeys as unknown as Json,
    p_content_hash: contentHash,
    p_linter_report: preflight as unknown as Json,
    ...(slug ? { p_slug: slug } : {}),
    ...(opts.visibility ? { p_visibility: opts.visibility } : {}),
  });
  if (error) {
    throw new PublishServiceError("publish_failed", `Publish failed: ${error.message}`);
  }
  const result = PublishRpcResultSchema.parse(data);
  const fresh = await getLatestPublication(client, doc.id);
  return {
    publication: fresh ? rowToSummary(fresh) : { ...result, previousSlugs: [] },
    diff: summarizePublishDiff(prevSnapshot, snapshot),
    alreadyCurrent: false,
  };
}

export async function updatePublicationSettings(
  client: Client,
  courseId: string,
  update: PublicationSettingsUpdate
): Promise<PublicationSummary> {
  const latest = await getLatestPublication(client, courseId);
  if (!latest) {
    throw new PublishServiceError("no_publication", "This course has never been published.");
  }

  switch (update.action) {
    case "unpublish": {
      if (latest.status !== "live") {
        throw new PublishServiceError("no_publication", "The course isn't live.");
      }
      const { data, error } = await client
        .from("course_publications")
        .update({ status: "unpublished" })
        .eq("id", latest.id)
        .select("*")
        .single();
      if (error) throw new Error(`Unpublish failed: ${error.message}`);
      // Mirror the gallery status (display-only; the draft is untouched).
      await client.from("courses").update({ status: "draft" }).eq("id", courseId);
      return rowToSummary(data);
    }
    case "restore": {
      if (latest.status === "live") {
        throw new PublishServiceError("already_live", "The course is already live.");
      }
      const { data, error } = await client
        .from("course_publications")
        .update({ status: "live" })
        .eq("id", latest.id)
        .select("*")
        .single();
      if (error) {
        // The live-slug partial unique index is the backstop for a slug that
        // was claimed by another course while this one was unpublished.
        throw new PublishServiceError(
          "publish_failed",
          `Couldn't restore the publication: ${error.message}`
        );
      }
      await client.from("courses").update({ status: "published" }).eq("id", courseId);
      return rowToSummary(data);
    }
    case "set_slug": {
      if (latest.status !== "live") {
        throw new PublishServiceError("no_publication", "Publish the course before renaming its URL.");
      }
      if (update.slug === latest.slug) return rowToSummary(latest);
      const slug = await resolveNewSlug(client, courseId, update.slug, update.slug);
      const previous = latest.previous_slugs.includes(latest.slug)
        ? latest.previous_slugs
        : [...latest.previous_slugs, latest.slug];
      const { data, error } = await client
        .from("course_publications")
        .update({ slug, previous_slugs: previous })
        .eq("id", latest.id)
        .select("*")
        .single();
      if (error) throw new Error(`Slug update failed: ${error.message}`);
      return rowToSummary(data);
    }
    case "set_visibility": {
      const { data, error } = await client
        .from("course_publications")
        .update({ visibility: update.visibility })
        .eq("id", latest.id)
        .select("*")
        .single();
      if (error) throw new Error(`Visibility update failed: ${error.message}`);
      return rowToSummary(data);
    }
  }
}
