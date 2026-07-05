/**
 * Clarifying questions — the SECOND "blocked, waiting on a human" shape
 * (beside pending approvals), stored in `marketing_question`.
 *
 * Two sources, one shape:
 *   'model' — the agent called the ask_creator tool: one specific
 *             multiple-choice question it genuinely can't proceed without.
 *   'gate'  — the gate auto-raised it because an irreversible tool arrived
 *             with ambiguous targeting (tool.clarifyTargeting). These rows
 *             carry tool_name + tool_params + tool_call_id so the resumed
 *             agent can retry the SAME tool with the targeting resolved.
 *
 * Both pause the loop identically (GateOutcome 'needs_clarification' →
 * the loop's single blocked branch) and resume through
 * resumeAgentAfterAnswer — the loop never learns a second pause protocol.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";

type DB = SupabaseClient<Database>;
type QuestionRow = Database["public"]["Tables"]["marketing_question"]["Row"];

export interface QuestionOption {
  label: string;
  value: string;
  description: string | null;
}

/** What a question looks like before storage — returned by ask_creator's
 *  params or a tool's clarifyTargeting hook. */
export interface QuestionSpec {
  question: string;
  options: QuestionOption[];
  /** Gate-raised only: the tool param the answer resolves (e.g. "status").
   *  Stored beside the original args so the retry knows what to set. */
  paramKey?: string | null;
}

export interface QuestionAnswer {
  value: string;
  label: string;
  freeText?: string | null;
}

export type QuestionStatus = "pending" | "answered" | "dismissed";

export interface MarketingQuestionRow {
  id: string;
  courseId: string;
  campaignId: string | null;
  conversationId: string | null;
  source: "model" | "gate";
  toolName: string | null;
  toolCallId: string | null;
  toolParams: Record<string, unknown> | null;
  question: string;
  options: QuestionOption[];
  status: QuestionStatus;
  answer: QuestionAnswer | null;
  requestedBy: "agent" | "user";
  resolvedAt: string | null;
  createdAt: string;
}

function questionRowToDomain(row: QuestionRow): MarketingQuestionRow {
  return {
    id: row.id,
    courseId: row.course_id,
    campaignId: row.campaign_id,
    conversationId: row.conversation_id,
    source: row.source as "model" | "gate",
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    toolParams: (row.tool_params as Record<string, unknown> | null) ?? null,
    question: row.question,
    options: Array.isArray(row.options) ? (row.options as unknown as QuestionOption[]) : [],
    status: row.status as QuestionStatus,
    answer: (row.answer as unknown as QuestionAnswer | null) ?? null,
    requestedBy: row.requested_by as "agent" | "user",
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

export async function insertQuestion(
  supabase: DB,
  fields: {
    courseId: string;
    campaignId: string | null;
    conversationId?: string | null;
    source: "model" | "gate";
    toolName?: string | null;
    toolCallId?: string | null;
    toolParams?: unknown;
    spec: QuestionSpec;
    requestedBy: "agent" | "user";
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("marketing_question")
    .insert({
      course_id: fields.courseId,
      campaign_id: fields.campaignId,
      conversation_id: fields.conversationId ?? null,
      source: fields.source,
      tool_name: fields.toolName ?? null,
      tool_call_id: fields.toolCallId ?? null,
      tool_params: (fields.toolParams ?? null) as Json,
      question: fields.spec.question,
      options: fields.spec.options as unknown as Json,
      requested_by: fields.requestedBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`question: failed to record — ${error?.message}`);
  return data.id;
}

export async function loadQuestion(supabase: DB, questionId: string): Promise<MarketingQuestionRow | null> {
  const { data } = await supabase.from("marketing_question").select("*").eq("id", questionId).maybeSingle();
  return data ? questionRowToDomain(data) : null;
}

/** Pending questions awaiting the creator (the "agent asked" inbox). */
export async function listPendingQuestions(supabase: DB, courseId: string): Promise<MarketingQuestionRow[]> {
  const { data } = await supabase
    .from("marketing_question")
    .select("*")
    .eq("course_id", courseId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  return (data ?? []).map(questionRowToDomain);
}

/**
 * Record the creator's answer. Guarded on status='pending' — answering an
 * already-resolved question is a no-op (idempotent; the first answer wins).
 * Returns true when THIS call resolved it.
 */
export async function answerQuestion(supabase: DB, questionId: string, answer: QuestionAnswer): Promise<boolean> {
  const { data, error } = await supabase
    .from("marketing_question")
    .update({
      status: "answered",
      answer: answer as unknown as Json,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", questionId)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`question.answer: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function dismissQuestion(supabase: DB, questionId: string): Promise<void> {
  const { error } = await supabase
    .from("marketing_question")
    .update({ status: "dismissed", resolved_at: new Date().toISOString() })
    .eq("id", questionId)
    .eq("status", "pending");
  if (error) throw new Error(`question.dismiss: ${error.message}`);
}
