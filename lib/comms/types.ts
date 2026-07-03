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
