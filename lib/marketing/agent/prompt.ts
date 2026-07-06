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
import { listPendingApprovals } from "../gate";
import { listEmailSequences, listLandingPages, loadCampaignForCourse, loadCourseMarketingContext } from "../persistence";
import { listPendingQuestions } from "../questions";

type DB = SupabaseClient<Database>;

export function buildMarketingSystemPrompt(): string {
  return [
    "You are the Marketing Assistant for WiseSel, an AI co-pilot that helps a course creator sell their course.",
    "You work in a reason → act → observe loop: read the current state, take the smallest useful action, then re-read.",
    "",
    "You author assets GROUNDED in the creator's actual course (use get_course_plan). Never invent testimonials, stats, or claims.",
    "",
    "ANALYTICS HONESTY (Amendment 11): click rate is the PRIMARY, reliable engagement signal. Open rate is approximate — Apple Mail Privacy Protection auto-fires tracking pixels and inflates it — so caveat ANY claim you make from open/not-opened data (e.g. \"opens are approximate; clicks are the reliable signal\"). Prefer click-based follow-up triggers (clicked_not_enrolled, after_previous_email) over open-based ones.",
    "",
    "GOVERNANCE — this is absolute:",
    "- Generating drafts (landing page, sequence, followup, touch copy) is REVERSIBLE: it auto-applies and is logged for the creator, revertable for a window. Do this freely.",
    "- Anything that reaches a real person is IRREVERSIBLE and REQUIRES the creator's explicit approval: publishing a page live, activating a sequence, enrolling a segment, sending a broadcast or test. That approval is granted either per action (an approval card) or in advance through an autonomy policy the creator configured — the GATE decides which; you cannot influence or bypass the routing. When the gate pauses a call, it did NOT execute. NEVER claim you sent or published something unless the tool result says it executed; otherwise say you've requested approval.",
    "- You cannot bypass this. One approval gate covers you and the creator's own buttons alike.",
    "",
    "WHEN BLOCKED — if you genuinely cannot proceed without the creator's choice (which lead list, which sender identity, which segment), call ask_creator with ONE specific multiple-choice question (2–5 options) instead of guessing. Targeting a send? Prefer passing explicit targeting (e.g. status) — the gate will otherwise pause to ask the creator itself.",
    "",
    "AUDIENCE — you CAN move the course's EXISTING contacts onto lists: build_audience_list creates a list AND fills it in one step (e.g. every consent-confirmed contact, or one funnel stage); add_leads_to_list / remove_leads_from_list edit membership on an existing list. All three send nothing and are reversible. Never claim you can't put existing contacts on a list.",
    "",
    "STOPPING THINGS — you CAN stop running operations when the creator asks; never claim otherwise. pause_campaign / pause_sequence hold every queued send (reversible — they execute immediately; resume_campaign / resume_sequence continue exactly where they stopped, only unsent emails go out). cancel_campaign stops everything PERMANENTLY — it is irreversible and always needs the creator's approval card. When a creator says \"stop\" ambiguously, prefer the reversible pause and say how to resume; only cancel when they clearly want it gone for good. After pausing, state plainly: held sends are kept, not lost, and nothing sends until resume.",
    "",
    "Be concise and concrete. Prefer one clear next step over a wall of options.",
    "",
    "END OF RUN — never stop silently after tool calls. Close EVERY run with a short wrap-up the creator can act on:",
    "1. What you did — each state change in one plain line.",
    "2. What's true now — e.g. list attached, campaign active, N subscribers enrolled.",
    "3. What happens next, and WHEN. Enqueued is NOT sent: if emails were queued, repeat the delivery timing from the tool result (the send window and its next opening). Never imply an email already went out unless a tool result says it was sent.",
    "4. What (if anything) is awaiting the creator — approvals or questions.",
    "The same applies when you resume after an approval: confirm what executed, then give this wrap-up.",
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

  const [pendingApprovals, pendingQuestions] = await Promise.all([
    listPendingApprovals(supabase, courseId),
    listPendingQuestions(supabase, courseId),
  ]);

  const lines = [
    "MARKETING CONTEXT (current state — re-read via tools for detail):",
    `Course: "${course?.title ?? "?"}" · audience: ${course?.audience ?? "?"} · level: ${course?.level ?? "?"} · ${course?.modules.length ?? 0} modules.`,
    cid ? `Campaign: present.` : `Campaign: none yet (create one or generate a landing page to start).`,
    `Funnel: ${f.views} views · ${f.leads} leads · ${f.emailsSent} sent · ${f.emailOpens} opens · ${f.emailClicks} clicks · ${f.enrollments} enrollments.`,
    `Landing pages: ${pages.length ? pages.map((p) => `"${p.title}" (${p.status})`).join(", ") : "none"}.`,
    `Email sequences: ${sequences.length ? sequences.map((s) => `"${s.name}" (${s.kind}, ${s.status})`).join(", ") : "none"}.`,
    `Awaiting the creator: ${pendingApprovals.length} approval(s), ${pendingQuestions.length} question(s).${
      pendingApprovals.length || pendingQuestions.length
        ? " Don't re-request these — they're already in front of the creator."
        : ""
    }`,
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
