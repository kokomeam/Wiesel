# Lesson Clip Repurposing — Marketing Phase 1.5

> PRD: the Phase 1.5 "Lesson Clip Repurposing" spec (delivered 2026-07-07) ·
> **Shipped so far: Milestone M-A** (transcripts + moment selection engine +
> eval harness) — 2026-07-07. **Task 0 (Reap smoke test) is BLOCKED on
> `REAP_API_KEY`** and gates M-B; see `docs/reap-task0-findings.md`.
> Phase 1 foundation: `docs/social-posts.md`.

## What this is

Creators turn real lesson recordings into short-form vertical clip **candidates**:
the engine transcribes the lesson (or reuses the Mux caption transcript), runs a
course-context-aware **moment selection engine** over it, and stages the 3–5 most
teachable, hook-worthy spans as ranked candidates — each with an honest hook,
2 alternates, funnel-stage fit, and a creator-facing rationale. Rendering
(Reap), posting kits, short links, and the clips UI arrive in M-B…M-E.

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

**Slide-sync status (FR-7(g) audit):** the platform has NO slide↔timestamp
producer — the recorder does not capture slide timings and no table stores
them (exhaustively verified 2026-07-08: slides/`deck_import_pages` carry no
time fields; the learner player advances slides manually; `slide_viewed`
dwell is not alignment). The CONTRACT is first-class (`SlideSyncEntrySchema`,
`loadLessonSlideSync` seam, coverage/`slidesForSpan` helpers, eval fixtures
carry synthetic sync) but production lessons route `slide_short` only once a
producer exists — recorder slide-timing capture is an **M-F prerequisite**
surfaced at the amendment checkpoint. Also from the audit: `screen_camera`
recordings are composited to ONE canvas track at record time (screen +
camera bubble baked together; audio mixed) — the platform never stores
separate tracks, so FR-5's separate-track compositing branch applies only to
hypothetical external dual-track uploads.

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

## Tests

- `npm run verify:clips` — **198 pure checks** (no key/DB), in the `npm test`
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
- `npm run verify:clips:int` — **44 checks** vs live Supabase + the mock
  model: platform/cache/provider/no-source acquisition, gate-staged selection
  with persisted ranks + prompt versions + events, byte-for-byte status
  revert, whole-set revert (transcript cache survives), zero-survivor
  nothing-persisted, the full creator-B RLS matrix, and the amendment's DB
  halves: block-metadata short-circuit (inspector-never-built spy),
  upload-path classification, the creator-override flip + cache persistence,
  layout on every candidate row + in ai_metadata + on the generated event.
- `npm run eval:clips` — the §20 eval (see above; 5 fixtures + layout gates;
  `--live --control` records the FR-8 pre-amendment delta artifact).
- `npm run smoke:reap` — Task 0 ((a)–(c) done vs the live API; (d)/(e) need
  one real ≥90s video; (f) provider layout probing rides the same script).

## Milestone map (amendment renumbering applied)

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
