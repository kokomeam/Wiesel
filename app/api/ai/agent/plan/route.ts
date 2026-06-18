/**
 * POST /api/ai/agent/plan — resolve a paused PLAN outline and resume.
 *
 * The PLAN phase emits a `plan_outline` and pauses for the creator's approval.
 * Their decision comes back here: on "approve" we re-validate the (transient,
 * client-round-tripped) outline and run GENERATE → CRITIQUE; on "discard" we
 * acknowledge. Streams the SAME normalized SSE protocol the main agent route
 * uses, so the docked panel just keeps reading.
 *
 * Node runtime + force-dynamic (a stream); the OpenAI key stays server-only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { encodeSSE, type AgentEvent } from "@/lib/ai/events";
import { resumeGeneratePlan } from "@/lib/ai/phases";
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

interface PlanBody {
  courseId?: string;
  lessonId?: string;
  conversationId?: string;
  plan?: unknown;
  decision?: "approve" | "discard";
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: PlanBody;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { courseId, lessonId, conversationId, plan, decision } = body;
  if (!courseId || !lessonId || !conversationId || (decision !== "approve" && decision !== "discard")) {
    return new Response("Missing or invalid plan fields", { status: 400 });
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
        await resumeGeneratePlan({
          supabase,
          model,
          courseId,
          lessonId,
          ownerId: user.id,
          conversationId,
          plan,
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
