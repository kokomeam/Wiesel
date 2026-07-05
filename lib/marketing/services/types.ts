/**
 * Marketing service interfaces — the mock→real swap seam.
 *
 * Tools and the gate depend ONLY on these interfaces, never on a vendor SDK.
 * The mock implementations (./mock.ts) make the whole engine run end-to-end
 * before any integration exists; the real ones (Phase 5: ./resend.ts) drop in
 * behind the same contract via an env-gated factory (./factory.ts) — exactly
 * the studio's `isOpenAIConfigured()` / mock-model-client pattern.
 *
 * On the SCHEDULER: there is deliberately no swappable "Scheduler" interface.
 * The outbox IS the `scheduled_send` table and the tick logic is the same code
 * in both modes (lib/marketing/scheduler.ts, Phase 3); only the TRIGGER differs
 * — a manual /api/marketing/scheduler/tick call in dev vs. cron in prod. That's
 * infrastructure, not a code seam, so abstracting it would add indirection
 * without buying interchangeability.
 */

import type { EmailBody } from "../types";

export interface SendEmailInput {
  to: string;
  subject: string;
  previewText?: string | null;
  body: EmailBody;
  /** Plain-text fallback; the real provider renders React Email for HTML. */
  text?: string;
  /** A working one-click unsubscribe URL — REQUIRED on every marketing send. */
  unsubscribeUrl: string;
  /**
   * Display name for the From header. The From ADDRESS is always the
   * provider's verified sending address (RESEND_FROM) — a sender identity can
   * only skin the display name, never impersonate an unverified domain.
   */
  fromName?: string | null;
  /** Where replies land (Reply-To) — typically the sender identity's address. */
  replyTo?: string | null;
  /** Tracking context (sequence/touch/subscriber ids) for correlation. */
  meta?: Record<string, unknown>;
}

export interface SendEmailResult {
  providerMessageId: string;
  /**
   * MOCK ONLY: deterministic simulated engagement so the analytics funnel and
   * the agent's observe step have realistic data before Resend exists. The send
   * runner turns this into synthetic `email_open` / `email_click` events. Real
   * providers return `undefined` — genuine opens/clicks arrive later via
   * webhook/pixel.
   */
  simulatedEngagement?: { opened: boolean; clicked: boolean };
  /**
   * MOCK ONLY: deterministic simulated hard/soft bounce (Amendment 8) so the
   * retry/suppression logic has real data to run against before Resend exists.
   * Real providers report bounces asynchronously via webhook
   * (app/api/marketing/webhooks/resend), never synchronously from `send()`.
   */
  simulatedBounce?: { type: "hard" | "soft" };
}

export interface EmailProvider {
  readonly mode: "mock" | "resend";
  /** Whether a usable provider is configured (a real key, or always-true for
   *  the mock). The send path no-ops gracefully when false. */
  isConfigured(): boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** Injectable clock so tests get deterministic timestamps (no `Date.now()` in
 *  shared logic, matching the studio's no-`Date.now()`-in-render discipline). */
export interface Clock {
  now(): string;
  /** Epoch millis — for "is this scheduled_send due?" comparisons. */
  epochMs(): number;
}

/** The service bundle carried in every tool's context. */
export interface MarketingServices {
  email: EmailProvider;
  clock: Clock;
}
