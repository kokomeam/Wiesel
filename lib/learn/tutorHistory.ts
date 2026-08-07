/**
 * SERVER data via the LEARNER's own RLS — a zero-throw browser loader for the
 * learner's tutor transcript.
 *
 * The `tutor_threads` select is user_id-own + enrolled (the strict-regime RLS in
 * migration 20260804100000): a learner reads only their OWN thread, and only
 * while enrolled. Assistant rows carry a `grounding` jsonb (the Wave-3 output
 * contract — cited anchors + the grounded/supplemental span map + flags) plus
 * the dedicated `rung` COLUMN, which this loader injects into the in-memory
 * grounding object (A3 D-2 — the jsonb never carried rung; the column is the
 * truth).
 *
 * ZOD-FREE by house rule: no zod, no lib/tutor/runtime import (the learn route
 * bundle stays schema-free). The supabase param is typed structurally
 * (`SupabaseClient<never> | SupabaseClient`) so this never drags the generated
 * `Database` types into the client chunk — mirroring the loose, no-Database
 * client typing lib/learn/lessonState.ts uses. Every failure path returns `[]`;
 * this never throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  TutorAssessmentCard,
  TutorCitation,
  TutorInvitation,
  TutorRenderStructureCard,
  TutorSpan,
} from "@/lib/learn/tutorClientTypes";

/** A thenable Postgrest result — untyped `data` (coerced tolerantly at the
 *  call site) + Postgrest's `{ message }` error. */
type QueryResult = { data: unknown; error: { message: string } | null };

/** The minimal query-builder surface `loadTutorHistory` chains — a self-returning
 *  fluent builder that is also a thenable (awaiting it yields a `QueryResult`).
 *  Deliberately loose (no generated `Database` types) to keep this file — and the
 *  learn route bundle — free of the zod-carrying schema chain. */
interface QueryBuilder extends PromiseLike<QueryResult> {
  select: (cols: string) => QueryBuilder;
  eq: (col: string, val: string) => QueryBuilder;
  order: (col: string, opts: { ascending: boolean }) => QueryBuilder;
  maybeSingle: () => PromiseLike<QueryResult>;
}

/** One row of the rendered transcript. `grounding` is present on assistant rows
 *  (null when absent or malformed). */
export interface TutorHistoryTurn {
  id: string;
  role: "learner" | "assistant" | "instructor";
  content: string;
  createdAt: string;
  grounding: {
    citations: TutorCitation[];
    spans: TutorSpan[];
    flags: string[];
    rung: number | null;
    invitation: TutorInvitation | null;
    /** A3 Wave 4 · presentational diagrams (default [] — survive reload IFF the
     *  server persisted them into the grounding jsonb; the practiceItems
     *  precedent). */
    structures: TutorRenderStructureCard[];
    /** A3 Wave 4 · assessment cards (default [], same persistence caveat). */
    assessments: TutorAssessmentCard[];
  } | null;
}

/** A3 Wave 3 · tolerantly coerce a `grounding.invitation` jsonb value — every
 *  field must be a string or the whole invitation degrades to null (a
 *  malformed invitation must never render a broken button). */
function coerceInvitation(raw: unknown): TutorInvitation | null {
  if (!raw || typeof raw !== "object") return null;
  const inv = raw as Record<string, unknown>;
  if (
    typeof inv.toolName !== "string" ||
    typeof inv.nodeId !== "string" ||
    typeof inv.label !== "string"
  ) {
    return null;
  }
  return { toolName: inv.toolName, nodeId: inv.nodeId, label: inv.label };
}

/** A3 Wave 4 · tolerantly coerce a persisted `grounding.structures` array — each
 *  entry must carry a valid `kind` + a `diagram` object (the diagram itself was
 *  validated server-side before persistence). Any malformed entry is DROPPED so a
 *  broken card never renders; a non-array degrades to []. */
function coerceStructures(raw: unknown): TutorRenderStructureCard[] {
  if (!Array.isArray(raw)) return [];
  const KINDS = new Set(["tree", "graph", "timeline", "axes"]);
  const out: TutorRenderStructureCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.kind !== "string" || !KINDS.has(s.kind)) continue;
    if (!s.diagram || typeof s.diagram !== "object") continue;
    out.push({
      kind: s.kind as TutorRenderStructureCard["kind"],
      title: typeof s.title === "string" ? s.title : null,
      caption: typeof s.caption === "string" ? s.caption : null,
      diagram: s.diagram as TutorRenderStructureCard["diagram"],
    });
  }
  return out;
}

/** A3 Wave 4 · tolerantly coerce a persisted `grounding.assessments` array — each
 *  entry must have a known `toolName` + the fields that entry's card renders.
 *  Malformed entries are DROPPED; a non-array degrades to []. */
function coerceAssessments(raw: unknown): TutorAssessmentCard[] {
  if (!Array.isArray(raw)) return [];
  const out: TutorAssessmentCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (
      typeof a.cardId !== "string" ||
      typeof a.conceptSlug !== "string" ||
      (a.initiation !== "practice_request" && a.initiation !== "invitation_accepted")
    ) {
      continue;
    }
    if (a.toolName === "checkUnderstanding" && typeof a.stem === "string" && Array.isArray(a.options)) {
      const options = (a.options as unknown[])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .filter((o) => typeof o.id === "string" && typeof o.text === "string" && typeof o.correct === "boolean")
        .map((o) => ({
          id: o.id as string,
          text: o.text as string,
          correct: o.correct as boolean,
          misconceptionId: typeof o.misconceptionId === "string" ? (o.misconceptionId as string) : null,
          feedback: typeof o.feedback === "string" ? (o.feedback as string) : "",
        }));
      if (options.length === 0) continue;
      out.push({
        cardId: a.cardId,
        toolName: "checkUnderstanding",
        conceptSlug: a.conceptSlug,
        initiation: a.initiation,
        stem: a.stem,
        options,
        collectConfidence: a.collectConfidence === true,
      });
    } else if (
      a.toolName === "sequenceTask" &&
      typeof a.prompt === "string" &&
      Array.isArray(a.items) &&
      Array.isArray(a.correctOrder)
    ) {
      const items = (a.items as unknown[])
        .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
        .filter((it) => typeof it.id === "string" && typeof it.text === "string")
        .map((it) => ({ id: it.id as string, text: it.text as string }));
      const correctOrder = (a.correctOrder as unknown[]).filter((x): x is string => typeof x === "string");
      if (items.length === 0) continue;
      out.push({
        cardId: a.cardId,
        toolName: "sequenceTask",
        conceptSlug: a.conceptSlug,
        initiation: a.initiation,
        prompt: a.prompt,
        items,
        correctOrder,
        partialCreditRule: a.partialCreditRule === "adjacent-pairs" ? "adjacent-pairs" : "exact",
      });
    }
  }
  return out;
}

/** Tolerantly coerce a `grounding` jsonb blob to the client shape. Any missing or
 *  malformed field degrades — citations/spans/flags/structures/assessments default
 *  to `[]`, rung and invitation to null. Returns null when there's nothing usable.
 *  Exported for the pure suite (scripts/verify-tutor-client.ts). */
export function coerceGrounding(raw: unknown): TutorHistoryTurn["grounding"] {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const citations = Array.isArray(g.citations)
    ? (g.citations as TutorCitation[])
    : [];
  const spans = Array.isArray(g.spans) ? (g.spans as TutorSpan[]) : [];
  const flags = Array.isArray(g.flags)
    ? (g.flags as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  const rung = typeof g.rung === "number" ? g.rung : null;
  const invitation = coerceInvitation(g.invitation);
  const structures = coerceStructures(g.structures);
  const assessments = coerceAssessments(g.assessments);
  return { citations, spans, flags, rung, invitation, structures, assessments };
}

/**
 * Load the learner's tutor transcript for a course, newest-thread-first order.
 *
 * Selects the (user_id, course_id) thread via `maybeSingle` — no thread ⇒ `[]`.
 * Then reads its `tutor_turns` ordered `created_at asc` and maps rows tolerantly.
 * RLS does the gating (own + enrolled). NEVER throws: any error path returns `[]`.
 */
export async function loadTutorHistory(
  supabase: SupabaseClient<never> | SupabaseClient,
  userId: string,
  courseId: string,
): Promise<TutorHistoryTurn[]> {
  // The `SupabaseClient<never> | SupabaseClient` union (the house param type —
  // see lessonState.ts / rpcJson.ts) has an un-callable `.from()` on the union;
  // like rpcJson casts to a minimal `.rpc` shape, we cast once to a minimal
  // query-builder surface so the chains type-check without the generated
  // `Database` types (which would drag zod into the client bundle) and without
  // `any`. Every result is coerced tolerantly below, so a loose shape is safe.
  const db = supabase as unknown as {
    from: (table: string) => QueryBuilder;
  };
  try {
    const { data: thread, error: threadError } = await db
      .from("tutor_threads")
      .select("id")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .maybeSingle();
    if (threadError || !thread) return [];

    const threadId = (thread as { id: string }).id;
    const { data: turns, error: turnsError } = await db
      .from("tutor_turns")
      .select("id, role, content, grounding, rung, created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });
    if (turnsError || !Array.isArray(turns)) return [];

    return turns.map((raw): TutorHistoryTurn => {
      const row = raw as Record<string, unknown>;
      // A3 D-2: the rung lives ONLY in the dedicated `rung` COLUMN (it was never
      // written into the grounding jsonb) — inject it into the coerced grounding
      // at load time so history turns carry it (the escape-hatch gate reads it).
      // The column is the truth; any jsonb value is only a defensive fallback.
      const grounding = coerceGrounding(row.grounding);
      const rung = typeof row.rung === "number" ? row.rung : null;
      return {
        id: String(row.id),
        role: row.role as TutorHistoryTurn["role"],
        content: typeof row.content === "string" ? row.content : "",
        createdAt: String(row.created_at),
        grounding: grounding === null ? null : { ...grounding, rung: rung ?? grounding.rung },
      };
    });
  } catch {
    return [];
  }
}
