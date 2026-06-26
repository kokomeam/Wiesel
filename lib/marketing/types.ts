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

export type CampaignStatus = "draft" | "active" | "paused" | "archived";
export type LandingPageStatus = "draft" | "published" | "unpublished";
export type SequenceKind = "time_launch" | "event_triggered";
export type SequenceStatus = "draft" | "active" | "paused";

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
  | "email_open"
  | "email_click"
  | "email_bounce"
  | "email_unsubscribe"
  | "enrollment";

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

/* ───────────────────────────── entities ──────────────────────────────── */

export interface MarketingCampaign {
  id: string;
  courseId: string;
  name: string;
  goal: string | null;
  status: CampaignStatus;
  config: Record<string, unknown>;
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
  attributes: Record<string, unknown>;
  anonymousId: string | null;
  unsubscribedAt: string | null;
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
