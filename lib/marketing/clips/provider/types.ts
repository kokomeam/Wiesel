/**
 * ClipRenderProvider — the provider-agnostic render seam (PRD §9.2 + the
 * amendment + docs/reap-task0-findings.md "Adapter design (M-B) — final").
 *
 * Task-0-backed shape decisions (do not "improve" without re-reading the
 * findings doc):
 *   - UPLOAD-ONLY source path: Reap's sourceUrl fetcher rejects
 *     stream.mux.com (and archive.org) — the adapter is handed BYTES.
 *   - Exact spans are PRE-CUT before upload (create-clips re-picks inside
 *     any window; never used for our own moments). The provider only ever
 *     sees the final clip-length video.
 *   - POLL-FIRST: no webhooks exist anywhere in Reap's API — getJob() is
 *     the delivery path, driven by the render tick.
 *   - Layout delegation (D-5): face_track → provider reframe (face-weighted
 *     crop is right for a camera-only frame); stacked_split /
 *     screen_action_zoom / audiogram → in-house FFmpeg (the provider
 *     pan-crops toward a PiP face and has NO active-region tracking);
 *     slide_short → the M-F Remotion provider.
 *   - cost minutes come from the provider's own `billedDuration` at
 *     terminal status — never recomputed locally.
 *
 * Two implementations share this interface and ONE clip_render_job table:
 *   providers/reapClient.ts   (provider id 'reap')      — M-B
 *   render/slideShort.ts      (provider id 'wisesel_slides') — M-F
 * The in-house FFmpeg layouts are NOT a provider — they run inside the
 * render tick as a local step (no remote job to poll).
 */

export type RenderProviderId = "reap" | "wisesel_slides";

/** Normalized remote-job status (the reap statuses collapse onto these). */
export type ProviderJobStatus = "processing" | "completed" | "failed" | "cancelled";

export interface ProviderSubmitResult {
  /** The provider's job/project id — persisted as provider_ref. */
  providerRef: string;
  /** The provider's upload handle when applicable (audit). */
  uploadRef: string | null;
  /** Cost minutes as reported AT SUBMIT (Reap bills on ingested duration —
   *  confirmed T0; refreshed again at terminal status). */
  costMinutes: number | null;
}

export interface ProviderJobView {
  status: ProviderJobStatus;
  /** Raw provider status string (observability; never branched on). */
  providerStatus: string;
  /** Downloadable output (signed URL) once completed. H-6: adapters put the
   *  CLEAN render here (provider captions are never consumed — all burned
   *  text is applied in-house by the burn stage). */
  outputUrl: string | null;
  /** The clean (caption-free) variant when the provider renders both — the
   *  burn stage's preferred source (falls back to outputUrl). */
  cleanOutputUrl: string | null;
  /** Output stream metadata when the provider reports it. */
  output: { width: number; height: number; durationSeconds: number } | null;
  costMinutes: number | null;
  error: string | null;
}

/**
 * Submit input, discriminated by work kind. M-B ships `provider_reframe`
 * (face_track — the exact pre-cut span's bytes, reframed whole by the
 * provider; `create-reframe` takes NO caption/timeline params, verified
 * live — output arrives in clean + provider-captioned variants and the
 * packaging layer picks). M-F adds a `slide_short` member carrying its
 * SlideShortSpec.
 */
export type RenderSubmitInput = {
  kind: "provider_reframe";
  /** The EXACT pre-cut clip bytes (20-90s) — never the full lesson video. */
  bytes: Buffer;
  filename: string;
};

export interface ClipRenderProvider {
  readonly id: RenderProviderId;
  /** Upload the pre-cut bytes and start the render. */
  submit(input: RenderSubmitInput): Promise<ProviderSubmitResult>;
  /** Poll one remote job (the poll-first delivery path). */
  getJob(providerRef: string): Promise<ProviderJobView>;
  /** Best-effort cancel (revert path); resolving after terminal is a no-op. */
  cancel(providerRef: string): Promise<void>;
}

/**
 * A provider error retrying the SAME request can never fix (bad ref,
 * rejected payload, bad credentials). Adapters mark these with
 * `permanent: true`; the job step handler FAILS the job instead of
 * re-polling the same 4xx every tick forever (found live: a leaked test
 * job's fake project id 422'd on every pass, silently, as "[object
 * Object]"). Duck-typed so the service never imports an adapter.
 */
export function isPermanentProviderError(err: unknown): err is Error & { permanent: true } {
  return err instanceof Error && (err as { permanent?: unknown }).permanent === true;
}
