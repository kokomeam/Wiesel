/**
 * SocialPublishProvider — the provider-agnostic connected-publishing seam
 * (M-A foundation; publishing itself ships in M-B). Default implementation:
 * Upload-Post (uploadPostClient.ts — the ONLY vendor module). Every shape
 * decision here is backed by the LIVE Task 0a verification
 * (spikes/task0-upload-post/FINDINGS.md + the recorded fixtures copied into
 * lib/marketing/accounts/fixtures/task0a/) — the findings are authoritative
 * over the vendor's own spec where they conflict:
 *
 *   - Result refs are reference-complete in the SYNC response AND the async
 *     status poll (platform_post_id + post_url — richer than the vendor
 *     spec); history is the audit backstop. POLL-ONLY delivery — webhook
 *     ingestion is deliberately NOT implemented (0 deliveries observed live;
 *     unsigned; the config left on the vendor side is a passive 0b
 *     experiment).
 *   - deletePost is an HONEST REFUSAL for every platform (Task 0a Test 3:
 *     no delete endpoint responded; the vendor's newer spec documents a
 *     posts/unpublish endpoint but it is UNVERIFIED — upgrade path noted in
 *     docs/social-accounts.md, never probed from here).
 *   - `verifyPost` treats "live" as terminal the moment the provider reports
 *     platform success + refs. It never waits on YouTube Shorts
 *     classification (lags ~2–3 min behind upload, verified live).
 *   - NO provider-side scheduling parameter is ever sent — our runtime owns
 *     all fire times (grep-fenced in verify-accounts.ts).
 *   - There is no provider idempotency key. `publish()` accepts OUR
 *     clientRef (the M-B manifest id) so callers can persist the
 *     request↔ref correlation BEFORE the call and recover via
 *     verifyPost/history afterward — the verify-before-republish rule.
 */

export type PublishProviderId = "upload_post";

/** The platforms the provider can carry. M-A links accounts only; M-B gates
 *  publishing per-platform (tiktok/instagram/facebook are Task 0b). */
export const PUBLISH_PLATFORMS = ["linkedin", "youtube", "tiktok", "instagram", "facebook"] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export interface CreateProfileResult {
  /** The provider-side profile username (we mint it; encrypted at rest). */
  profileRef: string;
  /** false when the profile already existed (409 → treated as success). */
  created: boolean;
}

export interface LinkUrlResult {
  /** The hosted account-linking page (JWT access_url; valid ~48 h). */
  url: string;
  expiresInHours: number | null;
}

export interface ProviderConnectedAccount {
  platform: PublishPlatform;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  /** The provider's token-lifecycle signal — maps onto our `expired`. */
  reauthRequired: boolean;
}

export type PublishKind = "text" | "video";

export interface PublishInput {
  profileRef: string;
  platform: PublishPlatform;
  kind: PublishKind;
  /** Post body for text; title/caption for video. */
  title: string;
  /** OUR correlation ref (M-B: the manifest id). The provider has no
   *  client-ref parameter — callers persist this BEFORE the call. */
  clientRef: string;
  firstComment?: string | null;
  /** kind "video" only. */
  videoBytes?: Buffer;
  filename?: string;
}

export interface PublishAccepted {
  /** "sync" = refs already present; "async" = poll verifyPost. */
  mode: "sync" | "async";
  providerRequestId: string | null;
  providerJobId: string | null;
  /** Present in sync mode on platform success. */
  platformPostId: string | null;
  postUrl: string | null;
  /** A per-platform failure inside an HTTP-200 envelope (e.g. LinkedIn's
   *  "Duplicate post detected" — verified live). null = accepted. */
  platformError: string | null;
  /** Monthly quota as reported by sync responses (async has none — we
   *  self-track on the ledger; there is no quota-read endpoint). */
  usage: { count: number; limit: number } | null;
}

export type VerifyState = "pending" | "live" | "failed";

export interface VerifyPostResult {
  state: VerifyState;
  platformPostId: string | null;
  postUrl: string | null;
  error: string | null;
}

export interface VerifyPostRef {
  profileRef: string;
  platform: PublishPlatform;
  providerRequestId: string;
}

export interface DeletePostResult {
  deleted: false;
  reason: "unsupported_by_provider";
}

/** A history row (GET /uploadposts/history, limit=10 — the only accepted
 *  page size). Fields are read defensively: the recorded Task 0a fixtures
 *  pin platform/success/request_id/refs; `title` is unverified vendor-spec
 *  surface, so recovery matching treats a null title as no-match. */
export interface ProviderRecentPost {
  platform: PublishPlatform | null;
  title: string | null;
  providerRequestId: string | null;
  platformPostId: string | null;
  postUrl: string | null;
  success: boolean;
}

export interface ProviderComment {
  id: string;
  text: string;
}

export interface SocialPublishProvider {
  readonly id: PublishProviderId;
  /** Idempotent per creator: an already-existing profile is success. */
  createCreatorProfile(profileRef: string): Promise<CreateProfileResult>;
  /** Hosted linking page URL (platform filter + return redirect). */
  getLinkUrl(profileRef: string, platforms: PublishPlatform[], redirectUrl: string): Promise<LinkUrlResult>;
  listConnectedAccounts(profileRef: string): Promise<ProviderConnectedAccount[]>;
  publish(input: PublishInput): Promise<PublishAccepted>;
  /** Poll-only verification; "live"/"failed" are terminal. */
  verifyPost(ref: VerifyPostRef): Promise<VerifyPostResult>;
  /** Recent uploads (history, limit=10). FALLBACK-ONLY (M-B decision 2):
   *  crash recovery adopts refs from here when the primary handle
   *  (provider_request_id) was never persisted — never the primary path. */
  listRecentPosts(profileRef: string): Promise<ProviderRecentPost[]>;
  /** Honest refusal — never fires a request (Task 0a Test 3). */
  deletePost(ref: { profileRef: string; platform: PublishPlatform; platformPostId: string }): Promise<DeletePostResult>;
  getComments(ref: { profileRef: string; platform: PublishPlatform; platformPostId: string }): Promise<ProviderComment[]>;
}

/**
 * A provider error retrying the SAME request can never fix (bad payload, bad
 * key, unknown profile). Duck-typed so services never import the adapter —
 * the isPermanentProviderError precedent from the clip render seam.
 */
export function isPermanentPublishError(err: unknown): err is Error & { permanent: true } {
  return err instanceof Error && (err as { permanent?: unknown }).permanent === true;
}
