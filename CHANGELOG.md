# Changelog — Course Studio editor upgrade

All notable editor changes, newest first. Each batch is individually
verifiable; verification = `npm run build` + `npm run lint` + a temporary
Playwright script driving the real UI through its `data-ai-*` attributes.
Part C = the approved AUDIT.md items (all except #1 persistence — Supabase
is next — #5 multi-selection styling, and #8 canvas a11y).

## The "missing content" rejection loop — DECISIVE fix (agent-null coercion), 2026-06-24

Proven from `slide_reject` logs (lesson b240a404): the slides were NOT missing
content — they were fully authored and rejected on rich-text **envelope
technicalities**. The agent emits `null` for an absent optional field (`runs: null`
for "no inline formatting", `marks: null`, `icon: null`, `detail: null`,
`example: null`, …) but the schema wanted `[]` / `{}` / absent. 7 of 8 slides per
lesson bounced this way and re-looped. Suites green (`verify:ai` · `verify:ai:int`
· `verify:visuals`) + tsc/lint/build.

- **`normalizeAgentNulls` (`lib/course/slide/clampStructured.ts`)** — a pure,
  recursive, LOSSLESS coercion run at the structured-slide tool boundary
  (`bestEffortTemplate`, so batch / set / add all get it): `runs: null → []`,
  `marks: null → {}`, and any OTHER null key → deleted (the agent's "absent"). `null`
  carries no content, so this changes encoding, never text. A genuinely-missing
  REQUIRED field still surfaces as a real error (an empty slide is never saved blank).
- **Schema tolerance (belt-and-suspenders, `structuredLayouts.ts`)** — the AI-input
  `rich()` slot's `runs` and a run's `marks` now `.nullish().transform(→ undefined)`,
  so a null can never hard-reject a slide even if the coercion is bypassed.
- **Cause 2 (diagram, secondary)** — `readDiagramFields` now reads a rich-text
  ENVELOPE (`{ text }`) as well as a plain string for title/caption/takeaways, so a
  diagram whose explanatory prose rides in `caption` isn't read as empty (which left
  `body` blank → a false `content.body.text: Too small` → the prose degrade now fills
  body from the caption sibling; no re-send loop).
- **Prompt nudge** — the GENERATE teaching bar now states: send `runs: []` (not null)
  when there's no formatting, `marks: {}` inside a run, and fill every required text
  field of the chosen layout.
- Safety nets kept: the per-spec re-send cap (`MAX_SPEC_BUILD_ATTEMPTS`) + the
  `slide_reject` / `authoring_turn` instrumentation (behind `AI_DEBUG_AGENT`).
- Tests: `verify-richtext-coercion.ts` reconstructs the ACTUAL log payloads (s1
  section_break, s2 comparison_columns with deep null runs/icon/detail, the diagram
  envelope) and asserts they build with text preserved byte-for-byte; the full
  8-slide log batch now builds `generated == planned (8/8)`; a genuinely-empty slide
  is still rejected.

## Content-agent reliability — scoped GENERATE input, plan-reasoning fix, hard transport deadline, resumable module loop, 2026-06-23

A multi-front fix grounded in server logs (checkpoint `01b49cc`). Suites green
(`verify:ai` · `verify:ai:int` · `verify:visuals`) + `tsc`/lint/`build`.

- **FIX 1 — GENERATE/REPAIR input is now SCOPED, so the plan can't be lost.** The
  driven authoring loop (`runConversationLoop`, `scopedInput`) no longer loads the
  conversation transcript at all (it had grown to ~854 messages for a module build,
  burying the plan and leaving the author working from a ~1.1K-char summary →
  `covered:0`). Each turn is rebuilt FROM SCRATCH out of: the system prompt + the full
  structured PLAN verbatim (in the developer context message) + the deterministic
  GenerationState (built / remaining specs) + this run's own tool I/O. New
  `buildScopedAgentInput` (`historyPolicy.ts`); there's nothing to compact, so the
  plan is present, intact, every turn. New log `agent_input_scoped`.
- **FIX 1.3 — slideSpecId stamping is GUARANTEED.** `add_structured_slides_batch`
  receives the plan's ordered spec ids (`ToolContext.planSpecIds`) and stamps each new
  slide with the model's id when it's a valid unclaimed plan spec, else the NEXT
  unclaimed spec in plan order — so `generated N / covered 0 / extra N` is impossible
  when slides correspond to specs. The edit path (no plan) is unchanged.
- **FIX 2 — no author-directive ever renders as slide content.** The diagram→prose
  degrade (`proseDegradeTemplate`) now builds the body ONLY from the model's real
  caption / takeaways, NEVER the `pedagogicalPurpose` / `altText` (author directives —
  the "Key idea: Show a concrete …" leak); a request with no real content fails to
  build (reported back) instead of authoring a directive. A plan slide spec that comes
  back "couldn't build (missing content)" twice is ABANDONED by the coverage driver
  (surfaced in the checkpoint) instead of spinning to the turn cap.
- **FIX 3 — a call can no longer exceed its timeout, and a lesson death can't kill a
  module.** `withTimeoutSignal` (`providers/openai.ts`) wires a real AbortController to
  the fetch (the SDK `timeout` was silently ignored by the proxied undici fetch — plan
  calls ran 11–18 min on a configured 180s); the ProxyAgent gets `connect` /
  `headersTimeout` / `bodyTimeout` ceilings; plan `maxRetries` drops to 1 (no 5× dead-
  socket retry); plan calls STREAM (keep the socket active). The module loop retries a
  lesson's rich plan ONCE with backoff on a transport death, else skips + surfaces it;
  each completed lesson is flushed immediately, and a partial module is never reported
  complete.
- **Lesson-plan reasoning runaway — the STRUCTURAL fix (not a cap).** Diagnosed from
  the logs: input was flat (~4.4K, cached), but output/reasoning ballooned 2.9K→23.5K /
  0.5K→20.7K across a module's lessons (latency 21s→11.5min→dead). Cause = the per-call
  reasoning burden, not accumulation. Fixes: lesson-plan effort **high→medium**; the
  SPLIT decision is now a **deterministic code rule** (`splitOverflowingSpecs`) instead
  of model reasoning, and `continuationOf` + `requiredElements` are **removed from the
  strict output schema** (fewer constrained fields per slide = far less reasoning to
  satisfy it); the numeric slide-count target is softened to depth-driven. The 16K
  output budget + the 180s hard deadline are SAFEGUARDS, not the cure.

## Method 1 — content-first planning + split-at-plan-time, 2026-06-23

The PLAN now finalizes a slide's CONTENT before its layout, and splits an
overflowing slide into two at plan time (no truncation, ever). Builds on commit
`48a92a2`. Suites green (`verify:ai` 181 · `verify:ai:int` 113 · `verify:visuals`
93 · `verify:slides` · `verify:reject`) + `tsc`/lint/`build`.

- **Content-first slide spec.** `SlideSpecSchema` (`lib/ai/outline.ts`) is reordered
  so `keyPoints` (the slide's finalized real content) precedes `layout`, and the
  prompt makes the model FINALIZE the points first, then pick the structured layout
  whose shape FITS them (and vary layouts across the deck) — instead of choosing a
  layout and hoping content fits. One plan pass, no extra round-trip.
- **Split decision at plan time (no truncation).** When a slide's points would
  genuinely overflow one card (cards auto-grow, so only real overflow), the model
  SPLITS into two slides rather than cram or drop any point:
  - **Continuation** (one idea, more points than a card holds): a new
    `continuationOf` field links the second slide to its parent; `normalizeContinuations`
    in `coerceOutline` stamps its title with " (cont.)" off the parent's base title and
    drops any point it repeats verbatim from the parent (an exact dup is not info — it
    lives on the parent), preserving every UNIQUE point. The GENERATE prompt has it
    carry the parent heading + a "continuing from …" cue and author ONLY its own points.
  - **Sub-topic split** (the points are two distinct sub-ideas): two slides with
    distinct descriptive titles ("Causes of X" / "Effects of X"), preferred over a bare
    continuation when the points naturally group.
- **Coverage unchanged.** A continuation is its own slide spec, so it counts toward
  coverage (no fit/repair loop reintroduced); GENERATE just fills the plan-assigned
  layout. `isContinuationSlide` exposes the relationship; the "(cont.)" title is the
  renderer's visual cue.
- Tests: `verify-outline.ts` (content-first field order, continuation stamp + dedup +
  zero-info-loss, sub-topic distinct titles, deck layout variety) and a `verify:ai:int`
  end-to-end split (plan card shows the normalized split; approving builds both slides,
  coverage passes, no repair).

## Stretching, fewer model calls, lighter validation, 2026-06-22

Adopt Gamma-style stretching (within the fixed 16:9 frame), kill the remaining
reject-retry loops, drop fit-driven validation, and cut redundant model calls —
without losing slide completeness. Revert point: commit `bcf3ff6`. Suites green
(`verify:ai` 170 · `verify:ai:int` 107 · `verify:visuals` 85 · `verify:slides`
incl. the new `verify:stretch` 19 · `verify:reject`) + `tsc`/lint/`build`.

- **STRETCHING — containers grow to fit (within the 16:9 frame).** The structured
  layouts were absolute-positioned boxes with `overflow:hidden` that CLIPPED heavy
  content. The clip-prone ones (`concept_example`, `comparison_columns`,
  `comparison_matrix`, `outline_list`, `prose`) are now FLOW layouts — a flex column
  (header → body that grows → footer); columns grow independently and stretch to the
  taller; the matrix grid uses content-sized (`auto`) rows; `outline_list` items flow
  in a column; `code_walkthrough` scales its font to the line count. No text container
  clips; the only guard kept is the existing horizontal break-word on long strings.
  (The user chose "fit within the fixed frame" over a variable-height-canvas rewrite.)
- **No more reject-retry.** Single-slide tools (`add_structured_slide`/
  `set_structured_slide`) now CLAMP like the batch (lenient + `clampStructuredTemplate`)
  — an over-long slot auto-shortens and saves, never bounces. **Diagrams** were the
  last reshape-and-retry path: `add_diagram`/`set_diagram` (and a `diagram` entry in the
  batch) are now best-effort — `lib/course/diagram/repair.ts` `repairDiagram`/
  `coerceDiagramBestEffort` fix the off invariants (slope, sort, dangling edges, missing
  weights) or fall back to a topic-matched template / minimal seed, so a malformed
  diagram is ACCEPTED + rendered, never bounced. The garbled "Had to reshape the make
  that change and retry" string is fixed (proper tool nouns; natural fallback).
- **Keep coverage, drop fit.** Repair now ONLY fills a genuinely MISSING slide spec or
  required quiz/homework block (`hasModelRepairableFailure`); a complete deck SKIPS
  repair. Duplicate specs + a missing recommended visual are now SOFT (reported, never
  repaired) — `ok` is computed from the hard-failure set only (`HARD_FAILURE_CODES`).
- **Cut calls / reuse data.** GENERATE/REPAIR can't re-fetch the course context /
  module list / lesson list (excluded from the toolset — they ride in the context +
  generation-state). The teaching bar now authors ALL of a lesson's slides in ONE
  `add_structured_slides_batch` (cap raised 4→24), not one segment per turn. REPAIR
  drops to MEDIUM effort (`AI_PHASE_MODELS.repair`); PLAN + the creative initial
  authoring stay high.
- **Concise authoring kept in the prompt.** Stretching removes crashes, not bloat —
  the teaching bar now says cards GROW to fit but to still write tight, scannable cards
  (short headings, 1–2-sentence bodies), putting depth across more slides.

## AI agent — strictness death-spiral fix, flush-on-exit, stop & live render, 2026-06-22

A second reliability pass. A module-generation run had spun for **10+ minutes and
persisted nothing** — the module had no data and the agent couldn't see it on a
follow-up turn. Root cause was a strictness death-spiral (valid slides rejected for
formatting → phantom coverage gaps → endless repair) compounded by **all persistence
happening once at the very end** (a kill before that lost everything). Fixed with
targeted changes; suites green (`npm run verify:ai` 170 · `verify:ai:int` 99 ·
`verify:visuals` 84 · `verify:slides` · `verify:reject`) + `tsc`/lint/`build`.

- **Clamp, don't reject (the death-spiral fix).** `add_structured_slides_batch` no
  longer bounces an over-length slot back to the model. A new schema-driven
  `clampStructuredTemplate` (`lib/course/slide/clampStructured.ts`) auto-shortens any
  over-length string / over-count array to its cap, **saves the slide**, and attaches
  a non-blocking `autoShortened` note. Only a slide MISSING required content (which
  clamping can't invent) comes back — so a valid slide can never be dropped for
  formatting, and "Added 0 slides" can't happen when any slide is valid.
  (`lib/ai/tools/structuredSlides.ts`.)
- **Coverage = a SAVED slide.** Because clamped slides save (stamped with their
  specId), coverage closes and REPAIR stops — no phantom gaps. Coverage is the
  saved-slide delta; a pass that saves zero new slides trips the no-progress guard
  rather than another repair pass.
- **No hard slide-count cap.** The PLAN's spec list is the length target. The
  `coerceOutline`/skeleton caps were raised to runaway-only safety rails
  (`MAX_LESSON_SLIDES` 14→40, `MAX_LESSON_SEGMENTS` 6→16, `MAX_MODULE_LESSONS` 8→20)
  so a legitimately long lesson/module is never truncated; token budget + the turn
  cap remain the operative limits. (`lib/ai/outline.ts`.)
- **REPAIR doesn't re-read the world.** The GENERATE/REPAIR toolset now excludes
  `get_course_context` / `list_modules` / `list_lessons` / `get_lesson` — the course,
  lesson, plan and authored-so-far set are already carried in the context message +
  generation-state every turn, so repair stops burning turns re-reading them.
  (`lib/ai/tools/index.ts`.)
- **Flush-on-exit — never discard partial work.** The lesson/module pipelines now
  reconcile to the DB **incrementally** (each authored batch persists at the turn it
  lands, via the driven loop; each lesson persists as it completes) and stage the
  change-set in a guarded `finalize()` that runs on **every** termination — completion,
  token cap, turn cap, no-progress guard, user Stop, or a thrown error. The module
  scaffold is persisted the instant it's planned, so a build that's killed mid-run
  still leaves the module + its built lessons in the DB (the "Module 5 has no data"
  fix). `reconcileAndStage` was split into a repeatable `reconcileDoc` + a one-shot
  `stageChangeSet`. Still ONE change-set per run. (`lib/ai/agentLoop.ts`,
  `lib/ai/phases.ts`.)
- **Stop button.** While a run streams, the composer's send arrow becomes a stop
  square; it aborts the request via an `AbortController`. The server sees the
  connection signal between tool turns, runs flush-on-exit, and returns cleanly; the
  input is freed for the next message. (`components/editor/agent/{AgentPanel,useAgentStream}.tsx`.)
- **Live rendering + autosave coordination.** A new `agentRunActive` flag pauses the
  browser autosave for the duration of a run (the agent persists server-side; a
  competing full-snapshot would race the reconcile and could orphan rows — the known
  hazard), and a debounced `scheduleLiveSync` (`lib/editor/liveSync.ts`) re-loads the
  doc into the editor via `syncLiveDoc` (no full re-hydrate — undo/selection intact),
  so the deck fills in as the agent authors it. A Supabase **Realtime** subscription
  on the staging table (`change_set_items`, `lib/editor/useChangeSetRealtime.ts` +
  migration `20260622010000_realtime_change_set_items.sql`) drives the same re-sync;
  it degrades gracefully if the publication isn't enabled. An **"Accept what's here"**
  affordance (the review bar's accept button while generating) lets the user gate out
  of a long repair loop early.
- **Investigation — the agent is NOT scope-limited.** The "I only have access to the
  current lesson" claim was a downstream effect of the data loss above, not a real
  scope limit: `runContentAgentTurn` loads the whole course tree, the edit path has
  the full structural toolset (`list_modules`/`create_module`/`create_lesson`), and
  `classifyIntent` already routes "build module N" → `generate_module`. So acting on
  an existing populated module works; only the empty/missing module failed. No scope
  changes made — the data-loss fix resolves it.

## AI slide generation — reliability, arc & live AI images, 2026-06-22

The big quality fix. Decks were coming out **incomplete** (a 10-slide plan shipped
3 slides — "Supply and equilibrium" never reached equilibrium), **inconsistent**
(one deck opened on a title, another cold-opened on a HOOK), and **visually
sparse**. Root cause was architectural, not prompting. Fixed across six
workstreams; all suites green (`npm run verify:ai` 162 · `verify:ai:int` 87 ·
`verify:slides` · `verify:visuals` 84 · `verify:reject`) + `tsc`/lint/`build`.

- **Coverage-driven GENERATE/REPAIR controller** (`lib/ai/agentLoop.ts`,
  `lib/ai/phases.ts`). The loop used to **stop the instant the model returned a
  no-tool-call turn** — a small model that "felt done" at 3/10 ended generation
  there, and a separate cold-start repair (capped 2×6 turns) burned ~3 min without
  catching up. GENERATE/REPAIR now opt into `driveToCoverage`: after each turn the
  loop computes plan coverage from the deterministic generation-state, and while
  specs remain it **injects a concrete "STILL TO BUILD …" nudge and keeps building**
  (turns scaled to the plan: `coverageMaxTurns`/`repairMaxTurns`). A **no-progress
  guard** (`AGENT_NO_PROGRESS_LIMIT`, 3) stops a stalled run instead of spinning.
  The driven loops no longer emit their own checkpoint — the validate/repair
  pipeline owns the ONE authoritative end-of-run checkpoint. Repair passes raised
  2→4 (`AI_MAX_REPAIR_PASSES`); the shared call budget 64→200 so module lessons
  don't starve.
- **High-effort authoring.** GENERATE/REPAIR default to **`high`** reasoning effort
  (was medium) with a generous `AI_GENERATE_MAX_OUTPUT_TOKENS` (24k) — the hardest
  phase finally gets the horsepower PLAN already had. (`lib/ai/modelConfig.ts`.)
- **Partial-success batch tool.** `add_structured_slides_batch` was all-or-nothing
  — one over-long slot rejected the WHOLE batch ("Had to reshape the slide layout
  and retry" churn). It's now `lenientArgs` (validates each slide in `execute`):
  every valid slide is SAVED and only the failures come back (with the exact slot)
  to re-send. The model schema stays strict. (`lib/ai/tools/{types,index,structuredSlides}.ts`.)
- **Title-opener + recap-closer arc.** Every full (non-micro) lesson now opens with
  a titled `section_break` and closes with a `recap`. The PLAN prompt asks for it;
  `ensureLessonArc` guarantees it in the pipeline AFTER the depth-floor re-ask (so
  the floor still measures the model's real content) and BEFORE approval — it
  prepends/appends the specs, re-ids, and re-derives segments (idempotent;
  `coerceOutline` stays pure). (`lib/ai/outline.ts`, `lib/ai/phases.ts`.)
- **Visuals, abundant but purposeful.** The planner bar was rewritten — dropped
  *"MOST slides need no visual"*; it now adds a visual wherever a learner would SEE
  the idea better (structure/process/relationship/comparison/timeline/worked
  example), uses `recommended` generously, and reserves `required`+`mustBeAccurate`
  for accuracy-critical diagrams. The GENERATE teaching bar BUILDS recommended
  visuals. `AI_VISUAL_MAX_PER_LESSON` 3→5.
- **AI image generation — now LIVE** (`AI_IMAGE_GENERATION_ENABLED` defaults true).
  For a concept no programmatic diagram fits, the new **`add_image`** tool generates
  an educational illustration (gpt-image-1 via the SAME OpenAI client + proxy:
  `ModelClient.generateImage`), **stores the bytes to the Supabase `course-assets`
  bucket** under the owner's folder (`lib/ai/visuals/storeImage.ts` — public URL on
  the slide, **never a blob/data URL**), and lands it as a first-class
  **`illustration` structured layout** (registry + strict schema + renderer +
  `SlideTemplate` union + dispatch — `IllustrationLayout.tsx`). Accuracy-critical
  figures still go programmatic; image generation is capped per lesson and routed
  through the planner's `visualIntent`, so it's purposeful, not spammy. The tool is
  an injected, side-effectful capability on the tool context (`VisualGenContext`),
  the one impure tool path. The mock provider gains a deterministic `generateImage`
  so the whole path (generate → store → slide) is tested with no key.
- **Tests:** new coverage-driver / no-progress / live-image-path checks in
  `verify-agent-integration.ts`; `ensureLessonArc` + partial-batch + add_image unit
  checks across `verify-outline.ts` / `verify-bounded.ts` / `verify-visuals.ts`;
  the `illustration` layout in `verify-structured-layouts.ts`.

## AI-assisted VISUAL pipeline — programmatic teaching diagrams, 2026-06-20

A visual is a TEACHING OBJECT, not decoration. Added a full visual pipeline whose
LIVE path renders **programmatic diagrams** — typed, deterministic data the
renderer draws as crisp SVG, so a teaching graph is **accurate by construction**
(a supply curve literally slopes up; a Dijkstra graph weights every edge),
editable, accessible, exportable, and persisted with **no blob URLs**. A diagram
is just a renderer-owned **structured slide layout** (`SlideTemplate` with
`layoutId: "diagram"`), so it flows through the EXISTING patch pipeline,
validate→repair loop, change-set staging/reject, and picker — **no new patch
actions, no new storage**. Verification: `npm run verify:visuals` (75 checks,
no key/DB) + `tsc` clean + existing suites green.

- **Diagram model** (`lib/course/diagram/*`, pure): a `DiagramSpec` union of **9
  kinds** — `supply_demand` (+ price ceiling/floor), `coordinate_plot`,
  `bar_chart`, `array_diagram` (two-pointers / sliding window / binary search),
  `tree_diagram`, `graph_diagram` (weighted/Dijkstra), `flowchart`,
  `number_line`, `venn` — plus a `VisualSpec` (pedagogical purpose + alt text +
  the reason it was added) and `DiagramContent` (title + caption + takeaways +
  spec + diagram). STRICT AI Zod schema (`schemas.ts`) with length/count caps and
  a `.superRefine` running the deterministic **`validateDiagram`** correctness
  check; a permissive STORAGE schema so loading never breaks. The AI tree node is
  FIXED-DEPTH (no `z.lazy`) so it inlines into OpenAI-strict JSON with no
  recursive `$ref`. A **template catalog** (`catalog.ts`, 19 named correct
  diagrams across econ/CS/math/business) seeds canonical visuals accurately and
  powers the router's "is there a programmatic template?" match (whole-WORD
  matching — `"bst"` can't match inside `"abstract"`).
- **Renderers** (`components/editor/slide/diagram/*`, pure → SSR/thumbnail/export
  safe): a shared SVG toolkit + 9 deterministic renderers (`DiagramView`) +
  `DiagramLayout` (the `diagram` structured layout — title + SVG + caption +
  optional takeaways column, `role="img"` + alt text + the machine-readable
  `data-ai-component="slide-visual"` envelope from spec §14). Auto-dispatched in
  `StructuredSlide`, auto-listed in the `LayoutPicker` "Structured" section.
- **Planning** (`lib/ai/outline.ts`): `visualIntent` upgraded from a bare string
  to a structured object (`required`/`role`/`reason`/`expectedVisualType`/
  `placement`/`priority`/`mustBeAccurate`) — tolerant coerce accepts the object
  OR a legacy string. The PLAN prompt gained visual-necessity rules (most slides
  need none; require one only when it materially improves teaching) and the old
  "explain drawings in prose" prohibition was REVERSED ("we render accurate
  programmatic diagrams — plan one when conventional").
- **Generation** (`lib/ai/tools/structuredSlides.ts`): `add_diagram` /
  `set_diagram` tools (a `templateId` seeds an accurate canonical diagram, or a
  custom `diagram` validated at the tool boundary); the `diagram` variant is also
  in the structured-slide batch schema. The teaching bar now tells the model to
  draw the picture a concept needs with `add_diagram` (still no AI/stock images,
  no fabricated chart data).
- **Validation/repair** (`lib/ai/validation.ts` + `phases.ts`): a new
  `REQUIRED_VISUAL_MISSING` hard failure — a slide whose plan REQUIRED a visual
  must carry one (accuracy-critical roles demand a real diagram/image; others
  accept any visual layout). The repair brief tells the model exactly which
  slides need a diagram and to prefer a `templateId`. Soft `VISUAL_SKIPPED` lint
  for recommended visuals. Human controls: an inspector **DiagramEditor** (view
  the spec + live validation, edit alt/caption/takeaways, swap template /
  regenerate, per-kind label editing, "make simpler") — change-set Accept/Reject
  already covers a diagram block.
- **Pipeline scaffold** (`lib/ai/visuals/*`): the full router-facing
  `VisualSpec`/`VisualAsset`, the source **router** (programmatic → AI-generated →
  web → manual, by priority), an image-prompt builder, and a flag-gated
  image/web generation seam — all matching the conservative **defaults**
  (`AI_VISUALS_ENABLED=true`, `AI_PROGRAMMATIC_DIAGRAMS_ENABLED=true`,
  `AI_IMAGE_GENERATION_ENABLED=false`, `AI_WEB_IMAGE_SEARCH_ENABLED=false`,
  `AI_VISUAL_VALIDATION_ENABLED=true`). AI image generation + web sourcing are
  Phase 3/5, scaffolded OFF; the programmatic path is the impressive, working one.

## Module SKELETON plan + lazy per-lesson rich planning — kill the module-plan timeout, 2026-06-19

Even after a lean schema + low effort, `generate_module` STILL timed out (~76s,
`rawLength:0`, before any timeout fired) — the model reasoned silently over the
whole-module plan and the connection dropped. Root cause: ONE call was doing two
jobs (unit map + every lesson's teaching contract). Redesigned so the first call
is tiny:

- **MODULE SKELETON → approve → per lesson: RICH plan → GENERATE → VALIDATE/REPAIR.**
  The first call (`ModuleSkeletonSchema`, `lib/ai/outline.ts`) returns only a
  COMPACT lesson MAP — per lesson: title, objective, rationale, prereqs, skills,
  estimatedMinutes, slide-range, suggested blocks, recommend quiz/homework — **no
  per-slide arrays, no speaker notes, no quiz content**. ~2.8 KB schema vs the old
  ~6 KB; returns in seconds. Each lesson's full contract (`LessonOutlineSchema`) is
  planned **LAZILY**, right before that lesson is generated (`runRichLessonPlan`,
  high effort, one small lesson) — so quality is preserved without one giant call.
  A lesson whose rich plan fails is **skipped + reported**; the rest still build,
  and a checkpoint lists what's left (`runGenerateModule` in `lib/ai/phases.ts`).
- **Ultra-lean FALLBACK** (`ModuleFallbackSchema`: title/objective per lesson + a
  count, no nested arrays): if the skeleton call **transport-fails**, the system
  retries ONCE with this tiny schema in **background mode**, then lets the user
  approve the rough map. Both fail → a clear checkpoint, never a hang.
- **Error categories, separated** (`modelClient.ts` `ModelErrorKind`; `openai.ts`
  `classifyError`): a transport **timeout** is no longer parsed as "invalid JSON".
  `agent_plan_fail` now logs `errorType` = `transport_timeout` | `model_error` |
  `transport` | `schema_error`; the empty timed-out body is never run through the
  JSON validator. The user sees "Module planning timed out before the model
  returned a plan. Try a smaller module request" — not a schema error.
- **Background mode + non-streaming plans** (`openai.ts`): plan calls are now
  NON-STREAMING (a plan needs reliability, not token streaming). `background:true`
  CREATEs the response then POLLs to completion (no long-held idle connection an
  proxy can drop) — opt-in via `AI_USE_BACKGROUND_FOR_PLANS`, and automatic for the
  module fallback after a timeout.
- **Instrumentation** (`agent_plan_request` before every plan call): planType
  (`module_skeleton`/`module_fallback`/`lesson_rich`/`lesson`), model, effort,
  timeoutMs, approxInputChars, approxSchemaChars, maxOutputTokens, background,
  streaming — so a future failure makes the cause (timeout vs schema vs model vs
  proxy) obvious from the logs.
- **UI** (`AgentPlanHost.tsx`): the module review card renders the lesson MAP
  (briefs + slide ranges + quiz/practice chips) with a note that each lesson's
  slides are planned just before it's built. `PlanOutline` module variant now
  carries `skeleton` (was the full outline).
- **Preserved:** bounded history, structured slide tools, batch generation,
  deterministic validate/repair, slideSpecId coverage, no default `gpt-5.5`,
  critique off, the approval gate, single change-set per module build.
- **Verified:** build + lint + tsc; `verify:ai` 64+**26**+27+32 (skeleton + fallback
  schema/coerce); `verify:slides` 17+8+67+23; `verify:reject` 17; `verify:ai:int`
  **76** vs live Supabase (+ skeleton→approve→per-lesson-rich-plan→generate,
  skeleton-timeout→fallback-in-background, and both-timeout→clear-message paths).
  No DB migration.

## Deterministic VALIDATE/REPAIR replaces heavy CRITIQUE — the plan is a contract, 2026-06-18

The heavy CRITIQUE pass was disabled (poor quality-per-cost). The reliability
problems it papered over — a deck finalizing with only 3 slides, a leftover
"Section title" placeholder, a failed batch silently skipping slides — are now
solved STRUCTURALLY: **PLAN → GENERATE → VALIDATE/REPAIR → (optional LIGHT
REVIEW) → STAGE**. Correctness is enforced by code, not by a model's opinion.

- **PLAN is the contract** (`lib/ai/outline.ts`): every slide spec now carries a
  pedagogical `role` (hook / worked_example / common_mistake / conceptual_check /
  edge_case / recap / …) + `kind` (`core` | `enrichment`), and the lesson carries
  a `microLesson` flag. The prompt gives explicit slide-count guidance (micro 3–4
  only on request · normal 6–10 · technical 7–12 · complex 9–14) and a "deepen,
  don't pad" checklist. A **depth floor** (`lessonDepthShortfall`, env
  `AI_MIN_NORMAL_LESSON_SLIDES`/`AI_MIN_TECHNICAL_LESSON_SLIDES`) re-asks ONCE when
  a non-micro plan comes back too thin — the PLAN-time half of the 3-slide fix
  (reuses the single repair-call slot in `runStructuredPlan` via a `postValidate`
  hook; a valid-but-thin plan is never lost if the deepen re-ask returns garbage).
- **No more placeholder decks** (`factories.ts`/`commands.ts`/`tools/structural.ts`):
  AI-created slide decks start EMPTY (`createBlock(…, {emptySlideDeck})`); the
  human AddBlockMenu keeps its starter slide. GENERATE now PRE-CREATES the empty
  deck and threads its `deckBlockId` into the context, so the model authors real
  slides into a known deck and never seeds a placeholder. `add_structured_slides_batch`
  takes a **nullable** `deckBlockId` that resolves to the lesson's deck (robust to
  a model that mis-cites the server-generated id; creates one if absent).
- **VALIDATE** (`lib/ai/validation.ts`, pure): after GENERATE, checks the doc
  against the plan — every spec built, no placeholder/empty slide, no duplicate
  primary spec, required quiz/homework present, deck not short of the contract,
  budget not exhausted mid-build. `lib/ai/slideDiagnostics.ts` is the leaf detector
  (precise placeholder/empty detection — a flat seed-only slide; a structured
  slide is authored content).
- **REPAIR** (`lib/ai/phases.ts`): hard failures are fixed — DETERMINISTICALLY
  first (strip placeholder/empty slides, drop junk/empty decks — no model), then a
  NARROW model pass handed ONLY the missing spec briefs + missing blocks ("fix
  these, leave correct slides alone"), re-validating each round up to
  `AI_MAX_REPAIR_PASSES`. If the contract still isn't met, it **checkpoints** with
  exactly what remains — a short deck is never presented as complete.
  `LoopResult.checkpointed` distinguishes "ran out of budget" from "model was done".
- **Generation state tracks remaining work** (`generationState.ts`): the bounded
  summary now carries the specs still to build, duplicates, placeholders present,
  slides missing a spec id, incomplete segments, and required blocks missing — so
  bounded history can't make the agent forget the rest of the contract.
- **Deterministic LINT + optional LIGHT REVIEW** (`lib/ai/lintGeneration.ts`,
  `lib/ai/lightReview.ts`): after hard validation passes, a no-model linter emits
  SOFT suggestions (thin slide, no speaker notes, example-planned slide with no
  example, quiz short of plan, …). An OPTIONAL **one-call** review (no tool loop,
  no regeneration, `gpt-5.4-mini`/medium) adds ≤3 suggestions — OFF by default,
  fired only when lint warnings cross `AI_LIGHT_REVIEW_LINT_THRESHOLD`. Neither
  blocks staging.
- **UI** (`events.ts`/`agentStore.ts`/`AgentPanel.tsx`): new `validate`/`repair`/
  `review` phases + `validation` ("Found 4 missing slides. Repairing…", "Final
  validation passed.") and `quality_report` events. The panel shows a calm
  validation line + a "Quality suggestions" card (warnings collapse behind a
  count; each review suggestion gets an "Ask AI to improve" action).
- **Config:** all default-ON for correctness, no premium `gpt-5.5` by default —
  `AI_VALIDATE_GENERATION` · `AI_REPAIR_HARD_FAILURES` · `AI_MAX_REPAIR_PASSES` ·
  `AI_LIGHT_REVIEW_ENABLED`/`_ON_LINT_THRESHOLD`/`_LINT_THRESHOLD` (`modelConfig.ts`).
  The legacy CRITIQUE path is kept behind `AI_CRITIQUE_ENABLED` (off) for parity.
- **Module-plan timeout fix:** "make all of module 3" failed with "The AI service
  hit an error" — diagnosis from the logs: the whole-module PLAN call **timed out**
  (`openai_error: Request timed out`) at ~77s, BEFORE our 120/180s timeouts — i.e.
  the model "reasons" for >75s producing **zero output** (`rawLength: 0`) over the
  giant per-slide outline, and the silent connection is dropped (server-side / a
  local proxy). Fixes: (a) the module plan is now a **DELIBERATELY LEAN** schema —
  `concept + layout + depth` per slide, NO per-slide keyPoints/notes/prerequisites
  (those were the bulk the model had to generate); the per-lesson GENERATE expands
  each concept. (b) **LOW effort** for the module plan (`AI_PHASE_MODELS.modulePlan`,
  env `AI_MODULE_PLAN_EFFORT`) — the single-lesson plan stays high; depth is built
  in GENERATE. (c) `runStructuredPlan` no longer **re-asks after a TRANSPORT error**
  (`finishReason === "error"`) — that was burning a SECOND timeout (the original
  2.6-min double-fail); it bails with the real provider message, now **surfaced to
  the chat** + the `agent_plan_fail` log (the PLAN path was swallowing the provider
  `error` event via `() => {}`). (d) a longer per-call PLAN timeout
  (`ModelTurnParams.timeoutMs`, `AI_PLAN_TIMEOUT_MS`=180s) as a safety net. Net: the
  module plan is now a small, fast call that returns in seconds.
- **Verified:** build + lint + tsc; `verify:ai` 64+20+27+**32** (new `verify-validation.ts`:
  placeholder detection, every hard-failure class, deterministic repair, depth floor,
  lint + review trigger); `verify:slides` 17+8+67+23; `verify:reject` 17;
  `verify:ai:int` **67** vs live Supabase (+ clean-validate, missing-spec repair,
  placeholder removal, and light-review-trigger end-to-end). No DB migration.

## Per-phase model · prompt-cache fix · reject↔autosave race (A/B/C), 2026-06-17

- **A — per-phase MODEL (not just effort):** `ModelTurnParams.model` + `LoopOptions.model` make the model a per-call parameter (provider falls back to `OPENAI_MODEL`/`DEFAULT_MODEL`). PLAN/CRITIQUE = `gpt-5.5`/high, **GENERATE = `gpt-5.4-mini`/medium** (the high-volume phase stays cheap), classifier = `gpt-5.4-mini`/minimal. `agent_phase` logs the per-call `{phase, model, effort}` (was logging the client default). Both strings confirmed valid live.
- **B — prompt caching fix:** the `~19.5K` stable prefix wasn't caching because `buildSystemPrompt` put the **variable** course/lesson context BEFORE the large static catalogs, truncating the cacheable prefix at the course title (and `cached_tokens` wasn't even logged). Fix: `buildSystemPrompt` is now **STATIC only** (role + catalogs + teaching bar); the variable course/lesson/outline moves to a leading `developer` message in `input` (new `buildContextMessage`), so the static system + tool schemas form one byte-identical prefix. `cachedTokens` added to `PhaseUsage` + the log. **Live spot check: ~98% of input cached on a repeat call** (10,752 / 10,994), vs effectively the role-only prefix before.
- **C — Reject ↔ autosave race + resilient autosave:** the "Course autosave failed: TypeError: Failed to fetch" around Reject was the debounced autosave (`coursePersistence.ts`) racing the reject's reconcile — a stale in-flight flush (un-reverted client doc) writing concurrently with the server revert (it's a transport-layer fetch failure, not an abort; reject merely provokes it). Fix: Reject now **suspends + aborts** autosave before the POST (`suspendAutosaveForReject` + an `AbortController` threaded into `reconcileCourseDoc` via `abortSignal`), and `hydrate` resumes + **skips re-saving** the reverted doc (already server state); the reject POST-failure path resumes too. Autosave failures now **auto-retry with backoff** (2 attempts) before surfacing `saveStatus("error")` — a transient blip no longer silently loses work. Server reject was already pending-only + atomic; Accept-all is untouched.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+48+23; `verify:ai:int` **53** (+per-phase-model + cacheable-split assertions); `verify:reject` 17. No DB migration.

## GENERATE quality — bind to the planned layout + teach with depth (A–E), 2026-06-17

PLAN was solid but GENERATE rendered skeletal primitives: a planned `concept_example`/`key_concept` "Greedy intuition" slide came out as three TIP boxes of ~5 words. General (not one-slide) fixes:
- **Root cause:** PLAN speaks the **structured** layout vocabulary, but GENERATE authored via `write_slide_deck` whose enum is the **14 FLAT layouts only** → a planned structured layout became a flat `step_by_step` (3 `variant:"tip"` callouts). Nothing bound slide *i* to the planned layout, and the prompt mandated brevity ("a few words each", "no walls of text") with max-only slot caps (no floor).
- **A — model `gpt-5.5`** (`openai.ts` `DEFAULT_MODEL`; `OPENAI_MODEL` overrides). Per-call effort already PLAN high / GENERATE medium / CRITIQUE high; logs carry model+effort. Confirmed valid against the live API.
- **B — deeper PLAN** (`outline.ts`): prompts now DECOMPOSE a concept into building sub-steps (each weight-bearing one its own slide), mandate ≥1 worked example + a low-stakes check, sequence primitive→improved, and — new — a required `keyPoints[]` per slide carrying the **actual content** (the writer's brief), surfaced in `outlinePromptFragment` as a "cover:" list.
- **C — bind to the planned (structured) layout + plain first-class:** new **`prose`** structured layout (a real teaching text slide: title + substantive body + optional points) added via the esd pattern (8 structured layouts now). `OUTLINE_LAYOUTS` is all-structured (`prose` replaces the bare "text" fallback). GENERATE/CRITIQUE run a new **`GENERATE_TOOL_NAMES`** set — reads + structured slide tools + `create_block` + `write_quiz/homework/lecture`, **excluding `write_slide_deck` and the flat slide ops** — so a flat tip/text deck is impossible; the prompt says render the planned layout, upgrade only to a better *structured* layout, never silently downgrade.
- **D — depth floor** (`context.ts`): the GENERATE teaching bar now demands real teaching (full sentences/steps/worked example, expand the brief, fill slots), **bans skeletal/3–6-word slots**, and the conflicting brevity lines are removed (max caps stay). A `agent_thin_slides` heuristic logs under-filled structured slides (observability — modules have no critique).
- **E — CRITIQUE enforces A–D** (single-lesson builds): fail-and-revise on skeletal slides, layout≠plan-without-justified-upgrade, missing worked example, should-build-up; structured-tool fixes only; one bounded pass. **Module builds stay GENERATE-only** (your call) — B+C+D carry module quality.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+**48**+23 (prose); `verify:ai:int` 49 (GENERATE toolset asserted structured-only); `verify:reject` 17. **Live spot check (gpt-5.5, routed via the proxy):** a Kruskal lesson planned 14 all-structured slides with keyPoints, decomposed greedy→cut property→algorithm→DSU→worked trace→check→correctness→runtime, with a `prose` slide + worked examples. No DB migration.

## Fix: "create a module" misrouted + generation went off-script (FK + no module), 2026-06-17

"Please create module 4 … only do the first 2 lessons" produced no module 4, a tangle of create/list/delete-lesson tool calls, and a save error `insert or update on table "lessons" violates foreign key constraint "lessons_module_id_fkey"`.

- **Root cause — router (`lib/ai/intent.ts`):** the `generate_module` short-circuit was gated by `&& !/\blessons?\b/i.test(msg)`, so ANY module request that mentions "lessons" (nearly all do) was disqualified and fell through to `generate_lesson`/edit. The dedicated module pipeline never ran. **Fix:** dropped that guard; added a narrow `LESSON_INTO_MODULE` check ("add a lesson to/in module X" → `generate_lesson`) that takes priority, else a module build → `generate_module`. Now "create a module … with N lessons" routes to the module pipeline.
- **Compounding cause — unconstrained generation (`lib/ai/tools/index.ts`, `agentLoop.ts`, `phases.ts`):** the GENERATE/CRITIQUE loops were handed the FULL toolset, so the misrouted model improvised — `create_lesson` (into the wrong/current module, since it defaults there), `delete_lesson`, etc. — churning the tree into an inconsistent state that failed the whole-doc reconcile (the FK). **Fix:** GENERATE + CRITIQUE now run with `authoringOnly` — restricted to `AUTHORING_TOOL_NAMES` (read context + write/edit slides/decks/quiz/lecture), EXCLUDING structural + destructive tools. The pipeline owns module/lesson creation; the edit path keeps the full toolset.
- **Tests:** `scripts/verify-outline.ts` gained routing assertions (module-with-lessons → module; add-lesson-to-module → lesson; short-circuits make no model call); the live `verify-agent-integration.ts` module case now uses lesson-naming phrasing and asserts the GENERATE toolset excludes `create_lesson`/`delete_*` and includes the authoring tools. `verify:ai` 63+16, `verify:ai:int` 49, build/lint/tsc green. No DB migration.
- **Known follow-up (NOT in this change):** the FK was reached because the agent's server reconcile and the studio's browser autosave both do **full-snapshot whole-doc writes on the same course with no coordination** — interleaved upsert/delete-orphans can transiently orphan a row. Constraining generation greatly narrows the window, but the real fix (pause autosave during an agent run, or scope reconcile to touched subtrees / serialize writes) is tracked separately.

## Fix: PLAN structured-output always failed ("couldn't produce a valid outline"), 2026-06-17

Every lesson AND module PLAN failed with the generic "couldn't produce a valid {outline|plan}" — even a tiny request. `verify:ai:int` passed only because the MOCK provider never exercises OpenAI's real structured-output path. Reproduced against the live API (routed through the dev proxy since the openai SDK / undici ignores `HTTPS_PROXY`).

- **Root cause (provider text extraction):** for a reasoning + structured-output (`text.format` json_schema) response, the OpenAI Responses API returns the JSON in the `message` output item but **`final.output_text` is empty** (live: `outputTokens 13589`, `reasoningTokens 11507`, yet `output_text.length === 0`). The provider read only `final.output_text` → empty → `JSON.parse` failed → the generic error. **Fix (`lib/ai/providers/openai.ts`):** new pure `messageTextFromOutput(output)` reads the `message` items' `output_text` parts directly; the turn now uses `messageTextFromOutput(...) || final.output_text || streamedDeltas`. Confirmed live: both lesson + module now return valid outlines.
- **Hardening (defense in depth, also justified by the live numbers):**
  - **Output budget:** the PLAN call now passes `maxOutputTokens` 32000 (was the 16000 default) so high-effort reasoning (~11k tokens observed) can't starve the JSON.
  - **Bounds-relaxed parse (`lib/ai/outline.ts`):** OpenAI strict mode strips `min/max/minItems/maxItems` from the schema, so the model is never told the floors/ceilings — rejecting on them locally just bounced a good plan. New `coerceOutline`/`coerceModuleOutline` parse types + enums (enums ARE API-enforced) and **clamp counts** (≥1 slide accepted, >14 truncated; lessons ≤8; empty-slide lessons dropped) instead of hard-failing; the "3–14 / length" guidance stays in `.describe()` + the prompt. Resume re-validation uses the same coercion (so an approved relaxed plan isn't re-rejected at approve).
  - **Real errors surfaced:** `runStructuredPlan` logs the true cause on failure (`finishReason`, reasoning/output tokens, raw head) and the user message now distinguishes "cut off" (incomplete) / "service error" from "invalid"; `openai.ts` captures the API error status + body verbatim.
- **Closed the test gap (`scripts/verify-outline.ts`, in `verify:ai`):** asserts the generated lesson/module response schemas obey OpenAI strict rules (no forbidden keywords; every object `additionalProperties:false` + complete `required`), the relaxed parse accepts a 1-slide/over-count/long-title outline and clamps, and `messageTextFromOutput` recovers JSON when `output_text` is empty. No DB migration.

## Phased agent — fix the bypass: module-level plan, 3-way routing, forced layering, prominent review, 2026-06-16

The phased pipeline shipped but a real request — "Add a search algorithm module … also counting and radix sorts" — bypassed it: it created a module + 4 lessons + 4 **basic** decks with **no plan card** (even with auto-approve OFF). Root cause (confirmed): the router classified "add a … module" as `edit`; the pipeline was **per-lesson only** (couldn't build a module); and **all non-pipeline content creation ran the un-layered loop**. Fixed end-to-end. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **47** (39 prior + 8 module-build), slides/reject unchanged.

- **A — 3-way routing** (`lib/ai/intent.ts`): `generate_module | generate_lesson | edit`. High-precision regex short-circuits for module/lesson builds (incl. "add a … module"), a small-add guard so "add a knowledge check / a slide / fix wording" stays on the fast `edit` path, and a rewritten 3-mode classifier (defaults to `edit`).
- **B — module-level plan** (`lib/ai/outline.ts` `ModuleOutlineSchema` = ordered lessons, each with its slide outline): the module request produces ONE plan card (module title + every lesson's outline), approve once → create the module + lessons → GENERATE each lesson (layered). **Per the cost trade-off, module builds skip CRITIQUE** (single-lesson generation still runs it); revisit if quality needs it. One reconcile → **one** change-set across the whole module; per-lesson progress via `phase.detail` ("Linked lists (2/4)").
- **C — no un-layered content path** (`lib/ai/agentLoop.ts`, `phases.ts`): the `edit` loop and the delete-resume loop now run `layered:true` (teaching bar + layout guide, no plan gate, still single-turn) — so any deck the fast path creates still meets the bar. The fast path stays fast (no PLAN/CRITIQUE).
- **D — prominent review** (`components/editor/agent/AgentPlanHost.tsx`): the plan review moved from a scrollable inline card to a **modal mounted at the shell level** (scrollable body + sticky Approve & generate / Discard, renders lesson vs module), so it can't scroll past and shows even if the panel is collapsed. `plan_outline` + `pendingOutline` are now discriminated (`kind: "lesson" | "module"`). Auto-approve stays OFF by default + honored server-side.
- **Instrumentation:** every `agent_phase` log now carries `layered`, and the `edit` path logs a phase line too — every run is traceable.
- New route entry `resumeGeneratePlan` (replaces `resumeGenerateLessonTurn`) dispatches lesson vs module on approve. No DB migration (outlines stay transient).

## Phased content agent — PLAN → GENERATE → CRITIQUE (per-call effort + sidebar phases), 2026-06-16

The single-turn content agent produced shallow decks (text + code + tip boxes, structured layouts unused, foundational concepts skipped, a whole lesson in ~30s). Effort was already `medium` — a process/prompting problem, not a knob. Fixed by giving ONE agent (gpt-5.4-mini) an explicit three-phase pipeline with **per-call reasoning effort**, a teaching bar + layout decision guide, and a fresh-eyes critique. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **39** (25 prior + 14 phased), `verify:slides`/`verify:reject` unchanged.

- **Per-call reasoning effort** (the seam): `ModelTurnParams` gains `effort?` + `responseFormat?`; `ModelTurnResult.usage` gains `reasoningTokens`. `providers/openai.ts` applies `params.effort ?? envDefault`, passes `text.format` json_schema for structured turns, and maps `reasoning_tokens`. The env value is now a fallback default only.
- **Auto-detect routing** (`lib/ai/intent.ts`): each turn is classified `generate_lesson` vs `edit` — a regex short-circuit for obvious "build a lesson/deck" phrasing, else a minimal-effort structured classification (defaults to `edit`). Small edits keep the existing single-turn loop untouched.
- **PLAN** (`effort:high`, structured output → `lib/ai/outline.ts` `LessonOutlineSchema`): emits a slide-by-slide outline (concept · prerequisites · layout · depth · notes), validate→repair (one re-ask). Manual approval by default — emits a `plan_outline` event and pauses (mirrors the delete confirm flow); an **auto-approve toggle** collapses the pause. The outline is **transient** — it round-trips client→server and is consumed by GENERATE/CRITIQUE; never persisted (no `courses.plan` change, no migration).
- **GENERATE** (`effort:medium`): the shared loop with a layered system prompt (teaching bar + layout decision guide + the approved outline appended at the end so the stable prefix still caches).
- **CRITIQUE** (`effort:high`, ONE bounded pass): a fresh-eyes critic prompt with the lesson's deck serialized **as data**; revisions go through the same ops tools. The whole pipeline reconciles once and stages **one** reviewable change-set (baseline = doc before GENERATE).
- **Sidebar phase indicator** (user-requested): new `phase` + `plan_outline` SSE events → `agentStore` (`phase`, `pendingOutline`, `autoApprovePlan`) → `AgentPanel` shows a PLAN/GENERATE/CRITIQUE badge, an inline outline-review card (Approve & generate / Discard), and an auto-approve checkbox.
- **Instrumentation**: one structured `console.log({ tag:"agent_phase", phase, model, effort, toolCalls, inputTokens, outputTokens, reasoningTokens, latencyMs, … })` per phase.
- **Loop reuse**: `runConversationLoop`/`loopContext`/`LoopContext` are now exported and take per-call options (`effort`, `outline`, `layered`, `systemOverride`, `maxTurns`, `deferFinalize`) and return `{doc, usage, toolCalls, …}`. Legacy callers pass no options → byte-identical. New `lib/ai/phases.ts` owns the orchestration (`runContentAgentTurn`, `runGenerateLessonTurn`, `runGenerateThenCritique`, `resumeGenerateLessonTurn`); new route `app/api/ai/agent/plan/route.ts` resolves the approval (mirrors `/confirm`).

## Fix: agent staging crash on a divergent docked lessonId (change_sets FK), 2026-06-16

The agent could apply a slide/block edit successfully and then fail staging with
`insert or update on table "change_sets" violates foreign key constraint
"change_sets_lesson_id_fkey"`. Root cause: `change_sets.lesson_id` was populated
from the **client-supplied docked `lessonId`** (`useEditorStore.activeLessonId`
→ request body → `agentLoop` → `createChangeSet`), never validated against the
DB. When that id was a client-only / not-yet-autosaved / stale lesson (no
`lessons` row), the insert violated the FK. The tool edit itself already
persisted (the full-doc `reconcileCourseDoc` runs *before* `createChangeSet`, in
a separate non-transactional call), so the change survived reload while staging
crashed and surfaced a red error on a successful edit.

- **Fix (`lib/ai/agentLoop.ts`):** coalesce the change-set's `lesson_id` to a
  server-validated value — trust the docked id only if `findLesson(doc, …)`
  finds it in the just-reconciled doc, else fall back to a changed block's
  lessonId (always persisted) or `NULL` (the column is nullable). The FK target
  now provably exists or is NULL.
- **Twin (`lib/ai/conversations.ts`):** `getOrCreateConversation` now stores
  `lesson_id` only if the lesson exists, else `NULL` — the same latent
  `conversations_lesson_id_fkey` would otherwise fire on the first turn of a
  thread opened on an unpersisted lesson.
- **Regression (`scripts/verify-agent-integration.ts`, now 25 checks):** an
  agent turn with a non-existent docked `lessonId` editing a block in a real
  lesson — asserts the tool succeeds, no error event, the change_set is emitted,
  and its `lesson_id` is coalesced to the real lesson (not the bogus id); plus a
  conversation opened on a non-existent lesson stores `lesson_id NULL`. Verified
  it reproduces the exact FK error when the fix is reverted. `change_set_items`
  has no lesson FK and its `lesson_id` comes from the diff (always valid), so it
  was never affected. No schema/migration change.

## Three more structured layouts — section break · concept→example · outline list, 2026-06-16

Added three renderer-owned structured layouts through the EXISTING pattern (no
new architecture): one registry entry + strict length-enforced Zod schema +
React component + discriminated-union variant + dispatch case each, auto-exposed
to the AI catalog and the manual "Structured" picker. Brings the registry to
**7** structured layouts. Verified: `npm run build` + `npm run lint` clean, 44
pure structured-layout checks + 23 agent-facing checks (`npm run verify:slides`),
17 reject/revert checks (incl. a new structured slide restored byte-for-byte),
63 AI tool/schema checks (`npm run verify:ai`), and a 10-frame Playwright
near-max overflow sweep (every slot at its limit + max item/step/sub-item counts,
all variants, both decoration levels — no clipping or overflow).

- **`section_break`** (refs 1–4 = one layout): a chapter/section transition — a
  numbered mono kicker, a big title, a short accent underline, and a one-line
  framing. Variants `standard` / `hero_numeral` (giant outline numeral) ×
  `titleStyle` serif/sans. Serif titles get renderer-owned **two-tone** coloring
  (accent on the last word). Decoration = kicker/base rules + corner concentric
  arcs + dot-grid.
- **`concept_example`** (refs 5–6 = one layout): an abstract rule/definition
  (left) paired with a worked example (right) whose body is a discriminated union
  — `steps` (2–4, numbered) OR `paragraphs` (1–3, prose). Renderer owns the "in
  practice" connector (solid for steps, dotted for paragraphs), the badges, the
  step number badges, and the optional footnote callout.
- **`outline_list`** (ref 7): a titled nested list serving both lesson objectives
  and a module table of contents — 2–5 items, each with 0–2 optional sub-points.
  Renderer owns the top accent bar, the rule, number markers, two-tone
  main-vs-sub coloring, indentation, and count-based type scaling/reflow.
- **Decoration is renderer-owned and dial-able.** Each layout carries a
  `decor` (`"full" | "minimal"`) knob — present in the PERMISSIVE storage schema
  and the inspector, but DELIBERATELY ABSENT from the strict AI tool schema, so
  the model can never request or position flair. The AI's contract is the slot
  structure only.
- **Reliability guard unchanged:** every text slot carries an enforced `.max()`
  + length hint; counts are bounded; the validate→repair loop bounces overflow
  before render. New `RichText` slots reuse the nullable-`marks.color` schema (no
  `received null` regressions). New layouts have NO `ITEM_BOUNDS` entry (now
  `Partial`) — the inspector dispatches to bespoke panels for them and keeps the
  generic item editor for the original four. No DB migration (jsonb).
- **Files:** `lib/course/types.ts` (+content interfaces, `DecorLevel`, union),
  `lib/course/schemas.ts` (permissive storage branches),
  `lib/course/slide/structuredLayouts.ts` (LIMITS + strict schemas + registry +
  input union), `components/editor/slide/structured/{SectionBreak,ConceptExample,
  OutlineList}Layout.tsx` + `common.tsx` (`twoToneTitle`, `Badge`, `EditableText`
  children) + `StructuredSlide.tsx` dispatch, `LayoutPicker.tsx` (thumbnails),
  `components/editor/inspector/StructuredContentEditor.tsx` (dispatcher + 3
  bespoke editors). AI tools (`add_structured_slide` / `set_structured_slide`)
  pick them up automatically via the shared input union.

## Module & lesson deletion — for the user AND the agent (with confirmation), 2026-06-16

Neither the creator nor the agent could delete a module or a lesson; now both
can, and every delete is gated by a confirmation. For the agent, the
confirmation is a HARD PAUSE: it proposes the delete, the studio pops the dialog,
and the run is frozen until the creator decides — then it resumes. Verified by
`npm run build` + `npm run lint`, 63 pure + 19 live-Supabase agent checks (incl.
pause→confirm and pause→cancel), and a 10-check Playwright run of the manual flow.

- **New patches** `DELETE_MODULE` / `DELETE_LESSON` (`lib/course/patches.ts`,
  pure reducers + `deleteModulePatch`/`deleteLessonPatch` commands) — the one
  validated way structure is removed, used by BOTH the UI and the agent.
- **Manual deletes** with a shared confirm gate: a reusable `ConfirmDialog`
  (`components/ui/ConfirmDialog.tsx`, portal + focus-on-Cancel + Esc) driven by
  an imperative `confirm()` store (`lib/editor/confirmStore.ts`, one
  `<ConfirmHost/>` in the app layout). Hover-revealed trash affordances on the
  outline sidebar (module + lesson rows), the CoursePage module cards, and the
  ModulePage (a header "Delete" + per-lesson rows) all route through
  `confirmDeleteModule` / `confirmDeleteLesson` (`deleteConfirm.tsx`) → the
  patch pipeline → autosave. Deleting the open module returns to the course home.
- **Agent deletes pause for confirmation.** New `delete_module` / `delete_lesson`
  tools (`lib/ai/tools/structural.ts`) return a `confirm` descriptor instead of
  applying. The loop (refactored into a shared `runConversationLoop`,
  `lib/ai/agentLoop.ts`) detects it, stages a placeholder tool output (keeping the
  conversation valid), emits a new `confirmation_request` event, and STOPS —
  no further tool calls run. The docked panel shows the same `ConfirmDialog` and
  freezes the composer. The decision posts to **`/api/ai/agent/confirm`**, which
  `resumeAgentTurn`s: applies (or skips) the whitelisted delete patch, rewrites
  the placeholder output to "confirmed/declined", and continues the model loop so
  the agent finishes or acknowledges. Deletes are excluded from the reviewable
  change-set (the confirmation IS the gate). The agent's docked-lesson context,
  history replay, and persistence all stay consistent across the pause.
- The system prompt gained a STRUCTURAL EDITS rule (deletes are destructive,
  user-confirmed, and never a stand-in for an in-place edit); the manifest lists
  the new actions.

## Course-root page, light-blue modules & null-mark hardening, 2026-06-16

Closed the "blank course has no clear way to add a module" gap, gave modules
their own colour, and killed a raw validation error that leaked into the agent
chat. Verified by `npm run build` + `npm run lint`, the AI suites (84 checks,
incl. a new null-mark regression), and a temporary Playwright run
(`scripts/verify-coursepage-browser.ts`, 7 checks) driving the real studio
against live Supabase.

- **Course-root page** (`components/editor/CoursePage.tsx`): the center column
  when the COURSE is selected. Mirrors `ModulePage` one level up — a prominent
  "No modules yet → Add module" empty state (the old fall-through showed a
  dead-end "No lesson selected"), and a list of module **preview cards** once
  populated. "Add module" creates + jumps straight into the new module (the
  same guided flow as add-lesson). Wired into `CourseEditorShell`
  (`selection.kind === "course"` → `CoursePage`).
- **Modules are light blue** (sky), distinct from the warm-orange course/lesson
  accent, for the colour variance the studio lacked. Applied to the outline
  sidebar's selected-module row + "Module N:" prefix, the `ModulePage` eyebrow
  (now a sky `Layers` kicker) + not-found state, and every `CoursePage` module
  card. Lesson/content actions stay orange — module identity vs. content reads
  apart at a glance.
- **Agent no longer leaks raw Zod dumps** (`lib/ai/agentLoop.ts`): a failed tool
  call now shows the user a calm one-liner (`friendlyToolError`) while the MODEL
  still receives the full detail to self-correct. The validate→repair guard is
  an internal safety net, not a message addressed to the creator.
- **Null run-marks are accepted + normalized** (the reported `set_structured_slide`
  error). Strict tool schemas advertise every optional key as nullable, so the
  model emits `marks:{color:null,…}` on emphasized runs; the structured AI input
  schema (`lib/course/slide/structuredLayouts.ts`) now uses a local run schema
  that `.nullish().transform()`s those nulls to "absent" — so the produced patch
  is CLEAN and the (untouched, strict) storage schema validates it. Schema
  generation switched to `io:"input"` (`lib/ai/schema.ts`) so the transform is
  representable AND the model is still told null is allowed. Regression-tested in
  `scripts/verify-agent-structured.ts` (accepts null marks, stores no `:null`).

## Slide layouts, primitives & generation, 2026-06-16

Expanded the slide system's vocabulary — more layouts and primitives, not busier
slides — and made the agent use them; hardened Reject. Verified by 4 new pure
suites (`npm run verify:slides` + `verify:reject`, 74 checks) + a temporary
preview page screenshot-checked at seed AND near-max content. New runtime dep:
`shiki` (the only one; deps now 14).

- **Reject is now atomic** (`lib/ai/changeSet.ts`): a new pure
  `revertChangeSet(doc, items, now)` builds the full inverse first and aborts the
  WHOLE revert (throw, stay `pending`) if any item can't invert — no more silent
  `continue`, no half-reverted decks. DELETE-op restores re-add at the original
  index. `scripts/verify-reject-revert.ts` proves byte-for-byte restore
  (create+update+delete, incl. a deck) + the atomicity abort.
- **Sticker primitive library** (`lib/course/slide/stickers.ts`): one pure
  registry (20 lucide-mapped ids) → a new `{type:"sticker",stickerId}` element
  (types/schemas/patches/manifest/factories/`elementFromPlaceholder`), rendered
  single-color in the slide accent inside a tinted circle (`StickerElement.tsx`,
  reusable `StickerGlyph`). Manual picker = Insert→sticker grid; AI inserts by id
  (`add_sticker`, enum-validated). Icon geometry never leaves the renderer.
- **Tokenized fonts** (Task 2): `ElementStyle.fontScale`
  (display/title/heading/body/caption) resolves to a per-theme `typeScale`
  (`themes.ts`) and WINS over legacy raw px; the toolbar + Design tab size
  controls are now token dropdowns (raw px retired from the UI, still rendered).
  New `display` family = Fraunces (editorial serif). AI tool `set_text_style`.
- **Renderer-owned structured layouts** (Task 3): a slide may carry
  `template:{layoutId,content}` (typed, RichText slots) that a dedicated
  component draws — owning arrangement, arrows, numbering, reflow — bypassing the
  freeform element canvas. Four, from cgref1–5: `process_steps`, `key_concept`
  (sans+serif variants + optional spine), `metrics_overview` (chart deferred),
  `code_walkthrough_steps` (Shiki, `lib/course/slide/highlight.ts`, JS engine).
  Registry `structuredLayouts.ts` holds STRICT length-enforcing Zod schemas (the
  reliability fix — an over-long heading bounces back before it renders) + seeds.
  Patches `SET_SLIDE_TEMPLATE` / `UPDATE_TEMPLATE_CONTENT` (path-addressed,
  re-validated); `SlideStage` branches on `template`; `LayoutPicker` gains a
  "Structured" section; in-place text edit + a structured inspector
  (`StructuredContentEditor.tsx`) for add/remove/reorder/sticker/variant/delta.
- **Agent uses the vocabulary** (Task 5): `add_structured_slide` /
  `set_structured_slide` (strict per-layout union schema → validate→repair on
  overflow), `set_text_style`, `add_sticker`; the system prompt
  (`lib/ai/context.ts`) gained the structured-layout + sticker catalogs and
  match-layout-to-content guidance.
- **Export-fidelity ledger:** structured layouts (renderer-owned components) +
  Shiki code are NOT yet PPTX-mapped — flagged for the export workstream; they
  cost more to map than flat layouts. The metrics chart is deferred to
  charts-as-data and is NOT faked.

## Slide agent — production tool surface + content contract, 2026-06-15

Turned the slide agent from "rewrites the whole deck into title+bullets and
leaks `**markdown**`" into a Cursor-style editor bound to the studio's OWN
renderer primitives (one source of truth — no parallel definition). Verified
with the real model: it varies layouts, writes bold that renders, and switches
ONE slide's layout without touching the others.

- **Layout registry, shared:** the agent now binds to `SLIDE_LAYOUTS` (the same
  14-layout registry the renderer + `applyLayoutToSlide` use), incl. each
  layout's `ai.bestFor/avoidWhen` — surfaced as a strict layout enum + a catalog
  in the system prompt (`lib/ai/tools/slideContent.ts`, `context.ts`).
- **Rich text kills the asterisk leak** (`lib/ai/richText.ts`): emphasis is
  STRUCTURED runs (`{text,bold?,italic?}`) → the studio's `TextRun[]` (renders
  as bold/italic), with a markdown→runs safety net so a stray `**` can never
  ship; bullet items flatten to plain (per-item runs are a studio cut).
- **Granular, id-addressed, non-destructive tools** (`lib/ai/tools/slides.ts`):
  `get_deck`, `get_slide`, `add_slide`, `update_slide`, `set_slide_layout`,
  `reorder_slides`, `delete_slide` — each wraps an existing slide patch and
  touches one slide. New additive `SET_SLIDE_CONTENT` patch (slide-level analog
  of `SET_BLOCK_CONTENT`). `write_slide_deck` is now per-slide layout + rich
  content and reserved for generating a FRESH deck.
- **Validate → repair → stage:** content is validated against the chosen
  layout's slots; failures return the message to the model to self-correct; all
  edits flow through the existing change-set staging.
- **No data-model change** (your "fix the wiring, not the model"): slot↔element
  mapping is derived from the slide's current layout; emphasis uses the existing
  `runs` model.
- **Verified:** `npm run verify:ai` (50 checks incl. layout choice, bold-as-runs,
  no-`**`-leak, non-destructive layout switch) · `verify:ai:int` (11) ·
  `verify-agent-live` (13, **real gpt-5.4-mini**: varied layouts, bold runs,
  get_deck→set_slide_layout, slide count preserved). build/lint/tsc green.

## AI Content Agent — first real AI (OpenAI), 2026-06-15

The first real AI layer: a Cursor-style **Content Agent** docked beside the
lesson editor. A creator types a request ("write a 5-slide intro deck and a
4-question knowledge check"); the agent streams its work, mutates the course
through tools, highlights every change for review, and discusses it.

- **Provider-agnostic core** (`lib/ai/*`): a `ModelClient` seam with the OpenAI
  Responses API behind it in ONE file (`providers/openai.ts`) + a deterministic
  `providers/mock.ts`. Server-side agentic loop (`agentLoop.ts`): stream a turn →
  run tool calls → feed results back → repeat (cap 12 + checkpoint).
- **Tools = the ops layer** (`lib/ai/tools/*`): read / structural / content
  writers, all mutating ONLY through the validated CoursePatch pipeline (new
  additive `SET_BLOCK_CONTENT` patch). Tool schemas are Zod → OpenAI-strict JSON
  Schema (`schema.ts`).
- **Change-set staging**: per-turn block diff (`changeSetDiff.ts`) → reviewable
  change-set (`changeSet.ts`); Accept clears, Reject replays the inverse. Editor
  shows an amber pending ring + inline Accept/Reject (`BlockFrame`) and a panel
  review bar; pending state survives reload (server-loaded).
- **Conversation persistence + grounding**: threads/messages in Postgres,
  replayed each turn (no provider-side state); a stable, cache-friendly system
  prompt built from the course plan + current lesson (`context.ts`).
- **Migration** (human-reviewed, applied): conversations / messages /
  change_sets / change_set_items, all RLS author-only.
- **Low-stakes assessments enforced structurally**: removed
  scores/passing/time/attempts/difficulty/points/due-dates from the quiz &
  homework types, Zod schemas, patches, factories, mock, manifest, and the
  studio UI — the schemas can no longer express a grade.
- **Server-only key**: `OPENAI_API_KEY` in `.env.local` (optional `OPENAI_MODEL`
  default `gpt-5.4-mini`). Routes run on the Node runtime, stream SSE.
- **Verification**: `npm run verify:ai` (34 checks — tools/schema/patch round-
  trip, no key) and `npm run verify:ai:int` (11 checks — full loop → tools →
  persist → change-set → accept/reject vs LIVE Supabase via the mock provider).
  `npm run build` + `npm run lint` green.

## C7 — rich text runs (34/34 cumulative — Part C complete)

- **Character-level formatting** for text, heading, and callout elements:
  the model gains `runs: TextRun[]` (`{text, marks: {bold, italic,
  underline, color}}`), with a reducer-maintained invariant —
  `concat(runs.text) === text` — so lint, AI rules, measurement, and search
  keep reading plain `text` completely unchanged. Updating `text` without
  runs clears formatting (a plain rewrite resets styling); old documents
  need no migration.
- **Marks are tri-state**: `bold: false` explicitly REMOVES the element
  weight (so un-bolding a selection inside a semibold heading round-trips;
  `execCommand` toggling surfaced this in verification).
- **Editing**: double-click opens a contenteditable overlay (no new deps);
  ⌘B/⌘I/⌘U format the live selection, and the toolbar's B/I/U + text-color
  swatches route to the selection while a session is open (whole-element
  styling otherwise — toolbar buttons/swatches now preventDefault on
  pointerdown so they never steal the selection). Blur commits ONE undo
  step: text + runs + auto-grow; Esc cancels. Commit serialization
  normalizes whatever the browser produces (b/strong/i/em/u, font-weight
  styles, `<font color>`, div/br breaks) into canonical merged runs.
- Bullet lists keep the plain one-item-per-line textarea (per-item runs =
  known cut). Other known cuts: links, per-selection font size/family,
  toolbar button states don't reflect the live selection yet, inspector
  text edits stay plain (and reset formatting). `document.execCommand` is
  deprecated-but-universal — accepted for this stage, isolated behind
  `richText.ts` for a future custom range implementation.
- **Verify**: double-click any text box, select a word, ⌘B — only that word
  bolds; select all, toolbar Italic — the selection italicizes; one undo
  reverts formatting + text together.

## C6 — real 2-point lines (30/30 cumulative)

- **Lines and arrows are now genuine segments**, not horizontal boxes:
  endpoint geometry lives as frame fractions (`points` on shape elements),
  so the frame stays the selection/snap/marquee AABB and move/resize keep
  working untouched. Old documents need no migration — absent `points`
  renders the legacy horizontal mid-line.
- **Endpoint handles**: a sole-selected line/arrow swaps the 8-handle resize
  box for two endpoint dots; dragging one keeps the other fixed, reshaping
  live (transient frame + points through the shared dragStore). Endpoints
  snap to the usual edge/center candidates (⌘/Alt bypasses); **Shift
  constrains the segment to 45° increments** (verified dx=dy=429.7).
- **One patch per reshape**: new `SET_LINE_ENDPOINTS` (absolute coords; the
  reducer derives a padded AABB — min 24px on the thin axis for a usable
  hit area — and frame fractions atomically). In the AI manifest.
- Arrowheads are now proper SVG markers that orient along the segment at
  any angle; viewBox matches the logical frame, so diagonals render
  undistorted. Stroke style (dash) and color carry over.
- Known difference vs GS: hit-testing/selection still uses the AABB, not
  the stroke; connectors (snap-to-shape anchors) deliberately deferred.
- **Verify**: insert an arrow → drag its end dot anywhere — a real
  diagonal; hold Shift — it clicks to 45° steps; one undo restores.

## C5 — equal-gap spacing guides + px chips (25/25 cumulative)

- **Equal-gap snapping** (Canva/GS): dragging an element (or selection bbox)
  between two row/column neighbors snaps to the point where both gaps are
  equal — per axis, only when no edge/center snap claimed that axis, same
  threshold and ⌘/Alt bypass as everything else. Pure math in `snap.ts`
  (neighbors = non-participants overlapping the moving frame on the cross
  axis).
- **Px measurement chips**: the two gap segments render with rose chips
  showing the gap in logical px, sized against the zoom so they stay
  readable at any scale (`GuideLine.label`).
- **Verify**: three shapes in a row with uneven gaps → drag the middle one
  toward the balance point — it clicks into perfect spacing with "170 ·
  170" chips (verified gaps 170.0/170.0 in the run).

## C4 — OS clipboard integration (23/23 cumulative)

- **Element copy is mirrored to the system clipboard** as a markered JSON
  payload (`lib/editor/clipboard.ts`): ⌘V falls back to it when the
  in-memory clipboard is empty — so paste now **survives reloads and
  crosses tabs**. Same-slide/+24 and in-place placement semantics carry
  through. Foreign/malformed payloads are rejected by the normal Zod patch
  validation; permission denial degrades silently to in-memory-only.
- **Plain text from anywhere pastes as a new text element** (GS behavior):
  copy text in any app → ⌘V on the canvas (or right-click → Paste, which
  centers it on the cursor).
- **The clipboard now holds ONE thing**: copying elements clears the slide
  clipboard and vice versa (previously both ⌘V handlers could fire and
  paste a slide AND elements in one keystroke); payload markers keep the
  two paste paths from misfiring cross-session. Context-menu Paste is
  always enabled (no-op when both clipboards are empty).
- Known limitation (documented in the module): a copy in another tab won't
  beat this tab's newer in-memory clipboard until reload.
- **Verify**: copy a shape → reload the page → ⌘V: it's back (+24). Copy a
  sentence from any app → ⌘V: a text element. Paste into a text editor
  after copying an element: you get the JSON payload (machine format).

## C3 — canvas zoom (20/20 cumulative)

- **Zoom 50–300%** on top of the fit-to-width scale: toolbar − / % / ＋
  control (the % chip resets), **⌘+ / ⌘− / ⌘0** (overriding browser page
  zoom inside the editor), zoom steps ×1.25.
- The canvas container becomes a **scroll viewport** when zoomed past 100%
  (native pan via scrollbars/trackpad); zoom changes keep the viewport
  CENTER stable. At 100% nothing changes visually (no scrollbars).
- All pointer math (drag, marquee, right-click paste point, guides,
  handles) now derives from the scaled stage's own rect, so it stays exact
  at any zoom + scroll — verified: a 120-screen-px drag at 156% moves
  exactly 120/scale logical px (185.8 vs 185.8 in the run).
- Logical coordinates are untouched — elements, patches, and the document
  never see zoom.
- **Verify**: toolbar ＋ twice → 156%, scrollbars appear, drag still lands
  precisely; ⌘0 snaps back to fit.

## C2 — text reflow everywhere + TEXT_CLIPPED lint (17/17 cumulative)

User-confirmed policy: **the box grows and reformats; text is never shrunk
to fit.**

- **Style commits reflow**: changing font size/family/weight, line height,
  letter spacing, or padding on a text-like element re-measures the content
  (same hidden-twin markup as the canvas) and grows the box in the SAME
  commit — one undo reverts style + height together. Wired into both the
  toolbar and the inspector Design tab.
- **Resize commits floor at content height**: a text box can't be committed
  shorter than its re-wrapped content — narrowing it grows it taller, from
  any path (drag handles, inspector W/H fields, multi-selection bbox
  resize). Shrinking the font later does NOT shrink the box back (grow-only).
  Known difference vs GS: group resize doesn't scale font sizes, so a
  narrowed text member grows instead.
- **New lint check `TEXT_CLIPPED`** (+ one-click "Grow box to fit"): catches
  boxes shorter than their content from paths the UI can't guard (AI
  patches, imports). Lint stays UI-free via a registered measurer (the
  editor shell registers it; SSR skips the check). Seed slide 3 now trips
  it deliberately (6 lint demos).
- **Measurer rebuilt on renderToStaticMarkup** — the old createRoot +
  flushSync version was illegal during render (lint runs in render), which
  silently returned wrong heights. Static markup is synchronous and
  render-safe; measurements are cached per element id + metrics key.
- **BUG FOUND & FIXED**: the quality-hint dropdown rendered UNDER the
  sticky slide toolbar (both z-30, toolbar later in DOM) — its Fix buttons
  were unclickable in the overlap. Panel raised to z-40.
- **Verify**: select a text box → inspector W = 240 → it grows taller as
  the text wraps; font size down — height stays; font size up — it grows
  (one undo reverts both). Slide 3's badge now shows "Text is taller than
  its box" with a working one-click fix.

## C1 — audit quick wins (10/10 checks, audit-suite.mjs)

- **BUG FOUND & FIXED: right-click collapsed multi-selections.** A
  right-click also fires pointerdown, which started a move gesture whose
  pointer-up ran the deferred-collapse — so context-menu actions on a
  multi-selection silently operated on ONE element. All gesture starts
  (element move, marquee, resize handles, bbox handles) are now gated to
  the primary button; right-click preserves the selection like GS.
- **#9 Multi z-order kept honest**: reorder actions now apply in
  z-aware order (front/backward → bottom-most first; back/forward →
  top-most first), so "Send to back" on a multi-selection moves the whole
  set with its internal stacking intact (verified: z 3<4 → 0,1).
- **#10 Marquee respects the entered-group scope** — rubber-banding inside
  a group selects only that group's members (was: silently exited to root).
- **#11 Select all**: ⌘A selects every visible, unlocked element on the
  slide (works with just the slide selected too); inside an entered group
  it selects only the group's members. Also a context-menu item.
- **#12 Paste placement (GS semantics)**: the element clipboard now records
  its source slide — pasting on ANOTHER slide lands in place, same slide
  offsets +24/+24, and context-menu paste centers the clipboard's bounding
  box on the right-click point (`canvasPoint` carried in the menu state).
- **#3b Rotation honesty**: `rotation` removed from the element schema —
  validated patches can no longer introduce rotated elements while the
  selection chrome / snapping / hit-testing are axis-aligned. The TS field
  and render path remain for forward-compat (legacy data still renders).
- **#16 Thumbnails memoized**: the reducer deep-clones the doc per patch,
  so identity-based memo can't work — thumbnails now compare a WeakMap-
  cached JSON snapshot per slide and skip re-render + re-lint when their
  slide didn't change.
- **#14 Undo verified, cap raised 50 → 100**: measured the doc at ~24 KB
  JSON (3 slides; a heavy 100-slide course projects to ~780 KB → ~76 MB at
  cap 100) — snapshots are fine until real-scale docs; inverse patches
  deferred to post-Supabase (comment in store.ts records the numbers).
- **#17 Export-fidelity ledger** recorded in CLAUDE.md (justify, shadows,
  dashes, triangle, nested groups, auto-height) for when PPTX export lands.
- **Verify**: right-click one of two selected shapes → Send to back —
  BOTH go behind, still stacked the same. Copy a shape, switch slides,
  ⌘V — it lands at identical coordinates. Right-click empty canvas →
  Paste — it lands centered under your cursor. ⌘A inside vs outside a
  group. Marquee while inside a group.

## B7 — A4: shadows, align-to-selection + distribute, text auto-grow (46/46 cumulative — Part A complete)

- **Shadows**: expressive `style.shadow` model (`{color, blur, offsetX,
  offsetY, opacity}`) with a preset UI — Design tab pills None / Subtle /
  Medium / Strong. Rendered as CSS `drop-shadow` on a body wrapper, so the
  shadow follows the actual pixels (glyphs, triangle geometry, image alpha)
  and the selection ring/handles never inherit it. Custom AI-set values show
  a "custom" note instead of silently mapping to the nearest preset.
- **Align to selection + distribute** (Arrange menu, multi-selections):
  align Left/Center/Right/Top/Middle/Bottom moves every UNIT (lone element
  or whole group closure — groups never tear) to the selection bounding
  box's edge/center; Distribute H/V (3+ units) equalizes the gaps between
  adjacent units, outermost units stay put (`lib/course/slide/arrange.ts`,
  pure math). One applyMany per action = one undo. Locked elements receive
  no moves. Mock AI understands "align these to the left" / "distribute".
- **Text auto-grow (Google Slides behavior, grow-only)**: while editing, a
  hidden twin of the REAL markup (callout label row, bullet gaps — textarea
  scrollHeight gets these wrong) measures the draft each keystroke and the
  overlay grows live; on commit `commitElementTextPatches` lands text +
  height as ONE undo step, capped at the slide's bottom edge. Manually
  enlarged boxes are respected (never shrinks). The inspector Content tab
  commits through the same path via a one-shot flushSync measurer
  (`measureTextLike.tsx`), so text edited there auto-grows too.
- **Undo sweep**: the cumulative suite's cleanup phases double as the
  one-undo-per-operation audit — every editor operation introduced in Part A
  (insert, drag, resize, group, ungroup, duplicate, paste, align, distribute,
  shadow, text+grow commit) reverses with exactly one undo. 46/46 checks.
- **Verify**: select the heading → Design tab → Shadow "Medium" → soft drop
  shadow appears (one undo removes). Double-click it, add 3 lines — the
  editor grows as you type; click away — the box keeps the new height; ONE
  undo restores both text and height. Select 3 shapes → Arrange →
  "Distribute vertically" → equal gaps; "Align left" → flush left edges.

## B6 — A3d: selection-bbox multi-resize (38/38 cumulative)

- **Multi-selections now have a real transform box** (Google Slides):
  one bounding box with 8 handles around all selected members
  (`MultiSelectionBox.tsx`); dragging a handle scales EVERY member
  proportionally about the opposite edge/corner — positions and sizes scale
  by one factor, so arrangements never shear.
- **Min-size floor**: the scale factor stops where the smallest member
  would drop below the element minimum (floors capped at 1, so an already-
  tiny member just can't shrink further without wedging the gesture).
- **Same modifier language as single resize**: Shift on a corner locks the
  bbox aspect ratio; snapping moves only the dragged edge(s) with the same
  6-screen-px threshold + guides; Cmd/Ctrl/Alt bypasses.
- Handles hide while ANY member is locked (the box outline stays); the box
  follows live during move gestures too, since it derives from the shared
  dragStore frames. One `applyMany` per gesture = one undo.
- Shared resize math (`rawResize`/`anchor`/`isCorner`) exported from
  `useElementDrag` instead of duplicated.
- **Verify**: shift-click two shapes → a box with handles wraps both → drag
  its SE handle: both scale together, spacing scales, guides appear near
  snap targets; one undo restores both frames.

## B5 — A3c: nested group / ungroup (34/34 cumulative)

- **Three new patches** (Zod-validated like everything else):
  `GROUP_ELEMENTS` splices a fresh group id into each member's `groupPath`
  at the current scope depth (validates ≥2 distinct units — so groups nest,
  Google-Slides style); `UNGROUP_ELEMENTS` removes one group id from every
  path (peels exactly one level); `DUPLICATE_ELEMENTS` clones a whole
  selection in ONE patch with group ids remapped, so duplicating a group
  yields a NEW group instead of clones silently joining the original.
- **`normalizeGroups` sweep**: after delete / ungroup / duplicate / layout
  application, group ids left with <2 units are dissolved automatically —
  no orphan "groups of one" can survive any operation.
- **Shortcuts**: ⌘G groups the selection, ⇧⌘G ungroups; ⌘D now duplicates
  via the one-patch path (one undo, clones re-selected, group preserved).
- **Surfaces**: Arrange menu gains a Group/Ungroup section (and now opens
  for multi-selections); context menu gains Group/Ungroup items (disabled
  when not applicable); paste (⌘V) now also preserves group structure via
  remapped ids; lone `DUPLICATE_SLIDE_ELEMENT` strips group membership (a
  single duplicated member must not join the source group).
- **Mock AI**: "Group these elements" / "ungroup" now work on
  multi-selections; manifest `allowedActions` extended to match.
- **Verify**: insert 3 shapes → shift-click two → ⌘G → click one: both
  select as a unit. Shift-click the third → ⌘G again: nested group of 3.
  Double-click a member: enters the outer group (inner pair selected);
  Esc walks back up. ⇧⌘G peels only the outer level. ⌘D on the inner pair:
  clones appear offset +24/24, selected, and grouped together. Right-click
  → Ungroup dissolves it. Every operation is exactly one undo step.

## B4 — A3b: marquee, multi-select, multi-move (25/25 cumulative)

- **Marquee selection**: drag on empty canvas rubber-bands a selection
  (intersection semantics, like Google Slides; hidden/locked excluded; plain
  click still selects the slide). Marquee rect renders live.
- **Shift-click** toggles whole *units* (an element, or its entire group
  closure once groups exist) in/out of the selection.
- **Deferred collapse** (GS behavior): pointer-down on a selected member
  never breaks the selection — dragging moves ALL members (uniform delta,
  bounding-box clamped, bbox-snapped, locked members stay put, one undo);
  a plain *click* collapses to the clicked unit on pointer-UP.
- **Group navigation scaffolding**: double-click descends into a group
  (selection scope), Esc walks up the ladder (members → enclosing group →
  slide). Double-click still opens the text editor when the element is the
  sole selection (edit gate via `soleSelected`).
- **Multi keyboard**: arrows/Delete/⌘D/⌘C/⌘X/⌘V all operate on the whole
  selection as single undo steps.
- **DOM/AI**: selected elements now carry `data-ai-selected` — agents (and
  the test suite) can read selection state straight from the DOM.
- **Verify**: marquee over several elements → drag one member → all move,
  one undo restores all; shift-click to build a selection; click one member
  → collapses to it.

## B3 — A3a: snapping + guides, aspect-lock, element clipboard, context menu (19/19 cumulative)

- **Smart guides + snapping** (`lib/course/slide/snap.ts`): dragging snaps
  edges/centers to slide edges/center and to every other visible element's
  edges/centers; rose guide lines (1 screen px) render during the gesture.
  Threshold ≈ 6 *screen* px converted through the stage scale, so snapping
  feels identical at any zoom. **Cmd/Ctrl or Alt bypasses snapping.**
  Keyboard nudges never snap. Resize snaps only the dragged edge(s).
- **Shift = aspect-lock** on corner resize handles (anchored at the opposite
  corner; with snapping the dominant axis snaps, the other re-derives).
- **Element clipboard**: ⌘C/⌘X/⌘V on selected element(s) — paste re-ids,
  offsets +24/24, and selects what was pasted. Stored in-memory (uiStore,
  not persisted, separate from the slide clipboard).
- **Right-click context menu** on canvas elements (Cut/Copy/Paste/Duplicate/
  Delete + z-order; multi-aware: acting on one member of a selection acts on
  all) and on empty stage (Paste). Esc/backdrop closes. Right-click selects
  the element under the cursor unless already selected (Google Slides
  semantics).
- **BUG FOUND & FIXED (real UX bug surfaced by verification): selection used
  to change the toolbar's height** — contextual buttons appeared, the
  toolbar wrapped to a second row, and the entire canvas jumped ~16px mid-
  interaction. Element actions now render permanently and disable without a
  selection (constant toolbar height, like Google Slides). Regression-checked
  (`dy=0.0`).
- **Verify**: drag a shape near the slide center → rose guide appears and it
  clicks into place; hold ⌘ to place it 4px off an edge freely; Shift-drag a
  corner handle → ratio locked; ⌘C/⌘V → offset copy; right-click → menu.

## B2 — A2: shapes as first-class objects (8/8 cumulative checks)

- **Shape picker** in the toolbar Insert group (replaces the lone
  rectangle-only button): rectangle, rounded rectangle, ellipse, triangle
  (new `ShapeKind` + SVG polygon renderer), line, arrow — each with
  kind-appropriate default frames (`addShapePatch` in commands.ts). Rounded
  rectangle = rectangle + 24px corner radius preset (not a separate kind;
  radius stays editable).
- **Stroke style**: `borderStyle: solid | dashed | dotted` added to the
  element style model/schema; renders via CSS border for boxes and
  `stroke-dasharray` for triangle/line/arrow.
- **Inspector Design tab — Stroke section** (all element types): stroke
  color swatches, width, style pills. Fill/radius/opacity were already
  present; shadow lands in B7.
- Shapes already shared select/move/resize via the element pipeline; they
  now also participate in everything later batches add (snap, multi-select,
  group) for free.
- **Verify**: toolbar ⬡ Shapes → insert each kind; select the triangle →
  Design tab → Stroke width 4 + "dashed" → dashed outline; every insert and
  style change is one undo step.

## B1 — A1: text alignment fixed; object alignment moved to Arrange (11/11 checks)

- **BUG FIX (P0)**: the toolbar's align buttons previously MOVED the text box
  (`moveElementPatch`); they were removed from the element group. Text
  alignment is now a proper text control.
- **Text toolbar** gains two popovers (enabled for text/heading/callout/
  bullet list): *Text alignment* — left / center / right / **justify**
  (new option in the model + schema) — and *Vertical alignment* — top /
  middle / bottom. Both write `style.textAlign` / `style.verticalAlign` via
  `UPDATE_SLIDE_ELEMENT`; the box frame is untouched (verified byte-identical
  left/top/width).
- **Arrange menu** (new toolbar dropdown, Google-Slides "Arrange > Align"):
  *Position on slide* — Left/Center/Right/Top/Middle/Bottom — moves the BOX
  via `MOVE_SLIDE_ELEMENT` (new `alignedY` helper in geometry.ts). Menu
  closes on action, like Slides. Align-to-selection + distribute land in B7.
- Inspector Design tab: justify option + vertical-alignment pills added for
  parity.
- **Verify (click-path)**: select the "Two Pointers" heading on slide 1 →
  toolbar ¶-align button → Center: the text re-centers inside its box while
  the box stays put (watch x/y/w/h in Design tab). Toolbar ↕ button → Middle:
  text drops to the box's vertical center. Toolbar "Arrange" → Left: now the
  BOX moves to the slide's left margin. One undo per action.

## B0 — Selection groundwork (foundation, no visible behavior change)

- **Selection model**: added multi-select kind
  `{kind:"elements", ids, slideId, blockId, lessonId, scope?}` and an optional
  `scope` (entered-group path) to single-element selections
  (`lib/course/types.ts`).
- **Group encoding**: `groupPath?: string[]` on every slide element (nested,
  Google-Slides-style; outermost group first) + pure navigation helpers in
  `lib/course/slide/groups.ts` (unit closures, scope checks, degenerate-group
  detection). No UI yet — lands in B4/B5.
- **Selection repair fixes** (`lib/course/store.ts`, `lib/course/queries.ts`):
  multi-selections shed deleted ids instead of being destroyed by the
  after-commit repair; FIXED pre-existing bug where deleting a selected
  element collapsed selection to *course* instead of its lesson.
- **Transient gesture store** `lib/editor/dragStore.ts` (deliberately separate
  from the persisted uiStore — pointermove-frequency writes must not hit
  localStorage). `useElementDrag` now writes per-participant frames there;
  dragging an element of a future multi-selection moves the whole selection,
  clamped by the selection bounding box (not per-element, which would shear
  arrangements). One `applyMany` per gesture = one undo step, as before.
- Mock AI: minimal handling for multi-selections (batch delete; group/align
  verbs arrive with the Arrange feature).

**Verify**: existing flows unchanged — drag/resize a single element, undo once
restores it; selection ring/handles as before. (Covered by the B1 Playwright
run.)
