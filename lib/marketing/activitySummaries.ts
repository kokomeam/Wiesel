/**
 * Deterministic activity summaries (UI-1 W3.3, DEV-1): one pure template per
 * mutating tool, exhaustively typed over the SAME name union as the
 * humanization map — a new tool without a template fails compilation, and
 * verify:ui asserts the union matches the live registry.
 *
 * Inputs are the `marketing_action` row's structured columns only — never
 * the stored prose. Tools emit a small typed bag (`ActionSummaryFields`)
 * alongside their prose summary; templates degrade gracefully when a field
 * (or the whole bag — historical rows) is missing. NO model calls anywhere
 * in this path.
 *
 * Render-time translation lives here too: funnel-stage codes, preset names,
 * transcript/provider internals and guardrail details never reach the
 * creator untranslated (D-12/D-14).
 */

import type { UiStatus } from "@/components/ui/StatusChip";
import {
  humanizeToolName,
  MUTATING_TOOL_NAMES,
  type MutatingToolName,
} from "@/lib/marketing/humanize";

/* ── the structured bag tools emit ─────────────────────────────────────── */

export interface ActionSummaryFields {
  /** Schema version for forward evolution. */
  v?: 1;
  /** The thing acted on — hook text, list/page/campaign name, subject line… */
  entity?: string;
  /** Primary count (moments found, contacts, drafts, recipients…). */
  count?: number;
  /** Secondary count (dropped by validation/lint, duplicates skipped…). */
  dropped?: number;
  /** Platform id — rendered via the platform label map. */
  platform?: string;
  /** Funnel stage code — ALWAYS translated at render. */
  stage?: "tofu" | "mofu" | "bofu";
  /** Comment keyword for posting kits. */
  keyword?: string;
  /** Short-link code — rendered against the CURRENT origin, never a baked URL. */
  shortCode?: string;
  /** Clip preset id — translated at render. */
  preset?: string;
  /** Clip layout id — rendered via the layout label map when present. */
  layout?: string;
  /** One clean, creator-facing sentence of context (no internals). */
  note?: string;
  /** Outcome refinement for the status chip. */
  outcome?: "done" | "queued" | "ready" | "sent" | "held" | "reverted";
}

export function parseSummaryFields(json: unknown): ActionSummaryFields | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  return json as ActionSummaryFields;
}

/* ── render-time vocabulary translation (D-12) ─────────────────────────── */

export const STAGE_LABELS: Record<"tofu" | "mofu" | "bofu", string> = {
  tofu: "Awareness",
  mofu: "Consideration",
  bofu: "Conversion",
};

export const PRESET_LABELS: Record<string, string> = {
  tofu_hook: "Hook",
  mofu_story: "Story",
  bofu_preview: "Preview",
};

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram Reels",
  tiktok: "TikTok",
  youtube: "YouTube",
  youtube_shorts: "YouTube Shorts",
};

export const platformLabel = (id?: string) =>
  id ? (PLATFORM_LABELS[id] ?? id.replaceAll("_", " ")) : undefined;
export const stageLabel = (s?: string) =>
  s && s in STAGE_LABELS ? STAGE_LABELS[s as keyof typeof STAGE_LABELS] : undefined;
export const presetLabel = (p?: string) => (p ? (PRESET_LABELS[p] ?? undefined) : undefined);

/* ── guardrail humanization (D-14 / W3.7) ──────────────────────────────── */

/** Per-guardrail creator language — replaces the joined debug details. */
export const GUARDRAIL_EXPLANATIONS: Record<string, string> = {
  hard_deny: "This action always asks you — it can never run on its own.",
  tool_allowlist: "You haven't opted this action into auto-approval.",
  recipient_cap: "No recipient cap is set, so sends can't auto-run.",
  recipient_cap_exceeded: "The audience was larger than your auto-send cap.",
  budget_cap: "No budget cap is set for actions that spend.",
  allowed_hours: "It was outside your allowed hours.",
  first_send_to_new_segment: "It was the first send to a segment this course hasn't emailed.",
  segment_history: "It was the first send to a segment this course hasn't emailed.",
  mode: "Your autonomy mode routes this to you.",
};

export function explainGuardrail(name: string): string {
  return GUARDRAIL_EXPLANATIONS[name] ?? "A guardrail routed this to you.";
}

/* ── the collapsed line: one template per tool ─────────────────────────── */

const q = (s: string, max = 38) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;
const n = (v: number | undefined, singular: string, plural = `${singular}s`) =>
  v === undefined ? undefined : `${v} ${v === 1 ? singular : plural}`;

type Template = (f: ActionSummaryFields) => string;

/** Every template MUST stay ≤80 chars for any input (entity is clamped by q();
 *  activity-summaries.test enforces this over long-input fixtures). */
const TEMPLATES: Record<MutatingToolName, Template> = {
  // campaign
  create_campaign: (f) => (f.entity ? `Created campaign ${q(f.entity)}` : "Created a campaign"),
  update_campaign_brief: () => "Updated the campaign brief",
  approve_campaign: () => "Approved the campaign",
  pause_campaign: (f) => (f.entity ? `Paused ${q(f.entity)}` : "Paused the campaign"),
  resume_campaign: (f) => (f.entity ? `Resumed ${q(f.entity)}` : "Resumed the campaign"),
  review_campaign_compliance: (f) =>
    f.count !== undefined ? `Compliance review — ${n(f.count, "finding")}` : "Ran a compliance review",
  launch_campaign: (f) => (f.entity ? `Launched ${q(f.entity)}` : "Launched the campaign"),
  cancel_campaign: (f) => (f.entity ? `Cancelled ${q(f.entity)}` : "Cancelled the campaign"),
  attach_lead_list_to_campaign: (f) =>
    f.entity ? `Attached list ${q(f.entity)} to the campaign` : "Attached a list to the campaign",
  attach_sender_identity_to_campaign: () => "Attached a sender to the campaign",

  // email
  generate_email_sequence: (f) =>
    f.count !== undefined ? `Drafted a sequence — ${n(f.count, "email")}` : "Drafted an email sequence",
  regenerate_email_step: (f) => (f.entity ? `Redrafted ${q(f.entity)}` : "Redrafted an email step"),
  generate_email_variants: (f) =>
    f.count !== undefined ? `Drafted ${n(f.count, "variant")}` : "Drafted email variants",
  delete_email_step: (f) => (f.entity ? `Removed step ${q(f.entity)}` : "Removed an email step"),
  generate_followup: () => "Drafted a follow-up email",
  write_email_touch: (f) => (f.entity ? `Edited email ${q(f.entity)}` : "Edited an email"),
  approve_email_step: (f) => (f.entity ? `Approved ${q(f.entity)}` : "Approved an email step"),
  pause_sequence: (f) => (f.entity ? `Paused sequence ${q(f.entity)}` : "Paused a sequence"),
  resume_sequence: (f) => (f.entity ? `Resumed sequence ${q(f.entity)}` : "Resumed a sequence"),
  activate_sequence: (f) => (f.entity ? `Activated ${q(f.entity)}` : "Activated a sequence"),
  enroll_segment_in_sequence: (f) =>
    f.count !== undefined ? `Enrolled ${n(f.count, "subscriber")}` : "Enrolled a segment",
  send_broadcast: (f) =>
    f.count !== undefined ? `Broadcast to ${n(f.count, "subscriber")}` : "Sent a broadcast",
  send_test_email: () => "Test email to your own address",
  create_sending_schedule: () => "Set a sending schedule",
  create_sender_identity: (f) => (f.entity ? `Created sender ${q(f.entity)}` : "Created a sender identity"),
  update_sender_identity: () => "Updated the sender identity",

  // landing pages
  generate_landing_page: (f) => (f.entity ? `Drafted page ${q(f.entity)}` : "Drafted a landing page"),
  update_landing_section: (f) => (f.entity ? `Edited the ${f.entity} section` : "Edited a page section"),
  set_page_design: () => "Changed the page design",
  set_section_variant: (f) => (f.entity ? `Swapped the ${f.entity} variant` : "Swapped a section variant"),
  publish_landing_page: (f) => (f.entity ? `Published ${q(f.entity)}` : "Published a landing page"),
  unpublish_landing_page: (f) => (f.entity ? `Unpublished ${q(f.entity)}` : "Unpublished a landing page"),

  // audience
  create_lead_list: (f) => (f.entity ? `Created list ${q(f.entity)}` : "Created a list"),
  import_leads: (f) =>
    f.count !== undefined ? `Imported ${n(f.count, "contact")}` : "Imported contacts",
  build_audience_list: (f) =>
    f.entity && f.count !== undefined
      ? `List ${q(f.entity, 28)} — ${n(f.count, "contact")}`
      : "Built an audience list",
  add_leads_to_list: (f) =>
    f.count !== undefined ? `Added ${n(f.count, "contact")} to a list` : "Added contacts to a list",
  remove_leads_from_list: (f) =>
    f.count !== undefined ? `Removed ${n(f.count, "contact")} from a list` : "Removed contacts from a list",
  send_consent_confirmation: () => "Sent one consent confirmation",
  send_consent_confirmations: (f) =>
    f.count !== undefined ? `Consent asks to ${n(f.count, "contact")}` : "Sent consent confirmations",

  // voice
  update_voice_profile: () => "Updated the voice profile",

  // social drafts
  generate_social_post_drafts: (f) => {
    const platform = platformLabel(f.platform);
    const head = f.count !== undefined ? `Drafted ${n(f.count, "post")}` : "Drafted social posts";
    const tail = f.dropped ? ` · ${f.dropped} dropped` : "";
    return platform ? `${head} — ${platform}${tail}` : `${head}${tail}`;
  },
  revise_social_post: () => "Revised a social post",
  change_post_tone: (f) => (f.note ? `Tone → ${f.note}` : "Changed a post's tone"),
  regenerate_social_post: () => "Regenerated a social post",
  create_social_post: (f) => {
    const platform = platformLabel(f.platform);
    return platform ? `Created a ${platform} post` : "Created a social post";
  },
  create_social_post_variant: () => "Created a post variant",
  update_social_post: () => "Edited a social post",
  delete_social_post: () => "Archived a social post",
  mark_social_post_status: (f) => (f.note ? `Post marked ${f.note}` : "Updated a post's status"),
  attach_social_post_image: () => "Attached an image to a post",
  remove_social_post_image: () => "Removed a post's image",
  rewrite_for_platform: (f) => {
    const platform = platformLabel(f.platform);
    return platform ? `Rewrote a post for ${platform}` : "Rewrote for another platform";
  },
  update_planned_post_time: () => "Changed the planned post time",
  log_social_post_performance: () => "Logged post performance",

  // lesson clips
  select_clip_moments: (f) => {
    const head = f.count !== undefined ? `Found ${n(f.count, "clip moment")}` : "Found clip moments";
    return f.dropped ? `${head} · ${f.dropped} dropped` : head;
  },
  update_clip_moment_status: (f) => (f.note ? `Clip moment ${f.note}` : "Updated a clip moment"),
  generate_lesson_clips: (f) =>
    f.entity ? `Queued clip render — ${q(f.entity)}` : "Queued a clip render",
  cancel_clip_job: (f) => (f.entity ? `Cancelled render ${q(f.entity, 30)}` : "Cancelled a clip render"),
  generate_posting_kit: (f) => {
    const platform = platformLabel(f.platform) ?? "clip";
    return f.keyword
      ? `Posting kit ready — ${platform} · keyword “${f.keyword}”`
      : `Posting kit ready — ${platform}`;
  },
  update_clip_hook: (f) => (f.entity ? `New hook ${q(f.entity)}` : "Updated a clip's hook"),

  // connected publishing
  propose_publish_plan: (f) =>
    f.count !== undefined ? `Proposed a publish plan — ${n(f.count, "post")}` : "Proposed a publish plan",
  publish_social_post: (f) => {
    const platform = platformLabel(f.platform);
    return platform ? `Publish card filed — ${platform}` : "Publish card filed";
  },
  schedule_social_post: (f) => {
    const platform = platformLabel(f.platform);
    return platform ? `Schedule card filed — ${platform}` : "Schedule card filed";
  },
  unpublish_social_post: () => "Marked a post taken down here",
  retry_publish: () => "Retried a failed publish",
  cancel_scheduled_publish: () => "Cancelled a scheduled post",
};

/* ── chip + assembled entry ────────────────────────────────────────────── */

export interface ActivityChip {
  label: string;
  status: UiStatus;
}

export interface ActivityRowInput {
  toolName: string;
  status: string; // marketing_action.status
  summaryFields: ActionSummaryFields | null;
  /** True when the stored autonomy decision routed to a card (pending_approval). */
  routedToApproval: boolean;
  /** True when the policy auto-executed it (route auto_execute). */
  autoExecuted: boolean;
}

const OUTCOME_CHIPS: Record<NonNullable<ActionSummaryFields["outcome"]>, ActivityChip> = {
  done: { label: "Done", status: "success" },
  queued: { label: "Queued", status: "pending" },
  ready: { label: "Ready for you", status: "success" },
  sent: { label: "Sent", status: "success" },
  held: { label: "Needs review", status: "attention" },
  reverted: { label: "Reverted", status: "neutral" },
};

export function activityChip(row: ActivityRowInput): ActivityChip {
  if (row.status === "reverted") return OUTCOME_CHIPS.reverted;
  // D-16: a card-routed action the creator resolved is APPROVED BY YOU —
  // never the policy's badge.
  if (row.routedToApproval && row.status === "executed") return { label: "Approved by you", status: "success" };
  if (row.summaryFields?.outcome) return OUTCOME_CHIPS[row.summaryFields.outcome];
  if (row.status === "executed" || row.status === "auto_approved") return OUTCOME_CHIPS.done;
  if (row.status === "pending") return OUTCOME_CHIPS.held;
  if (row.status === "rejected") return { label: "Declined", status: "neutral" };
  return { label: "Done", status: "success" };
}

export const SUMMARY_MAX_CHARS = 80;

/** The one collapsed line — ≤80 chars for ANY input; unknown tools (drift,
 *  historical) degrade to the humanized label. */
export function summarizeAction(toolName: string, fields: ActionSummaryFields | null): string {
  const template = (TEMPLATES as Record<string, Template>)[toolName];
  const line = template ? template(fields ?? {}) : humanizeToolName(toolName).label;
  return line.length <= SUMMARY_MAX_CHARS ? line : `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

/** Metadata chips for the expanded detail area (already translated). */
export function detailMetadata(fields: ActionSummaryFields | null): { label: string; value: string }[] {
  if (!fields) return [];
  const out: { label: string; value: string }[] = [];
  const platform = platformLabel(fields.platform);
  if (platform) out.push({ label: "Platform", value: platform });
  const stage = stageLabel(fields.stage);
  if (stage) out.push({ label: "Funnel", value: stage });
  const preset = presetLabel(fields.preset);
  if (preset) out.push({ label: "Style", value: preset });
  if (fields.layout) out.push({ label: "Layout", value: fields.layout });
  // User-supplied values render in curly quotes (the convention the copy-lint
  // exempts — creator keywords may legitimately be ALL-CAPS).
  if (fields.keyword) out.push({ label: "Keyword", value: `“${fields.keyword}”` });
  if (fields.count !== undefined) out.push({ label: "Count", value: String(fields.count) });
  if (fields.dropped) out.push({ label: "Dropped", value: String(fields.dropped) });
  return out;
}

/** Relative timestamp, computed server-side against one clock (no hydration
 *  drift); the absolute string rides as a hover title. */
export function relativeTime(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d" : `${d}d`;
}

/** Day bucket label for group dividers. */
export function dayLabel(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const now = new Date(nowMs);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export { MUTATING_TOOL_NAMES };
