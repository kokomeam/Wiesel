/**
 * The env-gated service factory — THE single place modes are chosen.
 *
 * Mock-first: with no `RESEND_API_KEY`, the mock provider runs the entire engine
 * end-to-end. Phase 5 adds `./resend.ts` and flips ONE branch here to return the
 * real provider when the key is present. Nothing else in the codebase changes —
 * tools, the gate, the agent, the schemas, and the UI never learn which mode is
 * live (the studio's `isOpenAIConfigured()` pattern).
 */

import { createMockEmailProvider, systemClock } from "./mock";
import { createResendEmailProvider } from "./resend";
import type { Clock, EmailProvider, MarketingServices } from "./types";

/** True when a real email provider is configured. UI uses this to show the
 *  "mock mode — sends are simulated" banner. */
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export function createEmailProvider(): EmailProvider {
  // The swap: real Resend when a key is set, the mock otherwise. Nothing else
  // in the codebase changes between modes.
  return isEmailConfigured() ? createResendEmailProvider() : createMockEmailProvider();
}

export function createMarketingServices(overrides?: {
  email?: EmailProvider;
  clock?: Clock;
}): MarketingServices {
  return {
    email: overrides?.email ?? createEmailProvider(),
    clock: overrides?.clock ?? systemClock(),
  };
}
