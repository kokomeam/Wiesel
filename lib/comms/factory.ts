/**
 * Provider selection — env-gated, mirroring the marketing branch's factory:
 * explicit COMMS_PROVIDER=mock wins; otherwise a present RESEND_API_KEY means
 * real sends, and its absence silently degrades to the recording mock (dev +
 * CI never need a key).
 */

import { createMockProvider } from "./mockProvider";
import { createResendProvider } from "./resendProvider";
import type { CommsProvider } from "./types";

export function isEmailConfigured(): boolean {
  return process.env.COMMS_PROVIDER !== "mock" && !!process.env.RESEND_API_KEY;
}

export function getCommsProvider(): CommsProvider {
  return isEmailConfigured() ? createResendProvider() : createMockProvider();
}
