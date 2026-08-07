/**
 * TUTOR-1 Amendment A3 Wave 2 — `recordToolEvidence`: THE tool-evidence writer.
 *
 * Ruling R-3: evidence writes go through this ONE named repository function,
 * wrapping the existing append-only deterministic-id upsert discipline (the
 * service.ts upsertEvent idiom — admin upsert, onConflict client_event_id,
 * ignoreDuplicates). learning_events stays APPEND-ONLY: no versioned UPDATE
 * exists or may be added here; exactly ONE row lands per `completionKey`
 * (id = tutorEvidenceId(`toolev:${completionKey}`)), and a replay is a no-op.
 *
 * Ruling R-1: `conceptSlug` is the concept node's uuid (concepts have no slug).
 * It is validated against the course's concept_nodes with `merged_into` CHAINS
 * resolved to the surviving node (bounded, cycle-safe — `resolveConceptNode`
 * below is pure and unit-tested); a retired/absent/cyclic ref DROPS the
 * observation with a `tutor_evidence_dropped` log (the runtime's drop-and-flag
 * philosophy — this module NEVER throws).
 *
 * Misconceptions: a model-proposed slug is NORMALIZED
 * (`normalizeMisconceptionSlug` — lowercase, hyphenated, [a-z0-9-], ≤80) and
 * get-or-created in the `tutor_misconceptions` registry, race-safe
 * (insert `on conflict do nothing` via ignoreDuplicates, then re-select). A
 * registry hiccup never drops the evidence — the event still records with the
 * slug (the rollup groups by the slug string; the registry id is a bonus link).
 *
 * A3-22 (STRUCTURAL, grep-asserted by verify-tutor-evidence.ts): this module
 * imports NOTHING from the tool-tier / approval surface — evidence recording is
 * an observation, never a gate.
 *
 * NOTE: this module records ONLY. Refold scheduling stays with the caller
 * (service.ts's endpoints show the sendTutorMasteryRefoldRequested pattern) —
 * the Wave-3+ call sites decide when a completion warrants a refold fire.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import {
  buildTutorEvidenceEvent,
  mapEventToColumns,
  type ToolEvidenceInitiation,
  type ToolEvidenceItemSource,
  type ToolEvidenceOutcome,
} from "@/lib/analytics/events";
import { tutorEvidenceId } from "./service";

type DB = SupabaseClient<Database>;

/* ─────────────────────────── the frozen contract ────────────────────────── */

export interface ToolEvidenceInput {
  courseId: string;
  publicationId: string;
  version: number;
  lessonId?: string | null;
  userId: string;
  conceptSlug: string; // concept node uuid (R-1)
  toolName: string;
  outcome: "demonstrated" | "partial" | "not_demonstrated";
  misconceptionSlug?: string | null;
  confidence?: "sure" | "unsure" | null;
  fadeLevel?: number | null;
  initiation: "question" | "practice_request" | "invitation_accepted";
  itemSource?: "generated" | "reviewed"; // default "generated"
  reviewedItemId?: string | null; // [FWD] — always null in A3
  latencyMs?: number | null;
  completionKey: string; // stable per tool completion — the idempotency carrier
}

export type RecordToolEvidenceResult =
  | { recorded: true; misconceptionId: string | null } // registry row id when linked
  | { recorded: false; reason: "unknown_concept" | "invalid_input" | "write_failed" };

/* ────────────────────────── pure helpers (tested) ───────────────────────── */

/**
 * PURE. Normalize a model-proposed misconception slug: lowercase, trim,
 * spaces/underscores → hyphens, strip everything outside [a-z0-9-], collapse
 * hyphen runs, trim edge hyphens, cap at 80 (re-trimming a trailing hyphen the
 * cap may expose). Returns null when nothing survives — an unusable slug.
 */
export function normalizeMisconceptionSlug(raw: string): string | null {
  let slug = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (slug.length > 80) slug = slug.slice(0, 80).replace(/-+$/, "");
  return slug.length > 0 ? slug : null;
}

/** The concept-node fields the resolver walks (camelCase mirror of the row). */
export interface ConceptNodeLineageRef {
  id: string;
  status: "active" | "retired" | "merged_into" | (string & {});
  mergedIntoNodeId: string | null;
}

/**
 * PURE. Resolve a concept node id against a course's node list, following
 * `merged_into` CHAINS to the surviving node. Bounded + cycle-safe (a visited
 * set caps the walk at the list length). Returns the surviving ACTIVE node, or
 * null for an absent, retired, malformed (merged with no survivor), or cyclic
 * reference — the caller drops-and-flags, never throws.
 */
export function resolveConceptNode(
  nodes: readonly ConceptNodeLineageRef[],
  id: string
): ConceptNodeLineageRef | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let current = byId.get(id) ?? null;
  while (current) {
    if (seen.has(current.id)) return null; // cycle — malformed lineage
    seen.add(current.id);
    if (current.status === "active") return current;
    if (current.status === "merged_into" && current.mergedIntoNodeId) {
      current = byId.get(current.mergedIntoNodeId) ?? null;
      continue;
    }
    return null; // retired, or merged with no survivor
  }
  return null; // absent
}

/* ─────────────────────────────── internals ──────────────────────────────── */

function dropped(reason: string, input: ToolEvidenceInput, detail = ""): void {
  console.log(
    JSON.stringify({
      tag: "tutor_evidence_dropped",
      reason,
      detail: detail.slice(0, 200),
      courseId: input.courseId,
      toolName: input.toolName,
      conceptSlug: input.conceptSlug,
      completionKey: input.completionKey,
    })
  );
}

/** Cheap uuid shape gate (the DB would reject a non-uuid anyway — this keeps
 *  the failure a typed `invalid_input`, not a `write_failed`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInput(input: ToolEvidenceInput): string | null {
  if (!input.completionKey || input.completionKey.trim().length === 0)
    return "empty completionKey";
  if (!UUID_RE.test(input.conceptSlug)) return "conceptSlug is not a node uuid";
  if (!UUID_RE.test(input.courseId)) return "courseId is not a uuid";
  if (!UUID_RE.test(input.publicationId)) return "publicationId is not a uuid";
  if (!UUID_RE.test(input.userId)) return "userId is not a uuid";
  if (!Number.isInteger(input.version) || input.version < 1) return "bad version";
  if (!input.toolName || input.toolName.trim().length === 0) return "empty toolName";
  if (
    input.fadeLevel !== null &&
    input.fadeLevel !== undefined &&
    (!Number.isInteger(input.fadeLevel) || input.fadeLevel < 0 || input.fadeLevel > 3)
  )
    return "fadeLevel outside 0..3";
  if (
    input.latencyMs !== null &&
    input.latencyMs !== undefined &&
    (!Number.isInteger(input.latencyMs) || input.latencyMs < 0)
  )
    return "negative latencyMs";
  // [FWD] A3 invariant: no reviewed-item bank exists — a non-null ref is a bug
  // at the call site, refused as invalid_input (the Zod schema pins z.null()).
  if (input.reviewedItemId !== null && input.reviewedItemId !== undefined)
    return "reviewedItemId must be null in A3";
  return null;
}

/** Race-safe get-or-create of the registry row for (course, node, slug):
 *  insert with ignoreDuplicates (→ `on conflict do nothing`), then re-select.
 *  Best-effort — returns null on any failure (the event still records). */
async function ensureMisconceptionRow(
  admin: DB,
  courseId: string,
  nodeId: string,
  slug: string
): Promise<string | null> {
  try {
    await admin
      .from("tutor_misconceptions")
      .upsert([{ course_id: courseId, node_id: nodeId, slug }], {
        onConflict: "course_id,node_id,slug",
        ignoreDuplicates: true,
      });
    const { data, error } = await admin
      .from("tutor_misconceptions")
      .select("id")
      .eq("course_id", courseId)
      .eq("node_id", nodeId)
      .eq("slug", slug)
      .maybeSingle();
    if (error || !data) {
      console.error("[tutor] misconception get-or-create failed", slug, error?.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error("[tutor] misconception get-or-create failed", slug, err);
    return null;
  }
}

/* ───────────────────────────── the ONE writer ───────────────────────────── */

/**
 * Record one tool-completion learning-evidence observation. NEVER throws.
 *
 *  1. Validate the input (typed `invalid_input` on a malformed field).
 *  2. Resolve `conceptSlug` against the course's concept_nodes — merge chains
 *     walk to the survivor; retired/absent/cyclic → `unknown_concept`
 *     (dropped-and-flagged, the runtime's mangled-ref philosophy).
 *  3. Normalize + get-or-create the misconception registry row (best-effort —
 *     an unusable slug or a registry hiccup records the event regardless).
 *  4. Append EXACTLY ONE learning_events row via the upsertEvent discipline,
 *     id = tutorEvidenceId(`toolev:${completionKey}`) — replay is a no-op.
 */
export async function recordToolEvidence(
  admin: DB,
  input: ToolEvidenceInput
): Promise<RecordToolEvidenceResult> {
  try {
    // (1) validate
    const invalid = validateInput(input);
    if (invalid) {
      dropped("invalid_input", input, invalid);
      return { recorded: false, reason: "invalid_input" };
    }

    // (2) resolve the concept node (merge chains → survivor; else drop).
    const { data: nodeRows, error: nodeErr } = await admin
      .from("concept_nodes")
      .select("id, status, merged_into_node_id")
      .eq("course_id", input.courseId);
    if (nodeErr) {
      dropped("write_failed", input, `concept_nodes read: ${nodeErr.message}`);
      return { recorded: false, reason: "write_failed" };
    }
    const resolved = resolveConceptNode(
      (nodeRows ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        mergedIntoNodeId: r.merged_into_node_id,
      })),
      input.conceptSlug
    );
    if (!resolved) {
      dropped("unknown_concept", input);
      return { recorded: false, reason: "unknown_concept" };
    }

    // (3) misconception: normalize + get-or-create (best-effort).
    let misconceptionSlug: string | null = null;
    let misconceptionId: string | null = null;
    if (input.misconceptionSlug != null) {
      misconceptionSlug = normalizeMisconceptionSlug(input.misconceptionSlug);
      if (misconceptionSlug === null) {
        // Unusable slug: keep the evidence, drop only the misconception link.
        console.log(
          JSON.stringify({
            tag: "tutor_misconception_dropped",
            reason: "unusable_slug",
            raw: input.misconceptionSlug.slice(0, 120),
            courseId: input.courseId,
            nodeId: resolved.id,
          })
        );
      } else {
        misconceptionId = await ensureMisconceptionRow(
          admin,
          input.courseId,
          resolved.id,
          misconceptionSlug
        );
      }
    }

    // (4) build + append (the upsertEvent discipline — deterministic id,
    //     onConflict client_event_id, ignoreDuplicates ⇒ replay no-ops).
    const event = buildTutorEvidenceEvent(
      {
        eventType: "tutor_evidence_recorded",
        courseId: input.courseId,
        publicationId: input.publicationId,
        version: input.version,
        lessonId: input.lessonId ?? null,
        nodeId: resolved.id,
        toolName: input.toolName,
        outcome: input.outcome as ToolEvidenceOutcome,
        misconceptionSlug,
        confidence: input.confidence ?? null,
        fadeLevel: input.fadeLevel ?? null,
        initiation: input.initiation as ToolEvidenceInitiation,
        itemSource: (input.itemSource ?? "generated") as ToolEvidenceItemSource,
        reviewedItemId: null, // [FWD] — always null in A3 (validated above)
        latencyMs: input.latencyMs ?? null,
      },
      { clientEventId: tutorEvidenceId(`toolev:${input.completionKey}`) }
    );

    const { error: writeErr } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, input.userId)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (writeErr) {
      dropped("write_failed", input, writeErr.message);
      return { recorded: false, reason: "write_failed" };
    }

    return { recorded: true, misconceptionId };
  } catch (err) {
    dropped("write_failed", input, err instanceof Error ? err.message : String(err));
    return { recorded: false, reason: "write_failed" };
  }
}
