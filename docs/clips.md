# Lesson Clip Repurposing — Marketing Phase 1.5

> PRD: the Phase 1.5 "Lesson Clip Repurposing" spec + the format-aware
> amendment + the continuation directive — **ALL MILESTONES SHIPPED
> (2026-07-14): Task 0 · M-A(+amendment) · M-B · M-C · M-R · M-D · M-E ·
> M-F · M-G.** Task 0 findings: `docs/reap-task0-findings.md` (live-verified
> against the real Reap API + a real lesson recording). Phase 1 foundation:
> `docs/social-posts.md`. **Live-usage fix pass 2026-07-15** — see
> § First-live-usage fixes below (recorder hidden-tab freeze, delivery-loop
> polling, frozen-source guard, permanent provider errors, idempotency
> retry).

## What this is

Creators turn real lesson recordings into short-form vertical clip **candidates**:
the engine transcribes the lesson (or reuses the Mux caption transcript), runs a
course-context-aware **moment selection engine** over it, and stages the 3–5 most
teachable, hook-worthy spans as ranked candidates — each with an honest hook,
2 alternates, funnel-stage fit, a resolved LAYOUT, and a creator-facing
rationale. Candidates RENDER (provider reframe or in-house ffmpeg/Remotion,
by layout), ingest into the one social queue, and ship with a posting kit
(caption/keyword/short link/disclosure) the creator copies and posts
MANUALLY. The whole surface lives at `/marketing/clips`.

The strategic bet (PRD §0): horizontal tools pick moments by vocal energy;
WiseSel picks them by the **course graph** — lesson outcomes, module context,
and **quiz-miss concepts** (the questions students get wrong are the strongest
clip subjects, and no generic tool can see them).

## Architecture (M-A slice)

```
lesson ──► [1] TRANSCRIPT ACQUISITION (lib/marketing/clips/transcripts.ts)
              cache (lesson_transcript, one row per lesson)
              → platform: video_assets.transcript_vtt → interpolated words
              → provider: TranscriptionProvider seam (Reap adapter lands M-B)
        ──► [2] MOMENT SELECTION (selection.ts · runSelectionCore — DB-free,
              shared VERBATIM with the eval harness)
              context.ts (course + lesson + QUIZ-MISS via rollup_question_stats)
              prompt.ts (versioned static prefix, §8) → ONE mid-tier structured
              call (map→reduce for over-budget transcripts, SEQUENTIAL small-tier
              map) → Zod gate + exactly ONE repair (Phase 1 semantics)
        ──► [3] VALIDATION (validate.ts, deterministic first)
              bounds/duration/platform-caps/overlap/rubric-bar/hook-numbers/
              safety-lint (SHARED §17.2 rules via social/lint.lintFreeText)
              → the ONE small-tier validation call: standalone-coherence
              (±8s adjust or drop; multi-segment NEVER adjusted) + hook
              integrity (first supported hook promoted; none → drop)
        ──► persist clip_moment_candidate (request_id = the revert unit)
              + events on the single analytics_event stream
```

Three surfaces, one seam: the REST route
(`/api/marketing/lessons/:lessonId/clip-moments`), the future clips UI, and the
agent all call `executeMarketingTool` → the gate. All three clip tools are
**reversible-tier — no approval cards anywhere in this feature** (PRD §13):
`select_clip_moments` (revert removes the whole candidate set via the
`clip_moment_set` composite snapshotter keyed on `request_id`),
`list_clip_moment_candidates` (read), `update_clip_moment_status` (single-row
snapshot/restore).

## The §8 prompt is a versioned artifact

- `CLIP_PROMPT_VERSION` (`lib/marketing/clips/prompt.ts`, currently `clips-v1`)
  is stamped into `ai_metadata` on every candidate and `prompt_version` on the
  row.
- The static prefix is byte-stable and cache-eligible: role → §8.2 taxonomy →
  §8.3 rubric → §8.4 hook formulas → §8.5 pacing specs (from
  `CLIP_PLATFORM_SPECS`, the single-source table) → §8.6 negative constraints →
  6 few-shot exemplars (`fixtures/exemplars.ts` — repo fixtures, injected at
  build time, versioned with the prompt).
- **Workflow for ANY prompt change** (prefix, output contract, exemplars):
  1. bump `CLIP_PROMPT_VERSION`;
  2. `npx tsx scripts/eval-clips.ts --live` — the new scores must meet or beat
     the committed baseline (`fixtures/recordings/eval-baseline.json`);
  3. re-record CI stubs: `--live --record`;
  4. commit recordings + baseline with the prompt change.

## Eval harness (§16/§20)

`scripts/eval-clips.ts` runs `runSelectionCore` (the REAL pipeline) over 5
annotated fixture lessons (`fixtures/lessons.ts`): `charismatic`
(camera-only; energy-trap sections that must NOT be selected), `flat_affect`
(screen-only, no sync — the differentiator: ≥2 viable candidates from content
alone, a hard gate), `multi_speaker` (camera-only, diarized), `screen_slides`
(FR-8: flat-affect slide lecture WITH synthetic slide-sync — ≥2 viable, ALL
routed `slide_short`, binding), `screen_action` (FR-8: action-dense
screencast — every GOLD-hitting candidate routes `screen_action_zoom` on the
lexicon alone, ≥2 candidates demonstrate it; a viable candidate on a quiet
aside honestly routes `audiogram`, which is correct FR-2 precedence, so the
gate scopes to gold + a floor rather than punishing honest routing).
Metrics: gold recall@5 (overlap ≥50% of the shorter span), rubric pass rate,
hook-integrity rate, coherence rate, mean visual_interest, plus per-fixture
layout-routing gates and viability floors. The **no-regression gate**: a
prompt bump must meet/beat the incumbent baseline on every prior fixture
while passing the new ones. CI runs in **replay** mode against recorded model
outputs (`fixtures/recordings/*.json`); replay format-checks each call so a
structural prompt change invalidates recordings loudly. `--live --control`
re-runs everything under the PRE-amendment (format-blind) prompt and records
`recordings/control-scores.json` — the FR-8 "visual_interest is scored from
screen content" delta artifact.

## Quality gates in code (not prompt hopes)

- **Rubric bar** (§8.3): total ≥21/35 AND hook ≥3 AND standalone ≥4 —
  below-bar candidates drop; the model is never asked to re-score itself.
- **Hook integrity** (§7.4.3): deterministic first (numeric claims in a hook
  must appear in the span's own transcript — `lint.ts`), then the model
  verdict; surfaced hooks are lint-clean by construction (re-checked
  independently in the eval).
- **Standalone coherence** (§7.4.2): fail → the model may propose a ±8s
  trim/extend (code validates the bound), else drop. Multi-segment candidates
  are dropped, never repaired into incoherence (§7.3).
- **The one repair call** (Phase 1 semantics): claimed by an invalid batch OR
  by repairable deterministic flags (bounds/overlap/hook-numbers/safety); a
  rubric-only failure never wastes it.
- **Fail closed**: an unreadable validation verdict aborts the run — an
  unverified batch is never surfaced.

## Recording formats & layout routing (amendment, 2026-07-08)

WiseSel lessons come in three **recording formats** the teacher chooses at
record time — facts, stored as `VideoLessonBlock.recording.mode` (the block's
content jsonb; literals identical to `RECORDING_FORMATS`). **Layouts** are
decisions about how a candidate/render job is treated. `routing.ts ·
resolveClipLayout(format, momentContext)` is the ONLY place facts become
decisions:

| Recording format | Condition | Layout |
|---|---|---|
| `camera_only` | always | `face_track` |
| `screen_camera` | always | `stacked_split` |
| `screen_only` | slide-sync covers the span | `slide_short` |
| `screen_only` | no slide-short eligibility AND span is action-dense | `screen_action_zoom` |
| `screen_only` | neither | `audiogram` |

Precedence within `screen_only` is top-down; `audiogram` is never selected
when a higher row applies. The resolved layout is stored on every
`clip_moment_candidate` row (creators see the clip kind BEFORE rendering; the
`clip_render_job` copy folds into M-B's CREATE). Human copy for the FR-9
chips lives in `CLIP_LAYOUT_LABELS` (import, never copy): Face clip · Split
screen + camera · Slide short · Screen zoom · Audiogram; audiogram candidates
carry `CLIP_AUDIOGRAM_CAVEAT` ("simplest visual treatment…").

**Format resolution (FR-1)**, in `format.ts` + the acquisition path:

1. **Platform metadata** — studio recordings always carry `recording.mode`;
   the read is an identity map and detection NEVER runs over it (spy-tested).
2. **Classifier** — external uploads only (the upload path never sets a
   mode): ≥8 frames sampled across the duration, each judged `{facePresent,
   screenContentPresent}`; face ≥60% of samples → `camera_only` (or
   `screen_camera` when screen content is frame-dominant, ≥50%); no
   consistent face → `screen_only`. **Frame source reality:** ffprobe/ffmpeg
   are not in this runtime and the repo has no face-detection dep — the
   production `FrameInspector` is Mux thumbnail stills judged through the
   existing `ModelClient.inspectImage` vision seam (zero new deps; a local
   ffprobe inspector can fill the same seam later). No metadata AND no
   inspector ⇒ the degraded default `camera_only` (source `classifier`).
3. **Creator override** — `overrideTranscriptFormat` pins
   `recording_format` + `format_source='creator_override'` on the transcript
   row; the cache path never re-classifies over it.

Classification runs ONCE per lesson and persists on `lesson_transcript`
(`recording_format`, `format_source`).

**Action density (FR-3)**, in `actionDensity.ts` — deterministic, no model
call. A span is action-dense when its **transcript-cue rate** (distinct
`CLIP_ACTION_CUES` hits per minute) meets `CLIP_ACTION_DENSITY_THRESHOLD`,
OR an optional **frame-diff ratio** meets `CLIP_ACTION_FRAME_DIFF_THRESHOLD`.

- *Threshold rationale:* annotating the eval fixtures, live demo narration
  ("watch this", "as I type…") lands 3–6 cues/min while slide/lecture reading
  lands 0–1; the default **2 cues/min** splits the populations with margin.
  Frame-diff default **0.15** = ≥15% of sampled adjacent-frame pairs differ
  materially. Both env-overridable.
- *Degraded mode (documented + tested):* frame sampling needs locally
  accessible media (ffmpeg) — unavailable in this runtime — so transcript
  cues alone decide. `frameDiffRatio` is an injectable input for when a local
  pipeline exists.
- *Lexicon maintenance:* `CLIP_ACTION_CUES` entries are regex sources
  compiled with word boundaries; **adding a cue is a data change only** —
  append to the array, run `npm run verify:clips` (the table-driven
  `actionDensity.lexicon.spec` section), done. Keep cues *demonstrative*
  ("watch what happens", "as I type"), never topical.

**Format-aware selection (FR-4):** the static prompt prefix carries ALL
formats' `visual_interest` scoring rules (byte-stable, cache-safe); the
request block names the lesson's actual format. `demo_payoff` earns a
deterministic +1 `visual_interest` (capped at 5, recorded as
`visualInterestBoosted`) when the format is `screen_only` and the span is
action-dense — applied BEFORE the rubric bar. The hook-integrity lint gained
`hook_slide_ref_unsupported`: a hook citing a diagram/slide must have a slide
inside the span's sync window — enforced only when sync data EXISTS (with no
sync the claim is unverifiable and the model-side verdict still applies).

**Slide-sync producer (M-R, D-2 — REAL since 2026-07-08):** the studio
recorder captures `{slideId, atMs}` on every slide advance WHILE recording
and persists it as `recording.slideSync` (the same jsonb home as
`recording.mode`), satisfying the M-A contract verbatim
(`SlideSyncEntrySchema` — one shape, producer to consumer;
`loadLessonSlideSync(supabase, lessonId)` reads it back). Mechanics:

- `lib/editor/recordingSlideSync.ts` — a capture singleton on the RECORDED
  timeline (the recorder's own clock, pauses excluded); consecutive
  duplicates collapse; pure-testable.
- Emitters: the editor store's selection (the recorder subscribes while
  recording) and the learner slide player (same-tab preview). A DIFFERENT
  browser tab is a different JS context and cannot be captured.
- **The minimized REC pill** makes in-studio presenting possible: while
  recording, "Minimize & present slides" collapses the modal to a floating
  pill (timer · pause/resume · stop · expand) so the teacher navigates their
  deck normally — that navigation IS the capture. Recording never
  interrupts (the recorder lives in the parent hook).
- `atMs` uses the recorder's elapsed clock (`performance.now() − start −
  pausedAccum`), so paused stretches never skew sync.

**pipGeometry (M-R, D-3):** the compositor stamps the bubble rect it ACTUALLY
drew (`recording.pipGeometry {x,y,width,height,corner}`, live camera aspect
included). stacked_split prefers it (provenance `deterministic`), falls back
to corner-metadata `bubbleRect`, then one vision call (`detected`).

**Dual-track capture (M-R, D-4, flag `NEXT_PUBLIC_RECORDER_DUAL_TRACK`,
default OFF):** when on, screen+camera sessions ALSO record the raw camera
stream (a second MediaRecorder) and upload it as a role-marked
`video_assets` row (`metadata.role = "camera_dual_track"`, no captions,
linked via `recording.dualCameraAssetRowId`). Dual-track rows are EXCLUDED
from every lesson-video picker (transcripts + render source). The
stacked_split render prefers it: both assets pre-cut to the same span, the
face band comes from the FULL-RES camera track (`buildStackedSplitDualArgs`
— no PiP upscale softness); a failed camera precut falls back to the PiP
crop rather than stranding the job. **Storage cost (the OFF-by-default
rationale):** roughly DOUBLES per-lesson video cost — a second ~1–2 MB/min
browser upload plus 2× Mux encoding/storage minutes.

From the FR-7(g) audit (unchanged): `screen_camera` recordings are
composited to ONE canvas track at record time — separate tracks only exist
when the D-4 flag captures them.

## Render jobs (M-B, migration `20260708130000_clip_render_jobs.sql`)

Every render is a `clip_render_job` row advanced ONE edge per scheduler tick
(`processClipRenderTick`, piggybacked on the marketing tick — the no-cron
fence; Reap has no webhooks, so **the reconciliation sweep IS the delivery
path**). Every status write goes through `transitionRenderJob` (the single
legal write path; optimistic `eq(status, from)` — the M-F Remotion worker
uses the SAME function).

- **State machine:** `queued → precutting → submitted → completed|failed`
  (provider) · `queued → precutting → rendering_local → completed|failed`
  (in-house) · any non-terminal → `cancelled`.
- **Pre-cut (every job):** a TEMPORARY Mux clip asset
  (`createClipAsset(source, start, end)` — zero-dep server-side trim; the
  media already lives on Mux) polled to ready, its exact-span MP4 downloaded,
  then deleted. Task 0 ruled this mandatory: Reap re-picks inside any
  `create-clips` window AND rejects `stream.mux.com` as `sourceUrl` — the
  adapter only ever uploads pre-cut bytes and calls **`create-reframe`**
  (renders the whole upload verbatim; output rides `get-project-clips`,
  never `urls.videoFile`).
- **Layout delegation (D-5):** `face_track` → Reap reframe ·
  `stacked_split`/`screen_action_zoom`/`audiogram` → in-house FFmpeg
  (`render/ffmpegArgs.ts` pure builders + `localRender.ts` spawn) ·
  `slide_short` → the M-F Remotion provider. The `provider` column widens
  the amendment's enum with `wisesel_ffmpeg` (a T0-findings extension,
  surfaced at the M-B checkpoint).
- **stacked_split geometry:** face band 720×460 (the PiP crop — DETERMINISTIC
  via the recorder's own `bubbleRect` constants when `recording.
  cameraBubblePosition` exists; a one-call vision-detected corner for legacy
  uploads; `crop_provenance` records which — D-3) + screen band 720×406 (the
  FULL slide, legible; all band heights EVEN — yuv420p pads round odd
  heights down) + a 720×414 brand-backdrop caption zone (the reserved
  seam region).
- **screen_action_zoom:** the frame scaled to full canvas height (an
  implicit ~1.78× region zoom) with a 720-wide window panning between
  transcript-cued regions (`actionCueTimes` → `zoomKeyframesFromCues` →
  a piecewise-eased overlay-x expression).
- **audiogram:** blurred cover backdrop + the footage as a legible 16:9 card
  + a brand-color `showwaves` strip.
- **Burned captions on in-house layouts arrive with M-F's Remotion caption
  engine** (deliberate: drawtext/libass font resolution is unreliable across
  deploy targets; the provider face_track output already ships a captioned
  variant). Surfaced at the M-B checkpoint.
- **Brand tokens (D-1):** `lib/marketing/brand/tokens.ts` is the ONE brand-
  constant module (mirrors globals.css `@theme` + `public/brand/*`); the
  divergence check in `verify-clips-render` fails if any other clips file
  defines a color literal. `creatorBrandOverrides` is the [FWD] per-creator
  seam (always undefined in MVP).
- **Quotas + pacing (server-side):** 10 provider submissions/min (token
  bucket over `submitted_at`), `CLIP_JOBS_PER_DAY` (20), and ONE cost ledger
  — `cost_minutes` = the provider's `billedDuration` (never recomputed) or
  in-house minutes × `CLIP_INHOUSE_MINUTE_RATE` — against
  `CLIP_MINUTES_PER_MONTH` (60). Pre-cutting to the exact span is also the
  cheapest spend (Reap bills the ingested duration).
- **Idempotency:** `(creator_id, idempotency_key)` unique; the generate tool
  keys `gen:{candidateId}:{preset}` so replays return the same job.
- **Revert = CANCEL, never delete:** the job row is a cost-ledger entry (no
  delete policy); the gate's revert-of-create marks it cancelled and the
  provider cancel is best-effort (a remote race converges via the next poll).
- **ffmpeg** is a REAL dependency (`ffmpeg-static`, installed by
  `npm install` — never a system assumption). Deploy note: the binary is
  ~75 MB; on serverless targets include it in the tick route's traced files
  (Vercel `outputFileTracingIncludes`) or run ticks from a worker box. Local
  dev works out of the box; `verify:clips:render` renders all three in-house
  layouts for real as proof.
- **Tools (all reversible or read — zero approval cards):**
  `generate_lesson_clips` (quota-gated create; summary says QUEUED IS NOT
  RENDERED + manual posting) · `cancel_clip_job` · `list_clip_jobs`.
- **Storage:** outputs land in the PRIVATE `clip-media` bucket
  (`{creator}/clips/{jobId}.mp4`), written by the service-role tick; reads
  go through author-gated signed URLs (M-E).

## Slide-short provider (M-F, `render/slideShort/*`)

`slide_short` renders IN-HOUSE via a Remotion composition (`provider =
'wisesel_slides'`, the SAME `clip_render_job` table/state machine — the tick's
`rendering_local` branch calls `renderSlideShort` through the injectable
`renderSlideShortImpl` seam):

- **Composition** (`SlideShortComposition.tsx`, 1080×1920 @30fps): hook
  overlay (≤2s) → the lesson's REAL slides advancing on their **M-R sync
  timestamps** (`buildSlideShortSpec` clips `recording.slideSync` to the span
  via `slidesForSpan`, joins the real deck JSON) → kinetic word-level
  captions from the transcript (clip-relative) → a preset-appropriate end
  card → a persistent creator watermark. Audio = the pre-cut span's own
  media URL (render Chrome fetches it).
- **Slide rendering** = a PURE mirror of StructuredSlide's dispatch over the
  `renderToStaticMarkup`-proven layout components + DiagramView — never
  SlideStage (browser-measurement-gated). Freeform ELEMENT slides render
  through a pure text-extraction card (honest fallback — the element canvas
  is editor territory; structured decks are the slide-short home turf).
- **Styling**: the bundle imports `app/globals.css` (ONE Tailwind theme, one
  brand ramp — D-1); brand values inline via `BRAND_TOKENS` (this folder is
  divergence-scanned). The `@remotion/tailwind-v4` webpack override + an
  `@` alias make the app's components bundle as-is.
- **Workers**: renders run in a pool of `CLIP_RENDER_WORKERS` (default 1) —
  OUTSIDE the two-concurrent LLM ceiling. **Footprint per render:** headless
  Chrome ~400–800 MB RSS + one CPU-bound H.264 encode; the first-ever render
  downloads Remotion's Chrome Headless Shell (~150 MB, cached).
- **⚖ Remotion license trigger — 4th hire.** Remotion is free for companies
  under 4 employees (The HB Duo qualifies today). Revisit the license at the
  4th hire.
- **Cost**: in-house minutes × `CLIP_INHOUSE_MINUTE_RATE` on the ONE ledger.
- **Deps note**: runtime dependencies grew to 20 (`remotion`,
  `@remotion/bundler`, `@remotion/renderer`, `@remotion/tailwind-v4` — the
  FR-6 mandate; plus M-B's `ffmpeg-static`). The historic "14 deps" pin in
  CLAUDE.md is superseded by this documented list.
- **Tests**: `verify:clips:slideshort` (REAL renders: frame-sample
  assertions for hook/slide-advance/captions/element-fallback/end-card +
  a full probed H.264 render; artifact
  `artifacts/m-f-slide-short-fixture.mp4`) · the lifecycle/cost/ingest
  proofs ride `verify:clips:int` with an injected renderer.

## Posting kit + short links (M-D, migration `20260710100000_clip_posting_kit.sql`)

A rendered clip's copy bundle for MANUAL posting (`generate_posting_kit`,
reversible): caption + hashtags + comment keyword + `/l/{code}` short link +
the disclosure line. Responsibility split (binding, PRD §10):

- **AI drafts** caption/hashtags/keyword candidates (ONE small-tier call;
  keyless ⇒ a deterministic template kit — degrades, never blocks);
  **CODE enforces** platform caps, keyword normalization (3–12 upper
  letters), and the **disclosure line** (`disclosureLine()` — never model
  output; stored on the row so the copy button reproduces reviewed text).
- **Keyword uniqueness** per creator among ACTIVE kits: a deterministic
  suffix walk in code + a partial unique index as the DB backstop
  (regenerating a kit retires the old row, freeing its keyword).
- **Short links** (`short_link`, unambiguous 7-char codes): `/l/{code}`
  counts the click (+ `short_link_click` event), **re-resolves the
  destination at CLICK time** (a `/p/{slug}` link minted pre-publish
  upgrades to `/learn/{slug}` — the email-CTA lesson), and stamps
  `?ref={code}`. Unknown codes soft-land on the homepage (no 404 oracle).
- **Enrollment attribution:** the EnrollButton threads `?ref` into
  POST /api/learn/enroll → `recordClipEnrollment` (admin client, the
  server-emit pattern) records an `enrollment` event with
  `source='clip_short_link'` + kit/post lineage — ONLY when the code
  belongs to that course (no cross-course credit). Best-effort: it can
  never fail an enrollment.
- **`/preview/{code}`** — the shareable clip preview (code possession = the
  capability): a signed 1-hour URL over the private clip-media bucket + the
  kit caption + an honest "hasn't been posted anywhere" notice. **Answer-key
  invariant re-asserted**: the page's table surface is
  short_link/posting_kit/social_post + storage ONLY (grep-tested — it can
  never touch quiz/publication tables).

## Data model (migration `20260707100000_lesson_clips.sql`)

- `lesson_transcript` — one row per lesson (unique), `words` jsonb
  `[{w,startMs,endMs,speaker}]`, source `platform|provider`, creator-scoped
  RLS, **no delete policy** (it's a cache; never a gate target; re-transcription
  upserts). Amendment (`20260708100000_clip_recording_format.sql`):
  `recording_format` (`camera_only|screen_camera|screen_only`) +
  `format_source` (`platform|classifier|creator_override`).
- `clip_moment_candidate` — spans + hooks + rubric + status
  (`candidate|selected|dismissed`), `request_id` groups a selection run,
  `prompt_version` + `ai_metadata` observability. Creator-scoped RLS **with a
  delete policy** — the gate's revert-of-create needs it (the
  `social_voice_profile` precedent). Amendment: `layout` (the FR-2 decision;
  DB default `'face_track'` exists ONLY so pre-amendment gate snapshots still
  restore — code always writes it explicitly).
- 5 event types on the single `analytics_event` stream (`source: "clips"`):
  `lesson_transcribed` · `clip_moments_generated` ·
  `clip_moments_generation_failed` · `clip_moment_selected` ·
  `clip_moment_dismissed`. TS union ↔ DB check extended together;
  `verify-clips.ts` regex-guards the drift. Later milestones add their events
  with their tables.

## Config (all optional, `.env.example`)

`CLIP_CONTEXT_MAX_TOKENS` (6000) · `CLIP_TRANSCRIPT_MAX_TOKENS` (24000) ·
`CLIP_SELECTION_TIMEOUT_MS` (180000 — quality-first hard ceiling, NOT a
latency target) · `CLIP_SELECT_MODEL`/`CLIP_SELECT_EFFORT` (provider default /
medium — mid-tier, never downgraded for latency) ·
`CLIP_VALIDATE_MODEL`/`CLIP_VALIDATE_EFFORT` (provider default / low) ·
`CLIP_MAP_MODEL`/`CLIP_MAP_EFFORT` (provider default / low) ·
`CLIP_ACTION_DENSITY_THRESHOLD` (2 cues/min) ·
`CLIP_ACTION_FRAME_DIFF_THRESHOLD` (0.15) — rationale in the routing section.
M-B adds `REAP_API_KEY` + quota knobs (`CLIP_MINUTES_PER_MONTH`,
`CLIP_JOBS_PER_DAY`).

## Deviations from the PRD (deliberate, repo conventions win)

- **Singular table names** (`lesson_transcript`, `clip_moment_candidate`) —
  the Phase 1 precedent.
- **Snake_case event names** (`clip_moments_generated`, not
  `clip_moments.generated`) — the single-stream convention; plus a
  `clip_moments_generation_failed` event (PRD §14: failure events on every
  path).
- **Tool names snake_case** (`select_clip_moments`) per the registry
  convention; M-A also ships `list_clip_moment_candidates` +
  `update_clip_moment_status` (the PRD's "candidates dismissible" reversal
  story needs them).
- **Candidates are grouped by `request_id`**, not a batch table — the gate
  needed one revert unit; a parent row would carry no other state.
- **Slide-sync input is absent** (PRD §7.1 "where available"): this platform
  has no slide↔video timestamp alignment. The context assembler documents the
  gap; quiz-miss data IS wired (via `rollup_question_stats`, which carries
  `lesson_id` directly). The amendment upgraded slide-sync to a first-class
  CONTRACT (routing section above) — the producer still doesn't exist.
- **The amendment's named `*.spec.ts` tests map to named verify sections**
  (this repo has no jest/vitest — the tsx verify-suite pattern is the
  convention): each spec name is a literal section header in
  `verify-clips.ts` (pure halves) / `verify-clips-int.ts` (DB halves).
- **Classifier frame signals ride the vision seam**, not ffprobe (not
  installed in this runtime; no face-detection dep exists) — see the routing
  section. The decision function implements the amendment's thresholds
  verbatim.
- **Selection is model-required** (typed 503) — no deterministic fallback
  could honestly rank teachable moments. Transcript acquisition and the
  candidate queue work without a key.
- **Word-level platform timings are interpolated** from Mux cue-level VTT
  (length-weighted within each cue) — plenty for 20–90s span selection;
  frame-accurate caption timing is the render provider's job (§9).

## First-live-usage fixes (2026-07-15)

The creator's first real render session surfaced five defects — all fixed,
all regression-tested:

1. **Recorder hidden-tab freeze (the root product bug — NOT a clips bug).**
   The screen+camera compositor drew to its canvas with
   `requestAnimationFrame`, which Chrome fully suspends in a backgrounded
   tab — and recording another window/app is exactly when the studio tab is
   backgrounded. Result: `canvas.captureStream()` got no new frames and
   MediaRecorder encoded ONE frozen frame with live audio for the whole
   take (verified: byte-identical Mux thumbnails from t=5s → t=370s on the
   real lesson). Fix: `lib/editor/backgroundTicker.ts` — a dedicated-Worker
   interval ticker (worker timers are exempt from visibility throttling)
   drives the draw loop at 30fps; rAF remains only as a degraded fallback
   when the worker can't be built. `backgroundTicker.spec` in verify:video.
   **Recordings made before this fix are unfixable — re-record.**
2. **Nothing delivered renders in dev ("Cutting the exact span…" forever).**
   Job progression is a reconciliation sweep (Reap has no webhooks), but dev
   has no cron — each manual "Process renders now" click advanced exactly
   one edge and then nothing ever ticked again (the job's Mux precut sat
   ready for hours). Fix: `POST /api/marketing/clips/tick` — a
   creator-scoped sweep (`processClipRenderTick({creatorId})`) the clips
   page now polls every 5s while jobs are active (in-flight-guarded; the
   button reuses it). Prod cron is unchanged and remains the unattended
   path; this is user-triggered polling, not a scheduler (the no-cron fence
   holds).
3. **Frozen-source guard (`static_video`).** Job creation samples 3 Mux
   thumbnails across the candidate span; byte-identical frames on a
   camera-bearing format (a webcam frame is never pixel-identical twice)
   refuse the render with a re-record message instead of billing minutes
   for a frozen clip. screen_only is exempt (static slides under narration
   are legitimate); a thumbnail fetch hiccup skips the guard. `staticGuard.
   spec` in verify:clips:render.
4. **Permanent provider errors poisoned the sweep silently.** A leaked
   int-test job with fake refs 422'd against the real Reap API on every
   tick, logged as `[object Object]`, forever. Fixes: structured 4xx detail
   is stringified into `ReapError`; reap-api 4xx (not 408/429/upload-put)
   carries `permanent: true`; the step handler FAILS the job on
   `isPermanentProviderError` (seam-level duck-type — the service still
   never imports an adapter); `failJob` now also cleans temp precut assets
   (a failed job used to leak its Mux clip asset); the int suite scopes its
   sweeps to the test creator and registers a leak guard that cancels its
   active rows on success AND crash. `providerErrors.spec`.
5. **A dead job blocked retry forever.** The `(creator, idempotency_key)`
   unique index made a failed/cancelled job consume `gen:{cand}:{preset}`
   permanently — "queue again" was impossible. Migration
   `20260715100000_clip_job_idem_partial.sql` scopes uniqueness to
   live/completed rows; the replay read filters the same way; the candidate
   card now shows the failure reason + a "Render again" button, and active
   job rows surface their last retry error.

Also in this pass: `ingestCompletedClipJob` now inserts through the social
REPOSITORY (`insertSocialPost`) — the M-C direct `.from("social_post")
.insert` had violated verify-social's single-write-module invariant (the
suite failure had been masked by output piping; the chain now runs with an
honest exit code).

Two more, found the moment real clip posts hit the surfaces (same day):

6. **The social queue crashed on the first ingested clip post.**
   `PLATFORM_LIMITS` is the TEXT-generation contract (deliberately closed at
   LinkedIn+Facebook), but clip posts legally carry
   instagram/tiktok/youtube_shorts — `PLATFORM_LIMITS[post.platform].label`
   threw for every clip row (queue card, editor counters, revise/hashtag/
   image paths would all have followed). Fix: `CLIP_POST_PLATFORMS` +
   `CAPTION_LIMITS` (generous EDIT guards, never generation targets) +
   **`platformLimitsFor()`** — the TOTAL lookup every loaded-post path now
   uses; `SocialPostSchema.platform` widened to the row union
   (`PostPlatformSchema` — clip rows used to fail parse under a hiding
   cast); the queue's platform filter shows clip-platform chips only when
   such posts exist. Text generation still iterates `PLATFORMS` — the
   closed-at-2 fence holds (grep-tested). `clipPostPlatforms.spec` in
   verify-social: totality, fence, ingest-platforms ⊆ row union drift guard,
   clip-row parse, and a repo-wide grep banning unguarded
   `PLATFORM_LIMITS[post.platform]` indexing.
7. **`/marketing/clips` crashed with "window is not defined"** once a
   persisted posting kit loaded with the page: `kitFullText` interpolated
   `window.location.origin` and Next SSRs client components. The origin now
   rides `useSyncExternalStore` (server snapshot renders the relative `/l/`
   link; the client pass fills the absolute origin) — the repo's standard
   hydration-safe pattern. SSR check added to `clipsUi` in
   verify-clips-render.
8. **A re-record was invisible to the whole pipeline (2026-07-16).** The
   creator re-recorded a lesson and the new take landed BESIDE the dead one
   — but the transcript picker, the render source, and the page labels were
   all "longest-first", so the abandoned take stayed the lesson's clip
   source forever, and the transcript cache (asset-blind) never re-checked.
   Fix, three parts:
   - **`pickCurrentVideoRow`** (`transcripts.ts`, pure, exported) is THE
     lesson-video pick — dual-tracks excluded → captioned preferred →
     **newest first** — shared by transcript acquisition, `findRenderSource`,
     and the clips page's lesson labels, so all three always agree on the
     same asset (the label now shows the duration clips will actually be
     cut from).
   - **The transcript cache is keyed to its asset**: `lesson_transcript.
     video_asset_id` (migration `20260716100000`, types spliced). When the
     current take is a different asset, `acquireLessonTranscript` REBUILDS
     from the new take and **retires the old take's open candidates**
     (their spans live on the old timeline; `clip_transcript_rebuild` log).
     A legacy null row is stamped in place when its duration matches the
     current take (±2s), else rebuilt. A creator format override belongs to
     the take it was set on — a rebuild re-resolves format from the NEW
     take's metadata, by design.
   - **Stale-render guard** (`stale_candidates`): `createClipRenderJob`
     refuses a candidate whose transcript was built from a different asset
     than the current render source — with the remedy ("run Find clip
     moments again") instead of silently cutting the new footage at
     old-timeline spans.
   Tests: `currentTake.spec` (pure ordering, verify-clips) +
   `currentTake.rebuild.spec` (verify-clips-int: live stale-refusal →
   rebuild → candidate retirement).

## Tests

- `npm run verify:clips` — **203 pure checks** (no key/DB), in the `npm test`
  chain: constants/taxonomy/rubric, Zod gates (incl. the multi-segment
  exception rules), VTT→word interpolation, anchors/chunking, every
  deterministic validation rule, verdict application (±8s bound, hook
  promotion, multi-segment drop), the full pipeline core vs. the mock model
  (happy/repair×2/rubric-no-repair/fail-closed/map→reduce/per-tier efforts),
  prompt pins + exemplars, fixture sanity, tool registry snapshot (1 read +
  2 reversible + ZERO irreversible), event-union↔migration drift guard, the
  hardening greps (no publish/schedule references, no scheduler primitives,
  banned language, text platforms still closed at 2), and the amendment's
  named spec sections: `recordingFormat.metadata/classifier/override.spec`,
  `routing.matrix.spec` (matrix + precedence + sync helpers),
  `actionDensity.lexicon/Diff/degraded.spec`, `rubric.formatAware.spec`
  (boost matrix), `hookIntegrity.slideRef.spec`.
- `npm run verify:clips:int` — **88 checks** vs live Supabase + the mock
  model: platform/cache/provider/no-source acquisition, gate-staged selection
  with persisted ranks + prompt versions + events, byte-for-byte status
  revert, whole-set revert (transcript cache survives), zero-survivor
  nothing-persisted, the full creator-B RLS matrix, and the amendment's DB
  halves: block-metadata short-circuit (inspector-never-built spy),
  upload-path classification, the creator-override flip + cache persistence,
  layout on every candidate row + in ai_metadata + on the generated event;
  plus the M-B→M-G additions (gate-staged render jobs, idempotent replay,
  retry-after-cancel via the partial index, revert-cancel, the full
  queued→precutting→submitted/rendering_local→completed lifecycle vs real
  DB/storage with fakes, token-bucket hold, ingest + kit + attribution,
  slide-short lifecycle, RLS). Sweeps are creator-scoped and a leak guard
  cancels the run's active job rows on success and on crash.
- `npm run verify:clips:render` — **114 checks** (pure/local; REAL ffmpeg
  renders): provider contract, state machine, golden args, brand divergence,
  D-3 provenance spies, recorder slide-sync, posting kit, UI greps,
  reconciliation chaos + WER, `providerErrors.spec` (permanent 4xx →
  terminal fail + precut cleanup; stringified detail), `staticGuard.spec`
  (frozen-source detection).
- `npm run verify:clips:slideshort` — **14 checks**, REAL Remotion renders
  (in `npm test`).
- `npm run eval:clips` — the §20 eval (see above; 5 fixtures + layout gates;
  `--live --control` records the FR-8 pre-amendment delta artifact).
- `npm run smoke:reap` — Task 0 ((a)–(c) done vs the live API; (d)/(e) need
  one real ≥90s video; (f) provider layout probing rides the same script).

## Milestone map (amendment renumbering applied — ALL SHIPPED 2026-07-14)

- **Task 0** — (a)–(c) DONE vs the live Reap API (camelCase contract, ≥60s
  window, no webhooks, no brand-template API — `docs/reap-task0-findings.md`);
  (d)/(e) open on one real ≥90s video; the amendment adds (f) provider layout
  probing (stacked_split on composited footage; screen-region tracking vs
  blind center-crop) and (g) the recorder audit (DONE — composited single
  track; no slide-sync producer; findings in the routing section + the
  findings doc).
- **M-A** — ✅ this document, including the amendment's FR-1/2/3/4 + FR-8
  (format plumbing, routing matrix, classifier, action density, clips-v3,
  eval fixtures 4+5).
- **M-B** — `ClipRenderProvider` + Reap adapter (per Task 0 findings; pre-cut
  FFmpeg fallback if timestamps unsupported), `clip_render_job` (CREATE
  includes the `layout` + widened `provider` columns), webhook consumer (M7
  pattern), reconciliation sweep, 10/min token bucket, quotas + cost ledger;
  amendment FR-5/FR-7: adapter layout mapping per Task 0 (f), in-house
  compositing only for genuine separate-track sources, in-house
  `screen_action_zoom` (FFmpeg zoompan) IF Task 0 (f) finds the provider gap.
- **M-C** — packaging presets (gain the required `layout` field — presets ×
  layouts orthogonal) + submit→webhook→ingest→`social_post` rows
  (`post_type='clip'`, platform enum extension gated by superRefine), lineage
  on regenerate.
- **M-D** — posting kit (small-tier, code-inserted disclosure line), comment
  keywords, `short_link` service, `/l/:code` + `/preview/:code` (answer-key
  invariant re-asserted), enrollment attribution.
- **M-E** — the clips UI inside Social Posts (moment picker, job cards, kit
  panel, usage meter) + FR-9 layout chips (`CLIP_LAYOUT_LABELS`) and the
  audiogram caveat (`CLIP_AUDIOGRAM_CAVEAT`).
- **M-F (NEW — amendment FR-6)** — `WiseselSlideShortProvider`
  (`provider='wisesel_slides'`, Remotion composition reusing the lesson slide
  components, kinetic word captions, same `clip_render_job` state machine +
  ingest path, `CLIP_INHOUSE_MINUTE_RATE` cost ledger, `CLIP_RENDER_WORKERS`
  pool outside the 2-LLM ceiling). **Prerequisites surfaced at the M-A
  checkpoint:** a slide-sync producer (recorder capture) and a brand-tokens
  source shared with Reap packaging (neither exists yet); note SlideStage
  itself is browser-only (ResizeObserver) — the Remotion composition builds
  on the PURE structured-layout components + DiagramView, which are
  `renderToStaticMarkup`-proven.
- **M-G (was M-F)** — hardening + docs: webhook chaos tests, WER measurement,
  eval re-run covering ALL five fixtures, the FR-6 render tests in the full
  suite, seed script.

## Hard fences (unchanged from the PRD §3, grep-tested)

No platform APIs/OAuth · no posting/scheduling (`/publish-clip` +
`/schedule-clips` are never referenced — CI grep) · no DM-automation
execution · no synthetic media/AI images · no cron (reconciliation piggybacks
on page loads + submissions) · Phase 1 language rules verbatim.
