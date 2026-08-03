/**
 * Resend delivery-webhook processing for LEARNER COMMS (Milestone 7).
 *
 * The route (app/api/comms/webhooks/resend) verifies the Svix signature and
 * hands the parsed payload here. This module:
 *   1. maps the Resend event to our taxonomy (comms_email_* events for
 *      delivered/opened/clicked/bounced/complained; trail-only notes for
 *      email.sent / email.delivery_delayed — low signal, no event minted),
 *   2. attributes it to a learner_messages row — by provider_message_id
 *      (persisted at send time) first, then by the send-time `message_id` tag
 *      (covers the email.sent-before-commit race; accepted only when the
 *      row's provider id is unset or matches),
 *   3. emits the analytics event with a clientEventId DERIVED from the Svix
 *      message id (`svix-id` is stable across retries → the learning_events
 *      UNIQUE constraint is the idempotency store),
 *   4. advances the message's delivery trail via the atomic
 *      apply_comms_delivery RPC (rank-monotone status, svixId-deduped trail),
 *   5. suppresses the learner on hard bounce / complaint.
 *
 * Trust: the learner is ALWAYS the learner_messages row's user_id — tags are
 * routing hints, never identity (the M3 server-pinning discipline). Foreign
 * send_source values (e.g. the marketing suite) are ignored without a lookup.
 *
 * Failure posture: attribution failures return "ignored" (the route 200s —
 * Svix must not retry-storm unattributable events); infrastructure failures
 * THROW (the route 500s so Svix retries). Side effects (trail/suppression)
 * are idempotent and re-applied even on a duplicate event, so a retry after a
 * partial failure self-heals.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  buildCommsDeliveryEvent,
  type CommsDeliveryEventType,
} from "@/lib/analytics/events";
import { emitCommsDeliveryEvent } from "@/lib/analytics/serverEmit";
import { CommsError, LEARNER_COMMS_SEND_SOURCE, type DeliveryStatus } from "./types";

type DB = SupabaseClient<Database>;

/* ─────────────────────────── Pure helpers ──────────────────────────────── */

/** Deterministic uuid from a Svix message id (retry-stable idempotency key).
 *  sha256 over a purpose-prefixed name, with uuid version/variant bits set —
 *  the same shape everywhere a uuid column expects one. */
export function uuidFromSvixId(svixId: string): string {
  const hash = createHash("sha256")
    .update(`wisesel.comms-webhook.v1:${svixId}`)
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 (name-derived)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resend webhook payloads have carried tags as BOTH an array of
 *  {name, value} and a plain name→value object across API versions — accept
 *  either; non-string values are dropped. */
export function parseResendTags(data: Record<string, unknown>): Record<string, string> {
  const tags = data.tags;
  const out: Record<string, string> = {};
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (
        t !== null &&
        typeof t === "object" &&
        typeof (t as { name?: unknown }).name === "string" &&
        typeof (t as { value?: unknown }).value === "string"
      ) {
        out[(t as { name: string }).name] = (t as { value: string }).value;
      }
    }
  } else if (tags !== null && typeof tags === "object") {
    for (const [k, v] of Object.entries(tags as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

export type ResendEventMapping =
  | {
      kind: "event";
      eventType: CommsDeliveryEventType;
      deliveryStatus: DeliveryStatus;
      bounceType?: "hard" | "soft";
      bounceSubtype?: string | null;
      url?: string | null;
    }
  | { kind: "trail"; note: "sent" | "delivery_delayed" };

/** Resend event type → our taxonomy. Bounce hardness: Resend's bounce.type is
 *  'Permanent' | 'Transient' | 'Undetermined' — only Permanent suppresses
 *  (never suppress on uncertainty). Unknown event types → null (ignored). */
export function mapResendEvent(
  type: string,
  data: Record<string, unknown>
): ResendEventMapping | null {
  switch (type) {
    case "email.sent":
      return { kind: "trail", note: "sent" };
    case "email.delivery_delayed":
      return { kind: "trail", note: "delivery_delayed" };
    case "email.delivered":
      return { kind: "event", eventType: "comms_email_delivered", deliveryStatus: "delivered" };
    case "email.opened":
      return { kind: "event", eventType: "comms_email_open", deliveryStatus: "opened" };
    case "email.clicked": {
      const click = (data.click ?? {}) as Record<string, unknown>;
      const url = typeof click.link === "string" ? click.link.slice(0, 500) : null;
      return { kind: "event", eventType: "comms_email_click", deliveryStatus: "clicked", url };
    }
    case "email.bounced": {
      const bounce = (data.bounce ?? {}) as Record<string, unknown>;
      const hard = String(bounce.type ?? "").toLowerCase().includes("permanent");
      const subRaw = bounce.subType ?? bounce.sub_type ?? bounce.subtype;
      return {
        kind: "event",
        eventType: "comms_email_bounce",
        deliveryStatus: "bounced",
        bounceType: hard ? "hard" : "soft",
        bounceSubtype: typeof subRaw === "string" ? subRaw.slice(0, 100) : null,
      };
    }
    case "email.complained":
      return { kind: "event", eventType: "comms_email_complaint", deliveryStatus: "complained" };
    default:
      return null;
  }
}

/* ─────────────────────────── Processing ────────────────────────────────── */

export interface ResendWebhookPayload {
  type?: string;
  created_at?: string;
  data?: Record<string, unknown>;
}

export type ProcessOutcome =
  | { outcome: "ignored"; reason: string }
  | { outcome: "trail_only"; note: "sent" | "delivery_delayed"; recorded: boolean }
  | { outcome: "duplicate"; eventType: CommsDeliveryEventType }
  | { outcome: "processed"; eventType: CommsDeliveryEventType };

type MessageRow = Pick<
  Database["public"]["Tables"]["learner_messages"]["Row"],
  "id" | "course_id" | "user_id" | "provider_message_id"
>;

async function resolveMessage(
  admin: DB,
  emailId: string,
  tags: Record<string, string>
): Promise<MessageRow | null> {
  if (emailId) {
    const byProvider = await admin
      .from("learner_messages")
      .select("id, course_id, user_id, provider_message_id")
      .eq("provider_message_id", emailId)
      .maybeSingle();
    if (byProvider.error) throw byProvider.error;
    if (byProvider.data) return byProvider.data;
  }
  // Fallback: the send-time message_id tag (covers a webhook arriving before
  // approveAndSend committed the provider id). Accepted only when the row's
  // provider id is unset or matches — a mismatch means the tag points at a
  // different send and must not be trusted.
  const taggedId = tags.message_id;
  if (taggedId && /^[0-9a-f-]{36}$/i.test(taggedId)) {
    const byTag = await admin
      .from("learner_messages")
      .select("id, course_id, user_id, provider_message_id")
      .eq("id", taggedId)
      .maybeSingle();
    if (byTag.error) throw byTag.error;
    if (
      byTag.data &&
      (byTag.data.provider_message_id === null || byTag.data.provider_message_id === emailId)
    ) {
      return byTag.data;
    }
  }
  return null;
}

export async function processResendCommsEvent(
  admin: DB,
  payload: ResendWebhookPayload,
  svixId: string
): Promise<ProcessOutcome> {
  const data = payload.data ?? {};
  const mapping = payload.type ? mapResendEvent(payload.type, data) : null;
  if (!mapping) return { outcome: "ignored", reason: "unhandled event type" };

  const tags = parseResendTags(data);
  if (tags.send_source && tags.send_source !== LEARNER_COMMS_SEND_SOURCE) {
    return { outcome: "ignored", reason: `foreign send_source: ${tags.send_source}` };
  }

  const emailId = typeof data.email_id === "string" ? data.email_id : "";
  const message = await resolveMessage(admin, emailId, tags);
  if (!message) {
    console.log(
      JSON.stringify({
        tag: "comms_webhook",
        outcome: "unattributable",
        type: payload.type,
        emailId: emailId || null,
      })
    );
    return { outcome: "ignored", reason: "no matching comms record" };
  }

  const at = typeof payload.created_at === "string" ? payload.created_at : new Date().toISOString();

  if (mapping.kind === "trail") {
    const applied = await admin.rpc("apply_comms_delivery", {
      p_message_id: message.id,
      p_status: null as unknown as string,
      p_entry: { type: mapping.note, at, via: "webhook", svixId } as unknown as Json,
    });
    if (applied.error) throw new CommsError(`trail update failed: ${applied.error.message}`);
    const recorded =
      typeof applied.data === "object" &&
      applied.data !== null &&
      (applied.data as { appended?: boolean }).appended === true;
    return { outcome: "trail_only", note: mapping.note, recorded };
  }

  // Event kind — mint the analytics event (idempotent on the Svix-derived id).
  const event = buildCommsDeliveryEvent(
    {
      eventType: mapping.eventType,
      courseId: message.course_id,
      messageId: message.id,
      ...(mapping.eventType === "comms_email_click" ? { url: mapping.url ?? null } : {}),
      ...(mapping.eventType === "comms_email_bounce"
        ? { bounceType: mapping.bounceType ?? "soft", bounceSubtype: mapping.bounceSubtype ?? null }
        : {}),
    } as Parameters<typeof buildCommsDeliveryEvent>[0],
    { clientEventId: uuidFromSvixId(svixId), clientTs: at }
  );
  const emitted = await emitCommsDeliveryEvent(admin, message.user_id, event);
  if (emitted === "error") {
    throw new CommsError("comms delivery event insert failed");
  }

  // Side effects run even on a duplicate — they're idempotent (rank-monotone
  // status, svixId-deduped trail, upsert suppression), so a Svix retry after
  // a partial failure completes the missing half instead of dropping it.
  const applied = await admin.rpc("apply_comms_delivery", {
    p_message_id: message.id,
    p_status: mapping.deliveryStatus,
    p_entry: {
      type: mapping.deliveryStatus,
      at,
      via: "webhook",
      svixId,
      ...(mapping.eventType === "comms_email_click" && mapping.url ? { detail: { url: mapping.url } } : {}),
      ...(mapping.eventType === "comms_email_bounce"
        ? {
            detail: {
              bounceType: mapping.bounceType,
              ...(mapping.bounceSubtype ? { bounceSubtype: mapping.bounceSubtype } : {}),
            },
          }
        : {}),
    } as unknown as Json,
  });
  if (applied.error) throw new CommsError(`delivery update failed: ${applied.error.message}`);

  const suppressReason =
    mapping.eventType === "comms_email_complaint"
      ? "complaint"
      : mapping.eventType === "comms_email_bounce" && mapping.bounceType === "hard"
        ? "hard_bounce"
        : null;
  if (suppressReason) {
    const suppressed = await admin.from("comms_suppressions").upsert(
      {
        user_id: message.user_id,
        reason: suppressReason,
        detail: {
          messageId: message.id,
          svixId,
          at,
          ...(mapping.kind === "event" && mapping.bounceSubtype
            ? { bounceSubtype: mapping.bounceSubtype }
            : {}),
        } as unknown as Json,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (suppressed.error) {
      throw new CommsError(`suppression upsert failed: ${suppressed.error.message}`);
    }
    console.log(
      JSON.stringify({
        tag: "comms_suppression",
        userId: message.user_id,
        reason: suppressReason,
        messageId: message.id,
      })
    );
  }

  return emitted === "duplicate"
    ? { outcome: "duplicate", eventType: mapping.eventType }
    : { outcome: "processed", eventType: mapping.eventType };
}
