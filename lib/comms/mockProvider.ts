/**
 * Mock comms provider — the no-key default and the verify:comms harness.
 * Records every send in a module singleton so tests assert on `getSends()`
 * (including the crucial NEGATIVE assertions: nothing sent by an agent run;
 * nothing sent after an opt-out).
 */

import type { CommsProvider, SendEmailInput, SendResult } from "./types";

export interface RecordedSend extends SendEmailInput {
  providerMessageId: string;
  at: string;
}

const sends: RecordedSend[] = [];
let counter = 0;

export function getMockSends(): readonly RecordedSend[] {
  return sends;
}

export function resetMockSends(): void {
  sends.length = 0;
  counter = 0;
}

export function createMockProvider(): CommsProvider {
  return {
    mode: "mock",
    isConfigured: () => true,
    async send(input: SendEmailInput): Promise<SendResult> {
      counter += 1;
      const providerMessageId = `mock-send-${counter}`;
      sends.push({ ...input, providerMessageId, at: new Date().toISOString() });
      return { providerMessageId, simulated: true };
    },
  };
}
