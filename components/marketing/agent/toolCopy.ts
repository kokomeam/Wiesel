/**
 * Render-only humanized copy for the marketing agent's tool rows (UI polish,
 * 2026-07-08) — stored item data, event shapes, and the 'run' matching status
 * are untouched by everything here.
 *
 * Lives OUTSIDE AgentPanel.tsx on purpose: the AC-MD.5 vocabulary fence
 * requires the panel to carry no publish/schedule copy of its own (the
 * connected-publishing strings ride the allowlisted publish module). This
 * module is the panel's label dictionary, same pattern as the editor's
 * lib/ai/toolLabels.ts.
 */

const TOOL_LABELS: Record<string, string> = {
  generate_email_sequence: "Drafting the email sequence",
  generate_landing_page: "Drafting the landing page",
  generate_followup: "Drafting a follow-up email",
  generate_email_variants: "Drafting email variants",
  build_audience_list: "Building the audience list",
  add_leads_to_list: "Adding contacts to the list",
  remove_leads_from_list: "Removing contacts from the list",
  import_leads: "Importing contacts",
  create_campaign: "Creating the campaign",
  launch_campaign: "Launching the campaign",
  pause_campaign: "Pausing the campaign",
  resume_campaign: "Resuming the campaign",
  cancel_campaign: "Cancelling the campaign",
  pause_sequence: "Pausing the sequence",
  resume_sequence: "Resuming the sequence",
  activate_sequence: "Activating the sequence",
  send_broadcast: "Sending a broadcast",
  send_test_email: "Sending a test email",
  send_consent_confirmations: "Asking contacts to confirm consent",
  publish_landing_page: "Publishing the landing page",
  review_campaign_compliance: "Checking compliance",
  analyze_course_for_marketing: "Analyzing your course",
  get_analytics_summary: "Reading your analytics",
  create_sender_identity: "Setting up the sender identity",
};

/** snake_case → sentence-case fallback for unmapped tools. */
export function marketingToolLabel(tool: string): string {
  const mapped = TOOL_LABELS[tool];
  if (mapped) return mapped;
  const words = tool.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tool-aware in-progress copy (display only; stored summaries unchanged). */
export function marketingToolRunningCopy(tool: string): string {
  if (/^(get_|list_|query_|analyze_|review_)/.test(tool)) return "Looking at your current setup…";
  if (/^generate_/.test(tool)) return "Writing a draft for you…";
  return "Working on it…";
}

/** Accessible label for the status glyph. */
export function toolStatusLabel(status: string): string {
  if (status === "needs_clarification") return "Needs your input";
  if (status === "pending_approval") return "Waiting for approval";
  if (status === "error") return "Couldn't finish";
  return "Done";
}
