/**
 * Public ingest — the controlled write path for ANONYMOUS landing-page visitors.
 *
 * Runs server-side with the service-role client (so it can write past RLS), but
 * is deliberately the ONLY thing that does. Each function:
 *   1. resolves the target landing page by slug and REQUIRES it be `published`
 *      (anti-abuse: you can only write against a real, live page);
 *   2. writes into the SINGLE event stream (`analytics_event`) and, for a lead,
 *      idempotently upserts the `subscriber` (the state machine's initial row).
 *
 * The subscriber's lifecycle status is a reducer over the event stream — here we
 * just create the `lead` row + emit the `form_submit`/`page_view` events; Phase 2
 * hardens dedup/anonymous-id linking and Phase 3 advances status on engagement.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_NAME = 120;

export interface IngestResolved {
  landingPageId: string;
  courseId: string;
  campaignId: string;
  authorId: string | null;
}

/** Resolve a PUBLISHED landing page by slug (the gate for every public write). */
async function resolvePublished(admin: DB, slug: string): Promise<IngestResolved | null> {
  const { data } = await admin
    .from("landing_page")
    .select("id,course_id,campaign_id,status")
    .eq("slug", slug)
    .maybeSingle();
  if (!data || data.status !== "published") return null;
  const { data: course } = await admin
    .from("courses")
    .select("author_id")
    .eq("id", data.course_id)
    .maybeSingle();
  return {
    landingPageId: data.id,
    courseId: data.course_id,
    campaignId: data.campaign_id,
    authorId: course?.author_id ?? null,
  };
}

/** Upsert the creator's account-level contact (the master mailing list) and
 *  return its id. Re-opt-in clears a prior global unsubscribe. Best-effort. */
async function linkContact(
  admin: DB,
  authorId: string | null,
  email: string,
  name: string | null
): Promise<string | null> {
  if (!authorId) return null;
  const { data: existing } = await admin
    .from("audience_contact")
    .select("id,name")
    .eq("author_id", authorId)
    .eq("email", email)
    .maybeSingle();
  if (existing) {
    const patch: Database["public"]["Tables"]["audience_contact"]["Update"] = { unsubscribed_at: null };
    if (!existing.name && name) patch.name = name;
    await admin.from("audience_contact").update(patch).eq("id", existing.id);
    return existing.id;
  }
  const { data: created } = await admin
    .from("audience_contact")
    .insert({ author_id: authorId, email, name })
    .select("id")
    .single();
  return created?.id ?? null;
}

export interface PageViewInput {
  slug: string;
  anonymousId?: string | null;
  referrer?: string | null;
}

export async function recordPageView(
  admin: DB,
  input: PageViewInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = await resolvePublished(admin, input.slug);
  if (!target) return { ok: false, error: "Page not found or not published" };

  const { error } = await admin.from("analytics_event").insert({
    course_id: target.courseId,
    campaign_id: target.campaignId,
    landing_page_id: target.landingPageId,
    anonymous_id: input.anonymousId ?? null,
    type: "page_view",
    source: "landing_page",
    props: { referrer: input.referrer ?? null },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export interface LeadInput {
  slug: string;
  email: string;
  name?: string | null;
  anonymousId?: string | null;
  /** The free-lesson capture variant (also emits a `free_lesson_capture` event). */
  freeLesson?: boolean;
  consentText?: string | null;
}

export interface LeadResult {
  subscriberId: string;
  created: boolean;
}

export async function captureLead(
  admin: DB,
  input: LeadInput
): Promise<{ ok: true; result: LeadResult } | { ok: false; error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Invalid email" };
  }
  const name = input.name?.trim().slice(0, MAX_NAME) || null;

  const target = await resolvePublished(admin, input.slug);
  if (!target) return { ok: false, error: "Page not found or not published" };

  // Link the account-level contact (master list) first so it can be stamped on
  // the per-course subscriber + events.
  const contactId = await linkContact(admin, target.authorId, email, name);

  // Idempotent subscriber upsert by (campaign_id, email).
  const { data: existing } = await admin
    .from("subscriber")
    .select("id")
    .eq("campaign_id", target.campaignId)
    .eq("email", email)
    .maybeSingle();

  let subscriberId: string;
  let created = false;
  if (existing) {
    subscriberId = existing.id;
    if (contactId) await admin.from("subscriber").update({ contact_id: contactId }).eq("id", subscriberId);
  } else {
    const { data: inserted, error: insErr } = await admin
      .from("subscriber")
      .insert({
        campaign_id: target.campaignId,
        course_id: target.courseId,
        contact_id: contactId,
        email,
        name,
        status: "lead",
        source: input.freeLesson ? "free_lesson" : "landing_form",
        anonymous_id: input.anonymousId ?? null,
        consent: {
          agreedAt: new Date().toISOString(),
          source: input.freeLesson ? "free_lesson_capture" : "landing_form",
          text: input.consentText ?? null,
        },
      })
      .select("id")
      .single();
    if (insErr || !inserted) return { ok: false, error: insErr?.message ?? "insert failed" };
    subscriberId = inserted.id;
    created = true;
  }

  // Emit into the single event stream (form_submit, + free_lesson_capture).
  const events: Database["public"]["Tables"]["analytics_event"]["Insert"][] = [
    {
      course_id: target.courseId,
      campaign_id: target.campaignId,
      landing_page_id: target.landingPageId,
      subscriber_id: subscriberId,
      contact_id: contactId,
      anonymous_id: input.anonymousId ?? null,
      type: "form_submit",
      source: input.freeLesson ? "free_lesson" : "landing_form",
      props: { email },
    },
  ];
  if (input.freeLesson) {
    events.push({
      course_id: target.courseId,
      campaign_id: target.campaignId,
      landing_page_id: target.landingPageId,
      subscriber_id: subscriberId,
      contact_id: contactId,
      anonymous_id: input.anonymousId ?? null,
      type: "free_lesson_capture",
      source: "free_lesson",
      props: {},
    });
  }
  const { error: evErr } = await admin.from("analytics_event").insert(events);
  if (evErr) return { ok: false, error: evErr.message };

  return { ok: true, result: { subscriberId, created } };
}

/**
 * GLOBAL unsubscribe: flag the contact + suppress EVERY per-course subscriber
 * linked to it (CAN-SPAM/GDPR-safe — out once, out everywhere). Shared by the
 * unsubscribe route and tests.
 */
export async function globalUnsubscribe(
  admin: DB,
  subscriberId: string
): Promise<{ ok: boolean }> {
  const { data: sub } = await admin
    .from("subscriber")
    .select("id,course_id,campaign_id,contact_id")
    .eq("id", subscriberId)
    .maybeSingle();
  if (!sub) return { ok: false };

  const now = new Date().toISOString();
  if (sub.contact_id) {
    await admin.from("audience_contact").update({ unsubscribed_at: now }).eq("id", sub.contact_id);
    await admin
      .from("subscriber")
      .update({ status: "unsubscribed", unsubscribed_at: now })
      .eq("contact_id", sub.contact_id)
      .neq("status", "unsubscribed");
  } else {
    await admin.from("subscriber").update({ status: "unsubscribed", unsubscribed_at: now }).eq("id", sub.id);
  }
  await admin.from("analytics_event").insert({
    course_id: sub.course_id,
    campaign_id: sub.campaign_id,
    subscriber_id: sub.id,
    contact_id: sub.contact_id,
    type: "email_unsubscribe",
    source: "unsubscribe_link",
  });
  return { ok: true };
}
