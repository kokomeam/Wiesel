/**
 * EmailBody → HTML + plain text (Milestone 6). PURE. Email-safe markup only
 * (inline styles, no external assets — the CSP/branding rules of web pages
 * don't survive email clients). Every render appends the compliant footer:
 * who it's from, why the learner is receiving it, and the working opt-out
 * link the send seam requires.
 */

import type { EmailBody } from "./types";

export interface RenderContext {
  fromName: string;
  courseTitle: string;
  unsubscribeUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderEmailHtml(body: EmailBody, ctx: RenderContext): string {
  const blocks = body
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `<h2 style="margin:24px 0 8px;font-size:19px;font-weight:600;color:#1c1917;">${escapeHtml(block.text)}</h2>`;
        case "paragraph":
          return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#44403c;">${escapeHtml(block.text)}</p>`;
        case "button":
          return `<p style="margin:20px 0;"><a href="${escapeHtml(block.href)}" style="display:inline-block;padding:10px 22px;border-radius:9999px;background:linear-gradient(135deg,#f59e0b,#ea580c);color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(block.label)}</a></p>`;
      }
    })
    .join("\n");

  return `<div style="max-width:560px;margin:0 auto;padding:28px 24px;background:#faf7f1;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${blocks}
<hr style="margin:28px 0 16px;border:none;border-top:1px solid #e7e5e4;" />
<p style="margin:0;font-size:12px;line-height:1.6;color:#a8a29e;">
You're receiving this from ${escapeHtml(ctx.fromName)} because you're enrolled in
&ldquo;${escapeHtml(ctx.courseTitle)}&rdquo; on WiseSel.
<a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#a8a29e;text-decoration:underline;">Unsubscribe from course emails</a>
</p>
</div>`;
}

export function renderEmailText(body: EmailBody, ctx: RenderContext): string {
  const blocks = body
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `${block.text}\n${"-".repeat(Math.min(block.text.length, 40))}`;
        case "paragraph":
          return block.text;
        case "button":
          return `${block.label}: ${block.href}`;
      }
    })
    .join("\n\n");
  return `${blocks}

—
You're receiving this from ${ctx.fromName} because you're enrolled in "${ctx.courseTitle}" on WiseSel.
Unsubscribe from course emails: ${ctx.unsubscribeUrl}
`;
}

export function renderEmail(
  body: EmailBody,
  ctx: RenderContext
): { html: string; text: string } {
  return { html: renderEmailHtml(body, ctx), text: renderEmailText(body, ctx) };
}
