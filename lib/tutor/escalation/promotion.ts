/**
 * Escalation CONTENT-PATCH PROMOTION service (TUTOR-1 Wave 6 · P6.4).
 *
 * `promoteClusterToPatch(admin, model, {courseId, clusterId})` closes the escalation
 * loop: it turns ONE creator-visible cluster (many learners asking the same thing on
 * one concept) into a proposed CLARIFICATION drafted by Terra and filed through the
 * EXISTING change-set rail — the SAME createChangeSet → pending BlockFrame chrome →
 * EvidenceCard → acceptChangeSet/rejectChangeSet the maintenance agent uses. There is
 * NO new approval system: the creator reviews the drafted FAQ block in the studio and
 * Accepts (it stays) or Rejects (it reverts BYTE-IDENTICAL through the pipeline).
 *
 * THE FLOW (service-role — escalation_dossier is identity-bearing, zero policies):
 *   (a) load the cluster + a representative dossier (its earliest member);
 *   (b) resolve the implicated LESSON from the concept node's teaching anchors (the
 *       first anchor's lessonId; fall back to snapshot_concept_map when the node has
 *       no draft anchor) — unresolvable → a typed reason, nothing filed;
 *   (c) Terra drafts a FAQ/clarification LectureTextBlock over the ANONYMIZED
 *       representative question + the creator's approved answer + the node context —
 *       NO learner identity ever reaches the model (the privacy spine);
 *   (d) load the course doc, append the block to that lesson, RECONCILE (persist), and
 *       stage a change-set recording the create with the dossier summary as evidence;
 *   (e) record cluster.change_set_id (admin update).
 *
 * IDEMPOTENT-ISH: a cluster already carrying a change_set_id whose change_set is still
 * `pending` short-circuits (returns the existing id) — a double Promote never files a
 * second FAQ block. A dismissed/accepted prior change-set lets a fresh promotion run.
 *
 * RESOLUTION IS DERIVED, NOT HOOKED: this service NEVER touches acceptChangeSet. A
 * cluster is "resolved_in_content" when its change_set_id's change_sets.status is
 * 'accepted' — computed by the tutor_escalation_queue / tutor_graph_console RPCs at
 * read time. Accepting the change-set through the ordinary rail is all it takes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { runStructuredCall } from "@/lib/ai/subagent";
import { buildLectureBlock } from "@/lib/ai/tools/blockBuilders";
import { createChangeSet } from "@/lib/ai/changeSet";
import { diffBlocks } from "@/lib/ai/changeSetDiff";
import { loadCourseDoc, reconcileCourseDoc } from "@/lib/ai/serverPersistence";
import type { CourseDocument, LectureTextBlock } from "@/lib/course/types";
import { buildPromotionBlockSpec, PROMOTION_RESPONSE_NAME, PromotionDraftSchema } from "./promotionDraft";

type DB = SupabaseClient<Database>;

/** The result of a promotion. `ok:false` carries a typed reason (unresolvable lesson,
 *  a missing course doc, …); on success it names the staged change-set + the lesson it
 *  landed in so the caller can revalidate + deep-link. `reused:true` means the cluster
 *  already had a pending change-set and we returned it (no new block filed). */
export type PromoteClusterResult =
  | { ok: true; changeSetId: string; lessonId: string; reused: boolean }
  | { ok: false; reason: string };

/** A representative dossier — the cluster's earliest member. Identity-bearing; read
 *  service-role. We use only its node_ids (for the anchor fallback) + question. */
interface RepresentativeDossier {
  nodeIds: string[];
  learnerQuestion: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Promote a cluster to a proposed content clarification, filed through the standard
 * change-set rail. Service-role. Returns the staged change-set id + the lesson.
 */
export async function promoteClusterToPatch(
  admin: DB,
  model: ModelClient,
  args: { courseId: string; clusterId: string; finalAnswer?: string | null }
): Promise<PromoteClusterResult> {
  const { courseId, clusterId } = args;

  /* 1. Load the cluster (identity-free surface). */
  const clusterRes = await admin
    .from("escalation_cluster")
    .select("id, course_id, node_id, representative_question, representative_answer, status, change_set_id")
    .eq("id", clusterId)
    .eq("course_id", courseId)
    .maybeSingle();
  if (clusterRes.error || !clusterRes.data) {
    return { ok: false, reason: "cluster_not_found" };
  }
  const cluster = clusterRes.data;

  /* 2. Idempotency: a still-pending change-set means we already filed this cluster —
   *    return it (never double-file). A dismissed/accepted prior lets a new run file. */
  if (cluster.change_set_id) {
    const existing = await admin
      .from("change_sets")
      .select("id, status")
      .eq("id", cluster.change_set_id)
      .maybeSingle();
    if (existing.data?.status === "pending") {
      const lessonId = await lessonIdForExistingChangeSet(admin, cluster.change_set_id);
      return { ok: true, changeSetId: cluster.change_set_id, lessonId: lessonId ?? "", reused: true };
    }
  }

  /* 3. A representative dossier (earliest member) — service-role read. */
  const dossier = await loadRepresentativeDossier(admin, clusterId);

  /* 4. Resolve the implicated LESSON from the node's teaching anchors. */
  const lessonId = await resolveImplicatedLesson(admin, courseId, cluster.node_id, dossier);
  if (!lessonId) {
    return { ok: false, reason: "no_implicated_lesson" };
  }

  /* 5. Load the course doc + confirm the lesson still exists in the draft. */
  const doc = await loadCourseDoc(admin, courseId);
  if (!doc) return { ok: false, reason: "course_not_found" };
  const lesson = findLessonInDoc(doc, lessonId);
  if (!lesson) return { ok: false, reason: "lesson_not_in_draft" };

  /* 6. Terra drafts the FAQ block (ANONYMIZED — no learner identity). */
  const conceptTitle = await conceptTitleFor(admin, cluster.node_id);
  const question = cluster.representative_question ?? dossier?.learnerQuestion ?? "";
  const approvedAnswer =
    (args.finalAnswer && args.finalAnswer.trim()) ||
    (cluster.representative_answer && cluster.representative_answer.trim()) ||
    "";
  const block = await draftFaqBlock(model, { conceptTitle, question, approvedAnswer });

  /* 7. Append the block to the lesson, RECONCILE (persist), then stage the change-set.
   *    The rail contract: the block is applied + persisted FIRST, then the change-set
   *    records the create (mirrors the agent's reconcileDoc → stageChangeSet order). */
  const baseline = doc; // pre-append snapshot for the diff.
  const nextDoc = appendBlockToLesson(doc, lessonId, block);

  const authorId = await courseAuthorId(admin, courseId);
  if (!authorId) return { ok: false, reason: "course_author_unresolved" };

  const reconcileErr = await reconcileCourseDoc(admin, nextDoc, authorId);
  if (reconcileErr) return { ok: false, reason: `reconcile_failed: ${reconcileErr}` };

  const changes = diffBlocks(baseline, nextDoc);
  const evidence = buildPromotionEvidence({
    conceptTitle,
    question,
    memberCount: await memberCountFor(admin, clusterId),
    summary: cluster.representative_question ?? question,
  });

  const ref = await createChangeSet(
    admin,
    {
      courseId,
      lessonId,
      summary: `Clarify "${conceptTitle}" after learners escalated`,
      evidence,
    },
    { blocks: changes, structure: [] }
  );
  if (!ref) return { ok: false, reason: "empty_change_set" };

  /* 8. Record the change-set on the cluster (drives derived resolution + the queue). */
  await admin
    .from("escalation_cluster")
    .update({ change_set_id: ref.changeSetId })
    .eq("id", clusterId)
    .eq("course_id", courseId);

  return { ok: true, changeSetId: ref.changeSetId, lessonId, reused: false };
}

/* ─────────────────────────── Terra FAQ draft ────────────────────────────── */

/**
 * Draft the FAQ/clarification LectureTextBlock. Terra writes the plain-English answer
 * over the ANONYMIZED question + the creator's approved answer + the concept title —
 * NO learner identity reaches the model. A model failure degrades to a deterministic
 * block built from the creator's answer verbatim (coverage always holds).
 */
async function draftFaqBlock(
  model: ModelClient,
  args: { conceptTitle: string; question: string; approvedAnswer: string }
): Promise<LectureTextBlock> {
  const spec = buildPromotionBlockSpec(args);

  const res = await runStructuredCall(model, {
    system: PROMOTION_SYSTEM_PROMPT,
    input: spec,
    outputName: PROMOTION_RESPONSE_NAME,
    outputSchema: PromotionDraftSchema,
    model: TUTOR_MODELS.escalation_dossier.model,
    effort: TUTOR_MODELS.escalation_dossier.effort,
    timeoutMs: TUTOR_MODELS.escalation_dossier.timeoutMs,
    maxRetries: TUTOR_MODELS.escalation_dossier.maxRetries,
    maxOutputTokens: TUTOR_MODELS.escalation_dossier.maxOutputTokens,
  });

  if (res.ok && res.data) {
    return buildLectureBlock({
      title: res.data.title,
      tone: "concise",
      paragraphs: res.data.paragraphs.map((p) => ({ kind: p.kind, text: p.text })),
    });
  }

  // Deterministic fallback — the creator's approved answer is authoritative content.
  return buildFallbackFaqBlock(args);
}

/** The deterministic FAQ block from the creator's own words (no model). */
export function buildFallbackFaqBlock(args: {
  conceptTitle: string;
  question: string;
  approvedAnswer: string;
}): LectureTextBlock {
  const paragraphs: { kind: "paragraph" | "key_idea" | "aside"; text: string }[] = [];
  if (args.question.trim()) {
    paragraphs.push({ kind: "key_idea", text: `Q: ${args.question.trim()}` });
  }
  paragraphs.push({
    kind: "paragraph",
    text: args.approvedAnswer.trim() || "A clarification your learners asked for.",
  });
  return buildLectureBlock({
    title: `FAQ: ${args.conceptTitle}`,
    tone: "concise",
    paragraphs,
  });
}

export const PROMOTION_SYSTEM_PROMPT = [
  "You are clarifying a course concept that several learners got stuck on. Write a",
  "SHORT FAQ-style clarification the instructor will review before it's added to the",
  "lesson. You are given ONLY: the concept title, the (anonymized) recurring learner",
  "question, and the instructor's approved answer. You have NO learner identity —",
  "never refer to any learner by name; write for the whole class.",
  "",
  "Return:",
  "- title: a short FAQ title, e.g. \"FAQ: <concept>\".",
  "- paragraphs: 1–3 short paragraphs that answer the question clearly, grounded in",
  "  the instructor's approved answer. Use kind 'key_idea' for the question restated,",
  "  'paragraph' for the explanation. Do NOT invent facts beyond the approved answer.",
  "",
  "Return ONLY the JSON object matching the schema.",
].join("\n");

/* ─────────────────────────── evidence ───────────────────────────────────── */

/** The dossier-summary ParsedEvidence shape stamped on the change-set item (the
 *  EvidenceCard reads it above Accept/Reject). PURE + exported for the pure suite. */
export function buildPromotionEvidence(args: {
  conceptTitle: string;
  question: string;
  memberCount: number;
  summary: string;
}): Json {
  const n = Math.max(0, Math.trunc(args.memberCount));
  return {
    title: `Learners asked about "${args.conceptTitle}"`,
    summary:
      `${n} learner${n === 1 ? "" : "s"} escalated a recurring question on this concept: ` +
      `"${truncate(args.question, 240)}". This clarification answers it in the lesson.`,
    severity: "medium",
    kind: "escalation_cluster",
    metrics: { learners: n },
    recommendation: "Review the drafted FAQ, then Accept to add it to the lesson or Reject to discard it.",
  } as Json;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/* ─────────────────────────── lesson resolution ──────────────────────────── */

/**
 * Resolve the implicated lesson for a cluster's node. PRIMARY: the concept node's own
 * teaching anchors (draft-side [{lessonId,…}]). FALLBACK: the snapshot_concept_map's
 * resolved anchors for the node (a live publication). Returns null when neither
 * resolves a lessonId (→ the promotion returns a typed reason, nothing filed).
 */
async function resolveImplicatedLesson(
  admin: DB,
  courseId: string,
  nodeId: string,
  dossier: RepresentativeDossier | null
): Promise<string | null> {
  // 1. The node's own draft anchors.
  const node = await admin.from("concept_nodes").select("anchors").eq("id", nodeId).maybeSingle();
  const fromNode = firstLessonIdFromAnchors(node.data?.anchors as Json | null | undefined);
  if (fromNode) return fromNode;

  // 2. snapshot_concept_map (resolved anchors on a published projection).
  const snap = await admin
    .from("snapshot_concept_map")
    .select("anchors")
    .eq("course_id", courseId)
    .eq("node_id", nodeId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromSnap = firstLessonIdFromAnchors(snap.data?.anchors as Json | null | undefined);
  if (fromSnap) return fromSnap;

  // 3. The dossier may name additional nodes; try their anchors too.
  for (const otherNodeId of dossier?.nodeIds ?? []) {
    if (otherNodeId === nodeId || !UUID_RE.test(otherNodeId)) continue;
    const on = await admin.from("concept_nodes").select("anchors").eq("id", otherNodeId).maybeSingle();
    const fromOther = firstLessonIdFromAnchors(on.data?.anchors as Json | null | undefined);
    if (fromOther) return fromOther;
  }

  return null;
}

/** The first `lessonId` from an anchors jsonb array (defensive coercion). */
export function firstLessonIdFromAnchors(value: Json | null | undefined): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const lessonId = (entry as Record<string, unknown>).lessonId;
      if (typeof lessonId === "string" && lessonId.length > 0) return lessonId;
    }
  }
  return null;
}

/* ─────────────────────────── DB helpers ─────────────────────────────────── */

/** Load a cluster's earliest dossier (its representative). Service-role — identity-
 *  bearing table, but we read only the node_ids + question here (never surfaced to a
 *  creator). */
async function loadRepresentativeDossier(admin: DB, clusterId: string): Promise<RepresentativeDossier | null> {
  const res = await admin
    .from("escalation_dossier")
    .select("node_ids, learner_question")
    .eq("cluster_id", clusterId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const nodeIds = Array.isArray(res.data.node_ids)
    ? (res.data.node_ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  return { nodeIds, learnerQuestion: res.data.learner_question };
}

/** The cluster's distinct-member count (for the evidence metric). */
async function memberCountFor(admin: DB, clusterId: string): Promise<number> {
  const res = await admin.from("escalation_cluster").select("member_count").eq("id", clusterId).maybeSingle();
  return typeof res.data?.member_count === "number" ? res.data.member_count : 0;
}

/** The concept node's title (for the FAQ title + evidence). Retired/missing → a
 *  generic label so promotion never strands on a stale node. */
async function conceptTitleFor(admin: DB, nodeId: string): Promise<string> {
  const res = await admin.from("concept_nodes").select("title").eq("id", nodeId).maybeSingle();
  const t = res.data?.title?.trim();
  return t && t.length > 0 ? t : "this concept";
}

/** The course's author id (the reconcile owner). */
async function courseAuthorId(admin: DB, courseId: string): Promise<string | null> {
  const res = await admin.from("courses").select("author_id").eq("id", courseId).maybeSingle();
  return res.data?.author_id ?? null;
}

/** The lesson a still-pending change-set landed in (for the reused-path result). */
async function lessonIdForExistingChangeSet(admin: DB, changeSetId: string): Promise<string | null> {
  const res = await admin
    .from("change_set_items")
    .select("lesson_id")
    .eq("change_set_id", changeSetId)
    .eq("node_type", "block")
    .not("lesson_id", "is", null)
    .limit(1)
    .maybeSingle();
  return res.data?.lesson_id ?? null;
}

/* ─────────────────────────── doc helpers (PURE) ─────────────────────────── */

/** Find a lesson node in the course doc by id. PURE. */
export function findLessonInDoc(doc: CourseDocument, lessonId: string): { moduleIndex: number; lessonIndex: number } | null {
  for (let mi = 0; mi < doc.modules.length; mi++) {
    const lessons = doc.modules[mi].lessons;
    for (let li = 0; li < lessons.length; li++) {
      if (lessons[li].id === lessonId) return { moduleIndex: mi, lessonIndex: li };
    }
  }
  return null;
}

/** Append a block to the named lesson, returning a NEW doc (structural clone of the
 *  touched lesson only). PURE. The appended block's order = the lesson's current
 *  block count so the diff records a clean create at the end. */
export function appendBlockToLesson(
  doc: CourseDocument,
  lessonId: string,
  block: LectureTextBlock
): CourseDocument {
  const modules = doc.modules.map((mod) => {
    if (!mod.lessons.some((l) => l.id === lessonId)) return mod;
    return {
      ...mod,
      lessons: mod.lessons.map((lesson) => {
        if (lesson.id !== lessonId) return lesson;
        const positioned = { ...block, order: lesson.blocks.length };
        return { ...lesson, blocks: [...lesson.blocks, positioned] };
      }),
    };
  });
  return { ...doc, modules };
}
