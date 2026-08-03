/**
 * Upload-Post adapter — the ONLY file in the repo that touches Upload-Post
 * HTTP (the reapClient/muxClient precedent: raw fetch, no SDK). Every shape
 * below is live-verified by Task 0a (2026-07-23) — fixtures recorded from the
 * real API live in lib/marketing/accounts/fixtures/task0a/ and drive the
 * verify-accounts adapter suite:
 *
 *   - Auth: `Authorization: Apikey <key>` on https://api.upload-post.com/api.
 *   - Publish endpoints are multipart/form-data; the SYNC response carries
 *     results.{platform}.{post_id, url, platform_post_id} + usage +
 *     request_id/job_id. A per-platform failure arrives INSIDE an HTTP-200
 *     envelope (results.{platform}.success=false + error — e.g. LinkedIn's
 *     consecutive-duplicate rejection).
 *   - Async accept: {request_id, job_id, total_platforms}. The status poll
 *     (GET /uploadposts/status?request_id=) is reference-complete
 *     (platform_post_id + post_url + error_message — RICHER than the vendor
 *     spec, which omits them); history (limit=10 ONLY — other limits are
 *     rejected) is the audit backstop.
 *   - listConnectedAccounts reads GET /uploadposts/users and picks our
 *     profile: social_accounts.{platform} is an object when connected, or
 *     ""/null placeholder when not.
 *   - deletePost NEVER fires a request — Task 0a Test 3 proved no delete
 *     endpoint (7 probes, all 404). The vendor's newer spec documents
 *     posts/unpublish (linkedin/youtube among supported) but it is
 *     UNVERIFIED; the upgrade path is documented in docs/social-accounts.md,
 *     deliberately not probed from production code.
 *
 * Hard fences (grep-tested in verify-accounts.ts): no scheduling parameter
 * (scheduled_date/timezone/add_to_queue/queue) is ever sent — our runtime
 * owns fire times; the webhook notifications endpoint is never referenced —
 * delivery is poll-only.
 */

import type {
  CreateProfileResult,
  DeletePostResult,
  LinkUrlResult,
  ProviderComment,
  ProviderConnectedAccount,
  ProviderRecentPost,
  PublishAccepted,
  PublishInput,
  PublishPlatform,
  SocialPublishProvider,
  VerifyPostRef,
  VerifyPostResult,
} from "./types";
import { PUBLISH_PLATFORMS } from "./types";

const DEFAULT_BASE = "https://api.upload-post.com/api";

export function isUploadPostConfigured(): boolean {
  return Boolean(process.env.UPLOAD_POST_API_KEY);
}

export class UploadPostError extends Error {
  /** True when retrying the SAME request can never succeed (a 4xx from the
   *  API — bad payload, bad key, unknown profile). NOT set for 408/429
   *  (transient by definition). The reapClient ReapError precedent. */
  readonly permanent: boolean;

  constructor(
    readonly op: string,
    readonly status: number,
    detail: string
  ) {
    super(`upload-post ${op} [${status}]: ${detail}`);
    this.name = "UploadPostError";
    this.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

/* ── raw response shapes (live-verified; kept local to the adapter) ────── */

interface RawPlatformResult {
  success?: boolean;
  post_id?: string;
  url?: string;
  platform_post_id?: string;
  error?: string;
  error_message?: string | null;
  [k: string]: unknown;
}

interface RawUploadResponse {
  success?: boolean;
  results?: Record<string, RawPlatformResult>;
  usage?: { count?: number; limit?: number };
  request_id?: string;
  job_id?: string;
  message?: string;
  [k: string]: unknown;
}

interface RawStatusEntry extends RawPlatformResult {
  platform?: string;
}

interface RawStatusResponse {
  status?: string; // pending | in_progress | completed
  completed?: number;
  total?: number;
  results?: RawStatusEntry[] | Record<string, RawStatusEntry>;
  [k: string]: unknown;
}

interface RawHistoryRow {
  platform?: string;
  success?: boolean;
  request_id?: string;
  platform_post_id?: string | null;
  post_url?: string | null;
  /** Unverified vendor-spec surface — read defensively, never required. */
  title?: string;
  [k: string]: unknown;
}

interface RawProfile {
  username?: string;
  social_accounts?: Record<string, unknown>;
}

function statusEntries(results: RawStatusResponse["results"]): RawStatusEntry[] {
  if (!results) return [];
  return Array.isArray(results)
    ? results
    : Object.entries(results).map(([platform, r]) => ({ platform, ...r }));
}

function detailFrom(json: unknown, text: string): string {
  if (json && typeof json === "object") {
    const j = json as Record<string, unknown>;
    const msg = j.message ?? j.error;
    if (typeof msg === "string") return msg;
    return JSON.stringify(json).slice(0, 400);
  }
  return text.slice(0, 400);
}

export function createUploadPostProvider(
  opts: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}
): SocialPublishProvider {
  const apiKey = opts.apiKey ?? process.env.UPLOAD_POST_API_KEY;
  const base = opts.baseUrl ?? process.env.UPLOAD_POST_API_BASE ?? DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!apiKey) throw new Error("Upload-Post provider requires UPLOAD_POST_API_KEY");

  async function call<T>(
    op: string,
    path: string,
    init: { method: string; json?: unknown; form?: FormData; okStatuses?: number[] } = { method: "GET" }
  ): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${base}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Apikey ${apiKey}`,
        ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.form as BodyInit | undefined),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.slice(0, 400) };
    }
    const ok = init.okStatuses ? init.okStatuses.includes(res.status) : res.ok;
    if (!ok) throw new UploadPostError(op, res.status, detailFrom(json, text));
    return { status: res.status, body: json as T };
  }

  function parseAccounts(profile: RawProfile): ProviderConnectedAccount[] {
    const out: ProviderConnectedAccount[] = [];
    for (const [platform, value] of Object.entries(profile.social_accounts ?? {})) {
      if (!(PUBLISH_PLATFORMS as readonly string[]).includes(platform)) continue;
      // "" / null are the provider's not-connected placeholders (verified live).
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      out.push({
        platform: platform as PublishPlatform,
        displayName: typeof v.display_name === "string" ? v.display_name : null,
        handle: typeof v.handle === "string" ? v.handle : null,
        avatarUrl: typeof v.social_images === "string" ? v.social_images : null,
        reauthRequired: v.reauth_required === true,
      });
    }
    return out;
  }

  return {
    id: "upload_post",

    async createCreatorProfile(profileRef: string): Promise<CreateProfileResult> {
      // 201 created · 409 already-exists = success (idempotent per creator).
      const { status } = await call<{ success?: boolean }>("create-profile", "/uploadposts/users", {
        method: "POST",
        json: { username: profileRef },
        okStatuses: [200, 201, 409],
      });
      return { profileRef, created: status !== 409 };
    },

    async getLinkUrl(
      profileRef: string,
      platforms: PublishPlatform[],
      redirectUrl: string
    ): Promise<LinkUrlResult> {
      const { body } = await call<{ success?: boolean; access_url?: string; duration?: string }>(
        "generate-jwt",
        "/uploadposts/users/generate-jwt",
        {
          method: "POST",
          json: {
            username: profileRef,
            redirect_url: redirectUrl,
            ...(platforms.length ? { platforms } : {}),
          },
        }
      );
      if (!body.access_url) throw new UploadPostError("generate-jwt", 200, "response missing access_url");
      const hours = body.duration ? Number.parseInt(body.duration, 10) : NaN;
      return { url: body.access_url, expiresInHours: Number.isFinite(hours) ? hours : null };
    },

    async listConnectedAccounts(profileRef: string): Promise<ProviderConnectedAccount[]> {
      const { body } = await call<RawProfile[] | { profiles?: RawProfile[] }>(
        "list-profiles",
        "/uploadposts/users",
        { method: "GET" }
      );
      const profiles = Array.isArray(body) ? body : (body.profiles ?? []);
      const mine = profiles.find((p) => p.username === profileRef);
      if (!mine) return [];
      return parseAccounts(mine);
    },

    async publish(input: PublishInput): Promise<PublishAccepted> {
      const form = new FormData();
      form.set("user", input.profileRef);
      form.append("platform[]", input.platform);
      form.set("title", input.title);
      if (input.firstComment) form.set("first_comment", input.firstComment);

      let path = "/upload_text";
      if (input.kind === "video") {
        if (!input.videoBytes) throw new Error("publish kind 'video' requires videoBytes");
        path = "/upload";
        form.set(
          "video",
          new Blob([new Uint8Array(input.videoBytes)], { type: "video/mp4" }),
          input.filename ?? `${input.clientRef}.mp4`
        );
        form.set("async_upload", "true");
      }

      const { body } = await call<RawUploadResponse>(`publish-${input.kind}`, path, {
        method: "POST",
        form,
      });

      const platformResult = body.results?.[input.platform] ?? null;
      const usage =
        body.usage && typeof body.usage.count === "number" && typeof body.usage.limit === "number"
          ? { count: body.usage.count, limit: body.usage.limit }
          : null;

      if (!platformResult) {
        // Async accept — refs arrive via verifyPost.
        return {
          mode: "async",
          providerRequestId: body.request_id ?? null,
          providerJobId: body.job_id ?? null,
          platformPostId: null,
          postUrl: null,
          platformError: null,
          usage,
        };
      }

      return {
        mode: "sync",
        providerRequestId: body.request_id ?? null,
        providerJobId: body.job_id ?? null,
        platformPostId: platformResult.platform_post_id ?? platformResult.post_id ?? null,
        postUrl: platformResult.url ?? null,
        platformError:
          platformResult.success === false
            ? (platformResult.error ?? platformResult.error_message ?? "platform reported failure")
            : null,
        usage,
      };
    },

    async verifyPost(ref: VerifyPostRef): Promise<VerifyPostResult> {
      const { body } = await call<RawStatusResponse>(
        "status",
        `/uploadposts/status?request_id=${encodeURIComponent(ref.providerRequestId)}`,
        { method: "GET" }
      );
      const entry = statusEntries(body.results).find(
        (r) => (r.platform ?? "").toLowerCase() === ref.platform
      );

      if (body.status !== "completed" && entry?.success === undefined) {
        return { state: "pending", platformPostId: null, postUrl: null, error: null };
      }
      if (entry?.success === false) {
        return {
          state: "failed",
          platformPostId: null,
          postUrl: null,
          error:
            (typeof entry.error_message === "string" && entry.error_message) ||
            (typeof entry.error === "string" && entry.error) ||
            "platform reported failure",
        };
      }
      if (entry?.success === true) {
        let postId = entry.platform_post_id ?? entry.post_id ?? null;
        let postUrl = entry.url ?? (entry as { post_url?: string }).post_url ?? null;
        if (!postId && !postUrl) {
          // Spec-shaped status without refs (never observed live, but the
          // vendor spec omits them) — history is the audit backstop.
          const { body: hist } = await call<{ history?: RawHistoryRow[] }>(
            "history",
            "/uploadposts/history?limit=10&page=1",
            { method: "GET" }
          );
          const row = (hist.history ?? []).find(
            (h) =>
              h.request_id === ref.providerRequestId &&
              (h.platform ?? "").toLowerCase() === ref.platform &&
              h.success === true
          );
          postId = row?.platform_post_id ?? null;
          postUrl = row?.post_url ?? null;
        }
        // "live" is terminal the moment the provider reports success — we
        // never wait on Shorts classification (lags minutes behind, T0a).
        return { state: "live", platformPostId: postId, postUrl, error: null };
      }
      // completed but our platform never reported — treat as pending; the
      // caller's retry budget decides when to give up.
      return { state: "pending", platformPostId: null, postUrl: null, error: null };
    },

    async listRecentPosts(): Promise<ProviderRecentPost[]> {
      // History is API-key-scoped (no user param — verified in Task 0a's
      // recorded fixture); limit=10 is the only accepted page size.
      const { body } = await call<{ history?: RawHistoryRow[] }>(
        "history",
        "/uploadposts/history?limit=10&page=1",
        { method: "GET" }
      );
      return (body.history ?? []).map((h) => {
        const platform = (h.platform ?? "").toLowerCase();
        return {
          platform: (PUBLISH_PLATFORMS as readonly string[]).includes(platform)
            ? (platform as PublishPlatform)
            : null,
          title: typeof h.title === "string" ? h.title : null,
          providerRequestId: h.request_id ?? null,
          platformPostId: h.platform_post_id ?? null,
          postUrl: h.post_url ?? null,
          success: h.success === true,
        };
      });
    },

    async deletePost(): Promise<DeletePostResult> {
      // Task 0a Test 3: NO delete endpoint exists (7 probes, all 404).
      // Honest refusal — deliberately no request is fired.
      return { deleted: false, reason: "unsupported_by_provider" };
    },

    async getComments(ref: {
      profileRef: string;
      platform: PublishPlatform;
      platformPostId: string;
    }): Promise<ProviderComment[]> {
      // Query param is `user`, NOT `profile` (400 otherwise — verified live).
      const { body } = await call<{ success?: boolean; comments?: Array<Record<string, unknown>> }>(
        "comments",
        `/uploadposts/comments?user=${encodeURIComponent(ref.profileRef)}&platform=${encodeURIComponent(
          ref.platform
        )}&post_id=${encodeURIComponent(ref.platformPostId)}`,
        { method: "GET" }
      );
      return (body.comments ?? []).map((c) => ({
        id: typeof c.id === "string" ? c.id : String(c.id ?? ""),
        text:
          typeof (c.message as { text?: unknown } | undefined)?.text === "string"
            ? ((c.message as { text: string }).text)
            : typeof c.text === "string"
              ? c.text
              : "",
      }));
    },
  };
}
