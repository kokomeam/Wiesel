/**
 * POST /api/ai/agent/confirm — resolve a paused destructive action and resume.
 *
 * When the agent calls delete_module / delete_lesson, the run PAUSES and the
 * studio shows the creator a confirmation dialog. Their decision comes back
 * here: we apply (or skip) the delete, finalize the placeholder tool message,
 * and continue the model loop — streaming the SAME normalized SSE protocol the
 * main agent route uses, so the docked panel just keeps reading.
 *
 * Node runtime + force-dynamic (a stream); the OpenAI key stays server-only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { resumeAgentTurn } from "@/lib/ai/agentLoop";
import { encodeSSE, type AgentEvent } from "@/lib/ai/events";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { createClient } from "@/lib/supabase/server";

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function singleEventStream(event: AgentEvent): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(encodeSSE(event)));
      controller.enqueue(enc.encode(encodeSSE({ type: "done" })));
      controller.close();
    },
  });
}

interface ConfirmBody {
  courseId?: string;
  lessonId?: string;
  conversationId?: string;
  toolCallId?: string;
  toolMessageId?: string;
  kind?: "module" | "lesson";
  label?: string;
  patch?: unknown;
  decision?: "confirm" | "cancel";
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: ConfirmBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { courseId, lessonId, conversationId, toolCallId, toolMessageId, kind, label, patch, decision } = body;
  if (
    !courseId || !lessonId || !conversationId || !toolCallId || !toolMessageId ||
    (kind !== "module" && kind !== "lesson") ||
    (decision !== "confirm" && decision !== "cancel")
  ) {
    return new Response("Missing or invalid confirmation fields", { status: 400 });
  }

  if (!isOpenAIConfigured()) {
    return sseResponse(
      singleEventStream({
        type: "error",
        message: "The AI service isn't configured, so the agent can't continue.",
      })
    );
  }

  const model = createOpenAIModelClient();
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(encodeSSE(event)));
        } catch {
          closed = true;
        }
      };

      try {
        await resumeAgentTurn({
          supabase,
          model,
          courseId,
          lessonId,
          ownerId: user.id,
          conversationId,
          toolCallId,
          toolMessageId,
          kind,
          label: label ?? (kind === "module" ? "this module" : "this lesson"),
          patch,
          decision,
          emit,
          signal: req.signal,
        });
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : "Failed to resume" });
        emit({ type: "done" });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return sseResponse(stream);
}
