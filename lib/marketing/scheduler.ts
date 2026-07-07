/**
 * The sequence/followup ENGINE — our state machine on our scheduler. Resend (or
 * the mock) only moves bytes; timing, enrollment, idempotency, bounce handling,
 * attribution, and the lifecycle are ours.
 *
 *   enrollSubscriber      → sequence_enrollment + the first due scheduled_send
 *   runSchedulerTick      → claim due sends (respecting sequence status, the
 *                           send window, and the per-creator ramp cap), deliver,
 *                           emit events, advance the enrollment, evaluate
 *                           guardrails
 *   processEventTrigger   → enroll a subscriber when a behavioral event matches
 *                           an active event_triggered sequence
 *   sendBroadcast         → one-off send to a segment (inline, not the outbox)
 *
 * Idempotency: the unique (touch_id, subscriber_id) on scheduled_send means a
 * subscriber is never sent the same touch twice, however often the tick runs.
 * Suppressed subscribers (unsubscribed/bounced) are skipped and their enrollment
 * is cancelled. A PAUSED sequence is never processed (Amendment fix — the
 * original tick had no sequence-status check, so pause didn't actually stop
 * sends). Single-process MVP (no row-locking) — fine at current scale.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { autoPauseCampaign, evaluateCampaignGuardrails, getAuthorSendRamp } from "./guardrails";
import { renderEmailText } from "./email/render";
import { resolveCopyLocale } from "./language";
import { resolveCtaDestinations, resolveSendTimeButtonHref, type CtaDestinations } from "./ctaDestination";
import { renderMergeVars, type MergeVarContext } from "./mergeVars";
import { loadCampaign, loadCourseMarketingContext, loadEmailSequence, loadSenderIdentity } from "./persistence";
import type { MarketingServices } from "./services/types";
import { applyEventToSubscriber, isSuppressed } from "./stateMachine";
import { clickUrl, unsubscribeUrl } from "./tokens";
import { DEFAULT_SEND_WINDOW } from "./types";
import type { AnalyticsEventType, EmailBlock, EmailBody, EmailSequence, SendWindow, SenderIdentity, SubscriberStatus } from "./types";

type DB = SupabaseClient<Database>;
type SubscriberLite = { id: string; email: string; name: string | null; status: SubscriberStatus; campaign_id: string | null };

const SOFT_BOUNCE_MAX_RETRIES = 3;
const SOFT_BOUNCE_BACKOFF_MIN = [30, 120, 480]; // 30m, 2h, 8h

async function loadSubscriber(supabase: DB, id: string): Promise<SubscriberLite | null> {
  const { data } = await supabase
    .from("subscriber")
    .select("id,email,name,status,campaign_id")
    .eq("id", id)
    .maybeSingle();
  // campaign_id became NULLABLE with course-level contacts (migration
  // 20260702120000; the live DB already has it) — a subscriber without a
  // campaign can't ride the campaign scheduler, so treat it like a missing
  // subscriber rather than faking an id into analytics. Keep `name` for the
  // firstName merge-var personalization used downstream.
  if (!data || !data.campaign_id) return null;
  return { id: data.id, email: data.email, name: data.name, status: data.status as SubscriberStatus, campaign_id: data.campaign_id };
}

async function emitEvent(
  supabase: DB,
  args: {
    courseId: string;
    campaignId: string | null;
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

/** Wrap every CTA button href in a signed, attributed click-redirect link and
 *  render merge variables (Amendments 3b + 5) — the ONE place a body becomes
 *  send-ready, shared by the sequence tick and broadcasts. */
function prepareBodyForSend(
  body: EmailBody,
  vars: MergeVarContext,
  dims: { subscriberId: string; campaignId?: string; touchId?: string; courseId: string }
): EmailBody {
  const blocks: EmailBlock[] = body.blocks.map((b) => {
    if (b.kind === "button") {
      // Send-time destination wins over the generation-time baked href — a
      // "#" placeholder or a pre-publish landing path upgrades to the live
      // course preview here, never reaching an inbox (resolveSendTimeButtonHref).
      return { ...b, label: renderMergeVars(b.label, vars), href: clickUrl(resolveSendTimeButtonHref(b.href, vars), dims) };
    }
    if (b.kind === "heading" || b.kind === "paragraph") return { ...b, text: renderMergeVars(b.text, vars) };
    if (b.kind === "bullets") return { ...b, items: b.items.map((i) => renderMergeVars(i, vars)) };
    return b;
  });
  return { blocks };
}

export interface RenderSendableEmailArgs {
  subject: string;
  body: EmailBody;
  vars: MergeVarContext;
  dims: { subscriberId: string; campaignId?: string; touchId?: string; courseId: string };
  unsubscribeUrl: string;
  locale?: string;
  senderName?: string | null;
  mailingAddress?: string | null;
}

/**
 * The ONE render pipeline every outgoing email goes through — merge vars,
 * click-wrapped links, and the localized compliant footer (sender + reason +
 * mailing address + unsubscribe). Pure; no DB writes. Shared by the scheduler's
 * `deliver()`, broadcasts, AND `send_test_email` (Amendment: a test send must
 * match a real send byte-for-byte, not a thinner bespoke path).
 */
export function renderSendableEmail(args: RenderSendableEmailArgs): { subject: string; body: EmailBody; text: string } {
  const preparedBody = prepareBodyForSend(args.body, args.vars, args.dims);
  const subject = renderMergeVars(args.subject, args.vars);
  const text = renderEmailText(preparedBody, {
    unsubscribeUrl: args.unsubscribeUrl,
    locale: args.locale,
    senderName: args.senderName,
    mailingAddress: args.mailingAddress,
  });
  return { subject, body: preparedBody, text };
}

interface DeliverArgs {
  sub: SubscriberLite;
  courseId: string;
  campaignId: string | null;
  subject: string;
  body: EmailBody;
  sequenceId: string | null;
  touchId: string | null;
  mergeVars?: MergeVarContext;
  /** Compliance footer + copy locale (Amendments 9 + 14). */
  locale?: string;
  senderName?: string | null;
  mailingAddress?: string | null;
  /** Reply-To for the provider send (the sender identity's address). */
  replyTo?: string | null;
}

interface DeliverOutcome {
  status: "sent" | "hard_bounce" | "soft_bounce";
  providerMessageId?: string;
}

/**
 * Deliver one email through the provider + record the send-result events into
 * the single stream + advance the subscriber's lifecycle. Shared by the
 * sequence tick and broadcasts. Classifies mock bounces (Amendment 8) — real
 * bounces arrive later via the Resend webhook, never synchronously here.
 */
async function deliver(supabase: DB, services: MarketingServices, args: DeliverArgs): Promise<DeliverOutcome> {
  const vars: MergeVarContext = args.mergeVars ?? { firstName: args.sub.name?.split(" ")[0] ?? null };
  const unsubUrl = unsubscribeUrl(args.sub.id);
  const { subject, body: preparedBody, text } = renderSendableEmail({
    subject: args.subject,
    body: args.body,
    vars,
    dims: { subscriberId: args.sub.id, campaignId: args.campaignId ?? undefined, touchId: args.touchId ?? undefined, courseId: args.courseId },
    unsubscribeUrl: unsubUrl,
    locale: args.locale,
    senderName: args.senderName,
    mailingAddress: args.mailingAddress,
  });

  const result = await services.email.send({
    to: args.sub.email,
    subject,
    body: preparedBody,
    text,
    unsubscribeUrl: unsubUrl,
    fromName: args.senderName ?? null,
    replyTo: args.replyTo ?? null,
    meta: { sequenceId: args.sequenceId, touchId: args.touchId, subscriberId: args.sub.id },
  });

  const source = args.sequenceId ? "sequence" : "broadcast";
  const campaignId = args.campaignId ?? args.sub.campaign_id;

  if (result.simulatedBounce) {
    await emitEvent(supabase, {
      courseId: args.courseId,
      campaignId,
      subscriberId: args.sub.id,
      type: "email_bounce",
      source,
      props: { bounceType: result.simulatedBounce.type, sequenceId: args.sequenceId, touchId: args.touchId },
    });
    if (result.simulatedBounce.type === "hard") {
      await applyEventToSubscriber(supabase, args.sub.id, "email_bounce");
      return { status: "hard_bounce" };
    }
    return { status: "soft_bounce" };
  }

  await emitEvent(supabase, {
    courseId: args.courseId,
    campaignId,
    subscriberId: args.sub.id,
    type: "email_sent",
    source,
    props: { providerMessageId: result.providerMessageId, sequenceId: args.sequenceId, touchId: args.touchId },
  });
  await applyEventToSubscriber(supabase, args.sub.id, "email_sent");

  // Mock providers report delivery synchronously (there's no webhook to wait
  // for); Resend's real delivered/open/click arrive later via webhook.
  if (services.email.mode === "mock") {
    await emitEvent(supabase, { courseId: args.courseId, campaignId, subscriberId: args.sub.id, type: "email_delivered", source });
  }

  const sim = result.simulatedEngagement;
  if (sim?.opened) {
    await emitEvent(supabase, { courseId: args.courseId, campaignId, subscriberId: args.sub.id, type: "email_open", source });
    await applyEventToSubscriber(supabase, args.sub.id, "email_open");
  }
  if (sim?.clicked) {
    await emitEvent(supabase, { courseId: args.courseId, campaignId, subscriberId: args.sub.id, type: "email_click", source, props: { touchId: args.touchId, attributed: true } });
    await applyEventToSubscriber(supabase, args.sub.id, "email_click");
  }
  return { status: "sent", providerMessageId: result.providerMessageId };
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

/* ─────────────────────── send window (Amendment 12) ─────────────────────── */

const DEFAULT_WINDOW: SendWindow = DEFAULT_SEND_WINDOW;

/** True if `nowMs` falls inside the send window, in the window's own timezone.
 *  A due-but-outside-window send simply isn't processed this tick — it stays
 *  `pending` and is picked up on a later tick once the window reopens
 *  (idempotency already guarantees no double-send from the delay). */
export function withinSendWindow(nowMs: number, window: SendWindow): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timezone || "UTC",
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  if (window.skipWeekends && (weekday === "Sat" || weekday === "Sun")) return false;
  return hour >= window.startHour && hour < window.endHour;
}

/** PURE: is the window open at `nowMs`, and if not, when does it next open?
 *  Steps 15-minute boundaries (correct for :30/:45-offset timezones) up to 14
 *  days; a degenerate window (start === end) returns nextOpenMs null. */
export function sendWindowState(
  nowMs: number,
  window: SendWindow
): { openNow: boolean; nextOpenMs: number | null } {
  if (withinSendWindow(nowMs, window)) return { openNow: true, nextOpenMs: null };
  const STEP = 15 * 60_000;
  const base = Math.floor(nowMs / STEP) * STEP;
  for (let i = 1; i <= 14 * 24 * 4; i++) {
    const t = base + i * STEP;
    if (withinSendWindow(t, window)) return { openNow: false, nextOpenMs: t };
  }
  return { openNow: false, nextOpenMs: null };
}

/** Human description of a send window, e.g. "09:00–11:00 UTC, weekdays". */
export function describeSendWindow(window: SendWindow): string {
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `${hh(window.startHour)}–${hh(window.endHour)} ${window.timezone || "UTC"}${window.skipWeekends ? ", weekdays" : ""}`;
}

/** The next opening formatted in the window's OWN timezone, e.g.
 *  "Fri, Jul 4, 09:00 (UTC)" — UIs that know the creator's locale should format
 *  the raw ms themselves instead. */
export function formatWindowOpening(ms: number, window: SendWindow): string {
  const tz = window.timezone || "UTC";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return `${text} (${tz})`;
}

/** ONE sentence for tool summaries: when queued emails will actually go out.
 *  This is what keeps the agent (and the creator) honest about delivery timing
 *  — enqueued ≠ sent. */
export function sendTimingSentence(nowMs: number, window: SendWindow): string {
  const state = sendWindowState(nowMs, window);
  if (state.openNow) return "The send window is open now — queued emails go out on the next delivery run.";
  return state.nextOpenMs !== null
    ? `Queued emails are HELD until the send window opens (${describeSendWindow(window)}); next opening ${formatWindowOpening(state.nextOpenMs, window)}.`
    : `Queued emails are HELD — the send window (${describeSendWindow(window)}) never opens; fix the campaign's sendWindow config.`;
}

/** Process the claimable due sends: gate on sequence status (paused sequences
 *  are skipped entirely), the send window, and the author's ramp cap. Returns
 *  counts, plus how many were held back by the window/ramp (informational —
 *  never dropped, always left `pending` for a later tick). */
export async function runSchedulerTick(
  supabase: DB,
  services: MarketingServices,
  opts: { courseId?: string; nowMs?: number; limit?: number } = {}
): Promise<{ processed: number; sent: number; skipped: number; failed: number; heldByWindow: number; heldByRamp: number }> {
  const nowMs = opts.nowMs ?? services.clock.epochMs();
  const nowIso = new Date(nowMs).toISOString();
  let q = supabase
    .from("scheduled_send")
    .select("*")
    .in("status", ["pending"])
    .not("touch_id", "is", null)
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.courseId) q = q.eq("course_id", opts.courseId);
  const { data: due } = await q;

  let sent = 0,
    skipped = 0,
    failed = 0,
    heldByWindow = 0,
    heldByRamp = 0;
  const authorRampCache = new Map<string, { remaining: number }>();
  // CTA destinations resolved once per (course, campaign) per tick — publishing
  // a course upgrades queued sends' {{ctaUrl}} without regenerating copy.
  const ctaDestCache = new Map<string, CtaDestinations>();
  const guardrailCheckedCampaigns = new Set<string>();

  for (const s of due ?? []) {
    const seq = s.sequence_id ? await loadEmailSequence(supabase, s.sequence_id) : null;
    const touch = seq?.touches.find((t) => t.id === s.touch_id);
    const sub = await loadSubscriber(supabase, s.subscriber_id);
    if (!seq || !touch || !sub) {
      await supabase.from("scheduled_send").update({ status: "failed", error: "missing touch/subscriber" }).eq("id", s.id);
      failed++;
      continue;
    }
    // Pause fix: a non-active sequence is never processed (was previously
    // ignored entirely, so "pause" didn't actually stop sends).
    if (seq.status !== "active") continue;
    if (isSuppressed(sub.status)) {
      await supabase.from("scheduled_send").update({ status: "skipped" }).eq("id", s.id);
      await cancelEnrollment(supabase, seq.id, sub.id);
      skipped++;
      continue;
    }

    const campaign = await loadCampaign(supabase, seq.campaignId);
    const window = (campaign?.config.sendWindow as SendWindow | undefined) ?? DEFAULT_WINDOW;
    if (!withinSendWindow(nowMs, window)) {
      heldByWindow++;
      continue;
    }

    const { data: courseRow } = await supabase.from("courses").select("author_id").eq("id", seq.courseId).maybeSingle();
    const authorId = courseRow?.author_id;
    if (authorId) {
      let ramp = authorRampCache.get(authorId);
      if (!ramp) {
        const r = await getAuthorSendRamp(supabase, authorId);
        ramp = { remaining: r.remaining };
        authorRampCache.set(authorId, ramp);
      }
      if (ramp.remaining <= 0) {
        heldByRamp++;
        continue;
      }
      ramp.remaining--;
    }

    const course = await loadCourseMarketingContext(supabase, seq.courseId);
    const sender = campaign?.senderIdentityId ? await loadSenderIdentity(supabase, campaign.senderIdentityId) : null;
    const destKey = `${seq.courseId}:${seq.campaignId ?? ""}`;
    let dest = ctaDestCache.get(destKey);
    if (!dest) {
      dest = await resolveCtaDestinations(supabase, { courseId: seq.courseId, campaignId: seq.campaignId });
      ctaDestCache.set(destKey, dest);
    }
    const mergeVars: MergeVarContext = {
      firstName: sub.name?.split(" ")[0] ?? null,
      courseName: course?.title ?? null,
      creatorName: sender?.fromName ?? null,
      freeLessonUrl: dest.freeLessonUrl,
      ctaUrl: dest.ctaUrl,
      offerDeadline: (campaign?.config.brief?.offerDeadlineIso as string | undefined) ?? null,
    };

    const outcome = await deliver(supabase, services, {
      sub,
      courseId: seq.courseId,
      campaignId: seq.campaignId,
      subject: touch.subject,
      body: touch.body,
      sequenceId: seq.id,
      touchId: touch.id,
      mergeVars,
      locale: course ? resolveCopyLocale(course, campaign?.config.brief) : "en",
      senderName: sender?.fromName ?? null,
      mailingAddress: sender?.mailingAddress ?? null,
      replyTo: sender?.replyTo ?? sender?.fromEmail ?? null,
    });

    if (outcome.status === "hard_bounce") {
      await supabase.from("scheduled_send").update({ status: "failed", bounce_type: "hard", error: "hard bounce" }).eq("id", s.id);
      await cancelEnrollment(supabase, seq.id, sub.id);
      failed++;
    } else if (outcome.status === "soft_bounce") {
      const nextCount = s.soft_bounce_count + 1;
      if (nextCount >= SOFT_BOUNCE_MAX_RETRIES) {
        // 3 consecutive soft bounces on distinct sends → treat as hard.
        await supabase
          .from("scheduled_send")
          .update({ status: "failed", bounce_type: "hard", soft_bounce_count: nextCount, error: "soft bounce escalated to hard after 3 retries" })
          .eq("id", s.id);
        await emitEvent(supabase, { courseId: seq.courseId, campaignId: seq.campaignId, subscriberId: sub.id, type: "email_bounce", source: "sequence", props: { bounceType: "hard", escalated: true } });
        await applyEventToSubscriber(supabase, sub.id, "email_bounce");
        await cancelEnrollment(supabase, seq.id, sub.id);
        failed++;
      } else {
        const backoffMs = SOFT_BOUNCE_BACKOFF_MIN[Math.min(nextCount - 1, SOFT_BOUNCE_BACKOFF_MIN.length - 1)] * 60000;
        await supabase
          .from("scheduled_send")
          .update({ bounce_type: "soft", soft_bounce_count: nextCount, scheduled_for: new Date(nowMs + backoffMs).toISOString(), attempts: s.attempts + 1 })
          .eq("id", s.id);
        skipped++; // retried, not dropped — counted here as "not sent this tick".
      }
      continue;
    } else {
      await supabase
        .from("scheduled_send")
        .update({ status: "sent", provider_message_id: outcome.providerMessageId, sent_at: nowIso, attempts: s.attempts + 1 })
        .eq("id", s.id);
      sent++;
    }

    // advance the enrollment to the next touch (or complete it) — only on a
    // real send or a hard bounce/escalation (both terminal for this touch).
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
      // Last enrollment for this sequence completed → the campaign is done.
      const { count: stillActive } = await supabase
        .from("sequence_enrollment")
        .select("id", { count: "exact", head: true })
        .eq("sequence_id", seq.id)
        .eq("status", "active");
      if ((stillActive ?? 0) === 0 && campaign?.status === "active") {
        await supabase.from("marketing_campaign").update({ status: "completed" }).eq("id", campaign.id);
      }
    }

    // Guardrails (Amendment 10) — evaluate once per campaign per tick, after
    // this campaign has had at least one send processed.
    if (seq.campaignId && !guardrailCheckedCampaigns.has(seq.campaignId)) {
      guardrailCheckedCampaigns.add(seq.campaignId);
      const trip = await evaluateCampaignGuardrails(supabase, seq.campaignId);
      if (trip) await autoPauseCampaign(supabase, seq.campaignId, seq.courseId, trip);
    }
  }
  return { processed: (due ?? []).length, sent, skipped, failed, heldByWindow, heldByRamp };
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

/** One-off broadcast to an explicit set of subscribers (processed inline, not
 *  via the outbox — a broadcast has no sequence, so sequence-level guardrail
 *  checks don't apply here; the campaign's own guardrail is still evaluated
 *  by the caller's next tick via the sequence path). Sender identity, CTA
 *  destination, and locale are resolved PER CAMPAIGN (course-level contacts
 *  can span several), same as `runSchedulerTick`. */
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
  const course = await loadCourseMarketingContext(supabase, args.courseId);

  // A broadcast's recipients can span multiple campaigns (contacts are
  // course-level) — cache each campaign's sender identity / CTA destination /
  // locale once, mirroring runSchedulerTick's per-tick cache. Without this a
  // broadcast NEVER carried the sender's mailing address, display name, or
  // Reply-To into the send (a compliance-footer gap), and any {{ctaUrl}}/
  // {{freeLessonUrl}}/{{courseName}} token in the body rendered as a literal
  // unresolved merge token instead of the real link/name.
  const campaignCache = new Map<string, { sender: SenderIdentity | null; locale: string; dest: CtaDestinations; offerDeadline: string | null }>();
  async function contextFor(campaignId: string | null) {
    const key = campaignId ?? "";
    const cached = campaignCache.get(key);
    if (cached) return cached;
    const campaign = campaignId ? await loadCampaign(supabase, campaignId) : null;
    const sender = campaign?.senderIdentityId ? await loadSenderIdentity(supabase, campaign.senderIdentityId) : null;
    const dest = await resolveCtaDestinations(supabase, { courseId: args.courseId, campaignId });
    const ctx = {
      sender,
      locale: course ? resolveCopyLocale(course, campaign?.config.brief) : "en",
      dest,
      offerDeadline: (campaign?.config.brief?.offerDeadlineIso as string | undefined) ?? null,
    };
    campaignCache.set(key, ctx);
    return ctx;
  }

  for (const id of args.subscriberIds) {
    const sub = await loadSubscriber(supabase, id);
    if (!sub || isSuppressed(sub.status)) {
      skipped++;
      continue;
    }
    const { sender, locale, dest, offerDeadline } = await contextFor(sub.campaign_id);
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
    const outcome = await deliver(supabase, services, {
      sub,
      courseId: args.courseId,
      campaignId: sub.campaign_id,
      subject: args.subject,
      body: args.body,
      sequenceId: null,
      touchId: null,
      mergeVars: {
        firstName: sub.name?.split(" ")[0] ?? null,
        courseName: course?.title ?? null,
        creatorName: sender?.fromName ?? null,
        freeLessonUrl: dest.freeLessonUrl,
        ctaUrl: dest.ctaUrl,
        offerDeadline,
      },
      locale,
      senderName: sender?.fromName ?? null,
      mailingAddress: sender?.mailingAddress ?? null,
      replyTo: sender?.replyTo ?? sender?.fromEmail ?? null,
    });
    if (row) {
      if (outcome.status === "sent") {
        await supabase.from("scheduled_send").update({ status: "sent", provider_message_id: outcome.providerMessageId, sent_at: nowIso }).eq("id", row.id);
      } else {
        await supabase.from("scheduled_send").update({ status: "failed", bounce_type: outcome.status === "hard_bounce" ? "hard" : "soft", error: outcome.status }).eq("id", row.id);
      }
    }
    if (outcome.status === "sent") sent++;
    else skipped++;
  }
  return { sent, skipped };
}
