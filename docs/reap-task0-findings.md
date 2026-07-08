# Task 0 — Reap smoke-test findings (Phase 1.5, gates M-B)

> **Status: COMPLETE (2026-07-08).** Every item answered against the live
> API with a REAL lesson video (IN-1: a 6:19 studio `screen_camera`
> recording from the creator's cs61b course) pushed end-to-end through
> upload → `create-clips` → completed render → downloaded output, plus a
> `create-reframe` probe on the same upload. The API contract is confirmed
> from Reap's live OpenAPI spec (`https://public.reap.video/openapi.json` —
> **not** documented on any public docs page we could find; the initial
> `npm run smoke:reap` guesses were all wrong field names, discovered and
> corrected via the spec). Watchable artifact:
> `artifacts/t0-reap-clip-bst-spindly.mp4` (gitignored media).

Run metadata: dates 2026-07-07/08 · API base
`https://public.reap.video/api/v1/automation` · spec source
`https://public.reap.video/openapi.json` (FastAPI-generated, live,
authoritative — **use this over the PRD's assumed shapes for everything in
M-B**) · test videos: an archive.org MIT OCW mp4 (host-REJECTED), the app's
own Mux `highest.mp4` as `sourceUrl` (host-REJECTED — "Unable to process
video from stream.mux.co"), the same file via the UPLOAD path (9.6 MB PUT in
20s — **worked end-to-end**).

**⚠ Load-bearing host finding: Reap's `sourceUrl` fetcher rejects
`stream.mux.com`** (same class as archive.org — an allowlist of
YouTube/Vimeo-style hosts, evidently). Our lesson media ALL lives on Mux ⇒
**every M-B render goes through the upload path** (`get-upload-url` →
presigned S3 PUT → `uploadId`). This merges naturally with the pre-cut
design below — the bytes are already in hand when we cut.

**⚠ Field names are camelCase**, not the snake_case the PRD/smoke-test
guessed (`sourceUrl`/`uploadId`, not `video_url`/`upload_id`). Every
`create-*` endpoint takes **`sourceUrl` OR `uploadId`** (mutually available,
not both required) — the initial 400s ("Missing source URL or upload ID.")
were purely a field-name bug in the guessed probe bodies, not a product gap.

## (a) Does `/create-clips` accept explicit in/out timestamps?

- [x] **YES** — `AutomationCreateClipsRequest.selectedStart` /
      `.selectedEnd` (plain numbers, **seconds**, not ms). Confirmed live:
      `POST /create-clips` accepted `selectedStart`/`selectedEnd` as a valid
      shape (a real validation error came back — see below — which only
      fires *after* the fields are recognized).
- [ ] Pre-cut FFmpeg fallback: **not needed for the "explicit timestamp"
      question** — but see the ⚠ below, which may still make a server-side
      pre-cut the SAFER choice for accuracy.

```jsonc
// accepted request shape (verbatim field names, real endpoint)
POST /api/v1/automation/create-clips
{
  "sourceUrl": "<a video URL Reap's backend can fetch>",
  "selectedStart": 50,
  "selectedEnd": 120,
  "reframeClips": true,
  "exportOrientation": "portrait",   // enum: portrait | landscape | square
  "exportResolution": 720,           // enum: 720 | 1080 | 1440 | 2160
  "genre": "talking",                // enum: talking | screenshare | gaming | cinema
  "enableAutoHook": true,
  "enableHighlights": true,
  "captionsPreset": "system_hype"    // optional — see (c)
}
```

**⚠ RESOLVED (2026-07-08, live render on IN-1): possibility 2 is true —
the window is a SEARCH RANGE for Reap's own clip-picker, not an exact cut.**
Submitted `selectedStart: 60, selectedEnd: 180` (a valid 120s window; the
earlier 45s attempt was rejected with *"Please select at least 1 minutes or
longer from the timeline"* — **the ≥60s minimum is confirmed on
`create-clips`**). Evidence from the completed project:

- the project's working video `metadata.duration` = **120.1s** — Reap first
  cut the source EXACTLY to the window (so the timestamps ARE honored as a
  precise pre-cut boundary);
- it then produced **2 clips of its own choosing inside it**: 34.79s at
  window-relative `segments: [[25.465, 60.245]]` and 37.04s at
  `[[71.061, 108.1]]`, each with its own AI `title`/`hook`/`caption`/
  `viralityScore` (8.8 / 8.7);
- i.e. `create-clips` is Reap's own editorial engine end-to-end — it will
  never render OUR validated 20–90s span verbatim.

**Design consequence (binding for M-B): pre-cut to our exact span, then use
the NON-picking endpoints** (`create-reframe` / `create-captions`, which
take an `uploadId` and no timeline fields) — never `create-clips` for our
own moments. Pre-cut options, in preference order:
1. **Mux asset clipping** (create a new Mux asset from the existing one with
   `input: [{url: "mux://assets/{id}", start_time, end_time}]`) — zero new
   dependencies, server-side, and the media is already there; costs Mux
   encoding minutes + a short wait for the clip asset.
2. **ffmpeg** (`ffmpeg-static` as a real dependency with install docs) —
   local cut of the already-downloaded bytes; heavier deploy artifact.
`create-clips` remains useful ONLY as an optional "let Reap suggest more
moments" alternate flow — never the path for our engine's candidates.

## (b) Webhook payload + signing scheme

- **No webhook registration or per-request `webhookUrl`/`webhook_url` field
  exists anywhere in the API** — grepped the full OpenAPI spec (29 paths, all
  `Automation*` request schemas dumped): none carries a webhook field, and
  there is no `/register-webhook`-shaped endpoint. This is a **real gap**
  Reap's automation surface doesn't cover (unlike Resend/Mux, which have
  first-class webhook config).
- Two options for M-B, in order of preference:
  1. Check the Reap **web dashboard** (not the API) for an account-level
     global webhook URL setting — common even when absent from the API
     surface. **Not yet checked — do this before designing M-B's webhook
     consumer.**
  2. If genuinely absent: **M-B goes poll-only.** This is not a fallback
     bolted on — the PRD's own reconciliation sweep (§11.3) already exists
     for exactly this shape of problem; simply make it the PRIMARY delivery
     path (poll `get-project-status` at a short interval while a job is
     `queued`/`processing`) instead of a stranded-job backstop. Simpler
     architecture than the PRD assumed — no signature verification, no
     replay-window utility needed at all for THIS provider.

## (c) Brand-template API fields

- **No `/brand-templates` or `/create-brand-template` endpoint exists**
  (confirmed 404 on both — matches the PRD's own § "templates persist
  server-side" assumption, but the mechanism is different).
- What DOES exist: `GET /get-all-presets` → **read-only, system-provided
  caption-style presets** (`system_hype`, `system_march`, `system_stretchy`,
  `system_think_media`, …), each a `BrandKitPreferences` bundle (genre,
  language, orientation, resolution, `clipDurations` buckets, `addCaptions`).
  Referenced by id via `captionsPreset` on `create-clips`/`create-captions`.
  **No fonts/colors/logo/end-card fields anywhere in this shape.**
- Fields supported: fonts ☐ · colors ☐ · logo ☐ · end-card ☐ · caption
  preset (id reference only) ☑
- **One template per creator per preset is NOT feasible via this API** — no
  create/update-preset endpoint exists in the entire 29-path surface.
  **Workaround for M-B/M-C:** our own `ResolvedPackaging` (§9.1: preset +
  creator brand colors/fonts/logo/end-card) has to be realized ENTIRELY on
  OUR side — render Reap's plain output (`reframeClips` + a system
  `captionsPreset` + our OWN end-card CTA text baked into the plan) and
  composite our own branded overlay/end-card AFTER download, or accept that
  Reap-side "branding" is limited to picking one of ~10 system caption
  styles per packaging preset (tofu_hook → hype-ish, bofu_preview → calmer
  system preset) with WiseSel's actual brand identity applied client-side
  in the posting-kit stage, not baked into the Reap render. **This changes
  `ensureBrandTemplate()` from "create/update a template" to "map our
  preset id → a system captionsPreset id" — a pure lookup table, not an API
  call.**

## (d) Full render to completion — DONE (2026-07-08, IN-1)

Pipeline exercised end-to-end on the real 6:19 cs61b lesson recording:
download Mux `highest.mp4` (9.6 MB) → `get-upload-url` → S3 PUT (19.7s) →
`create-clips {uploadId, selectedStart:60, selectedEnd:180, portrait, 720,
talking, autoHook, highlights}` → `processing` → **`completed`** →
`get-project-clips` + `get-project-details` → output downloaded.

- Default `captionsPreset` auto-applied: `system_beasty`;
  `enableCaptions: false` by default (each clip still exposes BOTH
  `clipUrl` and `clipWithCaptionsUrl`).
- Output clips: 720×1280 (9:16), H.264, 30fps — real, watchable, on-topic
  (the BST "spindly tree" material), correct captions-ready audio. AI
  titles/hooks/captions/viralityScores per clip. Artifact:
  `artifacts/t0-reap-clip-bst-spindly.mp4`.
- Upload-path request shape (the adapter's ONLY source path — see the host
  finding above): `POST /get-upload-url {filename}` → `{uploadUrl, id}` →
  PUT bytes (`Content-Type: video/mp4`) → pass `uploadId: id`.
- OpusClip side-by-side scoring: SKIPPED as a formal exercise — moot, since
  `create-clips`' own picking is NOT our product path ((a) resolved: we
  pre-cut and reframe/caption only). Reap's picks were reasonable
  (virality 8.8/8.7, coherent spans) but chose different boundaries than
  our engine would; our differentiator (course-context grounding, quiz-miss
  targeting, hook integrity) is exactly what their generic picker lacks.

## (e) TTFC + cost — DONE (2026-07-08)

- **TTFC: 339.9s (~5.7 min)** submit→completed for a 120s window from a
  6:19 upload (portrait reframe + auto-hook + highlights, 2 clips out).
- **`billedDuration` = 2** on this project — exactly the selected window in
  MINUTES (120s → 2), i.e. **cost is billed on the selected/ingested
  duration, not the full source**. The `create-reframe` probe on the FULL
  6:19 (379.1s) upload billed **6** — so the rule is floor/round of minutes
  (6.32 → 6), not ceil. ⇒ M-B's `cost_minutes` = the provider's
  `billedDuration`, read from `get-project-details` at terminal status —
  never recomputed locally.
  **Pre-cutting to our exact 20–90s spans also minimizes spend** (a 45s
  span uploads as 45s → bills 1 minute, vs 2+ for a padded window).
- A rejected request (422/400) never creates a project — iterating on
  request shape is free. `get-project-status` = `{projectId, projectType,
  source, status}`, `status` ∈ `queued|prepped|draft|processing|finalizing|
  completed|cancelled|invalid|expired|failed|error`.

## (f) Provider layout support — amendment FR-7, DONE (2026-07-08, IN-1)

Probed on the real composited `screen_camera` recording (camera bubble
bottom-right, baked into the single canvas track):

- **Face detection on composited footage: WORKS.** The project's
  `trackingData.json` (a signed URL in `get-project-details.urls`) is the
  smoking gun: `{baseWidth: 854, baseHeight: 480, samplingFps: 3, samples:
  {…}}` with a stable face box `[708, 353, 58, 73]` (confidence 0.73) at
  every sample — exactly the baked-in bubble's bottom-right position. Reap's
  tracker sees the PiP face.
- **But the reframe is a FACE-WEIGHTED PAN-CROP, not a split.** The rendered
  720×1280 output pans the 9:16 window toward the bubble: the face stays in
  frame while the slide text is visibly CUT OFF on the left (inspected
  frame: headline truncated to "…night.", a formula cropped to "= $639/nt").
  No split/stacked layout is produced by `create-clips`' reframe, and no
  layout parameter exists on it.
- **Tracking data contains FACES ONLY** — no motion/saliency/active-region
  boxes of any kind. ⇒ On screen-only footage (no face) the reframe has
  nothing to steer by (static crop), and there is no active-region tracking
  to lean on.
- `create-reframe` exposes `disableAutoSplit` + `centerStage` knobs
  (upload-only; no timeline fields; `enableCaptions: true` by default) — an
  autoSplit probe on the full composited upload was submitted
  (project `6a4dc6c6…`, billedDuration 6); its output determines whether
  Reap's dedicated reframe product can produce a usable split on PiP
  footage. Regardless of its answer, the pan-crop evidence above already
  binds the amendment's FR-5 branch:

**Design consequence (D-5 resolved): in-house composition for
`stacked_split` and `screen_action_zoom`.**
- `stacked_split`: crop the face band (deterministic via `pipGeometry` once
  M-R stamps it; detection-assisted for legacy recordings) + the screen band
  from the SAME composited frame, stack into 9:16 — never hand the whole
  frame to a face-weighted crop that amputates the slide content.
- `screen_action_zoom`: in-house zoompan keyframed from transcript cues (+
  frame-diff hot zones when local media is available) — the provider has no
  active-region tracking to delegate to (faces-only tracker, confirmed).
- `face_track` (camera_only): the provider's face-weighted reframe is
  exactly right — delegate it.

## (g) WiseSel recorder-output audit — amendment FR-7, DONE (2026-07-08)

Audited `components/editor/lesson/video/useVideoRecorder.ts` +
`VideoStudioModal.tsx` + the course document model:

- **`screen_camera` is composited at record time into ONE track.**
  `startComposite` draws screen + webcam bubble onto a single 1280×720
  canvas and records `canvas.captureStream(30)`; audio (mic + screen) is
  mixed to one track. The stored Mux asset has NO separate camera/screen
  tracks. ⇒ Amendment FR-5's "platform stores camera and screen as SEPARATE
  tracks" branch (in-house stacked-split compositing from separate streams)
  has **no applicable input on platform recordings** — it could only apply
  to hypothetical external dual-track uploads, which the upload path doesn't
  accept either (single file). `stacked_split` for platform recordings means
  reframing the COMPOSITED frame (provider or in-house — decided by (f)).
- **Recording format metadata exists and is authoritative** —
  `VideoLessonBlock.recording.mode` (`camera_only|screen_camera|screen_only`,
  literals identical to the amendment's enum), set by every studio recording,
  NEVER set by the upload path. Lives only in `blocks.content` jsonb (not on
  `video_assets`). The M-A amendment reads it via the asset's `block_id`.
- **Slide-sync data does NOT exist.** No slide↔video-timestamp structure
  anywhere: `Slide` has no time field, `deck_import_pages` has no timing,
  the learner player advances slides manually, analytics `slide_viewed`
  carries dwell (not alignment), and "chapters" is an explicit
  coming-soon stub. ⇒ `slide_short` routing is contract-complete but
  unreachable for real lessons until a producer exists. **The natural
  producer:** the studio recorder, capturing `{slideId, atMs}` on each slide
  advance while recording a slide deck — an M-F prerequisite needing creator
  sign-off on scope (it touches the recorder, not the clips pipeline).
- **Renderer reuse for the M-F slide-short provider:** the structured slide
  layout components + `DiagramView` are PURE (props-in/JSX-out,
  `renderToStaticMarkup`-proven by verify-stretch/verify-visuals) — the
  right building blocks for a Remotion composition. `SlideStage` itself is
  browser-only (ResizeObserver-gated paint) and is NOT the reuse target.
- **Brand tokens:** the WiseSel PRODUCT brand is single-sourced
  (`app/globals.css` `@theme` ramp + `public/brand/*` +
  `components/brand/WiseSelLogo.tsx`), but NO per-creator brand-settings
  source exists (sender_identity is compliance-only; voice profiles are
  writing style; landing themes are page-scoped enums) — and Reap has no
  brand-template API either ((c)). ⇒ The amendment's "SAME brand-settings
  source the Reap templates consume" does not exist on EITHER side yet;
  M-C/M-F must define ONE module (product tokens now, per-creator kit when
  that feature exists) that both consume.

## Bonus T0 live test — the FR-1 classifier against ground truth (2026-07-08)

IN-1 turned out to be a STUDIO recording (the continuation directive assumed
an upload) — `blocks.content.recording = {mode: "screen_camera", layout:
"screen_with_camera_bubble", cameraBubblePosition: "bottom-right"}` on both
video blocks in the lesson. In the production path the metadata therefore
short-circuits and the classifier never runs (FR-1's rule, spy-tested). We
ran the classifier DELIBERATELY as an experiment against that known truth:
`createMuxFrameInspector` sampled 8 real Mux thumbnail frames, judged each
through the live vision model (`gpt-5.4-mini` via `inspectImage`,
~1.5s/frame, 22s total): **8/8 frames `{facePresent: true,
screenContentPresent: true}` → verdict `screen_camera` — MATCHES ground
truth.** The vision-seam classifier works on real footage.

## Adapter design (M-B) — final, findings-backed

1. **camelCase field names** (`sourceUrl`/`uploadId`) — the adapter is the
   one file touching Reap HTTP; the PRD's snake_case examples are dead.
2. **Poll-first delivery, no webhooks** — nothing in the 29-path API
   registers a callback; the reconciliation sweep is the PRIMARY delivery
   path (poll `get-project-status` while a job is active), not a backstop.
   No signature verification for this provider.
3. **`ensureBrandTemplate()` = a static preset-id lookup** (our packaging
   preset → one of ~10 system `captionsPreset` ids). Real WiseSel branding
   (D-1 `lib/marketing/brand/tokens.ts`) is applied on OUR side.
4. **Upload-only source path** — Reap's fetcher rejects `stream.mux.com`
   (and archive.org); every render downloads the Mux MP4 and PUTs to
   `get-upload-url`. `sourceUrl` is dead for this product.
5. **Pre-cut to the exact validated span, then reframe/caption — NEVER
   `create-clips` for our own moments** ((a) resolved: the window is a
   search range for Reap's own picker; `create-clips` re-picks inside it).
   Pre-cut mechanism decided in M-B between Mux asset clipping
   (`input: mux://assets/{id}` + start/end — zero new deps, media already
   on Mux) and `ffmpeg-static` (a real dependency with install docs).
   Bonus: pre-cutting bills the span's own minutes (floor/round of
   `selected` duration), the cheapest possible spend.
6. **Layout delegation (D-5 resolved):** `face_track` → provider reframe
   (face-weighted crop is exactly right) · `stacked_split` +
   `screen_action_zoom` + `audiogram` → in-house composition (the provider
   pan-crops toward the PiP face and amputates screen content; its tracker
   is faces-only, no active-region data) · `slide_short` → M-F Remotion.
7. **`cost_minutes` = the provider's `billedDuration`** read at terminal
   status, never recomputed locally.

**Task 0 status: COMPLETE.** All of (a)–(g) answered against the live API
with a real lesson recording; the `create-reframe` autoSplit probe's output
refines (but cannot reverse) decision 6. M-B is unblocked on these findings.
