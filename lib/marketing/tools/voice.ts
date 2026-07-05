/**
 * Voice profile tools (Amendment 3c) — a persistent, CREATOR-level (not
 * course-level) style profile every copy generation and chat edit reads. The
 * creator edits the rules directly; the accepted/rejected `marketing_action`
 * ledger is a SIGNAL surfaced alongside the rules (an accepted rewrite = a
 * positive signal, a rejected one = negative — the gate already built is the
 * training signal), never an auto-mutation of the rules themselves.
 */

import { z } from "zod";
import { defaultVoiceRules, loadCourseMarketingContext, loadVoiceProfile } from "../persistence";
import { defineMarketingTool, MarketingToolError } from "./types";

export interface VoiceLedgerSignal {
  acceptedEdits: number;
  revertedEdits: number;
  recentRevertedSummaries: string[];
}

/** Accepted (executed) vs. reverted edits across ALL of the author's courses —
 *  the informational signal, not an auto-mutation path. */
export async function voiceLedgerSignal(
  supabase: import("./types").DB,
  authorId: string
): Promise<VoiceLedgerSignal> {
  const { data: courses } = await supabase.from("courses").select("id").eq("author_id", authorId);
  const courseIds = (courses ?? []).map((c) => c.id);
  if (courseIds.length === 0) return { acceptedEdits: 0, revertedEdits: 0, recentRevertedSummaries: [] };

  const { data: actions } = await supabase
    .from("marketing_action")
    .select("status,summary,tool_name")
    .in("course_id", courseIds)
    .in("tool_name", ["update_email_step", "write_email_touch"])
    .in("status", ["executed", "reverted"])
    .order("created_at", { ascending: false })
    .limit(50);

  const accepted = (actions ?? []).filter((a) => a.status === "executed").length;
  const reverted = (actions ?? []).filter((a) => a.status === "reverted");
  return {
    acceptedEdits: accepted,
    revertedEdits: reverted.length,
    recentRevertedSummaries: reverted.slice(0, 5).map((a) => a.summary ?? "(no summary)"),
  };
}

const getVoiceProfile = defineMarketingTool({
  name: "get_voice_profile",
  description: "Get the creator's persistent voice profile (style rules) plus the accepted/rejected edit signal that should inform revisions.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const profile = await loadVoiceProfile(ctx.supabase, ctx.ownerId);
    if (!profile) {
      const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
      const rules = defaultVoiceRules(course?.teachingStyle ?? null);
      return { summary: `No voice profile yet — seeded defaults: ${rules.length} rule(s).`, data: { rules, seeded: true } };
    }
    const signal = await voiceLedgerSignal(ctx.supabase, ctx.ownerId);
    return {
      summary: `${profile.rules.length} voice rule(s). Ledger signal: ${signal.acceptedEdits} accepted, ${signal.revertedEdits} reverted edits.`,
      data: { rules: profile.rules, signal },
    };
  },
});

const updateVoiceProfile = defineMarketingTool({
  name: "update_voice_profile",
  description: "Set the creator's voice profile — 5-10 plain-language style rules. Stages as reversible.",
  params: z.object({ rules: z.array(z.string().min(1).max(200)).min(1).max(12) }),
  reversibility: "reversible",
  actionKind: "update_voice_profile",
  async existingTarget(_args, ctx) {
    // voice_profile is keyed by author_id, not a passed id — look up whatever
    // row already exists so an edit snapshots it (Reject restores the prior
    // rules); a first-ever call has no existing row (Reject deletes the create).
    const existing = await loadVoiceProfile(ctx.supabase, ctx.ownerId);
    return existing ? { entity: "voice_profile", id: existing.id } : null;
  },
  async execute(args, ctx) {
    const { data, error } = await ctx.supabase
      .from("voice_profile")
      .upsert({ author_id: ctx.ownerId, rules: args.rules }, { onConflict: "author_id" })
      .select("id")
      .single();
    if (error || !data) throw new MarketingToolError(`update_voice_profile: ${error?.message}`);
    return { summary: `Updated the voice profile — ${args.rules.length} rule(s).`, target: { entity: "voice_profile", id: data.id } };
  },
});

export const voiceTools = [getVoiceProfile, updateVoiceProfile];
