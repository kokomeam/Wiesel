/**
 * Marketing Assistant — domain model (UI-free, provider-free).
 *
 * Mirrors lib/course/types.ts: these are the in-memory shapes the tools, the
 * gate, the renderer, and the agent all speak. Postgres rows ↔ these via
 * lib/marketing/persistence.ts (a pure, lossless mapping; ids ARE the row PKs).
 *
 * The core invariants of the suite live here as types:
 *   - a landing page is an ordered list of TYPED slot sections (AI fills slots,
 *     the renderer owns layout/decoration);
 *   - a subscriber has a STATE (`SubscriberStatus`) that is a reducer over the
 *     single analytics event stream;
 *   - every governance action is graded by `Reversibility`.
 */

/* ──────────────────────────── enums / unions ─────────────────────────── */

/** The full campaign lifecycle (Amendment: replaces the old draft/active/
 *  paused/archived set — `archived` rows were migrated to `completed`). */
export type CampaignStatus =
  | "draft"
  | "generated"
  | "in_review"
  | "approved"
  | "scheduled"
  | "sending"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";
export type ComplianceStatus = "not_reviewed" | "passed" | "warnings" | "blocked";
export type LandingPageStatus = "draft" | "published" | "unpublished";
export type SequenceKind = "time_launch" | "event_triggered";
export type SequenceStatus = "draft" | "active" | "paused";
export type EmailStepApprovalStatus = "draft" | "pending_review" | "approved";
export type ConsentStatus = "confirmed" | "pending" | "lapsed";
export type LeadListSourceType = "manual_import" | "course_interest_signup" | "previous_students" | "custom";
export type FollowUpTrigger =
  | "after_previous_email"
  | "opened_not_clicked"
  | "clicked_not_enrolled"
  | "not_opened"
  | "not_enrolled";
export type FollowUpRuleStatus = "draft" | "approved" | "active" | "paused";
export type LeadSegmentKey =
  | "clicked_not_enrolled"
  | "opened_not_clicked"
  | "not_opened"
  | "engaged_30d"
  | "most_engaged"
  | "by_source";
export type EngagementBucket = "hot" | "warm" | "cool" | "cold";

/** The subscriber lifecycle state machine. `unsubscribed`/`bounced` are
 *  terminal SUPPRESSED states no send may target. */
export type SubscriberStatus =
  | "lead"
  | "subscribed"
  | "engaged"
  | "enrolled"
  | "unsubscribed"
  | "bounced";

export type EnrollmentStatus = "active" | "completed" | "cancelled";

export type ScheduledSendStatus =
  | "pending"
  | "awaiting_approval"
  | "approved"
  | "sent"
  | "skipped"
  | "failed"
  | "cancelled";

/** Every analytics moment is one of these. ONE stream renders the dashboard,
 *  feeds the agent's observe step, AND drives the subscriber reducer. */
export type AnalyticsEventType =
  | "page_view"
  | "form_submit"
  | "free_lesson_capture"
  | "email_sent"
  | "email_delivered"
  | "email_open"
  | "email_click"
  | "email_bounce"
  | "email_unsubscribe"
  | "spam_complaint"
  | "consent_confirmed"
  | "campaign_auto_paused"
  | "enrollment"
  // Social Post Generator (Marketing Phase 1) — same single stream. These are
  // marketing events, not course-consumption events; course_id carries the
  // hub's course context. Extended TOGETHER with the DB check constraint
  // (migration 20260706120000) per the consequential-updates rule.
  | "social_post_batch_generated"
  | "social_post_created"
  | "social_post_updated"
  | "social_post_revised_by_agent"
  | "social_post_status_changed"
  | "social_post_copied"
  | "social_post_downloaded"
  | "social_post_image_attached"
  | "social_post_image_removed"
  | "social_post_performance_logged"
  | "social_post_generation_failed"
  | "social_voice_profile_derived"
  | "social_voice_profile_edited"
  // Lesson Clip Repurposing (Marketing Phase 1.5, M-A slice) — same single
  // stream, snake_case per repo convention. Extended TOGETHER with the DB
  // check constraint (migration 20260707100000); verify-clips.ts guards the
  // drift. Later milestones add job/ingest/kit/link events with their tables.
  | "lesson_transcribed"
  | "clip_moments_generated"
  | "clip_moments_generation_failed"
  | "clip_moment_selected"
  | "clip_moment_dismissed"
  // M-B render jobs (migration 20260708130000; payloads carry layout +
  // recordingFormat per the consequential-updates rule)
  | "clip_job_submitted"
  | "clip_job_completed"
  | "clip_job_failed"
  // M-C ingest (migration 20260708140000)
  | "clip_ingested"
  // M-D posting kit + short links (migration 20260710100000)
  | "posting_kit_generated"
  | "short_link_click";

/** The governance grade the gate routes on. `read` tools never mutate. */
export type Reversibility = "read" | "reversible" | "irreversible";

export type ActionStatus =
  | "auto_approved"
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "reverted";

export type RequestedBy = "user" | "agent";

/* ─────────────────────────── landing sections ────────────────────────── */

/** The landing page's typed slot sections. The AI (or a human) fills ONLY the
 *  text slots; the renderer owns all layout, spacing, color, and decoration.
 *  Every slot is length-capped at the schema (lib/marketing/schemas.ts) so
 *  generated copy can never overflow the design — the validate→repair guard. */
export type LandingSectionKind =
  | "hero"
  | "outcomes"
  | "curriculum"
  | "instructor"
  | "social_proof"
  | "pricing_cta"
  | "lead_capture"
  | "faq";

export type HeroVariant = "centered" | "split" | "minimal";
export type OutcomesVariant = "grid" | "list";

export interface HeroSection {
  id: string;
  kind: "hero";
  eyebrow?: string;
  headline: string;
  subhead: string;
  ctaLabel: string;
  /** Renderer-owned layout variant (NOT freeform markup). */
  variant?: HeroVariant;
}

export interface OutcomesSection {
  id: string;
  kind: "outcomes";
  heading: string;
  items: string[];
  variant?: OutcomesVariant;
}

export interface CurriculumSection {
  id: string;
  kind: "curriculum";
  heading: string;
  modules: { title: string; lessonCount: number }[];
}

export interface InstructorSection {
  id: string;
  kind: "instructor";
  heading: string;
  name: string;
  bio: string;
}

export interface SocialProofSection {
  id: string;
  kind: "social_proof";
  heading: string;
  quote: string;
  attribution: string;
}

export interface PricingCtaSection {
  id: string;
  kind: "pricing_cta";
  heading: string;
  priceLabel: string;
  points: string[];
  ctaLabel: string;
}

export interface LeadCaptureSection {
  id: string;
  kind: "lead_capture";
  heading: string;
  subhead: string;
  buttonLabel: string;
  /** Mandatory consent line — never blank (deliverability/compliance). */
  consentText: string;
  /** When true the form offers the free first lesson (free-lesson capture). */
  offerFreeLesson: boolean;
}

export interface FaqSection {
  id: string;
  kind: "faq";
  heading: string;
  items: { q: string; a: string }[];
}

export type LandingSection =
  | HeroSection
  | OutcomesSection
  | CurriculumSection
  | InstructorSection
  | SocialProofSection
  | PricingCtaSection
  | LeadCaptureSection
  | FaqSection;

/** The TYPED design layer — bounded knobs the renderer reads (it owns all the
 *  actual CSS/layout). The agent sets these via tools; it never emits markup. */
export type ColorTheme = "warm" | "cool" | "mono" | "bold";
export type TypePairing = "editorial" | "modern" | "classic";
export type Density = "compact" | "normal" | "airy";
export type ButtonStyle = "pill" | "rounded" | "square";

export interface LandingTheme {
  accent?: string; // legacy
  colorTheme?: ColorTheme;
  typePairing?: TypePairing;
  density?: Density;
  buttonStyle?: ButtonStyle;
}

/* ─────────────────────────── email content ───────────────────────────── */

/** One block of a (React-Email-rendered) email body. The renderer owns the
 *  wrapper, header, and footer (incl. the mandatory unsubscribe). */
export type EmailBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "button"; label: string; href: string }
  | { kind: "bullets"; items: string[] };

export interface EmailBody {
  blocks: EmailBlock[];
}

/* ───────────────────── campaign config (jsonb) shapes ─────────────────── */

/** The Campaign Brief (Amendment 3a) — optional-but-encouraged creator input,
 *  injected into generation alongside the auto-pulled course context. Lives at
 *  `marketing_campaign.config.brief`. */
export interface CampaignBrief {
  audienceNotes?: string;
  proofPoints?: string;
  offerDetails?: string;
  thingsToAvoid?: string;
  freeform?: string;
  /** Amendment 14 — overrides the auto-detected course language. */
  language?: string;
  /** Amendment 1 (promote_discount) — a REAL ISO deadline; required for that
   *  blueprint (fake-scarcity compliance rule blocks without it). */
  offerDeadlineIso?: string;
}

/** Send-window config (Amendment 12). Lives at `config.sendWindow`. */
export interface SendWindow {
  startHour: number;
  endHour: number;
  timezone: string;
  skipWeekends: boolean;
}

export const DEFAULT_SEND_WINDOW: SendWindow = {
  startHour: 9,
  endHour: 11,
  timezone: "UTC",
  skipWeekends: true,
};

export interface MarketingCampaignConfig {
  blueprintKey?: string;
  brief?: CampaignBrief;
  sendWindow?: SendWindow;
  /** Snapshotted at launch — the FIXED audience the approval covers (Amendment
   *  4c: "operates only within the approved list"). */
  approvedAudienceIds?: string[];
  autoPauseReason?: { metric: string; value: number; threshold: number; occurredAt: string };
  [key: string]: unknown;
}

/* ───────────────────────────── entities ──────────────────────────────── */

export interface MarketingCampaign {
  id: string;
  courseId: string;
  name: string;
  goal: string | null;
  status: CampaignStatus;
  complianceStatus: ComplianceStatus;
  complianceReport: Record<string, unknown>;
  approvedAt: string | null;
  approvedBy: string | null;
  senderIdentityId: string | null;
  leadListId: string | null;
  config: MarketingCampaignConfig;
}

export interface LandingPage {
  id: string;
  campaignId: string;
  courseId: string;
  slug: string;
  title: string;
  status: LandingPageStatus;
  sections: LandingSection[];
  theme: LandingTheme;
  publishedAt: string | null;
}

export interface EmailTouch {
  id: string;
  sequenceId: string;
  courseId: string;
  position: number;
  /** Time-based offset from enrollment (seconds). Null for event touches. */
  delaySeconds: number | null;
  /** Behavioral event that fires this touch. Null for time touches. */
  triggerEvent: AnalyticsEventType | null;
  subject: string;
  previewText: string | null;
  body: EmailBody;
  stageName: string | null;
  purpose: string | null;
  aiRationale: string | null;
  personalizationVariables: string[];
  approvalStatus: EmailStepApprovalStatus;
  complianceWarnings: string[];
  qualityScore: { score: number; failedCriteria: string[]; passedCriteria: string[] } | null;
}

export interface EmailSequence {
  id: string;
  campaignId: string;
  courseId: string;
  name: string;
  kind: SequenceKind;
  /** For event_triggered sequences: which event enrolls a subscriber. */
  trigger: { event?: AnalyticsEventType; withinSeconds?: number } & Record<string, unknown>;
  status: SequenceStatus;
  touches: EmailTouch[];
}

export interface Subscriber {
  id: string;
  campaignId: string;
  courseId: string;
  email: string;
  name: string | null;
  status: SubscriberStatus;
  source: string | null;
  consent: Record<string, unknown>;
  consentStatus: ConsentStatus;
  consentRequestedAt: string | null;
  attributes: Record<string, unknown>;
  anonymousId: string | null;
  unsubscribedAt: string | null;
}

/* ─────────────────────── new campaign-layer entities ───────────────────── */

export interface LeadList {
  id: string;
  courseId: string;
  campaignId: string | null;
  name: string;
  sourceType: LeadListSourceType;
  consentConfirmed: boolean;
}

export interface SenderIdentity {
  id: string;
  courseId: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  mailingAddress: string;
  businessName: string | null;
  verified: boolean;
}

export interface FollowUpRule {
  id: string;
  campaignId: string;
  courseId: string;
  name: string;
  trigger: FollowUpTrigger;
  delayDays: number;
  emailTouchId: string | null;
  status: FollowUpRuleStatus;
}

export interface VoiceProfile {
  id: string;
  authorId: string;
  rules: string[];
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  subscriberId: string;
  courseId: string;
  status: EnrollmentStatus;
  currentPosition: number;
  startedAt: string;
  completedAt: string | null;
}

export interface ScheduledSend {
  id: string;
  courseId: string;
  sequenceId: string | null;
  touchId: string | null;
  subscriberId: string;
  scheduledFor: string;
  status: ScheduledSendStatus;
  actionId: string | null;
  providerMessageId: string | null;
  attempts: number;
  error: string | null;
  sentAt: string | null;
}

export interface AnalyticsEvent {
  id: string;
  courseId: string;
  campaignId: string | null;
  landingPageId: string | null;
  subscriberId: string | null;
  anonymousId: string | null;
  type: AnalyticsEventType;
  source: string | null;
  props: Record<string, unknown>;
  occurredAt: string;
}

export interface MarketingActionRow {
  id: string;
  courseId: string;
  campaignId: string | null;
  toolName: string;
  actionKind: string;
  reversibility: Exclude<Reversibility, "read">;
  status: ActionStatus;
  params: Record<string, unknown>;
  beforeSnapshot: unknown | null;
  targetRef: { entity: string; id: string } | null;
  summary: string | null;
  requestedBy: RequestedBy;
  resolvedAt: string | null;
  createdAt: string;
  /** Agent-requested actions: the conversation the run paused in, so the
   *  approve/deny resume lands in the SAME thread. Null on user-surface calls. */
  conversationId: string | null;
  /** Reversible actions: one-click Revert is offered until this instant
   *  (then the revert closes, fail-closed). Null on irreversible rows. */
  revertExpiresAt: string | null;
  /** Irreversible actions routed by the autonomy engine: the full audit of
   *  mode + every guardrail evaluated (autonomy.ts AutonomyDecision). */
  autonomyDecision: unknown | null;
}

/* ─────────────── grounding context (read from the course) ─────────────── */

/** What the generators read to ground copy — assembled from the course row +
 *  its plan jsonb + module/lesson counts. Pure input; never persisted here. */
export interface CourseMarketingContext {
  courseId: string;
  title: string;
  description: string | null;
  audience: string | null;
  level: string | null;
  outcomes: string[];
  prerequisites: string[];
  teachingStyle: string | null;
  priceCents: number;
  modules: { title: string; lessonCount: number }[];
}
