/**
 * Conversation persistence + history replay.
 *
 * Threads + messages live in Postgres and ARE the source of truth: every turn
 * replays the full history from here to build the provider-neutral input
 * (we never depend on provider-side session state). Message rows:
 *   user      → { text }
 *   assistant → { text, toolCalls: [{ callId, name, arguments }] }
 *   tool      → { callId, name, output }
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ModelInputItem, ModelToolCall } from "./modelClient";

type DB = SupabaseClient<Database>;

export interface AssistantTurn {
  text: string;
  toolCalls: ModelToolCall[];
}

/** One active thread per (course, lesson): return `existing`, else the most
 *  recent thread for the lesson, else create a fresh one. */
export async function getOrCreateConversation(
  supabase: DB,
  courseId: string,
  lessonId: string,
  existing?: string | null
): Promise<string> {
  if (existing) return existing;

  const { data: recent } = await supabase
    .from("conversations")
    .select("id")
    .eq("course_id", courseId)
    .eq("lesson_id", lessonId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent) return recent.id;

  // The conversations.lesson_id FK requires an existing lessons row. The docked
  // lessonId is client-supplied and may be a not-yet-persisted / stale lesson;
  // store it only if it exists, else NULL (the column is nullable) so creating a
  // thread never trips conversations_lesson_id_fkey.
  const { data: lesson } = await supabase
    .from("lessons")
    .select("id")
    .eq("id", lessonId)
    .maybeSingle();

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ course_id: courseId, lesson_id: lesson ? lessonId : null })
    .select("id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Failed to create conversation");
  return created.id;
}

/** Rebuild provider-neutral input items from the stored message log. */
export async function loadHistory(
  supabase: DB,
  conversationId: string
): Promise<ModelInputItem[]> {
  const { data } = await supabase
    .from("messages")
    .select("role,content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const items: ModelInputItem[] = [];
  for (const row of data ?? []) {
    const c = (row.content ?? {}) as Record<string, unknown>;
    if (row.role === "user") {
      items.push({ role: "user", content: String(c.text ?? "") });
    } else if (row.role === "assistant") {
      if (c.text) items.push({ role: "assistant", content: String(c.text) });
      for (const tc of (c.toolCalls as ModelToolCall[] | undefined) ?? []) {
        items.push({ type: "function_call", callId: tc.callId, name: tc.name, arguments: tc.arguments });
      }
    } else if (row.role === "tool") {
      items.push({ type: "function_call_output", callId: String(c.callId ?? ""), output: String(c.output ?? "") });
    }
  }
  return items;
}

export async function saveUserMessage(
  supabase: DB,
  conversationId: string,
  courseId: string,
  text: string
): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, course_id: courseId, role: "user", content: { text } as unknown as Json })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to save user message");

  // Touch the thread (bumps updated_at via moddatetime) + seed a title.
  await supabase
    .from("conversations")
    .update({ title: text.slice(0, 80) })
    .eq("id", conversationId)
    .is("title", null);
  await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

  return data.id;
}

export async function saveAssistantMessage(
  supabase: DB,
  conversationId: string,
  courseId: string,
  turn: AssistantTurn
): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      course_id: courseId,
      role: "assistant",
      content: { text: turn.text, toolCalls: turn.toolCalls } as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to save assistant message");
  return data.id;
}

export async function saveToolMessage(
  supabase: DB,
  conversationId: string,
  courseId: string,
  result: { callId: string; name: string; output: string }
): Promise<string> {
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, course_id: courseId, role: "tool", content: result as unknown as Json })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to save tool message");
  return data.id;
}

/**
 * Replace a stored tool message's output in place — used when a paused
 * destructive action is finalized (confirmed/declined). The callId/name are
 * preserved so history replay stays valid; only the output text changes.
 */
export async function updateToolMessageOutput(
  supabase: DB,
  messageId: string,
  result: { callId: string; name: string; output: string }
): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .update({ content: result as unknown as Json })
    .eq("id", messageId);
  if (error) throw new Error(error.message);
}
