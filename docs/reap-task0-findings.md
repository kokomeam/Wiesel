# Task 0 — Reap smoke-test findings (Phase 1.5, gates M-B)

> **Status: PARTIALLY COMPLETE.** The API contract is now confirmed from
> Reap's live OpenAPI spec (`https://public.reap.video/openapi.json` —
> **not** documented on any public docs page we could find; the initial
> `npm run smoke:reap` guesses were all wrong field names, discovered and
> corrected via the spec). (a)/(b)/(c)/(e)-shape are answered below with real
> confidence. **(d) and a full render-to-completion are still open** — every
> render attempt so far failed on video-source compatibility (see below),
> not on our request shape. **CHECKPOINT before M-B**: the two open items
> need one real ≥90s video the API can actually fetch (a Mux-hosted mp4 from
> this app is the natural candidate — see "what's still needed" below).

Run metadata: date 2026-07-07 · API base `https://public.reap.video/api/v1/automation`
· spec source `https://public.reap.video/openapi.json` (FastAPI-generated,
live, authoritative — **use this over the PRD's assumed shapes for
everything in M-B**) · test video attempted: an archive.org MIT OCW lecture
mp4 (rejected — see below).

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

**⚠ Open question, NOT yet resolved — the load-bearing one for M-B:**
submitting `selectedStart: 60, selectedEnd: 105` (45s — one of OUR real,
validated 20–90s moment spans) was rejected with:
> `"Please select at least 1 minutes or longer from the timeline."`

**Reap enforces a ≥60s selection window on `create-clips`.** Our own
moment-selection engine (M-A, shipped) routinely validates genuine,
coherent, hook-integrity-checked moments in the 20–59s range (the live eval's
`flat_affect` fixture: 43s, 46s, 35s, 48s, 45s — none reach 60s). Two
unresolved possibilities once a ≥60s window is submitted:
1. Reap cuts **exactly** `selectedStart`→`selectedEnd` (so we'd just widen
   our own request by padding, e.g. ±10–15s each side, then trust our own
   boundaries were already validated) — safe, no fallback needed; **or**
2. Reap treats the window as a **search range for its own AI clip-picker**
   (`clipDurations`/`prompt`/`topics` exist alongside `selectedStart/End` in
   the same request — suggestive of "pick your own moment(s) within this
   range," not "cut exactly this"), which would silently discard our
   engine's editorial work (the whole product differentiator).

**Could not resolve which of the two is true** — every render attempt
failed on video-source fetching (archive.org rejected, see below) before a
render could complete and its output segments be inspected.
**Recommendation: adopt the pre-cut fallback as the SAFE default for M-B**
(cut our exact validated span server-side — no ffmpeg on this machine;
`fluent-ffmpeg`/`@ffmpeg-installer/ffmpeg` or a Vercel-side exec, OR pass a
padded window + inspect `get-clip-details.segments` against our intent and
fall back to pre-cut only when they diverge). **Do not finalize the M-B
adapter design until one real render's `segments` field is inspected.**

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

## (d) One render per preset, scored vs. OpusClip reference — NOT DONE

**Blocked on getting one video Reap can actually fetch to completion.**
Attempted: an archive.org direct-download MIT OCW lecture mp4 —
`POST /create-clips` returned:
> `"Unable to process video from archive.org. Please contact support."`

This reads as an archive.org-specific incompatibility (redirect handling,
user-agent sniffing, or rate-limiting on their end), not a general "Reap
can't fetch arbitrary URLs" finding — `VideoSource` enum includes
`Youtube`/`Vimeo`/`TwitchVod`/`Twitter`/`RumbleEmbed`/`Instagram`/`Generic`,
implying broad host support in normal operation. **This sandbox's network
egress is also restricted to a small allowlist** (confirmed: direct fetches
to archive.org/googleapis.com failed from THIS machine even via plain HEAD;
only reap.video and a couple of others are reachable) — so an alternative
was not testable end-to-end from here either.

**What IS fully confirmed and ready to use:** the direct-upload path.
`POST /get-upload-url {filename}` →
```jsonc
{
  "uploadUrl": "https://reap-user-upload-bkt-prod.s3-accelerate.amazonaws.com/studios/.../wisesel-smoke-test-....mp4?AWSAccessKeyId=...&Signature=...&content-type=video%2Fmp4&Expires=...",
  "id": "6a4d18bfdd32744e40487e89",   // this is the uploadId for later calls
  "fileName": "wisesel-smoke-test.mp4",
  "fileType": "video",
  "status": "upload",
  "createdAt": 1783437503, "updatedAt": 1783437503
}
```
PUT the video bytes to `uploadUrl` (S3 presigned, `Content-Type: video/mp4`,
matching what was requested), then pass `uploadId: id` to
`create-clips`/`create-transcription`/`create-reframe`. **This is the
adapter's real, most robust path** — it sidesteps host-compatibility
entirely since Reap never has to fetch a third-party URL. For M-B: upload
the Mux `mp4_url` bytes (fetch → re-upload) rather than passing `sourceUrl`
directly, unless a later test confirms Mux URLs work fine as `sourceUrl`.

**Next step to finish (d) + the (a) open question together:** from a
machine with normal network egress (or via the upload path above with any
real ≥90s mp4 on hand), submit one `create-clips` with `uploadId` +
`selectedStart`/`selectedEnd` spanning one of our real M-A candidate spans
padded to ≥60s, poll to `completed`, then read `get-project-clips` /
`get-clip-details.segments` to check whether the render matches our
intended sub-span or Reap's own re-selection. Do the OpusClip side-by-side
scoring on that same render.

## (e) TTFC + cost

Not measurable yet (no render reached `processing`/`completed` — every
attempt 400'd pre-project either on my field-name bug or on the
duration/host issues above). **What's confirmed:** a rejected request
(422/400) never creates a project (`get-all-projects` stayed at 0 after
every failed attempt) — no quota/cost is consumed on validation failures,
so iterating on the request shape is free. `get-project-status` response
shape is confirmed: `{ projectId, projectType, source, status }`, `status`
∈ `queued|prepped|draft|processing|finalizing|completed|cancelled|invalid|expired|failed|error`.
`AutomationProject.billedDuration` (a `number`) is very likely the
cost-minutes field M-B's `clip_render_jobs.cost_minutes` should read —
**unconfirmed until one job completes.**

## (f) Provider layout support — amendment FR-7, NOT YET RUNNABLE

Gated on the same blocker as (d)/(e): no video has reached a completed
render. What to probe once one does (the smoke script's render already
requests `reframeClips: true` + `exportOrientation: "portrait"`, so both
questions answer from the same runs):

- **stacked_split on composited footage:** WiseSel `screen_camera`
  recordings are ONE flattened canvas track (see (g)) — does Reap's facecam
  detection find the baked-in camera bubble and produce a usable split, or
  does it treat the frame as generic screen content? Determines whether the
  adapter can hand composited footage to the provider for `stacked_split`
  or must reframe in-house.
- **screen-only footage:** does the reframe track the ACTIVE screen region
  (cursor/typing/change hotspots) or blindly center-crop 16:9 → 9:16? If it
  center-crops, amendment FR-5 binds us to build the in-house
  `screen_action_zoom` path (FFmpeg zoompan keyframed from transcript cues +
  frame-diff hot zones) in M-B — fully, not stubbed.

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

## Adapter design changes surfaced for approval

1. **Field names are camelCase, not snake_case** — the whole M-B PRD section
   (§9.2's `ClipRenderProvider`) needs its example payloads corrected;
   trivial but must be done consistently (the adapter is the one file that
   touches Reap HTTP directly — get it right there once).
2. **Webhooks may not exist on this provider at all** — recommend designing
   M-B **poll-only from day one** (short-interval polling while a job is
   active, using the SAME reconciliation-sweep code the PRD already
   specifies for stranded jobs — just make it primary, not backup). Saves
   building webhook signature verification for a provider that may not
   support it. Confirm against the Reap dashboard settings first.
3. **No programmatic brand templates** — `ensureBrandTemplate()` becomes a
   static preset-id lookup table (our packaging preset → one of ~10 Reap
   system `captionsPreset` ids), not an API call. True creator branding
   (logo/colors/end-card matching `BrandSettings`) has to be layered on
   OUR side (post-download compositing, or accepted as a v1 limitation
   where Reap-side styling is generic and WiseSel branding lives only in
   the surrounding posting kit, not the video pixels).
4. **The ≥60s minimum vs. our 20–90s span range is the highest-risk open
   item** — recommend M-B defaults to the **pre-cut-and-upload path**
   (fetch our exact validated span's source bytes, trim server-side or via
   Mux's own clip/trim capability if available, upload via `get-upload-url`,
   then run `create-captions` + `create-reframe` — NOT `create-clips`' own
   moment-picking — over the already-precise upload) rather than trusting
   `selectedStart`/`selectedEnd` to cut exactly. This is more work than the
   optimistic "explicit timestamps" reading of (a) first suggested, but
   protects the actual product differentiator (our editorial engine's
   validated boundaries reaching the screen verbatim).

**What's still needed before this doc can be marked fully approved:** one
real ≥90s test video reachable either by Reap's `sourceUrl` fetcher or via
the upload path, run through to a completed render, to settle the (a)
open question and fill in (d)/(e). The cleanest source once M-B work starts
for real: any of this app's own Mux-hosted lesson recordings.

Approved by creator on: ______ → M-B unblocked (pending the item above).
