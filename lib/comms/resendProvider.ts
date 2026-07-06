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
 */

import { CommsError, type CommsProvider, type SendEmailInput, type SendResult } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

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

export function createResendProvider(): CommsProvider {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const configuredFrom = process.env.RESEND_FROM ?? "WiseSel <onboarding@resend.dev>";

  return {
    mode: "resend",
    isConfigured: () => apiKey.length > 0,
    async send(input: SendEmailInput): Promise<SendResult> {
      if (!apiKey) {
        throw new CommsError("RESEND_API_KEY is not set.", "not_configured");
      }
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
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
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new CommsError(
          `Resend rejected the send (${res.status}): ${detail.slice(0, 300)}`,
          "provider_error"
        );
      }
      const payload = (await res.json().catch(() => null)) as { id?: string } | null;
      if (!payload?.id) {
        throw new CommsError("Resend returned no message id.", "provider_error");
      }
      return { providerMessageId: payload.id, simulated: false };
    },
  };
}
