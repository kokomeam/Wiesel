/**
 * Pure email-body renderers. Dependency-free (no react-email yet) so the whole
 * Phase-3 engine runs mock-first; Phase 5's ResendEmailProvider can swap in a
 * React Email renderer behind the same EmailBody → string contract. Every email
 * appends a working one-click unsubscribe (compliance — never optional).
 */

import type { EmailBody } from "../types";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderEmailText(body: EmailBody, opts: { unsubscribeUrl: string }): string {
  const lines: string[] = [];
  for (const b of body.blocks) {
    switch (b.kind) {
      case "heading":
        lines.push(b.text.toUpperCase(), "");
        break;
      case "paragraph":
        lines.push(b.text, "");
        break;
      case "bullets":
        lines.push(...b.items.map((i) => `• ${i}`), "");
        break;
      case "button":
        lines.push(`${b.label}: ${b.href}`, "");
        break;
    }
  }
  lines.push("—", `Unsubscribe: ${opts.unsubscribeUrl}`);
  return lines.join("\n").trim();
}

export function renderEmailHtml(body: EmailBody, opts: { unsubscribeUrl: string }): string {
  const parts: string[] = [];
  for (const b of body.blocks) {
    switch (b.kind) {
      case "heading":
        parts.push(`<h2 style="font-size:20px;margin:0 0 12px;color:#1c1917">${esc(b.text)}</h2>`);
        break;
      case "paragraph":
        parts.push(`<p style="font-size:15px;line-height:1.6;margin:0 0 14px;color:#44403c">${esc(b.text)}</p>`);
        break;
      case "bullets":
        parts.push(
          `<ul style="margin:0 0 14px;padding-left:20px;color:#44403c">${b.items
            .map((i) => `<li style="margin:6px 0">${esc(i)}</li>`)
            .join("")}</ul>`
        );
        break;
      case "button":
        parts.push(
          `<p style="margin:18px 0"><a href="${esc(b.href)}" style="display:inline-block;background:linear-gradient(135deg,#f59e0b,#ea580c);color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:600;font-size:14px">${esc(b.label)}</a></p>`
        );
        break;
    }
  }
  return `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;padding:24px">
${parts.join("\n")}
<hr style="border:none;border-top:1px solid #ece7de;margin:24px 0 12px" />
<p style="font-size:12px;color:#a8a29e">You're receiving this because you signed up. <a href="${esc(opts.unsubscribeUrl)}" style="color:#a8a29e">Unsubscribe</a>.</p>
</div>`;
}
