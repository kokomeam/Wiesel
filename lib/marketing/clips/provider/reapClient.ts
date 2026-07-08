/**
 * Reap adapter — the ONLY file in the repo that touches Reap HTTP (the
 * muxClient.ts precedent: fetch + bearer auth, no SDK). Everything here is
 * backed by docs/reap-task0-findings.md (live-verified 2026-07-08):
 *
 *   - camelCase field names (`uploadId`, not `upload_id`)
 *   - UPLOAD-ONLY: get-upload-url → presigned S3 PUT → uploadId (Reap's
 *     sourceUrl fetcher rejects stream.mux.com — never pass URLs)
 *   - face_track renders via `create-reframe` (renders the WHOLE upload
 *     verbatim — the non-picking endpoint; `create-clips` re-picks inside
 *     any window and is NEVER used for our own validated moments)
 *   - POLL-FIRST: no webhooks exist in the API; getJob() drives delivery
 *   - a reframe project's OUTPUT rides get-project-clips (ONE clip with
 *     clipUrl + clipWithCaptionsUrl); `urls.videoFile` on the project
 *     details is the SOURCE working video — do not download that
 *   - costMinutes = the provider's `billedDuration` (selected duration in
 *     minutes, floor/round — never recomputed locally)
 *
 * Hard fence (grep-tested): the provider's posting/scheduling endpoints are
 * never referenced — WiseSel never posts or schedules on the creator's
 * behalf; the creator publishes every clip manually.
 */

import type {
  ClipRenderProvider,
  ProviderJobStatus,
  ProviderJobView,
  ProviderSubmitResult,
  RenderSubmitInput,
} from "./types";

const DEFAULT_BASE = "https://public.reap.video/api/v1/automation";

export function isReapConfigured(): boolean {
  return Boolean(process.env.REAP_API_KEY);
}

interface ReapProject {
  id?: string;
  status?: string;
  billedDuration?: number;
  [k: string]: unknown;
}

interface ReapClip {
  clipUrl?: string;
  clipWithCaptionsUrl?: string;
  metadata?: { width?: number; height?: number; duration?: number };
  [k: string]: unknown;
}

/** queued|prepped|draft|processing|finalizing → processing; the rest map 1:1. */
export function normalizeReapStatus(status: string | undefined): ProviderJobStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "invalid":
    case "expired":
    case "failed":
    case "error":
      return "failed";
    default:
      return "processing";
  }
}

export class ReapError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    detail: string
  ) {
    super(`reap ${op} [${status}]: ${detail}`);
    this.name = "ReapError";
  }
}

export function createReapProvider(
  opts: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}
): ClipRenderProvider {
  const apiKey = opts.apiKey ?? process.env.REAP_API_KEY;
  const base = opts.baseUrl ?? process.env.REAP_API_BASE ?? DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!apiKey) throw new Error("Reap provider requires REAP_API_KEY");

  async function call<T>(op: string, path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { detail: text.slice(0, 400) };
    }
    if (!res.ok) {
      const detail =
        (json as { detail?: string })?.detail ?? (typeof json === "string" ? json : JSON.stringify(json).slice(0, 400));
      throw new ReapError(op, res.status, String(detail));
    }
    return json as T;
  }

  return {
    id: "reap",

    async submit(input: RenderSubmitInput): Promise<ProviderSubmitResult> {
      if (input.kind !== "provider_reframe") {
        throw new Error(`reap provider cannot render '${(input as { kind: string }).kind}'`);
      }
      const upload = await call<{ id?: string; uploadUrl?: string }>(
        "get-upload-url",
        "/get-upload-url",
        "POST",
        { filename: input.filename }
      );
      if (!upload.id || !upload.uploadUrl) {
        throw new ReapError("get-upload-url", 200, "response missing id/uploadUrl");
      }
      const put = await fetchImpl(upload.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: input.bytes as unknown as BodyInit,
      });
      if (!put.ok) {
        throw new ReapError("upload-put", put.status, (await put.text()).slice(0, 300));
      }
      const project = await call<ReapProject>("create-reframe", "/create-reframe", "POST", {
        uploadId: upload.id,
        genre: "talking",
        orientation: "portrait",
      });
      if (!project.id) throw new ReapError("create-reframe", 200, "response missing project id");
      return {
        providerRef: project.id,
        uploadRef: upload.id,
        costMinutes: typeof project.billedDuration === "number" ? project.billedDuration : null,
      };
    },

    async getJob(providerRef: string): Promise<ProviderJobView> {
      const st = await call<ReapProject>(
        "get-project-status",
        `/get-project-status?projectId=${encodeURIComponent(providerRef)}`,
        "GET"
      );
      const status = normalizeReapStatus(st.status);
      if (status !== "completed") {
        return {
          status,
          providerStatus: st.status ?? "unknown",
          outputUrl: null,
          cleanOutputUrl: null,
          output: null,
          costMinutes: null,
          error: status === "failed" ? `provider terminal status: ${st.status}` : null,
        };
      }
      const [details, clipsRes] = await Promise.all([
        call<ReapProject>(
          "get-project-details",
          `/get-project-details?projectId=${encodeURIComponent(providerRef)}`,
          "GET"
        ),
        call<{ clips?: ReapClip[] }>(
          "get-project-clips",
          `/get-project-clips?projectId=${encodeURIComponent(providerRef)}`,
          "GET"
        ),
      ]);
      const clip = clipsRes.clips?.[0];
      const meta = clip?.metadata;
      return {
        status: "completed",
        providerStatus: st.status ?? "completed",
        outputUrl: clip?.clipWithCaptionsUrl ?? clip?.clipUrl ?? null,
        cleanOutputUrl: clip?.clipUrl ?? null,
        output:
          meta && meta.width && meta.height
            ? {
                width: meta.width,
                height: meta.height,
                durationSeconds: meta.duration ?? 0,
              }
            : null,
        costMinutes: typeof details.billedDuration === "number" ? details.billedDuration : null,
        error: null,
      };
    },

    async cancel(providerRef: string): Promise<void> {
      try {
        await call("cancel-project", "/cancel-project", "POST", { projectId: providerRef });
      } catch (err) {
        // Cancelling an already-terminal project is a no-op, not a failure —
        // the revert path must never throw over a race with completion.
        if (err instanceof ReapError && err.status < 500) return;
        throw err;
      }
    },
  };
}
