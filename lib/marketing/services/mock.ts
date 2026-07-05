/**
 * Deterministic MOCK marketing services.
 *
 * The whole point of mock-first: the gate, the agent loop, the state machine,
 * the analytics funnel, and the dashboard all run end-to-end with NO Resend.
 * `MockEmailProvider.send` records the message and returns DETERMINISTIC
 * simulated engagement (derived from a hash of the recipient + subject — no
 * `Math.random()`, so runs are reproducible), which the send runner turns into
 * synthetic open/click events. `getSends()` lets tests assert exactly what was
 * "sent" (mirrors the model mock's `getCalls()`).
 */

import type {
  Clock,
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
} from "./types";

/** FNV-1a — tiny, stable string hash for deterministic engagement. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface MockEmailProvider extends EmailProvider {
  getSends(): SendEmailInput[];
  reset(): void;
}

export function createMockEmailProvider(): MockEmailProvider {
  const sends: SendEmailInput[] = [];
  let seq = 0;
  return {
    mode: "mock",
    isConfigured: () => true,
    getSends: () => sends,
    reset: () => {
      sends.length = 0;
      seq = 0;
    },
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      sends.push(input);
      const h = hash(`${input.to}|${input.subject}`);
      // ADDRESS-TRIGGERED bounce simulation (Amendment 8) — the pattern real
      // ESP sandboxes use (Resend's bounced@resend.dev, SES's bounce
      // simulator): an address containing "hard-bounce" / "soft-bounce"
      // deterministically bounces; every other address delivers. Controllable
      // in tests, never randomly flaky.
      if (input.to.includes("hard-bounce")) {
        return { providerMessageId: `mock-${h.toString(16)}-${++seq}`, simulatedBounce: { type: "hard" } };
      }
      if (input.to.includes("soft-bounce")) {
        return { providerMessageId: `mock-${h.toString(16)}-${++seq}`, simulatedBounce: { type: "soft" } };
      }
      // ~66% open, and of those ~40% click — a plausible funnel, deterministic.
      const opened = h % 3 !== 0;
      const clicked = opened && h % 5 < 2;
      return {
        providerMessageId: `mock-${h.toString(16)}-${++seq}`,
        simulatedEngagement: { opened, clicked },
      };
    },
  };
}

/** Real wall-clock. */
export function systemClock(): Clock {
  return {
    now: () => new Date().toISOString(),
    epochMs: () => Date.now(),
  };
}

/** Deterministic clock for tests: starts at a fixed instant, advanceable. */
export function fixedClock(startIso = "2026-06-18T00:00:00.000Z"): Clock & {
  advance(ms: number): void;
} {
  let ms = new Date(startIso).getTime();
  return {
    now: () => new Date(ms).toISOString(),
    epochMs: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}
