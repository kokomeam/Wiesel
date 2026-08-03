/**
 * Publish-manifest domain — PURE (no DB, no provider): the state machine,
 * guard predicates, platform mapping, text composition, the decision-4
 * ledger predicate, and the crash-recovery matcher. The pure verify suite
 * golden-tests everything here; manifestRepository.ts owns the writes and
 * publishService.ts owns the IO orchestration.
 *
 * M-B binding decisions (docs/social-accounts.md § M-B binding decisions)
 * enforced structurally in this module:
 *   2 — the manifest id IS the provider clientRef; refs are their own
 *       durable step (the repository transition), history is fallback-only
 *       (matchRecentPost is deliberately conservative: no title → no match).
 *   4 — shouldWriteLedgerRow: provider-ACCEPT without platformError only.
 */

import type { ProviderRecentPost, PublishPlatform } from "./provider/types";

/* ─────────────────────────── state machine ────────────────────────────── */

export const PUBLISH_MANIFEST_STATUSES = [
  "queued",
  "held",
  "submitting",
  "submitted",
  "verifying",
  "live",
  "platform_failed",
  "failed",
  "cancelled",
  "voided",
] as const;
export type PublishManifestStatus = (typeof PUBLISH_MANIFEST_STATUSES)[number];

/**
 * Legal edges (single write path = transitionPublishManifest, optimistic on
 * status). `submitting` is entered BEFORE the provider call — a row FOUND in
 * `submitting` at tick start is a crashed/ambiguous prior run and only the
 * recovery path may move it (adopt refs via history, or fail after grace —
 * NEVER re-fire the publish call).
 */
export const PUBLISH_MANIFEST_TRANSITIONS: Record<PublishManifestStatus, PublishManifestStatus[]> = {
  queued: ["submitting", "held", "cancelled", "voided"],
  held: ["submitting", "cancelled", "voided"],
  submitting: ["submitted", "platform_failed", "failed"],
  submitted: ["live", "verifying", "failed"],
  verifying: ["live", "platform_failed", "failed"],
  live: [],
  platform_failed: [],
  failed: [],
  cancelled: [],
  voided: [],
};

export function isTerminalManifestStatus(s: PublishManifestStatus): boolean {
  return PUBLISH_MANIFEST_TRANSITIONS[s].length === 0;
}

export const ACTIVE_MANIFEST_STATUSES = PUBLISH_MANIFEST_STATUSES.filter(
  (s) => !isTerminalManifestStatus(s)
);

/** Cancel is only legal before submission begins — once `submitting` is
 *  entered there is no recall (decision 1: the provider has no delete). */
export const CANCELLABLE_MANIFEST_STATUSES: readonly PublishManifestStatus[] = ["queued", "held"];

/** Edit-voids applies to the same pre-submission window: a live-but-unsent
 *  manifest (queued/held) voids when its post's content changes. */
export const VOIDABLE_MANIFEST_STATUSES: readonly PublishManifestStatus[] = ["queued", "held"];

/** M-C amendment 2 semantics: retry re-enters via an approval-linked CLONE,
 *  and ONLY from `failed` (transient/ambiguous outcomes). `platform_failed`
 *  means the platform rejected the content — that needs an edit, which
 *  voids, which needs a fresh card. */
export function canRetryManifest(status: PublishManifestStatus): boolean {
  return status === "failed";
}

/** Card-token lifetime: minted at render, dead 15 minutes later. A stale tab
 *  re-renders and re-mints; nothing auto-approves on expiry. */
export const APPROVAL_TOKEN_TTL_MINUTES = 15;

/** Card honesty (checkpoint amendment 4): first-comment delivery is only
 *  PROVEN on LinkedIn (Task 0a). YouTube accepts the parameter but delivery
 *  is unverified — the card renders a "may be skipped" caveat until a live
 *  publish proves it. */
export const FIRST_COMMENT_SUPPORT: Record<PublishPlatform, "proven" | "unverified"> = {
  linkedin: "proven",
  youtube: "unverified",
  tiktok: "unverified",
  instagram: "unverified",
  facebook: "unverified",
};

/** Ambiguous-submit recovery budget: after this many recovery attempts with
 *  no history match, the manifest fails (retry = a NEW manifest). */
export const RECOVERY_GRACE_ATTEMPTS = 3;

/** Verify polling budget (one poll per tick) before an async accept with no
 *  terminal answer is failed as verify_timeout. */
export const VERIFY_MAX_ATTEMPTS = 60;

/* ──────────────────────────── platform gate ───────────────────────────── */

/** Task 0a proved LinkedIn + YouTube live; tiktok/instagram/facebook are
 *  Task 0b prerequisites (types.ts) — publishing refuses them honestly. */
export const PROVEN_PUBLISH_PLATFORMS: readonly PublishPlatform[] = ["linkedin", "youtube"];

/** social_post.platform → connected-account platform. Text posts use the
 *  platform verbatim; clip posts carry youtube_shorts (the row union), which
 *  publishes through the youtube connection. Unknown → null (refused). */
export function postPlatformToPublishPlatform(postPlatform: string): PublishPlatform | null {
  if (postPlatform === "youtube_shorts") return "youtube";
  const known: readonly string[] = ["linkedin", "youtube", "tiktok", "instagram", "facebook"];
  return known.includes(postPlatform) ? (postPlatform as PublishPlatform) : null;
}

/* ─────────────────────────────── guards ───────────────────────────────── */

/** send_window survives in the union ONLY so legacy held rows still render
 *  (M-D: the card-approved fire time is AUTHORITATIVE — see below). */
export type PublishHoldReason =
  | "account_not_linked"
  | "source_superseded"
  | "quota_exceeded"
  | "send_window";

export type PublishGuardDecision =
  | { kind: "proceed" }
  | { kind: "not_due" }
  | { kind: "hold"; reason: PublishHoldReason };

/**
 * Pre-submit guards, evaluated on queued AND held rows every advance (held
 * is self-healing: re-link / a re-render / a new month resumes it). Order:
 * schedule → health → frozen-source (amendment 2) → quota.
 *
 * DELIBERATELY NO send-window gate (M-D, caught by the first live E2E): the
 * email suite's 9–11 UTC window held a card fire the creator had explicitly
 * approved for 16:27 — but every manifest's timing IS a creator decision on
 * the card (a chosen instant, or "immediately after approval"), so the
 * approved time is authoritative and no generic window second-guesses it.
 */
export function evaluatePublishGuards(input: {
  scheduledFor: string | null;
  nowIso: string;
  accountStatus: "linked" | "expired" | "revoked";
  sourceSuperseded: boolean;
  uploadsThisMonth: number;
  uploadsPerMonth: number;
}): PublishGuardDecision {
  if (input.scheduledFor && input.scheduledFor > input.nowIso) return { kind: "not_due" };
  if (input.accountStatus !== "linked") return { kind: "hold", reason: "account_not_linked" };
  if (input.sourceSuperseded) return { kind: "hold", reason: "source_superseded" };
  if (input.uploadsThisMonth >= input.uploadsPerMonth) return { kind: "hold", reason: "quota_exceeded" };
  return { kind: "proceed" };
}

/* ─────────────────── decision 4 — the ledger predicate ────────────────── */

/** One ledger row per provider-ACCEPTED upload; a platformError inside the
 *  accept envelope (e.g. LinkedIn's duplicate rejection) writes NOTHING —
 *  mirrors the vendor's proven quota semantics. Accepted-then-platform-
 *  failed later (async) may over-count by one; that drift is accepted (no
 *  quota-read endpoint exists; over-counting warns early — safe direction). */
export function shouldWriteLedgerRow(accepted: { platformError: string | null }): boolean {
  return accepted.platformError === null;
}

/* ───────────────────────── text composition ───────────────────────────── */

export interface PublishablePostContent {
  body: string;
  cta: string | null;
  hashtags: string[];
}

/** The published text: body + CTA + hashtags — the same composition the
 *  manual-copy path shows creators (exportText.ts), so what goes out equals
 *  what they reviewed. Used verbatim as the video caption for clip posts. */
export function composePublishText(post: PublishablePostContent): string {
  const parts = [post.body];
  if (post.cta) parts.push(post.cta);
  const tags = post.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  if (tags) parts.push(tags);
  return parts.join("\n\n");
}

/* ─────────────────────── crash-recovery matcher ───────────────────────── */

export interface RecoveredRefs {
  providerRequestId: string | null;
  platformPostId: string | null;
  postUrl: string | null;
}

/**
 * Fallback-only correlation for a manifest stranded in `submitting`
 * (crashed between the publish call and the ref persist). DELIBERATELY
 * conservative: history rows without a title can never match (the title
 * field is unverified vendor surface), and only a successful row on the
 * same platform with the exact composed title is adopted. No match after
 * RECOVERY_GRACE_ATTEMPTS ⇒ the manifest fails — never re-fire (decision 2).
 */
export function matchRecentPost(
  recent: ProviderRecentPost[],
  target: { platform: PublishPlatform; title: string }
): RecoveredRefs | null {
  for (const row of recent) {
    if (!row.success) continue;
    if (row.platform !== target.platform) continue;
    if (row.title === null || row.title !== target.title) continue;
    if (!row.providerRequestId && !row.platformPostId && !row.postUrl) continue;
    return {
      providerRequestId: row.providerRequestId,
      platformPostId: row.platformPostId,
      postUrl: row.postUrl,
    };
  }
  return null;
}
