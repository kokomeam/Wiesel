/**
 * Marketing Agent endpoint — POST streams the reason→act→observe loop as SSE.
 * Node runtime; the OpenAI key stays server-only. Author-scoped (the server
 * client carries the session, so every tool the agent runs is RLS-authorized).
 */

import { NextResponse } from "next/server";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { createClient } from "@/lib/supabase/server";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import { encodeSSE, type MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { loadCampaignForCourse } from "@/lib/marketing/persistence";
import { createMarketingServices } from "@/lib/marketing/services/factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { courseId?: string; message?: string; conversationId?: string | null; pageId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { courseId, message } = body;
  if (!courseId || !message) {
    return NextResponse.json({ error: "courseId and message are required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: MarketingAgentEvent) => controller.enqueue(encoder.encode(encodeSSE(e)));
      try {
        if (!isOpenAIConfigured()) {
          emit({ type: "error", message: "The AI service isn't configured. Add OPENAI_API_KEY on the server." });
          emit({ type: "done", paused: false });
          return;
        }
        const campaign = await loadCampaignForCourse(supabase, courseId);
        await runMarketingAgentTurn({
          supabase,
          model: createOpenAIModelClient(),
          courseId,
          campaignId: campaign?.id ?? null,
          ownerId: user.id,
          conversationId: body.conversationId ?? null,
          userMessage: message,
          services: createMarketingServices(),
          emit,
          signal: req.signal,
          pageId: body.pageId ?? null,
        });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        emit({ type: "done", paused: false });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
