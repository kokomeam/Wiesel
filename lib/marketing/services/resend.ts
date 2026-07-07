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
 * FROM semantics: Resend can only send from a DOMAIN you verified, so the From
 * ADDRESS is always RESEND_FROM's address. A campaign's sender identity skins
 * the DISPLAY NAME and sets Reply-To — it can never point sending at an
 * unverified domain (e.g. a gmail address).
 *
 * Env: RESEND_API_KEY (required), RESEND_FROM (an address on your verified
 * domain — bare `hi@yourdomain.com` or `"Your Course <hi@yourdomain.com>"`).
 */

import { Resend } from "resend";
import { renderEmailHtml, renderEmailText } from "../email/render";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "./types";

/**
 * Trim + strip ONE layer of wrapping matching quotes off an env-sourced value.
 * A `.env` file's `RESEND_FROM="WiseSel <hi@x.com>"` has its quotes stripped
 * by dotenv-style parsing — but Vercel's environment-variable UI does NOT
 * strip quotes: pasting that exact line's value (a common copy from
 * .env.example) leaves the LITERAL quote characters in `process.env`, and
 * Resend's from-address parser rejects them with "Invalid `from` field"
 * (observed live: worked locally, broke only on the deployed domain). Pure —
 * unit-tested without a key.
 */
export function cleanEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Compose the From header: the ADDRESS always comes from the configured
 *  (verified-domain) `envFrom`; `fromName` only replaces the display name.
 *  `envFrom` is cleaned first (see `cleanEnvValue`) so a quoted env var can
 *  never reach Resend malformed. Pure — unit-tested without a key. */
export function composeFromHeader(fromName: string | null | undefined, envFrom: string): string {
  const cleanEnv = cleanEnvValue(envFrom);
  if (!fromName?.trim()) return cleanEnv;
  const m = cleanEnv.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const address = m ? m[1] : cleanEnv;
  // Strip characters that would break or spoof the header.
  const safeName = fromName.replace(/["<>\r\n]/g, "").trim();
  return safeName ? `${safeName} <${address}>` : cleanEnv;
}

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
        from: composeFromHeader(input.fromName, from),
        to: input.to,
        replyTo: input.replyTo ?? undefined,
        subject: input.subject,
        html,
        text,
        headers: { "List-Unsubscribe": `<${input.unsubscribeUrl}>` },
      });
      if (error) {
        // The #1 setup mistakes get actionable messages, not a raw API error.
        if (/domain is not verified/i.test(error.message)) {
          throw new Error(
            `Resend: ${error.message} — RESEND_FROM must be an address on the domain you verified in Resend (e.g. you@yourdomain.com). Sender identities only control the display name and Reply-To; they cannot send from an unverified domain.`
          );
        }
        if (/invalid `?from`? field/i.test(error.message)) {
          throw new Error(
            `Resend: ${error.message} — the composed From header was "${composeFromHeader(input.fromName, from)}" (from RESEND_FROM="${from}"). Expected \`email@domain.com\` or \`Name <email@domain.com>\` — check for stray quotes/whitespace in the env var value (a value pasted from .env.example onto Vercel keeps its literal quote characters, unlike a local .env file).`
          );
        }
        throw new Error(`Resend: ${error.message}`);
      }
      return { providerMessageId: data?.id ?? "resend-unknown" };
    },
  };
}
