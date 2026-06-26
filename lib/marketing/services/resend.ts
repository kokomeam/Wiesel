/**
 * The REAL email provider — Resend. This is the ONLY file that imports the
 * `resend` SDK (the studio's "SDK in one file" rule). It implements the exact
 * same `EmailProvider` contract as the mock, so flipping to it (in factory.ts,
 * when RESEND_API_KEY is set) changes nothing else — tools, the gate, the agent,
 * the scheduler, and the UI are byte-identical between modes.
 *
 * It renders the EmailBody to HTML + text (pure renderers) and sets a
 * List-Unsubscribe header. It returns NO simulatedEngagement — real opens/clicks
 * arrive later via Resend webhooks (a future event source feeding the same
 * analytics stream).
 *
 * Env: RESEND_API_KEY (required), RESEND_FROM (the verified sender, e.g.
 * "Your Course <hi@yourdomain.com>").
 */

import { Resend } from "resend";
import { renderEmailHtml, renderEmailText } from "../email/render";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "./types";

export function createResendEmailProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const from = process.env.RESEND_FROM ?? "WiseSel <onboarding@resend.dev>";
  const client = new Resend(apiKey);

  return {
    mode: "resend",
    isConfigured: () => !!apiKey,
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const html = renderEmailHtml(input.body, { unsubscribeUrl: input.unsubscribeUrl });
      const text = input.text ?? renderEmailText(input.body, { unsubscribeUrl: input.unsubscribeUrl });
      const { data, error } = await client.emails.send({
        from,
        to: input.to,
        subject: input.subject,
        html,
        text,
        headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>` },
      });
      if (error) throw new Error(`Resend: ${error.message}`);
      return { providerMessageId: data?.id ?? "resend-unknown" };
    },
  };
}
