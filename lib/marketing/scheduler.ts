/**
 * The sequence/followup ENGINE — our state machine on our scheduler. Resend (or
 * the mock) only moves bytes; timing, enrollment, idempotency, and the lifecycle
 * are ours.
 *
 *   enrollSubscriber      → sequence_enrollment + the first due scheduled_send
 *   runSchedulerTick      → claim due sends, deliver, emit events, advance the
 *                           enrollment to the next touch (or complete it)
 *   processEventTrigger   → enroll a subscriber when a behavioral event matches
 *                           an active event_triggered sequence
 *   sendBroadcast         → one-off send to a segment (inline, not the outbox)
 *
 * Idempotency: the unique (touch_id, subscriber_id) on scheduled_send means a
 * subscriber is never sent the same touch twice, however often the tick runs.
 * Suppressed subscribers (unsubscribed/bounced) are skipped and their enrollment
 * is cancelled. Single-process MVP (no row-locking) — fine at current scale.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { renderEmailText } from "./email/render";
import { loadEmailSequence } from "./persistence";
import type { MarketingServices } from "./services/types";
import { applyEventToSubscriber, isSuppressed } from "./stateMachine";
import type { AnalyticsEventType, EmailBody, EmailSequence, SubscriberStatus } from "./types";

type DB = SupabaseClient<Database>;
type SubscriberLite = { id: string; email: string; status: SubscriberStatus; campaign_id: string };

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "";
}
function unsubscribeUrl(subscriberId: string): string {
  return `${siteUrl()}/api/marketing/unsubscribe?sid=${subscriberId}`;
}

async function loadSubscriber(supabase: DB, id: string): Promise<SubscriberLite | null> {
  const { data } = await supabase
    .from("subscriber")
    .select("id,email,status,campaign_id")
    .eq("id", id)
    .maybeSingle();
  return data ? { id: data.id, email: data.email, status: data.status as SubscriberStatus, campaign_id: data.campaign_id } : null;
}

async function emitEvent(
  supabase: DB,
  args: {
    courseId: string;
    campaignId: string;
    subscriberId: string;
    type: AnalyticsEventType;
    source: string;
    props?: Record<string, unknown>;
  }
): Promise<void> {
  await supabase.from("analytics_event").insert({
    course_id: args.courseId,
    campaign_id: args.campaignId,
    subscriber_id: args.subscriberId,
    type: args.type,
    source: args.source,
    props: (args.props ?? {}) as Json,
  });
}

/**
 * Deliver one email through the provider + record the send-result events into
 * the single stream + advance the subscriber's lifecycle. Shared by the
 * sequence tick and broadcasts.
 */
async function deliver(
  supabase: DB,
  services: MarketingServices,
  args: {
    sub: SubscriberLite;
    courseId: string;
    subject: string;
    body: EmailBody;
    sequenceId: string | null;
    touchId: string | null;
  }
): Promise<{ providerMessageId: string }> {
  const text = renderEmailText(args.body, { unsubscribeUrl: unsubscribeUrl(args.sub.id) });
  const result = await services.email.send({
    to: args.sub.email,
    subject: args.subject,
    body: args.body,
    text,
    unsubscribeUrl: unsubscribeUrl(args.sub.id),
    meta: { sequenceId: args.sequenceId, touchId: args.touchId, subscriberId: args.sub.id },
  });

  const source = args.sequenceId ? "sequence" : "broadcast";
  await emitEvent(supabase, {
    courseId: args.courseId,
    campaignId: args.sub.campaign_id,
    subscriberId: args.sub.id,
    type: "email_sent",
    source,
    props: { providerMessageId: result.providerMessageId, sequenceId: args.sequenceId, touchId: args.touchId },
  });
  await applyEventToSubscriber(supabase, args.sub.id, "email_sent");

  // Mock providers return deterministic simulated engagement so the funnel +
  // observe step have data; real providers return undefined (webhooks later).
  const sim = result.simulatedEngagement;
  if (sim?.opened) {
    await emitEvent(supabase, { courseId: args.courseId, campaignId: args.sub.campaign_id, subscriberId: args.sub.id, type: "email_open", source });
    await applyEventToSubscriber(supabase, args.sub.id, "email_open");
  }
  if (sim?.clicked) {
    await emitEvent(supabase, { courseId: args.courseId, campaignId: args.sub.campaign_id, subscriberId: args.sub.id, type: "email_click", source });
    await applyEventToSubscriber(supabase, args.sub.id, "email_click");
  }
  return { providerMessageId: result.providerMessageId };
}

async function scheduleSend(
  supabase: DB,
  args: { courseId: string; sequenceId: string; touchId: string; subscriberId: string; whenMs: number }
): Promise<void> {
  await supabase.from("scheduled_send").upsert(
    {
      course_id: args.courseId,
      sequence_id: args.sequenceId,
      touch_id: args.touchId,
      subscriber_id: args.subscriberId,
      scheduled_for: new Date(args.whenMs).toISOString(),
      status: "pending",
    },
    { onConflict: "touch_id,subscriber_id", ignoreDuplicates: true }
  );
}

/** Enroll a subscriber into a sequence + schedule the first touch. Idempotent. */
export async function enrollSubscriber(
  supabase: DB,
  sequence: EmailSequence,
  subscriberId: string,
  opts: { nowMs: number }
): Promise<{ enrolled: boolean }> {
  const first = sequence.touches.find((t) => t.position === 0) ?? sequence.touches[0];
  if (!first) return { enrolled: false };

  await supabase.from("sequence_enrollment").upsert(
    {
      sequence_id: sequence.id,
      subscriber_id: subscriberId,
      course_id: sequence.courseId,
      status: "active",
      current_position: 0,
      started_at: new Date(opts.nowMs).toISOString(),
    },
    { onConflict: "sequence_id,subscriber_id", ignoreDuplicates: true }
  );

  await scheduleSend(supabase, {
    courseId: sequence.courseId,
    sequenceId: sequence.id,
    touchId: first.id,
    subscriberId,
    whenMs: opts.nowMs + (first.delaySeconds ?? 0) * 1000,
  });
  return { enrolled: true };
}

export async function enrollSegment(
  supabase: DB,
  sequence: EmailSequence,
  subscriberIds: string[],
  opts: { nowMs: number }
): Promise<{ enrolled: number }> {
  let enrolled = 0;
  for (const id of subscriberIds) {
    const r = await enrollSubscriber(supabase, sequence, id, opts);
    if (r.enrolled) enrolled++;
  }
  return { enrolled };
}

async function cancelEnrollment(supabase: DB, sequenceId: string, subscriberId: string): Promise<void> {
  await supabase
    .from("sequence_enrollment")
    .update({ status: "cancelled" })
    .eq("sequence_id", sequenceId)
    .eq("subscriber_id", subscriberId);
  await supabase
    .from("scheduled_send")
    .update({ status: "cancelled" })
    .eq("sequence_id", sequenceId)
    .eq("subscriber_id", subscriberId)
    .eq("status", "pending");
}

/** Process the claimable due sends. Returns counts. */
export async function runSchedulerTick(
  supabase: DB,
  services: MarketingServices,
  opts: { courseId?: string; nowMs?: number; limit?: number } = {}
): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const nowMs = opts.nowMs ?? services.clock.epochMs();
  const nowIso = new Date(nowMs).toISOString();
  let q = supabase
    .from("scheduled_send")
    .select("*")
    .eq("status", "pending")
    .not("touch_id", "is", null)
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.courseId) q = q.eq("course_id", opts.courseId);
  const { data: due } = await q;

  let sent = 0,
    skipped = 0,
    failed = 0;
  for (const s of due ?? []) {
    const seq = s.sequence_id ? await loadEmailSequence(supabase, s.sequence_id) : null;
    const touch = seq?.touches.find((t) => t.id === s.touch_id);
    const sub = await loadSubscriber(supabase, s.subscriber_id);
    if (!seq || !touch || !sub) {
      await supabase.from("scheduled_send").update({ status: "failed", error: "missing touch/subscriber" }).eq("id", s.id);
      failed++;
      continue;
    }
    if (isSuppressed(sub.status)) {
      await supabase.from("scheduled_send").update({ status: "skipped" }).eq("id", s.id);
      await cancelEnrollment(supabase, seq.id, sub.id);
      skipped++;
      continue;
    }

    const { providerMessageId } = await deliver(supabase, services, {
      sub,
      courseId: seq.courseId,
      subject: touch.subject,
      body: touch.body,
      sequenceId: seq.id,
      touchId: touch.id,
    });
    await supabase
      .from("scheduled_send")
      .update({ status: "sent", provider_message_id: providerMessageId, sent_at: nowIso, attempts: s.attempts + 1 })
      .eq("id", s.id);
    sent++;

    // advance the enrollment to the next touch (or complete it)
    const { data: enr } = await supabase
      .from("sequence_enrollment")
      .select("id,started_at")
      .eq("sequence_id", seq.id)
      .eq("subscriber_id", sub.id)
      .maybeSingle();
    const nextPos = touch.position + 1;
    const next = seq.touches.find((t) => t.position === nextPos);
    if (enr && next) {
      const startMs = new Date(enr.started_at).getTime();
      await scheduleSend(supabase, {
        courseId: seq.courseId,
        sequenceId: seq.id,
        touchId: next.id,
        subscriberId: sub.id,
        whenMs: startMs + (next.delaySeconds ?? 0) * 1000,
      });
      await supabase.from("sequence_enrollment").update({ current_position: nextPos }).eq("id", enr.id);
    } else if (enr) {
      await supabase
        .from("sequence_enrollment")
        .update({ status: "completed", completed_at: nowIso, current_position: nextPos })
        .eq("id", enr.id);
    }
  }
  return { processed: (due ?? []).length, sent, skipped, failed };
}

/** Enroll a subscriber into any ACTIVE event-triggered sequence whose trigger
 *  matches the event that just fired. */
export async function processEventTrigger(
  supabase: DB,
  args: { courseId: string; subscriberId: string; eventType: AnalyticsEventType; nowMs: number }
): Promise<{ enrolled: number }> {
  const { data: seqs } = await supabase
    .from("email_sequence")
    .select("id")
    .eq("course_id", args.courseId)
    .eq("kind", "event_triggered")
    .eq("status", "active");
  let enrolled = 0;
  for (const row of seqs ?? []) {
    const seq = await loadEmailSequence(supabase, row.id);
    if (!seq || seq.trigger.event !== args.eventType) continue;
    const r = await enrollSubscriber(supabase, seq, args.subscriberId, { nowMs: args.nowMs });
    if (r.enrolled) enrolled++;
  }
  return { enrolled };
}

/** One-off broadcast to an explicit set of subscribers (processed inline). */
export async function sendBroadcast(
  supabase: DB,
  services: MarketingServices,
  args: {
    courseId: string;
    subscriberIds: string[];
    subject: string;
    body: EmailBody;
    nowMs: number;
  }
): Promise<{ sent: number; skipped: number }> {
  let sent = 0,
    skipped = 0;
  const nowIso = new Date(args.nowMs).toISOString();
  for (const id of args.subscriberIds) {
    const sub = await loadSubscriber(supabase, id);
    if (!sub || isSuppressed(sub.status)) {
      skipped++;
      continue;
    }
    const { data: row } = await supabase
      .from("scheduled_send")
      .insert({
        course_id: args.courseId,
        subscriber_id: id,
        scheduled_for: nowIso,
        status: "pending",
      })
      .select("id")
      .single();
    const { providerMessageId } = await deliver(supabase, services, {
      sub,
      courseId: args.courseId,
      subject: args.subject,
      body: args.body,
      sequenceId: null,
      touchId: null,
    });
    if (row) {
      await supabase
        .from("scheduled_send")
        .update({ status: "sent", provider_message_id: providerMessageId, sent_at: nowIso })
        .eq("id", row.id);
    }
    sent++;
  }
  return { sent, skipped };
}
