/**
 * Pure-ish row ↔ domain mapping for the marketing entities, plus small loaders.
 *
 * Mirrors lib/course/persistence.ts: the mappers are pure; the loaders are thin
 * Supabase reads. ids ARE the row primary keys, so the mapping is 1:1 and
 * lossless. jsonb columns (sections/config/body/…) are stored verbatim and read
 * back through the Zod schemas at the tool boundary.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type {
  AnalyticsEventType,
  CampaignStatus,
  CourseMarketingContext,
  EmailBody,
  EmailSequence,
  EmailTouch,
  LandingPage,
  LandingPageStatus,
  LandingSection,
  LandingTheme,
  MarketingCampaign,
  SequenceKind,
  SequenceStatus,
} from "./types";

type DB = SupabaseClient<Database>;
type CampaignRow = Database["public"]["Tables"]["marketing_campaign"]["Row"];
type LandingRow = Database["public"]["Tables"]["landing_page"]["Row"];
type SequenceRow = Database["public"]["Tables"]["email_sequence"]["Row"];
type TouchRow = Database["public"]["Tables"]["email_touch"]["Row"];

/* ───────────────────────────── mappers ───────────────────────────────── */

export function campaignFromRow(row: CampaignRow): MarketingCampaign {
  return {
    id: row.id,
    courseId: row.course_id,
    name: row.name,
    goal: row.goal,
    status: row.status as CampaignStatus,
    config: (row.config as Record<string, unknown>) ?? {},
  };
}

export function landingPageFromRow(row: LandingRow): LandingPage {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    courseId: row.course_id,
    slug: row.slug,
    title: row.title,
    status: row.status as LandingPageStatus,
    sections: ((row.sections as unknown) as LandingSection[]) ?? [],
    theme: ((row.theme as unknown) as LandingTheme) ?? {},
    publishedAt: row.published_at,
  };
}

/* ───────────────────────────── loaders ───────────────────────────────── */

export async function loadCampaign(supabase: DB, id: string): Promise<MarketingCampaign | null> {
  const { data } = await supabase.from("marketing_campaign").select("*").eq("id", id).maybeSingle();
  return data ? campaignFromRow(data) : null;
}

/** The most-recent campaign for a course (MVP = one campaign per course). */
export async function loadCampaignForCourse(
  supabase: DB,
  courseId: string
): Promise<MarketingCampaign | null> {
  const { data } = await supabase
    .from("marketing_campaign")
    .select("*")
    .eq("course_id", courseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? campaignFromRow(data) : null;
}

export async function loadLandingPage(supabase: DB, id: string): Promise<LandingPage | null> {
  const { data } = await supabase.from("landing_page").select("*").eq("id", id).maybeSingle();
  return data ? landingPageFromRow(data) : null;
}

export async function loadLandingPageBySlug(supabase: DB, slug: string): Promise<LandingPage | null> {
  const { data } = await supabase.from("landing_page").select("*").eq("slug", slug).maybeSingle();
  return data ? landingPageFromRow(data) : null;
}

export async function listLandingPages(supabase: DB, campaignId: string): Promise<LandingPage[]> {
  const { data } = await supabase
    .from("landing_page")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  return (data ?? []).map(landingPageFromRow);
}

/**
 * Assemble the grounding context the generators read: the course row + its plan
 * jsonb (outcomes/prerequisites/teaching style) + per-module lesson counts.
 */
export async function loadCourseMarketingContext(
  supabase: DB,
  courseId: string
): Promise<CourseMarketingContext | null> {
  const { data: course } = await supabase
    .from("courses")
    .select("id,title,description,audience,level,price_cents,plan")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) return null;

  const { data: modules } = await supabase
    .from("modules")
    .select("id,title,order")
    .eq("course_id", courseId)
    .order("order", { ascending: true });
  const { data: lessons } = await supabase
    .from("lessons")
    .select("id,module_id")
    .eq("course_id", courseId);

  const lessonCounts = new Map<string, number>();
  for (const l of lessons ?? []) {
    lessonCounts.set(l.module_id, (lessonCounts.get(l.module_id) ?? 0) + 1);
  }

  const plan = (course.plan as Record<string, unknown> | null) ?? {};
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    courseId: course.id,
    title: course.title,
    description: course.description,
    audience: course.audience,
    level: course.level,
    priceCents: course.price_cents,
    outcomes: asStrings(plan.outcomes),
    prerequisites: asStrings(plan.prerequisites),
    teachingStyle: typeof plan.teachingStyle === "string" ? plan.teachingStyle : null,
    modules: (modules ?? []).map((m) => ({
      title: m.title,
      lessonCount: lessonCounts.get(m.id) ?? 0,
    })),
  };
}

/** Serialize sections for a jsonb column write. */
export function sectionsToJson(sections: LandingSection[]): Json {
  return sections as unknown as Json;
}

/* ───────────────────────── email sequences ───────────────────────────── */

export function touchFromRow(row: TouchRow): EmailTouch {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    courseId: row.course_id,
    position: row.position,
    delaySeconds: row.delay_seconds,
    triggerEvent: (row.trigger_event as AnalyticsEventType | null) ?? null,
    subject: row.subject,
    previewText: row.preview_text,
    body: ((row.body as unknown) as EmailBody) ?? { blocks: [] },
  };
}

export function sequenceFromRows(seq: SequenceRow, touches: TouchRow[]): EmailSequence {
  return {
    id: seq.id,
    campaignId: seq.campaign_id,
    courseId: seq.course_id,
    name: seq.name,
    kind: seq.kind as SequenceKind,
    trigger: (seq.trigger as EmailSequence["trigger"]) ?? {},
    status: seq.status as SequenceStatus,
    touches: touches
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(touchFromRow),
  };
}

export async function loadEmailSequence(supabase: DB, id: string): Promise<EmailSequence | null> {
  const { data: seq } = await supabase.from("email_sequence").select("*").eq("id", id).maybeSingle();
  if (!seq) return null;
  const { data: touches } = await supabase
    .from("email_touch")
    .select("*")
    .eq("sequence_id", id)
    .order("position", { ascending: true });
  return sequenceFromRows(seq, touches ?? []);
}

export async function listEmailSequences(supabase: DB, campaignId: string): Promise<EmailSequence[]> {
  const { data: seqs } = await supabase
    .from("email_sequence")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  if (!seqs || seqs.length === 0) return [];
  const { data: touches } = await supabase
    .from("email_touch")
    .select("*")
    .in(
      "sequence_id",
      seqs.map((s) => s.id)
    );
  const bySeq = new Map<string, TouchRow[]>();
  for (const t of touches ?? []) {
    const arr = bySeq.get(t.sequence_id) ?? [];
    arr.push(t);
    bySeq.set(t.sequence_id, arr);
  }
  return seqs.map((s) => sequenceFromRows(s, bySeq.get(s.id) ?? []));
}

export function bodyToJson(body: EmailBody): Json {
  return body as unknown as Json;
}

export function themeToJson(theme: LandingTheme): Json {
  return theme as unknown as Json;
}

/* ─────────────────── account tier (creator-level) ────────────────────── */

/** Resolve which course a per-course marketing view operates on: the preferred
 *  id when the author owns it, else their most-recently-updated course. */
export async function selectCourseForAuthor(
  supabase: DB,
  authorId: string,
  preferId?: string | null
): Promise<{ id: string; title: string } | null> {
  if (preferId) {
    const { data } = await supabase
      .from("courses")
      .select("id,title")
      .eq("id", preferId)
      .eq("author_id", authorId)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase
    .from("courses")
    .select("id,title")
    .eq("author_id", authorId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function listAuthorCourses(supabase: DB, authorId: string): Promise<{ id: string; title: string }[]> {
  const { data } = await supabase
    .from("courses")
    .select("id,title")
    .eq("author_id", authorId)
    .order("updated_at", { ascending: false });
  return data ?? [];
}

export interface ContactRow {
  id: string;
  email: string;
  name: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
}

/** The creator's master mailing list (one row per person, across all courses). */
export async function loadAudienceContacts(
  supabase: DB,
  authorId: string,
  limit = 200
): Promise<ContactRow[]> {
  const { data } = await supabase
    .from("audience_contact")
    .select("id,email,name,unsubscribed_at,created_at")
    .eq("author_id", authorId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((c) => ({
    id: c.id,
    email: c.email,
    name: c.name,
    unsubscribedAt: c.unsubscribed_at,
    createdAt: c.created_at,
  }));
}

export async function countAudienceContacts(supabase: DB, authorId: string): Promise<number> {
  const { count } = await supabase
    .from("audience_contact")
    .select("id", { count: "exact", head: true })
    .eq("author_id", authorId);
  return count ?? 0;
}

/* ───────────────── email sequences overview (the Email card) ──────────── */

export interface TouchOverview {
  id: string;
  position: number;
  delaySeconds: number | null;
  triggerEvent: AnalyticsEventType | null;
  subject: string;
  previewText: string | null;
  /** How many subscribers have been sent / are queued for this touch. */
  sent: number;
  queued: number;
}

export interface SequenceOverview {
  id: string;
  name: string;
  kind: SequenceKind;
  status: SequenceStatus;
  enrolledCount: number;
  touches: TouchOverview[];
}

/** Every sequence for a campaign with its touches + per-touch send counts —
 *  the "what's scheduled + who's on which email" view. */
export async function loadSequencesOverview(supabase: DB, campaignId: string): Promise<SequenceOverview[]> {
  const sequences = await listEmailSequences(supabase, campaignId);
  if (sequences.length === 0) return [];
  const seqIds = sequences.map((s) => s.id);

  const { data: sends } = await supabase
    .from("scheduled_send")
    .select("touch_id,status")
    .in("sequence_id", seqIds);
  const sentByTouch = new Map<string, number>();
  const queuedByTouch = new Map<string, number>();
  for (const s of sends ?? []) {
    if (!s.touch_id) continue;
    if (s.status === "sent") sentByTouch.set(s.touch_id, (sentByTouch.get(s.touch_id) ?? 0) + 1);
    else if (s.status === "pending" || s.status === "awaiting_approval" || s.status === "approved")
      queuedByTouch.set(s.touch_id, (queuedByTouch.get(s.touch_id) ?? 0) + 1);
  }

  const { data: enr } = await supabase
    .from("sequence_enrollment")
    .select("sequence_id")
    .in("sequence_id", seqIds);
  const enrolledBySeq = new Map<string, number>();
  for (const e of enr ?? []) enrolledBySeq.set(e.sequence_id, (enrolledBySeq.get(e.sequence_id) ?? 0) + 1);

  return sequences.map((seq) => ({
    id: seq.id,
    name: seq.name,
    kind: seq.kind,
    status: seq.status,
    enrolledCount: enrolledBySeq.get(seq.id) ?? 0,
    touches: seq.touches.map((t) => ({
      id: t.id,
      position: t.position,
      delaySeconds: t.delaySeconds,
      triggerEvent: t.triggerEvent,
      subject: t.subject,
      previewText: t.previewText,
      sent: sentByTouch.get(t.id) ?? 0,
      queued: queuedByTouch.get(t.id) ?? 0,
    })),
  }));
}

export interface SequenceRecipient {
  email: string;
  name: string | null;
  status: string;
  currentPosition: number;
  enrollmentStatus: string;
}

/** Who's enrolled in a sequence and which touch they're up to. */
export async function loadSequenceRecipients(supabase: DB, sequenceId: string): Promise<SequenceRecipient[]> {
  const { data } = await supabase
    .from("sequence_enrollment")
    .select("status,current_position,subscriber(email,name,status)")
    .eq("sequence_id", sequenceId)
    .order("started_at", { ascending: true });
  return (data ?? []).map((e) => {
    const sub = e.subscriber as { email?: string; name?: string | null; status?: string } | null;
    return {
      email: sub?.email ?? "—",
      name: sub?.name ?? null,
      status: sub?.status ?? "lead",
      currentPosition: e.current_position,
      enrollmentStatus: e.status,
    };
  });
}

/* ───────────────────── audience (funnel-legibility view) ─────────────── */

export interface AudienceEntry {
  id: string;
  email: string;
  name: string | null;
  status: string;
  enrollments: { sequence: string; status: string; position: number }[];
  pending: { subject: string; scheduledFor: string }[];
}

/** Per-subscriber funnel position for a course: lifecycle status + active
 *  sequence enrollments + the next pending sends. Read-only; powers the
 *  audience view so the funnel is legible without real email. */
export async function loadAudience(supabase: DB, courseId: string): Promise<AudienceEntry[]> {
  const { data: subs } = await supabase
    .from("subscriber")
    .select("id,email,name,status")
    .eq("course_id", courseId)
    .order("created_at", { ascending: true });
  if (!subs || subs.length === 0) return [];

  const { data: enr } = await supabase
    .from("sequence_enrollment")
    .select("subscriber_id,status,current_position,email_sequence(name)")
    .eq("course_id", courseId);
  const { data: sends } = await supabase
    .from("scheduled_send")
    .select("subscriber_id,scheduled_for,email_touch(subject)")
    .eq("course_id", courseId)
    .eq("status", "pending")
    .order("scheduled_for", { ascending: true });

  const enrBySub = new Map<string, AudienceEntry["enrollments"]>();
  for (const e of enr ?? []) {
    const seq = (e.email_sequence as { name?: string } | null)?.name ?? "sequence";
    const arr = enrBySub.get(e.subscriber_id) ?? [];
    arr.push({ sequence: seq, status: e.status, position: e.current_position });
    enrBySub.set(e.subscriber_id, arr);
  }
  const pendBySub = new Map<string, AudienceEntry["pending"]>();
  for (const s of sends ?? []) {
    const subject = (s.email_touch as { subject?: string } | null)?.subject ?? "(broadcast)";
    const arr = pendBySub.get(s.subscriber_id) ?? [];
    arr.push({ subject, scheduledFor: s.scheduled_for });
    pendBySub.set(s.subscriber_id, arr);
  }

  return subs.map((s) => ({
    id: s.id,
    email: s.email,
    name: s.name,
    status: s.status,
    enrollments: enrBySub.get(s.id) ?? [],
    pending: pendBySub.get(s.id) ?? [],
  }));
}
