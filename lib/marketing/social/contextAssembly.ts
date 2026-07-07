/**
 * Source-context assembly (PRD §9.1 step 1) — the ONE place that turns a
 * course / module / lesson / manual topic into the grounding text the model
 * (or the template fallback) reads. Reuses the existing course context
 * retriever (loadCourseMarketingContext) — never forks a second one.
 *
 * Token budget: SOCIAL_CONTEXT_MAX_TOKENS (~4 chars/token estimate), with
 * PRD priority on truncation: description > outcomes > selected node >
 * sibling summaries.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { loadCourseMarketingContext } from "../persistence";
import type { CourseMarketingContext } from "../types";
import type { GenerateRequest } from "./schemas";
import type { TemplateContext } from "./templates";

type DB = SupabaseClient<Database>;

export interface AssembledContext {
  /** The grounding text handed to the prompt (and to the safety lint's
   *  whitelist — the creator's own claims are never flagged). */
  text: string;
  /** True when there's little real content — the UI shows "posts will be
   *  more generic" (PRD §6.3); generation still proceeds. */
  thin: boolean;
  /** Grounding facts for the deterministic template fallback. */
  template: TemplateContext;
  course: CourseMarketingContext | null;
}

interface Section {
  priority: number; // lower = kept longer
  text: string;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Drop lowest-priority sections until the budget fits, then hard-trim. */
function fitToBudget(sections: Section[], maxTokens: number): string {
  const kept = [...sections].sort((a, b) => a.priority - b.priority);
  while (kept.length > 1 && estimateTokens(kept.map((s) => s.text).join("\n")) > maxTokens) {
    kept.pop();
  }
  let text = kept
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.text)
    .join("\n");
  const capChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length > capChars) text = `${text.slice(0, capChars - 1)}…`;
  return text;
}

export async function assembleSourceContext(
  supabase: DB,
  req: Pick<GenerateRequest, "sourceType" | "courseId" | "moduleId" | "lessonId" | "sourceText">,
  maxTokens: number
): Promise<AssembledContext> {
  const sections: Section[] = [];
  let course: CourseMarketingContext | null = null;
  let moduleTitle: string | null = null;
  let lessonTitle: string | null = null;

  if (req.courseId) {
    course = await loadCourseMarketingContext(supabase, req.courseId);
  }

  if (course) {
    sections.push({ priority: 0, text: `COURSE: "${course.title}"` });
    if (course.description) sections.push({ priority: 1, text: `Description: ${course.description}` });
    if (course.audience) sections.push({ priority: 2, text: `Target student: ${course.audience}` });
    if (course.outcomes.length)
      sections.push({ priority: 2, text: `Outcomes: ${course.outcomes.join("; ")}` });
  }

  if (req.sourceType === "module" && req.moduleId) {
    const { data: mod } = await supabase
      .from("modules")
      .select("id,title")
      .eq("id", req.moduleId)
      .maybeSingle();
    if (mod) {
      moduleTitle = mod.title;
      const { data: lessons } = await supabase
        .from("lessons")
        .select("title")
        .eq("module_id", mod.id)
        .order("order", { ascending: true });
      const lessonTitles = (lessons ?? []).map((l) => l.title).filter(Boolean);
      sections.push({
        priority: 3,
        text: `FOCUS MODULE: "${mod.title}"${lessonTitles.length ? ` — lessons: ${lessonTitles.join("; ")}` : ""}`,
      });
    }
  }

  if (req.sourceType === "lesson" && req.lessonId) {
    const { data: lesson } = await supabase
      .from("lessons")
      .select("id,title,module_id")
      .eq("id", req.lessonId)
      .maybeSingle();
    if (lesson) {
      lessonTitle = lesson.title;
      const { data: mod } = await supabase
        .from("modules")
        .select("title")
        .eq("id", lesson.module_id)
        .maybeSingle();
      if (mod) moduleTitle = mod.title;
      sections.push({
        priority: 3,
        text: `FOCUS LESSON: "${lesson.title}"${mod ? ` (module: "${mod.title}")` : ""}`,
      });
    }
  }

  if (course?.modules.length) {
    sections.push({
      priority: 4,
      text: `Modules: ${course.modules.map((m) => m.title).join("; ")}`,
    });
  }

  if (req.sourceText?.trim()) {
    // Creator-supplied topic/context — verbatim, highest priority after the
    // course header (and the lint whitelist's main input).
    sections.push({ priority: 1, text: `CREATOR-SUPPLIED CONTEXT (verbatim):\n${req.sourceText.trim()}` });
  }

  const text = fitToBudget(sections, maxTokens);
  const substantive =
    (course?.description?.length ?? 0) +
    (course?.outcomes.join("").length ?? 0) +
    (req.sourceText?.length ?? 0);

  return {
    text: text || "(no context provided)",
    thin: substantive < 80,
    template: {
      courseTitle: course?.title ?? null,
      description: course?.description ?? null,
      audience: course?.audience ?? null,
      outcomes: course?.outcomes ?? [],
      moduleTitles: moduleTitle
        ? [moduleTitle, ...(course?.modules.map((m) => m.title).filter((t) => t !== moduleTitle) ?? [])]
        : (course?.modules.map((m) => m.title) ?? []),
      topic: req.sourceText?.trim() || lessonTitle || null,
    },
    course,
  };
}
