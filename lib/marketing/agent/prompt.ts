/**
 * Marketing agent prompts.
 *
 * The system prompt is STATIC (role + governance rules) so it caches as a stable
 * prefix; the variable observe context (funnel + current assets) rides in a
 * leading `developer` message each turn — the studio's prompt-caching discipline.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getAnalyticsSummary } from "../analytics";
import { listEmailSequences, listLandingPages, loadCampaignForCourse, loadCourseMarketingContext } from "../persistence";

type DB = SupabaseClient<Database>;

export function buildMarketingSystemPrompt(): string {
  return [
    "You are the Marketing Assistant for WiseSel, an AI co-pilot that helps a course creator sell their course.",
    "You work in a reason → act → observe loop: read the current state, take the smallest useful action, then re-read.",
    "",
    "You author assets GROUNDED in the creator's actual course (use get_course_plan). Never invent testimonials, stats, or claims.",
    "",
    "GOVERNANCE — this is absolute:",
    "- Generating drafts (landing page, sequence, followup, touch copy) is REVERSIBLE: it auto-applies and is staged for the creator to Accept or Reject. Do this freely.",
    "- Anything that reaches a real person is IRREVERSIBLE and REQUIRES the creator's explicit approval: publishing a page live, activating a sequence, enrolling a segment, sending a broadcast or test. When you call one of these tools it does NOT execute — it pauses and asks the creator. NEVER claim you sent or published something; say you've requested approval.",
    "- You cannot bypass this. One approval gate covers you and the creator's own buttons alike.",
    "",
    "Be concise and concrete. Prefer one clear next step over a wall of options. When you're done, briefly summarize what you staged and what (if anything) is awaiting the creator's approval.",
  ].join("\n");
}

/** The variable observe-step context — current funnel + assets. When `pageId` is
 *  set (the split-view editor), the agent is focused on that one page and is
 *  given its section ids so content/design edits can target them precisely. */
export async function buildObservation(
  supabase: DB,
  courseId: string,
  campaignId: string | null,
  pageId?: string | null
): Promise<string> {
  const course = await loadCourseMarketingContext(supabase, courseId);
  const campaign = campaignId ? null : await loadCampaignForCourse(supabase, courseId);
  const cid = campaignId ?? campaign?.id ?? null;
  const summary = await getAnalyticsSummary(supabase, courseId);
  const pages = cid ? await listLandingPages(supabase, cid) : [];
  const sequences = cid ? await listEmailSequences(supabase, cid) : [];
  const f = summary.funnel;

  const lines = [
    "MARKETING CONTEXT (current state — re-read via tools for detail):",
    `Course: "${course?.title ?? "?"}" · audience: ${course?.audience ?? "?"} · level: ${course?.level ?? "?"} · ${course?.modules.length ?? 0} modules.`,
    cid ? `Campaign: present.` : `Campaign: none yet (create one or generate a landing page to start).`,
    `Funnel: ${f.views} views · ${f.leads} leads · ${f.emailsSent} sent · ${f.emailOpens} opens · ${f.emailClicks} clicks · ${f.enrollments} enrollments.`,
    `Landing pages: ${pages.length ? pages.map((p) => `"${p.title}" (${p.status})`).join(", ") : "none"}.`,
    `Email sequences: ${sequences.length ? sequences.map((s) => `"${s.name}" (${s.kind}, ${s.status})`).join(", ") : "none"}.`,
  ];

  if (pageId) {
    const focus = pages.find((p) => p.id === pageId);
    if (focus) {
      lines.push(
        "",
        `EDITING THIS PAGE: "${focus.title}" (id ${focus.id}, ${focus.status}). Use update_landing_section for copy, set_page_design for tokens, set_section_variant for layout — all target this page id.`,
        `Its sections: ${focus.sections.map((s) => `${s.kind}#${s.id}`).join(", ")}.`,
        `Current design: ${JSON.stringify(focus.theme ?? {})}.`
      );
    }
  }
  return lines.join("\n");
}

/** A short human one-liner of what the agent observed (for the transcript). */
export function observationSummary(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("Funnel:"));
  return line ?? "Reviewed the current campaign state.";
}
