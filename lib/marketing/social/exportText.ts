/**
 * Export builders (PRD §16) — pure. Downloads are generated client-side from
 * these; every export fires its analytics event (the Phase-1 proxy for
 * "which drafts were actually used").
 *
 * Exports never claim publication: the .md front-matter carries the post's
 * actual status (draft|ready|planned|posted_manual|archived) — never anything
 * publish-like.
 */

export interface ExportablePost {
  id: string;
  platform: string;
  funnelStage: string;
  status: string;
  body: string;
  cta: string | null;
  hashtags: string[];
  plannedPostAt: string | null;
}

/** Full post text for the clipboard: body + CTA (hashtags ride separately via
 *  "Copy hashtags"). */
export function buildCopyText(post: Pick<ExportablePost, "body" | "cta">): string {
  return post.cta ? `${post.body}\n\n${post.cta}` : post.body;
}

export function buildHashtagText(post: Pick<ExportablePost, "hashtags">): string {
  return post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
}

/** .txt = body, blank line, CTA, blank line, hashtags. */
export function buildTxtExport(post: ExportablePost): string {
  const parts = [post.body];
  if (post.cta) parts.push(post.cta);
  const tags = buildHashtagText(post);
  if (tags) parts.push(tags);
  return parts.join("\n\n") + "\n";
}

/** .md = front-matter (platform, stage, plannedPostAt, status) + content. */
export function buildMdExport(post: ExportablePost): string {
  const front = [
    "---",
    `platform: ${post.platform}`,
    `funnelStage: ${post.funnelStage}`,
    `plannedPostAt: ${post.plannedPostAt ?? "null"}`,
    `status: ${post.status}`,
    "---",
  ].join("\n");
  return `${front}\n\n${buildTxtExport(post)}`;
}

/** Filesystem-safe download name. */
export function exportFileName(post: ExportablePost, ext: "txt" | "md"): string {
  return `${post.platform}-${post.funnelStage}-${post.id.slice(0, 8)}.${ext}`;
}
