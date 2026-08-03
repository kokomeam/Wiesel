/**
 * The Resend provider — the ONLY file that talks to the Resend API, via
 * `fetch` against its REST endpoint (NO SDK: keeps the runtime-dependency
 * count at the guarded 14, exactly the muxClient precedent). Tradeoff: no
 * SDK types/retries — accepted for a single stable POST endpoint; revisit if
 * batch sends ever land.
 *
 * The From ADDRESS is always the verified RESEND_FROM; `fromName` only skins
 * the display name ("<creator> via WiseSel") so a creator can never spoof an
 * arbitrary sender.
 *
 * TRANSIENT-FAILURE RESILIENCE (2026-07-07): a single dropped socket used to
 * park the message in 'failed' with an opaque "fetch failed" (observed live —
 * dev machines behind a system proxy flicker on direct connections). The
 * provider now retries transport errors and 429/5xx up to MAX_ATTEMPTS with
 * backoff, and every attempt carries Resend's `Idempotency-Key` (the
 * learner_messages id, stable across in-provider retries AND the author
 * clicking Send again on a failed row) so a retry after a lost RESPONSE can
 * never double-send. Non-429 4xx responses are the request's own fault —
 * surfaced immediately, never retried.
 */

import { CommsError, type CommsProvider, type SendEmailInput, type SendResult } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

/** Extract the address part of `Name <addr@domain>` (or pass a bare address). */
export function fromAddress(configured: string): string {
  const match = configured.match(/<([^>]+)>/);
  return match ? match[1].trim() : configured.trim();
}

export function composeFrom(fromName: string, configured: string): string {
  const address = fromAddress(configured);
  const safeName = fromName.replaceAll(/["<>]/g, "").trim() || "WiseSel";
  return `${safeName} via WiseSel <${address}>`;
}

/** Unwrap the useful part of a Node fetch failure — undici buries the real
 *  cause (ECONNRESET, ETIMEDOUT, ENOTFOUND…) under `error.cause`, leaving the
 *  top-level message as just "fetch failed". */
export function describeTransportError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const causeText = cause?.code ?? cause?.message;
  return causeText ? `${err.message} (${causeText})` : err.message;
}

/** Injectable for tests; production uses the real fetch + timers. */
export interface ResendProviderDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createResendProvider(deps: ResendProviderDeps = {}): CommsProvider {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const configuredFrom = process.env.RESEND_FROM ?? "WiseSel <onboarding@resend.dev>";
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return {
    mode: "resend",
    isConfigured: () => apiKey.length > 0,
    async send(input: SendEmailInput): Promise<SendResult> {
      if (!apiKey) {
        throw new CommsError("RESEND_API_KEY is not set.", "not_configured");
      }
      const request = {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Stable per message: an in-provider retry (or the author re-sending
          // a 'failed' row whose first attempt actually landed) is a no-op at
          // Resend instead of a duplicate email. Keys live 24h server-side.
          ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: composeFrom(input.fromName, configuredFrom),
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
          headers: {
            "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
          },
          // Correlation tags (M7): send_source + message/course/user ids so
          // webhook events attribute without guessing (values are uuids /
          // fixed slugs — inside Resend's ASCII letters/numbers/_/- charset).
          ...(input.tags?.length ? { tags: input.tags } : {}),
        }),
      } satisfies RequestInit;

      let lastFailure = "";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let res: Response;
        try {
          res = await doFetch(RESEND_ENDPOINT, request);
        } catch (err) {
          // Transport never reached Resend (or the response was lost) —
          // retryable; the idempotency key makes the retry safe either way.
          lastFailure = `network error: ${describeTransportError(err)}`;
          if (attempt < MAX_ATTEMPTS) {
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
            continue;
          }
          throw new CommsError(
            `Could not reach Resend after ${MAX_ATTEMPTS} attempts — ${lastFailure}. Check the network connection and retry the send.`,
            "provider_error"
          );
        }

        if (res.ok) {
          const payload = (await res.json().catch(() => null)) as { id?: string } | null;
          if (!payload?.id) {
            throw new CommsError("Resend returned no message id.", "provider_error");
          }
          return { providerMessageId: payload.id, simulated: false };
        }

        const detail = await res.text().catch(() => "");
        lastFailure = `Resend rejected the send (${res.status}): ${detail.slice(0, 300)}`;
        // 429/5xx are Resend-side/transient — retry; other 4xx are OUR
        // request's fault (bad from-domain, invalid recipient…) — no retry.
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        throw new CommsError(lastFailure, "provider_error");
      }
      // Unreachable (every loop exit returns or throws) — satisfies TS.
      throw new CommsError(lastFailure || "Send failed.", "provider_error");
    },
  };
}
