/**
 * Learner communications (Milestone 6) — shared types + the provider seam.
 *
 * Deliberately standalone from the marketing suite (which lives on an
 * unmerged branch): same proven shape (provider interface / mock / factory /
 * signed tokens / block renderer), different paths and different population —
 * marketing mails anonymous leads gated by subscriber consent; comms mails
 * AUTHENTICATED, ENROLLED learners gated by enrollments.comms_opt_out.
 *
 * Trust model: `CommsProvider.send` is called by EXACTLY ONE function in the
 * repo — lib/comms/service.ts `approveAndSend` — which re-checks the opt-out
 * flag at send time. There is NO auto-send path (not even behind a flag): the
 * maintenance agent only ever creates `draft` rows.
 */

import { z } from "zod";

/* ───────────────────────────── Email body ──────────────────────────────── */

/** Block model persisted in learner_messages.body — rendered at SEND time so
 *  an edited draft always sends exactly what the author last saw. */
export const EmailBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("paragraph"), text: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal("button"),
    label: z.string().min(1).max(80),
    href: z.string().url().max(500),
  }),
]);
export type EmailBlock = z.infer<typeof EmailBlockSchema>;

export const EmailBodySchema = z.array(EmailBlockSchema).min(1).max(12);
export type EmailBody = z.infer<typeof EmailBodySchema>;

/* ───────────────────── Delivery tracking (Milestone 7) ─────────────────── */

/** Tagged onto every learner-comms send so webhook events route back here and
 *  future marketing-side events route elsewhere without rework. */
export const LEARNER_COMMS_SEND_SOURCE = "learner_comms";

/** learner_messages.delivery_status — advanced monotonically by rank in
 *  public.apply_comms_delivery (SQL is the single source of the rank ladder;
 *  this array documents the vocabulary for UI/tests). */
export const DELIVERY_STATUSES = [
  "none",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type SuppressionReason = "hard_bounce" | "complaint";

/** Resend tag — name/value restricted to ASCII letters/numbers/_/- . */
export interface EmailTag {
  name: string;
  value: string;
}

/* ─────────────────────────── Provider seam ─────────────────────────────── */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Display name only — the From ADDRESS is always the verified RESEND_FROM. */
  fromName: string;
  /** REQUIRED: every learner email carries a working opt-out link. */
  unsubscribeUrl: string;
  /** Stable per-message key (the learner_messages id) — rides to Resend as an
   *  Idempotency-Key header so ANY retry of the same message (in-provider
   *  backoff or the author re-sending a 'failed' row) can never double-send. */
  idempotencyKey?: string;
  /** Send-source + correlation tags (Milestone 7) — ride to Resend verbatim
   *  so webhook events can be attributed without a DB lookup guess. */
  tags?: EmailTag[];
  meta?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  /** true = the mock recorded it; nothing left the machine. */
  simulated: boolean;
}

export interface CommsProvider {
  readonly mode: "resend" | "mock";
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendResult>;
}

export class CommsError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "provider_error"
      | "invalid_request" = "provider_error"
  ) {
    super(message);
    this.name = "CommsError";
  }
}
