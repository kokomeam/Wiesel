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
  is: (col: string, val: null) => QueryBuilder;
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
    } else if (
      // A3 Wave 5 · fadedExample — problem + the COMPLETE worked steps (each with a
      // text + answer; `blanked` marks the trailing steps to fill). fadeLevel is a
      // number; a step missing its text/answer drops.
      a.toolName === "fadedExample" &&
      typeof a.problem === "string" &&
      Array.isArray(a.steps)
    ) {
      const steps = (a.steps as unknown[])
        .filter((st): st is Record<string, unknown> => !!st && typeof st === "object")
        .filter((st) => typeof st.text === "string" && typeof st.answer === "string")
        .map((st) => ({
          text: st.text as string,
          blanked: st.blanked === true,
          answer: st.answer as string,
        }));
      if (steps.length === 0) continue;
      out.push({
        cardId: a.cardId,
        toolName: "fadedExample",
        conceptSlug: a.conceptSlug,
        initiation: a.initiation,
        fadeLevel: typeof a.fadeLevel === "number" ? a.fadeLevel : 0,
        problem: a.problem,
        steps,
      });
    } else if (
      // A3 Wave 5 · predictThenReveal — setup + prompt + the accepted/near-miss keys
      // (ship for local grading) + the reveal.
      a.toolName === "predictThenReveal" &&
      typeof a.setup === "string" &&
      typeof a.prompt === "string" &&
      typeof a.revealExplanation === "string"
    ) {
      const acceptedAnswers = Array.isArray(a.acceptedAnswers)
        ? (a.acceptedAnswers as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const nearMisses = Array.isArray(a.nearMisses)
        ? (a.nearMisses as unknown[])
            .filter((nm): nm is Record<string, unknown> => !!nm && typeof nm === "object")
            .filter(
              (nm) =>
                typeof nm.pattern === "string" &&
                typeof nm.misconceptionId === "string" &&
                typeof nm.feedback === "string",
            )
            .map((nm) => ({
              pattern: nm.pattern as string,
              misconceptionId: nm.misconceptionId as string,
              feedback: nm.feedback as string,
            }))
        : [];
      out.push({
        cardId: a.cardId,
        toolName: "predictThenReveal",
        conceptSlug: a.conceptSlug,
        initiation: a.initiation,
        setup: a.setup,
        prompt: a.prompt,
        acceptedAnswers,
        nearMisses,
        revealExplanation: a.revealExplanation,
      });
    } else if (
      // A3 Wave 5 · explainBack — prompt + a 2–5 criterion rubric. A rubric entry
      // missing its criterion string drops; an empty rubric drops the whole card.
      a.toolName === "explainBack" &&
      typeof a.prompt === "string" &&
      Array.isArray(a.rubric)
    ) {
      const rubric = (a.rubric as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter((r) => typeof r.criterion === "string")
        .map((r) => ({ criterion: r.criterion as string, required: r.required === true }));
      if (rubric.length === 0) continue;
      out.push({
        cardId: a.cardId,
        toolName: "explainBack",
        conceptSlug: a.conceptSlug,
        initiation: a.initiation,
        prompt: a.prompt,
        rubric,
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
 * Load the learner's tutor transcript for the ACTIVE thread of a LESSON (A4).
 *
 * A4 scopes threads to lessons: this resolves the ACTIVE (non-archived) thread
 * for (user_id, lesson_id) — or the general (null-lesson) thread for
 * (user_id, course_id) when `lessonId` is null — via `maybeSingle` (no thread ⇒
 * `[]`), then reads its `tutor_turns` ordered `created_at asc`. Opening a
 * different lesson resolves a different thread (A4-2); an archived thread is not
 * shown here (Start fresh opens a new one). RLS gates (own + enrolled). NEVER
 * throws: any error path returns `[]`.
 */
export async function loadTutorHistory(
  supabase: SupabaseClient<never> | SupabaseClient,
  userId: string,
  courseId: string,
  lessonId: string | null = null,
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
    // Resolve the ACTIVE thread: (user, lesson) when a lesson is open, else the
    // general (null-lesson) thread for the course. archived_at is null = active.
    const threadBase = db
      .from("tutor_threads")
      .select("id")
      .eq("user_id", userId)
      .is("archived_at", null);
    const threadQuery = lessonId
      ? threadBase.eq("lesson_id", lessonId).maybeSingle()
      : threadBase.eq("course_id", courseId).is("lesson_id", null).maybeSingle();
    const { data: thread, error: threadError } = await threadQuery;
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

/**
 * The set of lesson ids the learner has a non-empty tutor conversation for (A4-8)
 * — the course-outline "has a conversation here" indicators. Derived from
 * `tutor_turns` (a turn is denormalized with its lesson_id), so it counts a
 * lesson iff ≥1 turn was ever sent from it — independent of whether the current
 * thread is active or archived (a conversation the learner started still exists).
 * RLS scopes to the learner's own+enrolled rows. NEVER throws: any error ⇒ empty.
 */
export async function loadTutoredLessonIds(
  supabase: SupabaseClient<never> | SupabaseClient,
  userId: string,
  courseId: string,
): Promise<Set<string>> {
  const db = supabase as unknown as { from: (table: string) => QueryBuilder };
  try {
    const { data, error } = await db
      .from("tutor_turns")
      .select("lesson_id")
      .eq("user_id", userId)
      .eq("course_id", courseId);
    if (error || !Array.isArray(data)) return new Set();
    const ids = new Set<string>();
    for (const raw of data) {
      const lessonId = (raw as { lesson_id?: unknown }).lesson_id;
      if (typeof lessonId === "string" && lessonId) ids.add(lessonId);
    }
    return ids;
  } catch {
    return new Set();
  }
}
