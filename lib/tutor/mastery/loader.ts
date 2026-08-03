/**
 * Mastery EVIDENCE LOADER (TUTOR-1 Wave 2). IMPURE — the ONE place the refold
 * touches the DB (admin/service-role client). It gathers every evidence source
 * for a single (user, course), normalizes each into `MasteryEvidence` via the
 * pure mappers (evidence.ts), assembles + sorts the stream, and drives
 * `refoldMastery`. The writer (writer.ts) persists the result.
 *
 * SOURCES (each pulled here, mapped by evidence.ts):
 *   1. quiz_attempt_detail — per-question correctness (block-anchored nodes).
 *   2. HISTORICAL quiz_attempts WITHOUT detail rows — block-level score only
 *      (the cold-start story). We DEDUPE against attempts that HAVE detail (an
 *      attempt with per-question rows is source #1, never double-counted here).
 *      Ordinal is derived by (created_at, id) per (user, publication, block) in
 *      the mapper — reproducible from the raw rows (R-22).
 *   3. learning_events of the five evidence types (practice_answer, hint_request,
 *      self_report, tutor_inference, content_engagement) — the typed columns +
 *      metadata already ride the row.
 *   4. DERIVED dwell — slide_viewed dwell events joined against the per-slide
 *      cohort median in rollup_slide_dwell (the dwell_over_median derivation).
 *
 * ANCHORS: block→nodeIds and slide→nodeIds are built from ACTIVE concept_nodes
 * (status='active') via their `anchors` jsonb (R-13 shape {lessonId, blockId,
 * slideId?}). The lineage index is loaded via lineage.ts.
 *
 * ⚠ TYPE LAG: quiz_attempt_detail / learner_mastery may not be in
 * database.types.ts yet (the sibling is splicing them). Reads of a still-untyped
 * table go through a narrowly-cast client so tsc stays clean here; when the
 * sibling lands the types the casts become no-ops.
 *
 * ZERO MODEL CALLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { resolveMasteryConfig, type MasteryConfig } from "./config";
import { refoldMastery, type MasteryRow } from "./refold";
import { loadLineageIndex } from "./lineage";
import {
  assembleEvidence,
  mapQuizDetail,
  mapHistoricalAttempts,
  mapEvents,
  mapDwell,
  type MasteryEvidence,
  type QuizDetailRow,
  type HistoricalAttemptRow,
  type MasteryEventRow,
  type DwellRow,
} from "./evidence";
import type { TutorInferenceStrength } from "./weights";

type DB = SupabaseClient<Database>;

/** An anchor as it rides on concept_nodes.anchors (R-13 shape). */
interface NodeAnchor {
  lessonId: string;
  blockId: string;
  slideId?: string | null;
}

/* ────────────────────────────── anchors + active ids ────────────────────── */

/**
 * Load the ACTIVE concept-node id set + the block→nodeIds and slide→nodeIds
 * anchor maps from concept_nodes (status='active'). A node with N anchors
 * contributes its id under every anchored block (and slide, when the anchor
 * carries a slideId). Pure over the fetched rows.
 */
async function loadActiveAnchors(supabase: DB, courseId: string): Promise<{
  activeNodeIds: Set<string>;
  blockNodeIds: Map<string, string[]>;
  slideNodeIds: Map<string, string[]>;
}> {
  const { data, error } = await supabase
    .from("concept_nodes")
    .select("id, anchors")
    .eq("course_id", courseId)
    .eq("status", "active");
  if (error) throw new Error(`loadActiveAnchors: ${error.message}`);

  const activeNodeIds = new Set<string>();
  const blockNodeIds = new Map<string, string[]>();
  const slideNodeIds = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, nodeId: string) => {
    const list = map.get(key);
    if (list) {
      if (!list.includes(nodeId)) list.push(nodeId);
    } else {
      map.set(key, [nodeId]);
    }
  };

  for (const row of data ?? []) {
    const nodeId = (row as { id: string }).id;
    activeNodeIds.add(nodeId);
    const anchors = ((row as { anchors: unknown }).anchors as NodeAnchor[] | null) ?? [];
    for (const a of anchors) {
      if (a && typeof a.blockId === "string" && a.blockId.length > 0) {
        push(blockNodeIds, a.blockId, nodeId);
      }
      if (a && typeof a.slideId === "string" && a.slideId.length > 0) {
        push(slideNodeIds, a.slideId, nodeId);
      }
    }
  }
  return { activeNodeIds, blockNodeIds, slideNodeIds };
}

/* ─────────────────────────────── quiz sources ───────────────────────────── */

/** A quiz_attempt_detail row shape (the table may not be typed yet). Column
 *  names mirror the migration the sibling authors. */
interface QuizAttemptDetailDbRow {
  attempt_id: string;
  question_id: string;
  block_id: string;
  correct: boolean;
  created_at: string;
}

/**
 * Load per-question detail evidence + the set of attempt ids that HAVE detail
 * (so the historical loader can exclude them). Reads quiz_attempt_detail joined
 * to its parent quiz_attempts for the (user, course) scope.
 */
async function loadQuizDetail(
  supabase: DB,
  userId: string,
  courseId: string
): Promise<{ rows: QuizDetailRow[]; attemptsWithDetail: Set<string> }> {
  // quiz_attempts gives us the (user, course)-scoped attempt ids + publication.
  const { data: attempts, error: attErr } = await supabase
    .from("quiz_attempts")
    .select("id, user_id, course_id, publication_id, block_id, submitted_at")
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (attErr) throw new Error(`loadQuizDetail attempts: ${attErr.message}`);

  const attemptMeta = new Map<
    string,
    { publicationId: string; blockId: string; submittedAt: string }
  >();
  for (const a of attempts ?? []) {
    attemptMeta.set((a as { id: string }).id, {
      publicationId: (a as { publication_id: string }).publication_id,
      blockId: (a as { block_id: string }).block_id,
      submittedAt: (a as { submitted_at: string }).submitted_at,
    });
  }
  const attemptIds = [...attemptMeta.keys()];
  if (attemptIds.length === 0) return { rows: [], attemptsWithDetail: new Set() };

  // quiz_attempt_detail may not be typed yet — go through a cast client for it.
  const detailQuery = (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        in: (col: string, vals: string[]) => Promise<{ data: QuizAttemptDetailDbRow[] | null; error: { message: string } | null }>;
      };
    };
  })
    .from("quiz_attempt_detail")
    .select("attempt_id, question_id, block_id, correct, created_at")
    .in("attempt_id", attemptIds);
  const { data: details, error: detErr } = await detailQuery;
  if (detErr) throw new Error(`loadQuizDetail detail: ${detErr.message}`);

  const attemptsWithDetail = new Set<string>();
  const rows: QuizDetailRow[] = [];
  for (const d of details ?? []) {
    const meta = attemptMeta.get(d.attempt_id);
    if (!meta) continue; // detail whose parent isn't in scope — ignore
    attemptsWithDetail.add(d.attempt_id);
    rows.push({
      attemptId: d.attempt_id,
      userId,
      courseId,
      publicationId: meta.publicationId,
      // Prefer the detail row's block (question's own block) but fall back to the
      // attempt's block when the detail omits it.
      blockId: d.block_id || meta.blockId,
      questionId: d.question_id,
      correct: d.correct,
      createdAt: d.created_at || meta.submittedAt,
    });
  }
  return { rows, attemptsWithDetail };
}

/**
 * Load HISTORICAL detail-less attempts: quiz_attempts for the (user, course)
 * whose id is NOT in `attemptsWithDetail`. score fraction = score / max_score
 * (guarded). createdAt = submitted_at (the recorded instant; quiz_attempts has
 * no created_at column — submitted_at is the stable order key for the ordinal).
 */
async function loadHistoricalAttempts(
  supabase: DB,
  userId: string,
  courseId: string,
  attemptsWithDetail: Set<string>
): Promise<HistoricalAttemptRow[]> {
  const { data, error } = await supabase
    .from("quiz_attempts")
    .select("id, user_id, publication_id, block_id, score, max_score, submitted_at")
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (error) throw new Error(`loadHistoricalAttempts: ${error.message}`);

  const out: HistoricalAttemptRow[] = [];
  for (const a of data ?? []) {
    const id = (a as { id: string }).id;
    if (attemptsWithDetail.has(id)) continue; // has per-question detail → source #1
    const score = (a as { score: number }).score ?? 0;
    const max = (a as { max_score: number }).max_score ?? 0;
    const scoreFraction = max > 0 ? score / max : 0;
    out.push({
      attemptId: id,
      userId,
      publicationId: (a as { publication_id: string }).publication_id,
      blockId: (a as { block_id: string }).block_id,
      scoreFraction,
      createdAt: (a as { submitted_at: string }).submitted_at,
    });
  }
  return out;
}

/* ─────────────────────────────── event source ───────────────────────────── */

/**
 * Load the five Wave-2 evidence-type learning_events for the (user, course).
 * The typed columns (evidence_correct, attempt_ordinal, hint_rung, node_id) ride
 * the row; tutor_inference direction/strength + content_engagement signal ride
 * `metadata` jsonb. The learner is `user_id` (the ingest RPC pins it to auth.uid).
 */
async function loadEvidenceEvents(
  supabase: DB,
  userId: string,
  courseId: string
): Promise<MasteryEventRow[]> {
  const { data, error } = await supabase
    .from("learning_events")
    .select(
      "id, event_type, node_id, server_ts, evidence_correct, attempt_ordinal, hint_rung, metadata"
    )
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .in("event_type", [
      "practice_answer",
      "hint_request",
      "self_report",
      "tutor_inference",
      "content_engagement",
    ]);
  if (error) throw new Error(`loadEvidenceEvents: ${error.message}`);

  const out: MasteryEventRow[] = [];
  for (const r of data ?? []) {
    const eventType = (r as { event_type: string }).event_type as MasteryEventRow["eventType"];
    const meta = ((r as { metadata: unknown }).metadata ?? {}) as Record<string, unknown>;
    out.push({
      eventId: (r as { id: string }).id,
      eventType,
      nodeId: (r as { node_id: string | null }).node_id,
      createdAt: (r as { server_ts: string }).server_ts,
      evidenceCorrect: (r as { evidence_correct: boolean | null }).evidence_correct,
      attemptOrdinal: (r as { attempt_ordinal: number | null }).attempt_ordinal,
      hintRung: (r as { hint_rung: number | null }).hint_rung,
      inferenceDirection:
        eventType === "tutor_inference" && (meta.direction === "positive" || meta.direction === "negative")
          ? meta.direction
          : null,
      inferenceStrength:
        eventType === "tutor_inference" && (meta.strength === "weak" || meta.strength === "moderate")
          ? (meta.strength as TutorInferenceStrength)
          : null,
      contentSignal:
        eventType === "content_engagement" &&
        (meta.signal === "rewatch" || meta.signal === "scrub_back" || meta.signal === "completed")
          ? (meta.signal as "rewatch" | "scrub_back" | "completed")
          : null,
    });
  }
  return out;
}

/* ─────────────────────────────── dwell source ───────────────────────────── */

/**
 * Load slide_viewed dwell events for the (user, course) and pair each with its
 * slide's cohort median (from rollup_slide_dwell). The mapper (mapDwell) raises
 * a light negative only when dwell > `dwellOverMedianMult` × the median AND the
 * slide anchors ≥1 active node.
 */
async function loadDwell(
  supabase: DB,
  userId: string,
  courseId: string,
  slideNodeIds: Map<string, string[]>
): Promise<DwellRow[]> {
  // The cohort median per slide (course-scoped; ignore publication versioning —
  // the median-of-the-slide is the cohort read the derivation wants).
  const { data: rollups, error: rollErr } = await supabase
    .from("rollup_slide_dwell")
    .select("slide_id, median_dwell_ms")
    .eq("course_id", courseId);
  if (rollErr) throw new Error(`loadDwell rollups: ${rollErr.message}`);
  const medianBySlide = new Map<string, number | null>();
  for (const r of rollups ?? []) {
    medianBySlide.set(
      (r as { slide_id: string }).slide_id,
      (r as { median_dwell_ms: number | null }).median_dwell_ms
    );
  }

  const { data: events, error: evErr } = await supabase
    .from("learning_events")
    .select("id, slide_id, dwell_ms, server_ts")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .eq("event_type", "slide_viewed");
  if (evErr) throw new Error(`loadDwell events: ${evErr.message}`);

  const out: DwellRow[] = [];
  for (const e of events ?? []) {
    const slideId = (e as { slide_id: string | null }).slide_id;
    const dwellMs = (e as { dwell_ms: number | null }).dwell_ms;
    if (!slideId || dwellMs === null || dwellMs === undefined) continue;
    const nodeIds = slideNodeIds.get(slideId) ?? [];
    if (nodeIds.length === 0) continue; // no active node anchored to this slide
    out.push({
      eventId: (e as { id: string }).id,
      nodeIds,
      dwellMs,
      cohortMedianMs: medianBySlide.get(slideId) ?? null,
      createdAt: (e as { server_ts: string }).server_ts,
    });
  }
  return out;
}

/* ──────────────────────────────── the loader ────────────────────────────── */

/**
 * Gather every evidence source for one (user, course), assemble the sorted
 * stream, resolve through lineage, and refold to mastery rows. Returns the rows
 * + the total evidence count (post-mapping, pre-lineage-fanout — the count of
 * normalized observations, useful for the caller's telemetry).
 *
 * `nowIso` defaults to the current instant (the ONLY clock read in the module —
 * a caller [the Inngest fn / a test] passes an explicit instant for determinism).
 */
export async function refoldLearnerCourse(
  admin: DB,
  params: { userId: string; courseId: string; nowIso?: string; cfg?: MasteryConfig }
): Promise<{ rows: MasteryRow[]; evidenceCount: number }> {
  const { userId, courseId } = params;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const cfg = params.cfg ?? resolveMasteryConfig();

  const [{ activeNodeIds, blockNodeIds, slideNodeIds }, lineage] = await Promise.all([
    loadActiveAnchors(admin, courseId),
    loadLineageIndex(admin, courseId),
  ]);

  const { rows: detailRows, attemptsWithDetail } = await loadQuizDetail(admin, userId, courseId);
  const [historicalRows, eventRows, dwellRowsRaw] = await Promise.all([
    loadHistoricalAttempts(admin, userId, courseId, attemptsWithDetail),
    loadEvidenceEvents(admin, userId, courseId),
    loadDwell(admin, userId, courseId, slideNodeIds),
  ]);

  const parts: MasteryEvidence[][] = [
    mapQuizDetail(detailRows, blockNodeIds),
    mapHistoricalAttempts(historicalRows, blockNodeIds),
    mapEvents(eventRows),
    mapDwell(dwellRowsRaw, cfg),
  ];
  const evidence = assembleEvidence(parts);

  const rows = refoldMastery(evidence, activeNodeIds, lineage, nowIso, cfg);
  return { rows, evidenceCount: evidence.length };
}
