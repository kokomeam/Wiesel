/**
 * The contextual language split (M-D §3 / AC-MD.5) — THE single list of
 * paths whose USER-VISIBLE strings may carry connected-publishing vocabulary
 * (Publish/Schedule). Everything else on the social/accounts surfaces keeps
 * Phase-1 wording, and the fences prove BOTH directions:
 *   verify-social.ts    — skips these paths in its banned-phrase scan (its
 *                         scan set is otherwise unchanged)
 *   verify-publish-path — asserts vocabulary exists INSIDE each allowlisted
 *                         path, is absent from every other social-surface
 *                         literal, and that the Phase-1 copy is
 *                         byte-unchanged (snapshot)
 * Repo-relative prefixes.
 */

export const CONNECTED_VOCAB_ALLOWLIST = [
  "components/marketing/publish/",
  "app/(app)/marketing/publish/",
  "components/marketing/social/connected/",
] as const;

export function isConnectedVocabPath(repoRelativePath: string): boolean {
  const normalized = repoRelativePath.replace(/\\/g, "/");
  return CONNECTED_VOCAB_ALLOWLIST.some((p) => normalized.includes(p));
}
