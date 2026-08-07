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
import type { TutorCitation, TutorSpan } from "@/lib/learn/tutorClientTypes";

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
  } | null;
}

/** Tolerantly coerce a `grounding` jsonb blob to the client shape. Any missing or
 *  malformed field degrades — citations/spans/flags default to `[]`, rung to null.
 *  Returns null when there's nothing usable. */
function coerceGrounding(raw: unknown): TutorHistoryTurn["grounding"] {
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
  return { citations, spans, flags, rung };
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
