/**
 * POST /api/ai/agent — run one agent turn, streaming a normalized SSE protocol
 * (see lib/ai/events.ts) back to the docked chat panel.
 *
 * Node.js runtime (the OpenAI SDK + long tool loop need it; Edge is unsupported
 * here) and force-dynamic (never cache a stream). The OpenAI key lives only on
 * the server; the browser only ever sees our normalized events.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { runContentAgentTurn } from "@/lib/ai/phases";
import { getOrCreateConversation } from "@/lib/ai/conversations";
import { encodeSSE, type AgentEvent } from "@/lib/ai/events";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { createClient } from "@/lib/supabase/server";

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so events flush immediately.
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

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: {
    courseId?: string;
    lessonId?: string;
    message?: string;
    conversationId?: string;
    autoApprove?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const { courseId, lessonId, message, conversationId, autoApprove } = body;
  if (!courseId || !lessonId || !message || !message.trim()) {
    return new Response("Missing courseId, lessonId, or message", { status: 400 });
  }

  if (!isOpenAIConfigured()) {
    return sseResponse(
      singleEventStream({
        type: "error",
        message:
          "The AI service isn't configured. Add OPENAI_API_KEY on the server to enable the agent.",
      })
    );
  }

  const conversation = await getOrCreateConversation(supabase, courseId, lessonId, conversationId);
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

      emit({ type: "conversation", conversationId: conversation });
      try {
        await runContentAgentTurn({
          supabase,
          model,
          courseId,
          lessonId,
          ownerId: user.id,
          conversationId: conversation,
          userMessage: message,
          autoApprove: autoApprove === true,
          emit,
          signal: req.signal,
        });
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : "Agent run failed" });
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
