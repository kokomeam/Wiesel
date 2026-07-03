/**
 * Server-side progress writer — the ONLY writer of learn_progress (the table
 * has no client insert/update policies). Every mutation:
 *   1. locates the lesson in the LIVE snapshot (unknown ids are rejected),
 *   2. merges the reported action into progress_state (intersecting ids with
 *      the snapshot so a client can't inflate state with invented slides),
 *   3. recomputes status/pct via the fixed completion rule (completion.ts),
 *      reading REAL quiz attempts from the DB (a client claim is worthless),
 *   4. upserts the row, and
 *   5. on lesson completion, checks course completion and flips the
 *      enrollment to 'completed' (upgrade-only; never downgrades).
 *
 * Takes the ADMIN client: callers (routes) MUST have verified the user's
 * enrollment/authorship first — this module trusts userId/courseId.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { emitServerEvent } from "@/lib/analytics/serverEmit";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  computeLessonProgress,
  findSnapshotLesson,
  isCourseComplete,
  lessonTrackables,
} from "./completion";
import { LearnError } from "./errors";
import {
  ProgressStateSchema,
  type LessonProgressSnapshot,
  type ProgressAction,
  type ProgressState,
} from "./schemas";

type DB = SupabaseClient<Database>;

export interface ProgressContext {
  userId: string;
  courseId: string;
  publicationId: string;
  /** The live publication's version — rides on server-emitted events. */
  version: number;
  snapshot: PublicationSnapshot;
}

function parseState(value: Json | null | undefined): ProgressState {
  const parsed = ProgressStateSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** Merge an action into the stored state. Ids are intersected with the
 *  snapshot's real ids so invented ids can never accumulate. */
export function mergeProgressState(
  state: ProgressState,
  action: ProgressAction,
  snapshot: PublicationSnapshot
): ProgressState {
  const lesson = findSnapshotLesson(snapshot, action.lessonId);
  if (!lesson) throw new LearnError("not_found", "Lesson is not in the live publication.");
  const units = lessonTrackables(lesson);

  switch (action.action) {
    case "lesson_opened":
      return state;
    case "slides_viewed": {
      const unit = units.find((u) => u.kind === "slides" && u.blockId === action.blockId);
      if (!unit || unit.kind !== "slides") {
        throw new LearnError("invalid_request", "Block is not a trackable slide deck.");
      }
      const real = new Set(unit.slideIds);
      const viewed = new Set(state.viewedSlides?.[action.blockId] ?? []);
      for (const id of action.slideIds) if (real.has(id)) viewed.add(id);
      return {
        ...state,
        viewedSlides: { ...(state.viewedSlides ?? {}), [action.blockId]: [...viewed] },
      };
    }
    case "video_progress": {
      const unit = units.find((u) => u.kind === "video" && u.blockId === action.blockId);
      if (!unit) throw new LearnError("invalid_request", "Block is not a trackable video.");
      const prev = state.videoPct?.[action.blockId] ?? 0;
      // High-water mark: scrubbing backwards never loses progress.
      const pct = Math.max(prev, Math.min(100, action.pct));
      return { ...state, videoPct: { ...(state.videoPct ?? {}), [action.blockId]: pct } };
    }
    case "block_viewed": {
      const unit = units.find(
        (u) => u.kind === "imported_deck" && u.blockId === action.blockId
      );
      if (!unit) throw new LearnError("invalid_request", "Block is not a trackable deck.");
      const viewed = new Set(state.viewedBlocks ?? []);
      viewed.add(action.blockId);
      return { ...state, viewedBlocks: [...viewed] };
    }
    case "mark_complete": {
      if (units.length > 0) {
        throw new LearnError(
          "invalid_request",
          "This lesson tracks its own completion — it can't be marked complete manually."
        );
      }
      return { ...state, markedComplete: true };
    }
  }
}

async function attemptedQuizBlocks(
  admin: DB,
  userId: string,
  quizBlockIds: string[]
): Promise<Set<string>> {
  if (quizBlockIds.length === 0) return new Set();
  const { data, error } = await admin
    .from("quiz_attempts")
    .select("block_id")
    .eq("user_id", userId)
    .in("block_id", quizBlockIds);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.block_id));
}

async function maybeCompleteEnrollment(
  admin: DB,
  ctx: ProgressContext
): Promise<boolean> {
  const { data, error } = await admin
    .from("learn_progress")
    .select("lesson_id, status")
    .eq("user_id", ctx.userId)
    .eq("course_id", ctx.courseId);
  if (error) throw error;
  const completed = new Set(
    (data ?? []).filter((r) => r.status === "completed").map((r) => r.lesson_id)
  );
  if (!isCourseComplete(ctx.snapshot, completed)) return false;
  const update = await admin
    .from("enrollments")
    .update({ status: "completed" })
    .eq("course_id", ctx.courseId)
    .eq("user_id", ctx.userId)
    .eq("status", "active");
  if (update.error) throw update.error;
  return true;
}

/**
 * Apply one learner action and return the recomputed lesson progress.
 *
 * Concurrency: read-merge-write with OPTIMISTIC LOCKING. Two near-simultaneous
 * reports (e.g. two slide views racing a slow route compile, or two tabs) must
 * both survive — a plain upsert lets the second writer clobber the first's
 * merge (a lost update the browser suite caught). The update is therefore
 * guarded on the row's updated_at (bumped by the moddatetime trigger on every
 * write) and the insert on the unique index; on conflict we re-read and
 * re-merge, so every reported action lands regardless of interleaving.
 */
export async function applyProgressAction(
  admin: DB,
  ctx: ProgressContext,
  action: ProgressAction
): Promise<LessonProgressSnapshot> {
  const lesson = findSnapshotLesson(ctx.snapshot, action.lessonId);
  if (!lesson) throw new LearnError("not_found", "Lesson is not in the live publication.");

  const quizBlockIds = lessonTrackables(lesson)
    .filter((u) => u.kind === "quiz")
    .map((u) => u.blockId);

  const MAX_TRIES = 4;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const existing = await admin
      .from("learn_progress")
      .select("*")
      .eq("user_id", ctx.userId)
      .eq("course_id", ctx.courseId)
      .eq("lesson_id", action.lessonId)
      .maybeSingle();
    if (existing.error) throw existing.error;

    const prevState = parseState(existing.data?.progress_state);
    const nextState = mergeProgressState(prevState, action, ctx.snapshot);
    const attempted = await attemptedQuizBlocks(admin, ctx.userId, quizBlockIds);
    const computed = computeLessonProgress(lesson, nextState, attempted);
    const status = computed.completed ? "completed" : "in_progress";
    const row = {
      user_id: ctx.userId,
      course_id: ctx.courseId,
      lesson_id: action.lessonId,
      status,
      pct: computed.pct,
      progress_state: nextState as Json,
      last_activity_at: new Date().toISOString(),
    };

    let progressRowId: string;
    if (existing.data) {
      const updated = await admin
        .from("learn_progress")
        .update(row)
        .eq("id", existing.data.id)
        .eq("updated_at", existing.data.updated_at) // optimistic guard
        .select("id");
      if (updated.error) throw updated.error;
      if ((updated.data ?? []).length === 0) continue; // lost the race — re-merge
      progressRowId = existing.data.id;
    } else {
      const inserted = await admin
        .from("learn_progress")
        .insert(row)
        .select("id")
        .single();
      if (inserted.error) {
        if (inserted.error.code === "23505") continue; // concurrent insert — re-merge
        throw inserted.error;
      }
      progressRowId = inserted.data.id;
    }

    // Server-emitted analytics event (hybrid model) exactly when the lesson
    // FLIPS to completed. The learn_progress row id is the idempotency key —
    // one lesson_completed per (user, lesson), ever. Never throws.
    if (computed.completed && existing.data?.status !== "completed") {
      await emitServerEvent(
        admin,
        ctx.userId,
        {
          publicationId: ctx.publicationId,
          version: ctx.version,
          courseId: ctx.courseId,
          lessonId: action.lessonId,
        },
        { eventType: "lesson_completed" },
        progressRowId
      );
    }

    const courseCompleted = computed.completed
      ? await maybeCompleteEnrollment(admin, ctx)
      : false;
    return { lessonId: action.lessonId, status, pct: computed.pct, courseCompleted };
  }
  throw new LearnError("conflict", "Progress is being updated elsewhere — please retry.");
}

/** Recompute a lesson after a quiz attempt landed (no state change — the
 *  attempt itself is read from the DB during recompute). */
export async function recomputeLessonProgress(
  admin: DB,
  ctx: ProgressContext,
  lessonId: string
): Promise<LessonProgressSnapshot> {
  return applyProgressAction(admin, ctx, { action: "lesson_opened", lessonId });
}
