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

`scripts/eval-clips.ts` runs `runSelectionCore` (the REAL pipeline) over 3
annotated fixture lessons (`fixtures/lessons.ts`): `charismatic` (energy-trap
sections that must NOT be selected), `flat_affect` (the differentiator: ≥2
viable candidates from content alone — a hard gate), `multi_speaker`
(diarized). Metrics: gold recall@5 (overlap ≥50% of the shorter span), rubric
pass rate, hook-integrity rate, coherence rate. CI runs in **replay** mode
against recorded model outputs (`fixtures/recordings/*.json`); replay
format-checks each call so a structural prompt change invalidates recordings
loudly.

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

## Data model (migration `20260707100000_lesson_clips.sql`)

- `lesson_transcript` — one row per lesson (unique), `words` jsonb
  `[{w,startMs,endMs,speaker}]`, source `platform|provider`, creator-scoped
  RLS, **no delete policy** (it's a cache; never a gate target; re-transcription
  upserts).
- `clip_moment_candidate` — spans + hooks + rubric + status
  (`candidate|selected|dismissed`), `request_id` groups a selection run,
  `prompt_version` + `ai_metadata` observability. Creator-scoped RLS **with a
  delete policy** — the gate's revert-of-create needs it (the
  `social_voice_profile` precedent).
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
`CLIP_MAP_MODEL`/`CLIP_MAP_EFFORT` (provider default / low). M-B adds
`REAP_API_KEY` + quota knobs (`CLIP_MINUTES_PER_MONTH`, `CLIP_JOBS_PER_DAY`).

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
  `lesson_id` directly).
- **Selection is model-required** (typed 503) — no deterministic fallback
  could honestly rank teachable moments. Transcript acquisition and the
  candidate queue work without a key.
- **Word-level platform timings are interpolated** from Mux cue-level VTT
  (length-weighted within each cue) — plenty for 20–90s span selection;
  frame-accurate caption timing is the render provider's job (§9).

## Tests

- `npm run verify:clips` — **113 pure checks** (no key/DB), in the `npm test`
  chain: constants/taxonomy/rubric, Zod gates (incl. the multi-segment
  exception rules), VTT→word interpolation, anchors/chunking, every
  deterministic validation rule, verdict application (±8s bound, hook
  promotion, multi-segment drop), the full pipeline core vs. the mock model
  (happy/repair×2/rubric-no-repair/fail-closed/map→reduce/per-tier efforts),
  prompt pins + exemplars, fixture sanity, tool registry snapshot (1 read +
  2 reversible + ZERO irreversible), event-union↔migration drift guard, and
  the hardening greps (no publish/schedule references, no scheduler
  primitives, banned language, text platforms still closed at 2).
- `npm run verify:clips:int` — **33 checks** vs live Supabase + the mock
  model: platform/cache/provider/no-source acquisition, gate-staged selection
  with persisted ranks + prompt versions + events, byte-for-byte status
  revert, whole-set revert (transcript cache survives), zero-survivor
  nothing-persisted, and the full creator-B RLS matrix.
- `npm run eval:clips` — the §20 eval (see above).
- `npm run smoke:reap` — Task 0 (blocked on `REAP_API_KEY`).

## Milestone map

- **Task 0** — BLOCKED on `REAP_API_KEY` (script + findings doc ready).
- **M-A** — ✅ this document.
- **M-B** — `ClipRenderProvider` + Reap adapter (per Task 0 findings; pre-cut
  FFmpeg fallback if timestamps unsupported), `clip_render_job`, webhook
  consumer (M7 pattern), reconciliation sweep, 10/min token bucket, quotas +
  cost ledger.
- **M-C** — packaging presets + brand templates, submit→webhook→ingest→
  `social_post` rows (`post_type='clip'`, platform enum extension gated by
  superRefine), lineage on regenerate.
- **M-D** — posting kit (small-tier, code-inserted disclosure line), comment
  keywords, `short_link` service, `/l/:code` + `/preview/:code` (answer-key
  invariant re-asserted), enrollment attribution.
- **M-E** — the clips UI inside Social Posts (moment picker, job cards, kit
  panel, usage meter).
- **M-F** — webhook chaos tests, WER measurement, eval re-run vs Task 0
  baseline, seed script.

## Hard fences (unchanged from the PRD §3, grep-tested)

No platform APIs/OAuth · no posting/scheduling (`/publish-clip` +
`/schedule-clips` are never referenced — CI grep) · no DM-automation
execution · no synthetic media/AI images · no cron (reconciliation piggybacks
on page loads + submissions) · Phase 1 language rules verbatim.
