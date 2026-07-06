/**
 * POST /api/ai/visual/generate — produce ONE pending image off the agent's critical
 * path. `add_image` stages an image slide with `imageUrl:""` + a `pendingGen` spec;
 * the studio calls this per pending slide. It reuses the SAME server image stack
 * (proxied OpenAI client → buildImagePrompt → generate → reference verify → store),
 * then sets the slide's imageUrl and clears `pendingGen`. On failure it prose-degrades
 * the slide so the deck still teaches. RLS guarantees the caller owns the course.
 *
 * Body: { courseId, blockId, slideId }. Idempotent: a slide with no pendingGen is a
 * no-op (handles double-fires / a slide already filled or reverted).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { buildImagePrompt, type ImagePromptSpec } from "@/lib/ai/visuals/imageIntent";
import { generateAndStoreImage } from "@/lib/ai/visuals/generateAndStore";
import { VISUAL_WEIGHT } from "@/lib/ai/visuals/config";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { loadCourseDoc, upsertBlock } from "@/lib/ai/serverPersistence";
import { setSlideTemplatePatch } from "@/lib/course/commands";
import { applyCoursePatch } from "@/lib/course/patches";
import { findBlock, findSlide } from "@/lib/course/queries";
import { createClient } from "@/lib/supabase/server";
import type { CourseDocument, ImageReferenceContent, ImageSupportingContent, ProseContent, RichText, SlideTemplate } from "@/lib/course/types";

type ImageContent = ImageReferenceContent | ImageSupportingContent;
const rt = (s: string): RichText => ({ text: s.trim() });

/** Prose-degrade an image slide from its OWN authored text (image gen failed). */
function imageToProse(content: ImageContent): SlideTemplate {
  const points: RichText[] = [];
  let body = "";
  if ("lead" in content && content.lead?.text?.trim()) body = content.lead.text;
  if ("caption" in content && !body && content.caption?.text?.trim()) body = content.caption.text;
  if ("bullets" in content) for (const b of content.bullets ?? []) if (b.text.trim()) points.push(b);
  if ("annotations" in content)
    for (const a of content.annotations ?? []) if (a.label.text.trim()) points.push(rt(a.description.text.trim() ? `${a.label.text}: ${a.description.text}` : a.label.text));
  if ("cards" in content) for (const c of content.cards ?? []) if (c.title.text.trim()) points.push(rt(c.description.text.trim() ? `${c.title.text}: ${c.description.text}` : c.title.text));
  if (!body) body = points[0]?.text ?? "This concept is taught in the surrounding slides.";
  const prose: ProseContent = {
    title: content.title?.text?.trim() ? content.title : rt("Key idea"),
    body: rt(body),
    ...(points.length ? { points: points.filter((p) => p.text !== body).slice(0, 5) } : {}),
  };
  return { layoutId: "prose", content: prose };
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: { courseId?: string; blockId?: string; slideId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const { courseId, blockId, slideId } = body;
  if (!courseId || !blockId || !slideId) return new Response("Missing courseId, blockId, or slideId", { status: 400 });
  if (!isOpenAIConfigured()) return new Response("Image service not configured", { status: 503 });

  let doc: CourseDocument | null;
  try {
    doc = await loadCourseDoc(supabase, courseId);
  } catch {
    return new Response("Course read failed (transient)", { status: 503 });
  }
  if (!doc) return new Response("Course not found", { status: 404 });
  const hit = findSlide(doc, blockId, slideId);
  const template = hit?.slide.template;
  if (!hit || !template || (template.layoutId !== "image_reference" && template.layoutId !== "image_supporting")) {
    return Response.json({ ok: true, status: "skipped" }); // not an image slide (deleted / reverted)
  }
  const content = template.content;
  const pending = content.pendingGen;
  if (!pending || pending.status !== "pending" || content.imageUrl) {
    return Response.json({ ok: true, status: "skipped" }); // already filled / failed / no job
  }

  // Reconstruct the prompt spec from the stored pendingGen (no model call to re-derive).
  const spec: ImagePromptSpec = {
    visualWeight: pending.visualWeight,
    prompt: pending.prompt,
    ...(pending.subject ? { subject: pending.subject } : {}),
    ...(pending.requiredLabels ? { requiredLabels: pending.requiredLabels } : {}),
    ...(pending.axes ? { axes: pending.axes } : {}),
    ...(pending.annotations ? { annotations: pending.annotations } : {}),
  };
  const cfg = VISUAL_WEIGHT[pending.visualWeight];
  const verify =
    pending.visualWeight === "reference" && pending.requiredLabels && pending.requiredLabels.length > 0
      ? { requiredLabels: pending.requiredLabels }
      : undefined;

  const asset = await generateAndStoreImage({
    model: createOpenAIModelClient(),
    supabase,
    ownerId: user.id,
    courseId,
    prompt: buildImagePrompt(spec),
    size: cfg.size,
    background: cfg.background,
    quality: cfg.quality,
    thinking: cfg.thinking,
    verify,
    signal: req.signal,
  });

  // Build the next template: filled image (clear pendingGen) on success, else prose.
  let next: SlideTemplate;
  if (asset) {
    const filled = { ...content, imageUrl: asset.url, storagePath: asset.storagePath };
    delete (filled as { pendingGen?: unknown }).pendingGen;
    next = { layoutId: template.layoutId, content: filled } as SlideTemplate;
  } else {
    next = imageToProse(content);
  }

  const patch = setSlideTemplatePatch(blockId, slideId, next);
  const applied = applyCoursePatch(doc, patch, new Date().toISOString());
  if (!applied.ok) return new Response(applied.error, { status: 500 });

  // Persist ONLY this one block. A full reconcileCourseDoc here would upsert a
  // seconds-old whole-course snapshot AND orphan-delete anything a concurrent
  // autosave wrote during image generation — this runs off the agent's critical
  // path, so browser autosave is UNPAUSED and may have just saved a user edit.
  const updated = findBlock(applied.doc, blockId);
  if (!updated) return new Response("Block not found after patch", { status: 500 });
  const err = await upsertBlock(supabase, courseId, updated.lesson.id, updated.block, req.signal);
  if (err) return new Response(err, { status: 500 });

  return Response.json({ ok: true, status: asset ? "filled" : "degraded", layoutId: next.layoutId });
}
