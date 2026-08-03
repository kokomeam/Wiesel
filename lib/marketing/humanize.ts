/**
 * THE humanization map (UI-1 W1.4): every mutating marketing tool → its
 * user-facing label + category (which carries the icon). Users manage actions
 * in their vocabulary, not the system's — no raw tool identifier may render
 * anywhere on the marketing surface.
 *
 * Contribution rule: a new mutating tool must be added to
 * `MUTATING_TOOL_NAMES` + `TOOL_HUMANIZATION` or the build fails —
 * exhaustiveness is type-enforced against the name union here, and
 * `npm run verify:ui` asserts this list matches the LIVE tool registry
 * (lib/marketing/tools) exactly, so a registry addition without a label
 * fails CI even if this file is untouched.
 *
 * Read tools and `ask_creator` are deliberately absent: they never reach the
 * `marketing_action` ledger, so they never render as user-facing actions.
 */

import {
  AudioLines,
  Clapperboard,
  Mail,
  Megaphone,
  PanelsTopLeft,
  Send,
  Share2,
  Users,
  Wand2,
  type LucideIcon,
} from "lucide-react";

export const MUTATING_TOOL_NAMES = [
  // campaign
  "create_campaign",
  "update_campaign_brief",
  "approve_campaign",
  "pause_campaign",
  "resume_campaign",
  "review_campaign_compliance",
  "launch_campaign",
  "cancel_campaign",
  "attach_lead_list_to_campaign",
  "attach_sender_identity_to_campaign",
  // email
  "generate_email_sequence",
  "regenerate_email_step",
  "generate_email_variants",
  "delete_email_step",
  "generate_followup",
  "write_email_touch",
  "approve_email_step",
  "pause_sequence",
  "resume_sequence",
  "activate_sequence",
  "enroll_segment_in_sequence",
  "send_broadcast",
  "send_test_email",
  "create_sending_schedule",
  "create_sender_identity",
  "update_sender_identity",
  // landing pages
  "generate_landing_page",
  "update_landing_section",
  "set_page_design",
  "set_section_variant",
  "publish_landing_page",
  "unpublish_landing_page",
  // audience
  "create_lead_list",
  "import_leads",
  "build_audience_list",
  "add_leads_to_list",
  "remove_leads_from_list",
  "send_consent_confirmation",
  "send_consent_confirmations",
  // voice
  "update_voice_profile",
  // social drafts
  "generate_social_post_drafts",
  "revise_social_post",
  "change_post_tone",
  "regenerate_social_post",
  "create_social_post",
  "create_social_post_variant",
  "update_social_post",
  "delete_social_post",
  "mark_social_post_status",
  "attach_social_post_image",
  "remove_social_post_image",
  "rewrite_for_platform",
  "update_planned_post_time",
  "log_social_post_performance",
  // lesson clips
  "select_clip_moments",
  "update_clip_moment_status",
  "generate_lesson_clips",
  "cancel_clip_job",
  "generate_posting_kit",
  "update_clip_hook",
  // connected publishing
  "propose_publish_plan",
  "publish_social_post",
  "schedule_social_post",
  "unpublish_social_post",
  "retry_publish",
  "cancel_scheduled_publish",
] as const;

export type MutatingToolName = (typeof MUTATING_TOOL_NAMES)[number];

export type ToolCategory =
  | "campaign"
  | "email"
  | "landing"
  | "audience"
  | "voice"
  | "social"
  | "clips"
  | "publishing";

export interface ToolHumanization {
  /** Verb-first, sentence case — the name the action keeps through the whole flow. */
  label: string;
  category: ToolCategory;
}

export const TOOL_CATEGORY_META: Record<ToolCategory, { label: string; icon: LucideIcon }> = {
  campaign: { label: "Campaign", icon: Megaphone },
  email: { label: "Email", icon: Mail },
  landing: { label: "Landing pages", icon: PanelsTopLeft },
  audience: { label: "Audience", icon: Users },
  voice: { label: "Voice", icon: AudioLines },
  social: { label: "Social posts", icon: Share2 },
  clips: { label: "Lesson clips", icon: Clapperboard },
  publishing: { label: "Publishing", icon: Send },
};

export const TOOL_HUMANIZATION = {
  create_campaign: { label: "Create a campaign", category: "campaign" },
  update_campaign_brief: { label: "Update the campaign brief", category: "campaign" },
  approve_campaign: { label: "Approve the campaign", category: "campaign" },
  pause_campaign: { label: "Pause the campaign", category: "campaign" },
  resume_campaign: { label: "Resume the campaign", category: "campaign" },
  review_campaign_compliance: { label: "Run a compliance review", category: "campaign" },
  launch_campaign: { label: "Launch a campaign", category: "campaign" },
  cancel_campaign: { label: "Cancel a campaign", category: "campaign" },
  attach_lead_list_to_campaign: { label: "Attach a list to the campaign", category: "campaign" },
  attach_sender_identity_to_campaign: { label: "Attach a sender to the campaign", category: "campaign" },

  generate_email_sequence: { label: "Draft an email sequence", category: "email" },
  regenerate_email_step: { label: "Redraft an email step", category: "email" },
  generate_email_variants: { label: "Draft email variants", category: "email" },
  delete_email_step: { label: "Remove an email step", category: "email" },
  generate_followup: { label: "Draft a follow-up email", category: "email" },
  write_email_touch: { label: "Edit an email", category: "email" },
  approve_email_step: { label: "Approve an email step", category: "email" },
  pause_sequence: { label: "Pause a sequence", category: "email" },
  resume_sequence: { label: "Resume a sequence", category: "email" },
  activate_sequence: { label: "Activate a sequence", category: "email" },
  enroll_segment_in_sequence: { label: "Enroll a segment", category: "email" },
  send_broadcast: { label: "Send a broadcast", category: "email" },
  send_test_email: { label: "Send a test email", category: "email" },
  create_sending_schedule: { label: "Set a sending schedule", category: "email" },
  create_sender_identity: { label: "Create a sender identity", category: "email" },
  update_sender_identity: { label: "Update the sender identity", category: "email" },

  generate_landing_page: { label: "Draft a landing page", category: "landing" },
  update_landing_section: { label: "Edit a landing page section", category: "landing" },
  set_page_design: { label: "Change the page design", category: "landing" },
  set_section_variant: { label: "Swap a section variant", category: "landing" },
  publish_landing_page: { label: "Publish a landing page", category: "landing" },
  unpublish_landing_page: { label: "Unpublish a landing page", category: "landing" },

  create_lead_list: { label: "Create a list", category: "audience" },
  import_leads: { label: "Import contacts", category: "audience" },
  build_audience_list: { label: "Build an audience list", category: "audience" },
  add_leads_to_list: { label: "Add contacts to a list", category: "audience" },
  remove_leads_from_list: { label: "Remove contacts from a list", category: "audience" },
  send_consent_confirmation: { label: "Send one consent confirmation", category: "audience" },
  send_consent_confirmations: { label: "Bulk consent confirmations", category: "audience" },

  update_voice_profile: { label: "Update the voice profile", category: "voice" },

  generate_social_post_drafts: { label: "Draft social posts", category: "social" },
  revise_social_post: { label: "Revise a social post", category: "social" },
  change_post_tone: { label: "Change a post's tone", category: "social" },
  regenerate_social_post: { label: "Regenerate a social post", category: "social" },
  create_social_post: { label: "Create a social post", category: "social" },
  create_social_post_variant: { label: "Create a post variant", category: "social" },
  update_social_post: { label: "Edit a social post", category: "social" },
  delete_social_post: { label: "Archive a social post", category: "social" },
  mark_social_post_status: { label: "Update a post's status", category: "social" },
  attach_social_post_image: { label: "Attach an image to a post", category: "social" },
  remove_social_post_image: { label: "Remove a post's image", category: "social" },
  rewrite_for_platform: { label: "Rewrite for another platform", category: "social" },
  update_planned_post_time: { label: "Change the planned post time", category: "social" },
  log_social_post_performance: { label: "Log post performance", category: "social" },

  select_clip_moments: { label: "Find clip moments", category: "clips" },
  update_clip_moment_status: { label: "Update a clip moment", category: "clips" },
  generate_lesson_clips: { label: "Queue a clip render", category: "clips" },
  cancel_clip_job: { label: "Cancel a clip render", category: "clips" },
  generate_posting_kit: { label: "Prepare a posting kit", category: "clips" },
  update_clip_hook: { label: "Update a clip's hook", category: "clips" },

  propose_publish_plan: { label: "Propose a publish plan", category: "publishing" },
  publish_social_post: { label: "Publish a social post", category: "publishing" },
  schedule_social_post: { label: "Schedule a social post", category: "publishing" },
  unpublish_social_post: { label: "Take down a social post", category: "publishing" },
  retry_publish: { label: "Retry a failed publish", category: "publishing" },
  cancel_scheduled_publish: { label: "Cancel a scheduled post", category: "publishing" },
} as const satisfies Record<MutatingToolName, ToolHumanization>;

/** Lookup that never throws: unknown names (registry drift, historical rows)
 *  degrade to a prettified label + a generic icon; verify:ui catches the
 *  drift in CI, the user never sees a snake_case identifier either way. */
export function humanizeToolName(name: string): {
  label: string;
  category: ToolCategory | null;
  icon: LucideIcon;
} {
  const entry = (TOOL_HUMANIZATION as Record<string, ToolHumanization>)[name];
  if (entry) return { ...entry, icon: TOOL_CATEGORY_META[entry.category].icon };
  const pretty = name.replaceAll("_", " ").trim();
  return {
    label: pretty.charAt(0).toUpperCase() + pretty.slice(1),
    category: null,
    icon: Wand2,
  };
}
