# CLAUDE.md — WiseSel (handoff)

> **Obsidian scoping note:** This is a **personal project**, separate from the
> internship. Its vault notes live under `Personal/Projects/WiseSel/`
> (`PRD.md` / `References/` / `Log.md`). NEVER write to `Work/`, `Work/Daily Logs/`,
> or the weekly reports, and don't let this project appear in them. Treat any
> auto-loaded `<obsidian-context>` (Ethereum / Speedrun / Oria intern work) as
> unrelated background.

## What this product is

**WiseSel** — an AI co-pilot for educators. Creators turn expertise into
engaging, monetizable courses (multi-agent studio: Curriculum Architect →
Content Producer → "Magic Wand" iterative editor), then market them (AI landing
pages / emails / social kits), analyze them (drop-off insights, feedback
summaries), export them (PPTX / PDF / SCORM), and sell them on a marketplace.
Learners buy and study those courses. Full PRD lives in the first user message
of the original session; key points:

- **Audiences:** creators (educators, competition coaches — USACO/FBLA, SMEs,
  trainers) and learners.
- **Pricing tiers:** Hobbyist (free) / Pro ($29, current user's tier) /
  Expert ($79); marketplace takes 15–25% commission.
- **Roadmap phases:** 1 Core Studio → 2 Marketplace+Stripe → 3 Marketing suite
  → 4 Analytics engine → 5 Multi-modal (video/avatars).
- **Backend status (2026-06-15):** Supabase **auth + persistence are LIVE**
  (email/password login, RLS-secured `courses → modules → lessons → blocks`
  schema, course-assets storage bucket). The **first real AI is LIVE** too: a
  Cursor-style **Content Agent** docked beside the lesson editor, backed by the
  **OpenAI Responses API server-side** (`lib/ai/*`). Still NOT built: Stripe;
  the marketing/analytics/marketplace suites; multi-agent orchestration.

The **Studio is now a real, persisted authoring app**: it loads your course
from Postgres (or auto-creates an empty one), autosaves every edit, and is
gated behind sign-in. The **docked AI agent** authors slide decks, knowledge
checks, homework, and lecture text by calling tools that mutate the course
through the SAME validated CoursePatch pipeline the UI uses, streams its work,
and stages every change for review (highlight → Accept/Reject). The **other
in-app pages** (dashboard, analytics, marketplace, exports, marketing,
settings) are still **presentational placeholders backed by `lib/data.ts` mock
data**. The legacy inline command bar (`AICommandBar` → `requestAIPatches` in
`lib/course/ai/mockClient.ts`) remains a deterministic mock and is secondary to
the real agent panel; Publish/Export buttons remain non-functional.

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · **Tailwind CSS v4**
(CSS-first config via `@theme` in `app/globals.css` — there is no
`tailwind.config.*`) · `framer-motion` · `lucide-react` · **`@supabase/ssr` +
`@supabase/supabase-js`** (auth + Postgres). npm. **Git repo on GitHub
(private, `kokomeam/coursegen-pro`, default branch `main`).** Dev:
`npm run dev` (localhost:3000) · `npm run build` · `npm run lint` (all
currently green/clean). Supabase creds live in `.env.local`
(`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`).

**This is NOT a shadcn project.** No `components.json`, no `@/lib/utils`, no
cva/radix Button. When asked to "integrate a shadcn component," adapt the
technique to the existing primitives instead of copy-pasting its scaffolding:
use `cn` from `@/lib/cn`, the existing `Button` in `components/ui/Button.tsx`,
and put reusable primitives in `components/ui/`.

## Route map

- `/` — **dual-audience product introduction** (2026-06-12, route group
  `app/(marketing)/`, components in `components/intro/`). Its OWN visual
  identity per user request (iterated twice): **warm paper `#FAF7F1` + stone
  ink + amber→orange gradient accent** — light-first (user rejected the
  earlier dark/"too technical" hero AND the original purple), **no sparkle-AI
  imagery**; Fraunces serif display (`components/intro/fonts.ts`,
  `--font-display`) + Geist Mono eyebrows; hand-drawn SVG annotation strokes
  (`Annotate.tsx`) as the brand motif; emerald only for success semantics.
  `WarmBackdrop.tsx` = the atmosphere: HalftoneDrift + SunriseGlow +
  DoodleField (`backgrounds.tsx`) + a **cursor-following warm glow**
  (fine-pointer + reduced-motion gated) + grain — NO BackgroundPaths here. Hero has a learn/teach toggle driving two
  looping primitive-built demos (`HeroDemo.tsx`, deterministic step timelines,
  inView + reduced-motion gated). "For educators" card/links route to
  `/educators`. Final CTA = big orange-gradient panel with RippleArcs.
- `/educators` — the original educator landing's **structure and elements
  preserved** (RotatingText word-swap hero, BackgroundPaths lines, HeroPreview
  self-assembling demo, full section lineup) but **re-skinned to the warm
  orange identity** (components/marketing/* recolored violet→orange, serif
  headings, mono eyebrows, typographic `WiseSel*` wordmark replacing the
  Sparkles tile, pill buttons; student-path accents sky→teal). Its nav links
  collapse to the hamburger below `lg` (the mono links don't fit at md).
  `components/ui/background-paths.tsx` default tint is now `text-orange-400`.
- `/dashboard` — creator dashboard (moved here from `/` when the landing took root)
- `/studio` — Creator Studio, the core. Rebuilt (June 2026) as a **fully
  functional AI-native course editor**, then upgraded (V2, 2026-06-12) into a
  **Google-Slides-like authoring surface**: slides are a 1280×720 logical
  canvas of absolutely positioned elements (9 types incl. image/shape/callout/
  divider/table) with drag/resize/keyboard interactions, a grouped slide
  toolbar (Insert · Text · Layout/Background/Theme · Arrange · AI), 14
  placeholder-based layouts + user-saved custom layouts, 5 themes (defaults
  that never clobber explicit styles), solid/gradient/image backgrounds,
  required-alt image upload (object URLs; Supabase swap point marked), a
  10-check quality linter with one-click fixes, collapsible panels everywhere
  (app sidebar → icon rail, outline/inspector → labeled rails, AI bar →
  sparkle FAB, filmstrip → pill; localStorage via `lib/editor/uiStore.ts`),
  focus mode, and shortcuts (⌘\\ panels, ⌘. inspector, ⌘K AI bar, ⌘Z/⇧⌘Z
  undo/redo, ⌘C/V slide copy-paste, arrows/Delete/⌘D on elements). Every
  change — human or AI — still flows through one Zod-validated patch pipeline.
  The mock LLM lives behind a single seam: `lib/course/ai/mockClient.ts`.
  **V3 "professional editor" upgrade (2026-06-12, Part A — see CHANGELOG.md,
  46-check browser suite):** text alignment fixed (toolbar sets
  `style.textAlign`/`verticalAlign` incl. justify; the BOX moves only via the
  Arrange menu); shape picker (rect/rounded/ellipse/triangle/line/arrow +
  stroke color/width/style); smart guides + snapping (6 *screen*-px threshold
  through the stage scale, ⌘/Alt bypass); Shift aspect-lock; element
  clipboard (⌘C/X/V, re-id + remap group ids); right-click context menu;
  marquee + shift-click multi-select with Google-Slides deferred collapse;
  **nested groups** (`groupPath: string[]` on elements, ⌘G/⇧⌘G,
  dblclick-descend / Esc-ascend scope ladder, `lib/course/slide/groups.ts`);
  multi-selection bbox transform (proportional member scaling, min floors);
  align-to-selection + distribute H/V on whole UNITS (`slide/arrange.ts`);
  drop-shadow presets over an expressive `style.shadow` model; text boxes
  **auto-grow on commit** (hidden-twin measurement, grow-only, one undo for
  text+height via `commitElementTextPatches`).
  **Part C (approved AUDIT.md items, 34-check suite — skipped: #1
  persistence [Supabase next], #5 multi-select styling, #8 canvas a11y):**
  right-click no longer collapses multi-selections (gesture starts gated to
  the primary button); multi z-order keeps internal stacking; marquee/⌘A
  respect the entered-group scope; GS paste placement (cross-slide in
  place, same-slide +24, context-menu paste at cursor via `canvasPoint`);
  rotation stripped from the element SCHEMA (axis-aligned chrome can't lie;
  TS field + render kept for legacy); thumbnails memoized via WeakMap-cached
  JSON (reducer deep-clones, identity memo can't work); undo cap 100
  (measured: seed 24 KB; inverse patches post-Supabase);
  **text reflow everywhere** — style/resize commits grow text boxes
  (grow-only, user policy: never shrink text) + `TEXT_CLIPPED` lint with
  grow fix (measurer = `renderToStaticMarkup` — flushSync is illegal during
  render — registered into lint by the shell; seed slide 3 trips 6 checks
  now); **zoom 50–300%** (⌘+/⌘−/⌘0, scroll-pan, center-stable; pointer math
  reads the scaled stage's own rect); **OS clipboard** (`lib/editor/
  clipboard.ts`: markered JSON mirror, paste survives reload/tabs, plain
  text pastes as a text element, ONE-thing clipboard exclusivity);
  **equal-gap snapping + px chips** (`snap.ts` lane detection,
  `GuideLine.label`); **2-point lines** (`points` frame-fractions +
  `SET_LINE_ENDPOINTS` padded-AABB reducer, endpoint handles, Shift=45°,
  marker arrowheads; AABB hit-test + connectors deferred); **rich text
  runs** (`runs: TextRun[]` with tri-state marks, invariant concat(runs)===
  text so lint/AI read plain text unchanged; contenteditable overlay +
  execCommand isolated in `elements/richText.ts`; toolbar/swatches
  preventDefault-on-pointerdown to preserve the live selection; bullets/
  links/selection-aware button states = known cuts).
  **DB persistence + authoring UX (2026-06-15, see CHANGELOG.md):** the
  studio is now a **server component** (`app/(app)/studio/page.tsx`) that
  loads the signed-in author's most-recent course from Postgres (or
  auto-creates an empty one), reconstructs the `CourseDocument`, and hands
  it to `StudioLoader` which hydrates the store (effect-gated skeleton →
  no SSR mismatch). **Autosave** (`lib/editor/coursePersistence.ts`) debounce-
  reconciles the whole doc to the DB on every edit (header shows live
  Saving/Saved). **No more seed** — a brand-new course is genuinely empty.
  **Module page** (`ModulePage.tsx`): clicking a module in the outline opens
  a clean overview — editable name, description, lesson list, prominent
  "Add lesson" (creates + opens the lesson). **"Module N:" convention**
  (`lib/course/moduleLabel.ts`): modules always display as `Module {n}:
  {name}` (n = 1-based position, auto-renumbers on reorder; only the name is
  stored/edited). **Pencil edit-affordance** (`EditableName.tsx`): a faint
  pencil sits next to editable names (course/lesson/module titles) on hover
  and hides while editing; the input auto-sizes to content so the pencil
  hugs the text. Module/lesson/block ids are now **real UUIDs** (= the DB
  primary keys); the AI-Credits widget and `currentUser.credits` mock were
  removed. **15-check browser suite** drove the whole flow against live
  Supabase (sign in → empty course → module page → add lesson → rename →
  persist across reload).
- `/api/ai/component-manifest` — JSON manifest of component types + allowed
  patch actions for AI agents.
- `/marketing`, `/analytics`, `/exports`, `/marketplace`, `/settings` — in-app
  pages under `app/(app)/` sharing the Sidebar+Topbar shell in `app/(app)/layout.tsx`.
- `/login` — email/password auth (Supabase). `app/(app)/layout.tsx` +
  `lib/supabase/middleware.ts` redirect signed-out visitors here.

## Supabase (auth + persistence)

- **Schema:** `supabase/migrations/*` — `profiles` (auto-created on signup) +
  `courses → modules → lessons → blocks`, RLS-on everywhere (author full CRUD;
  public read only when published+public), `course-assets` storage bucket.
  Block payloads (slides[], questions[], …) live in `blocks.content` jsonb;
  course `plan`/`theme` are jsonb columns. Applied to the live project; regen
  types into `lib/database.types.ts` after any migration.
- **Clients:** `lib/supabase/{client,server,middleware}.ts` (browser /
  server-component / middleware, `@supabase/ssr`, cookie-shared sessions).
- **Doc ↔ rows:** `lib/course/persistence.ts` (PURE `courseDocFromRows` /
  `courseDocToRows`; module/lesson/block ids ARE the row primary keys, so the
  map is 1:1, lossless — verified by an 11-check round-trip). Studio load is
  server-side; autosave (`lib/editor/coursePersistence.ts`) is a debounced
  full-snapshot reconcile via the browser client (upsert parents→children,
  delete orphans children→parents), surfaced through the store's `saveStatus`.
  Store init = `PLACEHOLDER_COURSE` (deterministic, hydration-safe) until
  `store.hydrate(doc, courseId)` installs the loaded course.
  **Reject-aware autosave (2026-06-17):** the flush carries an `AbortController`
  (`reconcileCourseDoc(…, signal)`); Reject calls `suspendAutosaveForReject()` to
  pause + abort the in-flight flush BEFORE its revert, and `hydrate` resumes +
  skips re-saving the reverted doc (so a stale flush can't clobber the revert /
  trip "Failed to fetch"). Autosave failures auto-retry (2× backoff) before
  `saveStatus("error")`.

## AI Content Agent (OpenAI) — `lib/ai/*` (2026-06-15)

> **Prompt single-source-of-truth (2026-06-25):** diagram-vs-image routing is stated
> ONCE — `VISUAL_ROUTING_RULE` (`context.ts`, referenced by `ROLE_AND_RULES` +
> `GENERATE_TEACHING_BAR`) for the prose, and `renderVisualDirective(slide)`
> (`outline.ts`, exported) for the per-slide directive (used by BOTH
> `outlinePromptFragment` AND `phases.ts:renderSpecBrief`). This killed the stale
> 7-cut-kind `add_diagram` lists + the "no AI-generated images" contradiction that
> a prior visual change had left in the GENERATE/edit/repair prompts. Also: the
> GENERATE one-batch instruction now agrees across `GENERATE_TEACHING_BAR` +
> `outlinePromptFragment` (was "one segment per turn" vs "one batch" — a speed
> contradiction); and `SlideSpecSchema.notes` is nullable (coerce `null→""`).
> When changing visual routing, edit those TWO symbols — nothing else re-proses it.
>
> **Perf + correctness pass (2026-06-25):** (0) image model pinned to the dated
> snapshot `gpt-image-2-2026-04-21` (`DEFAULT_IMAGE_MODEL` + `.env.local`). (1)
> Lesson-plan cost cut: `LessonOutlineSchema` descriptions trimmed (global
> principles live once in `PLAN_SYSTEM_PROMPT`, not per field) — strict-JSON schema
> **9514→7430 chars**; per-slide `speakerNotesGoal` moved to a single **lesson-level**
> field (GENERATE derives per-slide notes); the **module-path** per-lesson plan
> (`runRichLessonPlan`) now runs **LOW** effort via `AI_PHASE_MODELS.moduleLessonPlan`
> (it doesn't re-ask on thin, so the medium guard is unneeded there) while the
> standalone single-lesson plan stays MEDIUM. (2) Plan calls log `agent_plan_usage`
> with `cachedTokens`; the plan request was confirmed already correctly ordered
> (static system prefix → course-then-lesson context) — `cachedTokens:0` is TTL
> eviction across the slow pipeline, mitigated by these speedups, NOT an ordering bug.
> (3) **Images off the critical path:** `add_image` is now **ENQUEUE-only** — it stages
> a PENDING image slide (`imageUrl:""` + a `pendingGen` spec on the content) and
> returns immediately; a new Node endpoint **`app/api/ai/visual/generate/route.ts`**
> (reusing `lib/ai/visuals/generateAndStore.ts` = the shared gen→verify→regen→store
> flow) produces the bytes on demand, driven by the client hook
> **`lib/editor/useVisualJobs.ts`** (idle-only, sequential, re-syncs via `liveSync`).
> `VISUAL_WEIGHT` now also pins `quality` (supporting `low` / reference `high`) +
> `thinking` (reference only; the gpt-image-2 `thinking` param is gated behind
> `AI_IMAGE_THINKING_ENABLED` pending field confirmation); `openai_image`/`_inspect`
> log `latencyMs`. (4) **Quiz/homework off the per-lesson hot path:** authored by a
> single CONCURRENT structured call (`authorAuxBlocks` + `lib/ai/auxContent.ts`,
> routed in the mock by `responseFormat` name so the deterministic test stays
> stable), merged before the one reconcile/stage; the slide loop drives
> **`coverageSlidesOnly`**. Verify: `verify:ai`/`verify:visuals`/`verify:slides`/
> `verify:ai:int` all green.

The first real AI: a Cursor-style chat docked beside the lesson editor. Built
**provider-agnostic** — the agent loop, tools, streaming, and change-tracking
never import a provider SDK.

- **Model seam:** `lib/ai/modelClient.ts` (the `ModelClient` interface +
  normalized event/tool types). The OpenAI SDK is imported in **exactly one
  file**, `lib/ai/providers/openai.ts` (Responses API via `client.responses.stream`;
  default model = `OPENAI_MODEL ?? "gpt-5.5"` (edit/fallback; phases override per-call — see below), `OPENAI_REASONING_EFFORT`,
  `OPENAI_MAX_OUTPUT_TOKENS`). `providers/mock.ts` is a deterministic client for
  tests / the no-key path (records each call's params via `getCalls()`).
  **MODEL + `reasoning.effort` are PER CALL** (2026-06-17): `ModelTurnParams.model`
  + `.effort` override the env default. Central config = `lib/ai/modelConfig.ts`:
  every phase defaults to `gpt-5.4-mini` — PLAN high · **GENERATE medium**
  (2026-06-26 — was high; the plan is a binding contract so generation is a structured
  fill, not open-ended creativity; `AI_GENERATE_MAX_OUTPUT_TOKENS` 24k) · REPAIR medium ·
  EDIT medium · LIGHT REVIEW medium (off by default) · CRITIQUE off by default (legacy) ·
  classifier **low** (NOT `minimal` — gpt-5.4-mini rejects it: accepts
  none/low/medium/high/xhigh); each env-overridable (`AI_PLAN_MODEL`/`AI_PLAN_EFFORT`/
  …/`AI_CLASSIFIER_EFFORT`). The correctness gate is its own config block:
  `AI_VALIDATION` (`AI_VALIDATE_GENERATION`/`AI_REPAIR_HARD_FAILURES`/`AI_MAX_REPAIR_PASSES`,
  default ON), `AI_LESSON_FLOORS` (`AI_MIN_NORMAL_/TECHNICAL_LESSON_SLIDES`),
  `AI_LIGHT_REVIEW` (`AI_LIGHT_REVIEW_ENABLED`/`_ON_LINT_THRESHOLD`/`_LINT_THRESHOLD`/
  `_MODEL`/`_EFFORT`). No premium `gpt-5.5` by default anywhere.
  `agent_phase` logs the per-call `{model, effort}`. `ModelTurnParams.responseFormat`
  forces a strict json_schema turn; `usage.{reasoningTokens,cachedTokens}` surfaced.
  **Prompt caching (2026-06-17):** the STABLE prefix must be byte-identical + FIRST.
  `buildSystemPrompt()` is STATIC only (role + catalogs + teaching bar); the
  variable course/lesson/outline rides in a leading `developer` `input` message
  (`buildContextMessage`) so the static system + tool schemas cache as one prefix
  (measured ~98% input cached on repeats). NEVER put course/lesson/outline back
  into the system string.
  **Structured-output gotchas (2026-06-17):** for a reasoning + json_schema
  response `final.output_text` is EMPTY though the JSON exists — read the
  `message` items' `output_text` parts (`messageTextFromOutput`); give the call a
  generous `maxOutputTokens` (PLAN uses 32000) so reasoning tokens don't starve
  it. Strict mode STRIPS `min/max/minItems/maxItems` (`schema.ts`), so never
  hard-reject the parse on them — `coerceOutline`/`coerceModuleSkeleton` clamp
  counts, limits stay as `.describe()`/prompt guidance.
  **Plan calls are NON-STREAMING (2026-06-19):** a plan needs reliability, not
  token streaming — `ModelTurnParams.stream:false` uses `responses.create`. Optional
  `background:true` (CREATE + POLL, no long-held idle connection) gated by
  `AI_USE_BACKGROUND_FOR_PLANS` / used automatically by the module fallback. Errors
  are CATEGORIZED (`ModelErrorKind` + `classifyError`): a transport **timeout** is
  NEVER parsed as "invalid JSON". Every plan call logs `agent_plan_request`
  (planType/model/effort/timeoutMs/input+schema chars/maxTokens/background); a
  failure logs `agent_plan_fail` with `errorType` = `transport_timeout` |
  `model_error` | `transport` | `schema_error`.
- **Phased content pipeline (2026-06-16; VALIDATE/REPAIR added 2026-06-18):**
  content generation runs ONE agent through **PLAN → GENERATE → VALIDATE/REPAIR →
  (optional LIGHT REVIEW) → STAGE** with **per-call effort**; small edits keep the
  single-turn loop. The plan is a **contract**; correctness is enforced by code,
  not a model critique (the heavy CRITIQUE pass is OFF by default — see below).
  **3-way auto-routing** (`lib/ai/intent.ts` `classifyIntent`: regex short-circuits
  + low-effort 3-mode classifier):
  - **`generate_module`** (REDESIGNED 2026-06-19 — the old whole-module plan timed
    out) → a COMPACT **module SKELETON** (`ModuleSkeletonSchema`: a lesson MAP —
    title/objective/rationale/skills/slide-range/blocks per lesson, **NO per-slide
    content**; low effort, ~2.8 KB schema → returns in seconds) → ONE approval card
    → create module + lessons → **for EACH lesson: a LAZY RICH lesson plan**
    (`runRichLessonPlan`, full `LessonOutlineSchema`, high effort, one small lesson)
    → GENERATE (medium) → **VALIDATE/REPAIR**. A lesson whose rich plan fails is
    SKIPPED + checkpointed (the rest still build). If the skeleton call
    transport-fails, an **ultra-lean FALLBACK** (`ModuleFallbackSchema`, background
    mode) retries once (`runModuleSkeletonPlan`). No light review (kept cheap; lint
    aggregated into one `quality_report`). Routing: a module build that NAMES its
    lessons routes here; only "add a lesson TO module X" (`LESSON_INTO_MODULE`)
    diverts to `generate_lesson`.
  - **`generate_lesson`** → lesson PLAN (`LessonOutlineSchema`) → approve → GENERATE
    (medium) → **VALIDATE/REPAIR** → optional **LIGHT REVIEW**.
  - **`edit`** → the single-turn loop, LAYERED (teaching bar + layout guide); no
    plan gate, no validate — stays fast. The delete-resume loop is layered too.
  **PLAN is the contract** (`lib/ai/outline.ts`): each slide spec carries a `role`
  (hook/worked_example/common_mistake/conceptual_check/…) + `kind` (core|enrichment);
  the lesson carries `microLesson`. **CONTENT-FIRST (Method 1, 2026-06-23):** the
  slide spec is ordered + prompted so the model FINALIZES the slide's `keyPoints` (its
  real content) BEFORE choosing the `layout` that fits them (and varies layout across
  the deck) — not layout-first. If a slide's points overflow one card it SPLITS at plan
  time (never truncates): a **continuation** (`continuationOf` links to the parent;
  `normalizeContinuations` stamps a " (cont.)" title + drops points repeated verbatim
  from the parent, preserving every unique point) or a **sub-topic split** (two distinct
  descriptive titles). A continuation is its own spec → counts toward coverage;
  `isContinuationSlide` + the "(cont.)" title are the cue. Slide-count guidance (micro 3–4 only on request ·
  normal 6–10 · technical 7–12 · complex 9–14) + a **depth floor**
  (`lessonDepthShortfall`, `AI_MIN_NORMAL_/TECHNICAL_LESSON_SLIDES`) that re-asks
  ONCE for a too-thin non-micro plan (via `runStructuredPlan`'s `postValidate` hook,
  reusing the single repair-call slot; a valid-but-thin plan is never lost). The
  outline is **transient** (round-trips client→server, never persisted). An
  **auto-approve** toggle (OFF by default) skips the pause.
  **GENERATE** runs the narrow **`generateTools`** (`GENERATE_TOOL_NAMES`: the slide-
  inspection reads + structured slide tools + create_block + write_quiz/homework/
  lecture — **no `write_slide_deck`/flat slide ops**, and as of 2026-06-22 **no
  `get_course_context`/`list_modules`/`list_lessons`/`get_lesson`** either: the
  course/lesson/plan/authored set already ride in the context + generation-state, so
  GENERATE/REPAIR can't burn turns re-reading them). It **pre-creates an EMPTY deck**
  and threads its `deckBlockId` into the context (`buildContextMessage`), so the model
  authors real slides into a known deck and **never seeds a placeholder**.
  `add_structured_slides_batch` takes a **nullable** `deckBlockId` resolving to the
  lesson's deck, and **CLAMPS-not-rejects** (2026-06-22): each slide's over-length
  slots are auto-shortened to their cap server-side (`clampStructuredTemplate`,
  schema-driven via Zod `too_big` issues) and the slide is SAVED with its specId — a
  formatting overflow never bounces back, so coverage closes; only a slide MISSING
  required content (unclampable) comes back. (The single-slide `add_structured_slide`/
  `set_structured_slide` tools stay strict.) The edit path runs `authoringOnly`
  (`AUTHORING_TOOL_NAMES`). The outline's per-slide `keyPoints` brief
  is expanded; the teaching bar frames the plan as a binding contract + bans skeletal
  slides (`agent_thin_slides` log).
  **VALIDATE/REPAIR** (`lib/ai/validation.ts` pure + `slideDiagnostics.ts` leaf):
  after GENERATE, check the doc vs the plan — every spec built, no placeholder/empty
  slide, no duplicate primary spec, required quiz/homework present, deck not short,
  budget not exhausted. Hard failures are repaired DETERMINISTICALLY first (strip
  placeholder/empty slides, drop junk/empty decks — no model) then a NARROW model
  pass handed ONLY the missing spec briefs + missing blocks (`buildRepairInstruction`,
  via `LoopOptions.extraInstruction`), re-validating up to `AI_MAX_REPAIR_PASSES`. If
  still unmet → **checkpoint** with exactly what remains (never staged as complete;
  `LoopResult.checkpointed` = budget vs done). `generationState` now also tracks
  remaining/duplicate/placeholder/no-spec/incomplete-segment/missing-block so bounded
  history can't forget the contract.
  **LINT + LIGHT REVIEW** (`lib/ai/lintGeneration.ts` pure, `lib/ai/lightReview.ts`):
  after hard validation passes, a no-model linter emits SOFT warnings; an OPTIONAL
  **one-call** review (no tool loop, no regen, gpt-5.4-mini/medium, OFF by default,
  fires only when lint ≥ `AI_LIGHT_REVIEW_LINT_THRESHOLD`) adds ≤3 suggestions.
  Neither blocks staging. The whole run stages ONE change-set, but now via
  **flush-on-exit** (2026-06-22): the pipeline reconciles the doc to the DB
  INCREMENTALLY (the driven loop persists each authored batch the turn it lands;
  each lesson persists as it completes; a module's scaffold persists the instant it's
  planned) and stages the change-set in a guarded `finalize()` that runs on EVERY
  termination — completion, token cap, turn cap, no-progress guard, **user Stop
  (abort)**, or a thrown error — so partial work is NEVER discarded (the "module
  spun 10 min, persisted nothing" fix). `reconcileAndStage` is split into a
  repeatable `reconcileDoc` + a one-shot `stageChangeSet`.
  **Autosave coordination (the former hazard, now fixed):** the editor store's
  `agentRunActive` flag PAUSES the browser autosave for a run's duration (so the
  agent's server reconcile and a browser full-snapshot can't race + orphan rows),
  and a debounced `scheduleLiveSync` (`lib/editor/liveSync.ts`) re-loads the doc via
  `syncLiveDoc` (no full re-hydrate) so the deck renders LIVE as it's built; a
  Supabase Realtime sub on `change_set_items` (`useChangeSetRealtime`, migration
  `20260622010000`) drives the same re-sync (degrades gracefully if unpublished).
  Orchestration in `lib/ai/phases.ts`
  (`runContentAgentTurn`/`runGenerateLessonTurn`/`runGenerateModuleTurn`/
  `runModuleSkeletonPlan`/`runRichLessonPlan`/`runLessonPipeline`/`validateAndRepairLesson`/
  `runGenerateModule`/`resumeGeneratePlan`; legacy `runLegacyCritique` gated by
  `AI_CRITIQUE_ENABLED`, off); approval resolved
  by `app/api/ai/agent/plan/route.ts`. The review is a **prominent modal**
  (`components/editor/agent/AgentPlanHost.tsx`) + a sidebar phase badge + a calm
  `validation` line + a `quality_report` "Quality suggestions" card
  (`agentStore.phase`/`validation`/`qualityReport`/`pendingOutline`/`autoApprovePlan`).
  Per-phase `console.log({tag:"agent_phase", layered, effort, tokens, latencyMs,…})`;
  per-lesson `agent_plan_coverage`.
- **Loop:** `lib/ai/agentLoop.ts` — per turn: persist user msg → load doc +
  replayed history → stream a model turn → execute each tool call (validate args
  → apply CoursePatches to the in-memory doc → stream `tool_result`) → feed
  output back → repeat (cap `AGENT_MAX_TURNS`, with a `checkpoint`). Then
  reconcile the doc to the DB ONCE and stage the net block diff as one
  change-set.
  **Coverage driver (2026-06-22):** GENERATE/REPAIR pass `driveToCoverage` — the
  loop no longer stops the instant the model returns a no-tool-call turn; while
  plan specs remain it injects a concrete "STILL TO BUILD …" nudge
  (`buildContinuationNudge`) and keeps building (turns scaled to the plan via
  `coverageMaxTurns`/`repairMaxTurns`), with a no-progress guard
  (`AGENT_NO_PROGRESS_LIMIT`) stopping a stalled run. Driven loops DON'T emit
  their own checkpoint (`stopShort` only records it) — the validate/repair
  pipeline owns the ONE final checkpoint. This is the fix for the "3-of-10 deck".
- **Tools = the ops layer:** `lib/ai/tools/*`. Read (get_course_context /
  list_modules / list_lessons / get_lesson / get_block), structural
  (create_module/lesson/block, delete_block, reorder_blocks), and content
  writers (write_slide_deck / write_quiz / write_homework / write_lecture_text).
  writers, PLUS a granular **slide tool surface** (`lib/ai/tools/slides.ts`:
  get_deck / get_slide / add_slide / update_slide / set_slide_layout /
  reorder_slides / delete_slide) — id-addressed + non-destructive, bound to the
  studio's OWN `SLIDE_LAYOUTS` registry (a strict layout enum + catalog;
  `lib/ai/tools/slideContent.ts`). Emphasis is rich-text **runs**
  (`lib/ai/richText.ts`, structured + markdown→runs safety net — no `**` leak).
  Tools are PURE over `ctx.doc` → return CoursePatches + a summary; the loop
  owns apply/persist/stream. Writers build full blocks (blockBuilders.ts) and
  commit via **`SET_BLOCK_CONTENT`**; the slide tools use **`SET_SLIDE_CONTENT`**
  (switch one slide's layout + content in place) / `ADD_SLIDE` /
  `UPDATE_SLIDE_ELEMENT` / `APPLY_SLIDE_LAYOUT`. `write_slide_deck` is now
  per-slide layout + rich content, reserved for a FRESH deck. Tool param schemas
  are Zod (single source of truth) → strict JSON Schema via `lib/ai/schema.ts`
  (`z.toJSONSchema` + a strict post-process: all keys required, optionals→
  nullable, oneOf→anyOf, unsupported keywords stripped).
- **Change-set staging:** `lib/ai/changeSetDiff.ts` (pure block diff) +
  `lib/ai/changeSet.ts` (create/accept/reject; Reject replays the inverse
  through the patch pipeline). Mutations apply + persist, but blocks are flagged
  pending so the editor highlights them (amber ring + inline Accept/Reject in
  `BlockFrame`, panel review bar). DB is authoritative.
- **Conversations:** `lib/ai/conversations.ts` — threads + messages in Postgres;
  history is REPLAYED each turn (no provider-side state). Tables added by
  `supabase/migrations/20260615010000_ai_agent_conversations_changesets.sql`
  (conversations, messages, change_sets, change_set_items; all RLS author-only).
- **Persistence:** server reconcile is the SHARED `lib/course/persistenceSync.ts`
  (the browser autosave now wraps it too). `lib/ai/serverPersistence.ts` re-exports
  `loadCourseDoc` / `reconcileCourseDoc`.
- **Routes (Node runtime, SSE):** `app/api/ai/agent/route.ts` (POST → streams
  the `lib/ai/events.ts` protocol) and `app/api/ai/change-set/[id]/route.ts`
  (accept/reject). **The OpenAI key is server-only.**
- **UI:** `lib/editor/agentStore.ts` (transient streaming + pending-highlight
  state), `components/editor/agent/{AgentPanel,useAgentStream}.tsx`, docked in
  `CourseEditorShell` (collapsible `agentPanel` PanelKey), studio server-loads
  pending blocks → `StudioLoader` → `agentStore.hydratePending`.
- **Env:** set `OPENAI_API_KEY` (required) in `.env.local`; optional
  `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT` / `OPENAI_MAX_OUTPUT_TOKENS` /
  `OPENAI_TIMEOUT_MS` (client default 120s) / `OPENAI_MAX_RETRIES`.
- **Transport / proxy (2026-06-19):** the OpenAI SDK's bundled undici `fetch`
  **ignores `HTTPS_PROXY`**, so on a proxy-only machine (e.g. Clash `:7890`) it
  connects DIRECTLY, the socket never establishes, and it dies at the OS TCP-connect
  timeout (**~75s** on macOS = `net.inet.tcp.keepinit`) → a `transport_timeout` that
  was mis-blamed on "slow module planning". `createOpenAIModelClient` now reads
  `OPENAI_PROXY_URL` (else `HTTPS_PROXY`/`HTTP_PROXY`) and, when set, routes through a
  proxy **scoped to the OpenAI client** (`new OpenAI({ fetch, fetchOptions:{ dispatcher:
  new ProxyAgent(url) } })` — undici's fetch + dispatcher MUST be from the same undici;
  global dispatcher untouched so Supabase stays direct). **No proxy env ⇒ direct
  connection (production unchanged).** `undici` is a **devDependency** (runtime deps stay
  14), `require`d via a variable-specifier `createRequire` so the bundler never resolves
  it at build (prod never needs it). Logs `openai_client_config {proxy,transport,…}`.
  Diagnose with `npm run smoke:openai` (`scripts/smoke-openai.ts`): Phase A = no-proxy
  reproduction (~75s), Phase B/C = proxied success (1–3s, incl. structured + background);
  `SMOKE_SKIP_A=1` skips the slow part. Background mode (poll loop) is env-tunable via
  `AI_BACKGROUND_POLL_TIMEOUT_MS` / `AI_BACKGROUND_POLL_INTERVAL_MS`.
- **Tests:** `npm run verify:ai` (tools/schema/patch + the outline PLAN schema/parse/extraction guard `verify-outline.ts` + bounded-history `verify-bounded.ts` + the **VALIDATE/REPAIR/LINT** suite `verify-validation.ts` — placeholder detection, every hard-failure class, deterministic repair, the PLAN depth floor, lint + light-review trigger; all no-key) and
  `npm run verify:ai:int` (full loop vs live Supabase via the mock provider — **113**
  checks incl. the phased lesson pipeline, the **module SKELETON → approve →
  per-lesson rich-plan → generate → validate** flow, **skeleton-timeout →
  background fallback**, **both-timeout → clear-message** (not "invalid JSON"),
  per-call effort + layered system-prompt via the mock's `getCalls()`, the 3-way
  classifier routing, clean-validate · missing-spec repair · placeholder removal ·
  light-review-trigger paths, the **coverage driver** (a model that stops at
  1/3 is nudged to completion), the **no-progress guard** (one pipeline checkpoint),
  the **live AI-image path** (add_image → mock bytes → Supabase upload →
  `illustration` slide with a real public URL), **CLAMP-not-reject** (an over-length
  slot auto-shortens + saves → coverage closes, no repair), **flush-on-exit** (a
  stalled run AND a simulated user-Stop both STAGE + PERSIST their partial deck), and
  (the stretching/call-reduction pass) **diagram best-effort** (an off-slope
  add_diagram resolves in ONE shot — no error/retry — and renders a repaired valid
  diagram), **REPAIR at medium effort**, and the **course-level reads excluded** from
  GENERATE (loaded once, never re-fetched)). The mock can inject a transport error
  (`MockTurn.error`), a deterministic `generateImage`, and (via a thin runTurn wrapper)
  an abort mid-run.
  Slide-vocabulary suites (no key): `npm run verify:slides` (stickers + font
  tokens + all 8 structured layouts incl. near-max overflow + the structured
  agent tools) and `npm run verify:reject` (atomic byte-for-byte revert, incl. a
  structured slide). Renderer near-max overflow is checked with a temporary
  `/zz-layout-preview` + Playwright harness (build it, drive it through every
  variant + both decor levels, assert no frame overflow / container clipping,
  then delete it + `npm uninstall playwright`).
- **Slide vocabulary (2026-06-16):** **stickers** = a pure id-keyed registry
  (`lib/course/slide/stickers.ts`) + a `sticker` element (icons stay in the
  renderer, `StickerElement.tsx`/`StickerGlyph`). **Font tokens** =
  `ElementStyle.fontScale` (display/title/heading/body/caption) → per-theme
  `typeScale`, wins over legacy px (toolbar/Design tab are token dropdowns now);
  `display` family = Fraunces. **Structured layouts** = renderer-owned
  `slide.template` (`structuredLayouts.ts` registry with STRICT length-enforcing
  Zod schemas; `components/editor/slide/structured/*`; Shiki via `highlight.ts`)
  — `SlideStage` branches on `template`, the `LayoutPicker` "Structured" section
  + `StructuredContentEditor` edit them. AI tools: `add_structured_slide` /
  `set_structured_slide` / `set_text_style` / `add_sticker`
  (`lib/ai/tools/structuredSlides.ts`); the strict schema's `.max()` no longer
  REJECTS — it CLAMPS (auto-shortens + saves; `clampStructuredTemplate`), so no slide
  is ever bounced for fit. **Reject is atomic** (`revertChangeSet`).
  **STRETCHING (Gamma-style, within the fixed 16:9 frame, 2026-06-22):** the clip-prone
  renderers (`concept_example`, `comparison_columns`/`_matrix`, `outline_list`, `prose`,
  `code_walkthrough`) were rebuilt from absolute boxes with `overflow:hidden` into FLOW
  layouts — a flex column (header → growing body → footer); columns grow independently +
  stretch to the taller; the matrix grid uses `auto` rows; `outline_list` flows; code
  font scales to line count. No text container clips (only the horizontal break-word
  guard remains). `SlideStage` is still a fixed 1280×720 canvas, so concise/capped
  content fits the frame — the canvas itself was deliberately NOT made variable-height.
  Runnable guard: `scripts/verify-stretch.ts` (SSR-renders heavy content, asserts
  nothing is dropped + the layout flows); pixel-level no-overflow is the temporary
  `/zz-layout-preview` + Playwright visual pass.
  **8 structured layouts:** the original four (process_steps,
  key_concept, metrics_overview, code_walkthrough_steps) PLUS **section_break**
  (chapter divider; variants standard/hero_numeral × titleStyle serif/sans;
  renderer-owned two-tone title + corner arcs), **concept_example** (rule/def
  left + worked example right whose body is a `steps`|`paragraphs` discriminated
  union; "in practice" connector + footnote callout), and **outline_list**
  (titled nested list — objectives / TOC — 2–5 items × 0–2 sub-points), and
  **prose** (2026-06-17 — a deliberate plain teaching slide: title + a substantive
  rich body + optional points; a FIRST-CLASS plan choice rendered structured, NOT
  a flat fallback). Each is the SAME pattern (registry entry + strict schema +
  component + union variant + dispatch case), auto-exposed to the AI catalog +
  picker. Decoration is
  renderer-owned and dial-able via a `decor` (`full`|`minimal`) knob that lives
  in storage + the inspector but is **ABSENT from the strict AI schema** (the AI
  can never request/position flair). `ITEM_BOUNDS` is now `Partial` — the three
  bespoke layouts use their own inspector panels (dispatcher in
  `StructuredContentEditor`); the original four share the generic item editor.
- **Low-stakes assessments enforced structurally:** quiz/homework schemas no
  longer contain scores/passing/time/attempts/difficulty/points/due-dates (the
  fields, patches, and UI were removed 2026-06-15).

## Visual pipeline — image-first overhaul (2026-06-25)

> **Supersedes the diagram-centric notes below where they conflict.** Most visuals
> are now **GPT Image generated images** (default model **`gpt-image-2`**, the latest;
> `OPENAI_IMAGE_MODEL` overrides) rendered as clean academic **textbook
> figures**; only **`supply_demand` + `coordinate_plot`** stay programmatic (they
> need exact axis values). The other 7 diagram kinds (bar_chart, array_diagram,
> tree_diagram, graph_diagram, flowchart, number_line, venn) were **retired from the
> AI surface** (AI-surface-only — storage schema + renderers + validate/repair/
> geometry KEPT so any already-saved diagram still loads/renders/reverts; the model
> just can't author them). Enforced by: the strict `DiagramSpecInputSchema` union =
> 2 kinds; `catalog.ts` filtered by kind (`AUTHORABLE_DIAGRAM_KINDS` in `repair.ts`);
> `coerceDiagramBestEffort` returns null for a retired kind → prose/image degrade;
> `router.ts` `ROLE_TO_KIND` keeps only `coordinate_plot` roles (the rest route to
> images); `accuracyCriticalKind` = the 2 kinds.
>
> - **Two new image layouts** (mirror the `illustration` precedent — authored ONLY by
>   `add_image`, an `imageUrl` only the tool supplies, so NOT in
>   `StructuredTemplateInputSchema`): **`image_reference`** (hero; image IS the
>   subject — eyebrow+title, 0–4 annotations, 0–3 numbered concept cards; 3:2
>   1536×1024) and **`image_supporting`** (image aids the text — eyebrow+title+lead,
>   0–4 bullets, optional caption; 1:1 1024×1024). Both: fixed-AR box + `object-fit:
>   cover` so the image can't bleed. Renderers in `components/editor/slide/structured/
>   {ImageReferenceLayout,ImageSupportingLayout}.tsx`; registered in
>   `STRUCTURED_LAYOUTS` (+ new `capacity` metadata), storage `SlideTemplateSchema`,
>   the `SlideTemplate` union, and `StructuredSlide` dispatch.
> - **Legacy `illustration` retired from the AI side** (`PLANNABLE_LAYOUT_IDS` +
>   `structuredLayoutCatalog()` exclude it; `add_image` never emits it). Kept only for
>   back-compat rendering of existing slides.
> - **`visualWeight: 'reference' | 'supporting'`** on the plan's `visualIntent` (plus a
>   structured **`imageSpec`** {subject, requiredLabels, axes, annotations} for
>   reference). Pinned in ONE place — **`VISUAL_WEIGHT`** in `lib/ai/visuals/config.ts`
>   (→ layoutId + gen `size` + `background` opaque/transparent + `promptMode`).
>   `ImageGenParams` gained `size`/`background`; `openai.ts` passes them to the GPT Image model.
> - **Content-first split is capacity-aware:** `StructuredLayoutDef.capacity.maxPoints`
>   + `layoutPointCapacity()` drive `splitOverflowingSpecs` (image_reference 7,
>   image_supporting 4) — an over-full image slide spills to a `(cont.)` slide.
> - **Prompt builder** = `lib/ai/visuals/imageIntent.ts` (PURE): a shared TEXTBOOK
>   style preamble + per-`promptMode` spec (reference = quoted required labels/axes;
>   supporting = looser-but-academic). `buildImagePrompt` + `imageIntentHash`.
> - **Reference verification** (reference only, `AI_IMAGE_VERIFY_ENABLED` default on):
>   new `ModelClient.inspectImage` (vision; `AI_VISION_MODEL` ?? gpt-5.4-mini, mock has
>   a deterministic verdict) checks the required labels appear → regenerate ONCE →
>   else `add_image` **prose-degrades** (coverage holds, no loop). Lives in
>   `makeVisualGenContext` (`agentLoop.ts`).
> - **Freeze-on-accept:** the image content carries `intentHash`; `add_image` reuses
>   the stored asset when an existing slide for the spec has the same hash (no regen),
>   and **`set_image_text`** edits an image slide's text WITHOUT regenerating.
> - Tests: `npm run verify:visuals` (94) + the image path in `verify:ai:int` (122) +
>   `verify:slides`. **Remaining manual step (deferred):** the Playwright pixel-overflow
>   pass for the two new layouts (`/zz-layout-preview`) — not yet run.

## Visual pipeline — programmatic diagrams (2026-06-20, see CHANGELOG.md)

A teaching visual is a **teaching object, not decoration**. The LIVE path renders
**programmatic diagrams**: typed deterministic data drawn as crisp SVG, so a graph
is **accurate by construction** (a supply curve slopes up; a Dijkstra graph weights
every edge), editable, accessible, exportable, and persisted in `blocks.content`
with **no blob URLs**. A diagram is just an **11th structured layout** (`SlideTemplate`
`layoutId: "diagram"`), so it reuses the SAME patch pipeline, validate→repair,
change-set staging/reject, and picker — **no new patch actions, no new storage**.

- **Model** = `lib/course/diagram/*` (pure): `types.ts` (`DiagramSpec` union of 9
  kinds: supply_demand [+ price ceiling/floor], coordinate_plot, bar_chart,
  array_diagram, tree_diagram, graph_diagram, flowchart, number_line, venn; plus
  `VisualSpec` [purpose + alt text + reason] and `DiagramContent`) · `schemas.ts`
  (STRICT AI Zod with caps + a `.superRefine` running `validateDiagram`; permissive
  STORAGE schema; AI tree node is FIXED-DEPTH so it inlines to OpenAI-strict JSON
  with no recursive `$ref`) · `validate.ts` (deterministic correctness — the spec's
  named failure cases) · `catalog.ts` (19 correct named templates; whole-WORD topic
  matching) · `geometry.ts` (tree/graph/flow layout, scales, equilibrium).
- **Renderers** = `components/editor/slide/diagram/*` (PURE → SSR/thumbnail/export
  safe): `svg.tsx` toolkit + `DiagramView` (9 renderers) + `structured/DiagramLayout`
  (`role="img"` + alt text + the `data-ai-component="slide-visual"` envelope). The
  diagram is registered in `STRUCTURED_LAYOUTS` + `StructuredTemplateInputSchema` +
  storage `SlideTemplateSchema` + the `SlideTemplate` union; auto-exposed to picker,
  plan catalog, and AI tools.
- **Planning** = `lib/ai/outline.ts` `visualIntent` is now a STRUCTURED object
  (required/role/reason/expectedVisualType/placement/priority/mustBeAccurate; tolerant
  of a legacy string). **AI tools** = `add_diagram` / `set_diagram` (templateId
  seeds an accurate canonical diagram). **BEST-EFFORT + REAL-DATA-ONLY, never reshape-
  and-retry (2026-06-22):** the diagram tools are `lenientArgs` — a custom diagram is
  parsed permissively then `coerceDiagramBestEffort` (`lib/course/diagram/repair.ts`)
  REPAIRS the invariants on the model's OWN data (re-slope/re-sort/drop-dangling-edge/
  drop-the-weighted-claim) and renders it iff it validates, ELSE returns `null`. It
  **never fabricates or seeds placeholder/demo data** (the old minimal-seed / topic-
  template fallback was a regression — a generic A/B/C chart on an econ lesson); an
  unusable diagram **degrades to a real-text PROSE slide** built from the model's
  title/caption (so coverage still holds, no retry). A templateId is reserved for the
  canonical STRUCTURAL diagrams. (`bestEffortVisualTemplate` is the shared builder; a
  `diagram` entry inside `add_structured_slides_batch` routes through it too.)
  **Validation (2026-06-22):** `REQUIRED_VISUAL_MISSING` is now SOFT —
  reported, but it does NOT block `ok` or trigger repair (KEEP COVERAGE, DROP FIT:
  repair only fills a genuinely missing slide/block). **Inspector** = `DiagramEditor`.
- **Pipeline architecture** = `lib/ai/visuals/*` — `config.ts` flags (defaults
  2026-06-22: programmatic ON, **image-gen ON**, web OFF, validation ON;
  `AI_VISUAL_MAX_PER_LESSON` 5), full `VisualSpec`/`VisualAsset`, the source
  `router.ts` (programmatic → AI-generated → web → manual, by priority),
  `imagePrompt.ts`, the `generate.ts` seam, and `storeImage.ts`. **Web sourcing
  stays Phase 5 (OFF).**
- **AI IMAGE GENERATION — LIVE (2026-06-22).** For a concept no programmatic
  diagram fits (a historical scene, a biological structure, an analogy) the
  **`add_image`** tool generates an educational illustration via
  `ModelClient.generateImage` (gpt-image-2 default, `OPENAI_IMAGE_MODEL`, through the SAME
  proxied OpenAI client — base64 out), **stores the bytes to the Supabase
  `course-assets` bucket** under `{ownerId}/ai-visuals/{courseId}/…`
  (`storeImage.ts`; public URL on the slide, NEVER a blob/data URL), and lands it
  as a first-class **`illustration` structured layout** (registry + strict schema +
  `IllustrationLayout.tsx` + `SlideTemplate` union + `SlideStage` dispatch). It's
  the ONE impure tool path: a `VisualGenContext` capability injected into the tool
  ctx by `loopContext` (present only when image-gen is on AND the client can make
  images; absent ⇒ `add_image` ToolErrors → the model falls back to a diagram/
  prose). `illustration` is authored ONLY by `add_image` — it's intentionally NOT
  in the hand-authored `StructuredTemplateInputSchema`. Accuracy-critical figures
  still go programmatic; capped per lesson (`AI_VISUAL_MAX_PER_LESSON`). The mock
  provider has a deterministic `generateImage` so the whole generate→store→slide
  path is tested with no key. Tests: `npm run verify:visuals` (84 checks) + the
  live image path in `npm run verify:ai:int`.

## Marketing Assistant suite (`lib/marketing/*`) — 2026-06-19

The second half of the product: turn a finished course into a go-to-market
engine. Full engineering guide in `docs/marketing-suite.md`; PRD in
`docs/prd/Marketing-Assistant-Creator-Studio-Web.html`; per-phase detail in
CHANGELOG. Built on **three spines**: ONE typed tool layer
(`lib/marketing/tools/*`, `executeMarketingTool` behind the Generate-Kit button,
the hub cards, AND the agent), ONE event stream (`analytics_event`; subscriber
status is a pure reducer over it — `lib/marketing/stateMachine.ts`), ONE
**reversibility-graded governance gate** (`lib/marketing/gate.ts` +
`marketing_action` ledger: read executes; reversible auto-stages Reject-able with
a before-snapshot; irreversible records `pending` + waits for human approval).
Mock-first: `lib/marketing/services/*` (EmailProvider/Clock interfaces + mock +
env-gated factory; **Resend** swaps in via `RESEND_API_KEY`, zero contract
changes). The Marketing Agent (`lib/marketing/agent/*`) reuses the studio's
provider-agnostic `ModelClient`: observe (funnel injected as a developer msg) →
act (every tool call through the gate) → **pauses** at any irreversible action.

- **DB:** migration `20260618000000_marketing_assistant.sql` — 9 author-scoped
  tables (`marketing_campaign`, `landing_page` [public-read when published],
  `email_sequence`/`email_touch`, `subscriber`, `sequence_enrollment`,
  `scheduled_send` [idempotent outbox], `analytics_event`, `marketing_action`),
  RLS via `private.is_course_author(course_id)`. Public lead/analytics writes go
  through a **service-role** ingest route (`app/api/marketing/ingest`,
  `lib/supabase/admin.ts`), not anon RLS.
- **Routes:** public `/p/[slug]` (landing pages, `components/marketing-pages/*`);
  `app/api/marketing/{ingest,agent,scheduler/tick,unsubscribe}`. Creator UI:
  `app/(app)/marketing/{page,actions,MarketingHub,analytics,agent}` +
  `components/marketing/agent/AgentPanel`.
- **Env (new):** `SUPABASE_SERVICE_ROLE_KEY` (ingest + scheduler; server-only),
  `RESEND_API_KEY`/`RESEND_FROM` (real email), `CRON_SECRET`,
  `NEXT_PUBLIC_SITE_URL`. All optional — absent → the engine runs mock/author-
  scoped.
- **Verify:** `verify:marketing` (gate 37), `:flow` (Phase 1 e2e 13 — ingest
  needs the service key), `:analytics` (12), `:email` (31), `:agent` (18, mock
  model), `:swap` (7). All self-provision a throwaway live-Supabase user.
- **Status:** Phases 0/2/3/4/5 verified green. Phase 1's 6 anonymous-ingest
  checks pass once `SUPABASE_SERVICE_ROLE_KEY` is in `.env.local` (everything
  else stands without it).

## Where things live

- `lib/course/` — the Studio's **structured course document model** (UI-free):
  `types.ts` (CourseDocument → modules → lessons → 7 block types; V2 slides =
  positioned `SlideElement` union + `ElementStyle` + `SlideStyle`
  background/theme snapshot) · `schemas.ts` (Zod mirrors, pinned with
  `satisfies z.ZodType<X>`) · `patches.ts` (Zod discriminated-union
  CoursePatch, ~35 actions incl. 18 slide/element ops + pure
  `applyCoursePatch`; **the only way the doc changes**; ids ride in payloads,
  custom-layout placeholders travel inline so the reducer never reads browser
  state) · `slide/` (geometry 1280×720 + clamping, layouts ×14 +
  `applyLayoutToSlide` role-matching, themes ×5, styleResolver
  theme-defaults-under-overrides, contrast, simplify, placeholderImages,
  migrate for V1 flow slides) · `store.ts` (Zustand; `apply` validates →
  applies → logs → pushes undo; redoStack) · `commands.ts` (human patch
  creators) · `factories.ts` (crypto.randomUUID ids — event handlers only,
  never render) · `seed.ts` (deterministic; slide 3 deliberately trips 5 lint
  checks) · `manifest.ts` (+ slide_element/image_element/callout_element) +
  `aiAttributes.ts` (`aiAttrs()` for document nodes, `toolAttrs()` for
  toolbar/tab/panel controls) · `lint.ts` (10 checks, lazy one-click `fix`
  patches) · `ai/` (templates → rules → mockClient, the LLM seam).
- `lib/editor/uiStore.ts` — panel collapse/focus-mode/inspector-tab/custom
  layouts/slide clipboard/image-dialog state (+ non-persisted element
  clipboard & context-menu state). zustand persist with `skipHydration` +
  `UIHydrator` in the (app) layout = no hydration mismatch.
- `lib/editor/dragStore.ts` — **separate non-persisted store** for
  pointermove-frequency transient state (drag/resize frames, snap guides,
  marquee rect). Deliberately NOT uiStore: its persist middleware would hit
  localStorage every frame. One `applyMany` per gesture = one undo step.
- `components/editor/` — the Studio UI: CourseEditorShell (+ shortcuts, rails,
  focus mode), CourseOutlineSidebar (dnd-kit), LessonWorkspace + BlockFrame +
  AddBlockMenu, `slide/` (SlideStage scaled canvas + ElementView +
  useElementDrag one-patch-per-gesture, SlideToolbar, Layout/Theme/Background
  pickers, ColorSwatchPicker, GlobalImageDialog), blocks/* editors,
  InspectorPanel with Design/Content/AI/Metadata tabs (inspector/*),
  AICommandBar (minimizes to FAB) + useAICommand (the one AI pipeline),
  InlineText (commit-one-patch-on-blur), QualityHintBadge (+Fix buttons,
  exports `useEscapeToClose`).
- `lib/data.ts` — remaining in-app mock data + types (courses, analytics,
  marketplace listings, pricing tiers; `curriculum` feeds the landing
  HeroPreview). Swap for Supabase later.
- `lib/marketing.ts` — landing-page content (nav, dual-path copy, features,
  steps, stats, footer columns).
- `lib/cn.ts` — classnames joiner. `lib/ease.ts` — shared `EASE` cubic-bezier
  `[0.22, 1, 0.36, 1]` for all framer-motion transitions.
- `components/ui/` — Card, Badge (+`statusTone`), Button, Stat, PageHeader,
  **RotatingText** (cycling hero keyword), **background-paths** (animated SVG
  flow lines).
- `components/charts/` — dependency-free AreaChart (SVG Catmull-Rom) and BarChart.
- `components/shell/` — in-app Sidebar (active-state nav from `lib/nav.ts`) + Topbar.
- `components/marketing/` — the whole landing: MarketingNav, Hero, HeroPreview
  (self-assembling CSS product mock), Cta, motion.tsx (Reveal/Stagger/StaggerItem
  scroll primitives), CountUp, TrustStrip, DualPath, HowItWorks, Features,
  StatsBand, MarketplacePeek, FinalCTA, MarketingFooter.

## Design system (follow strictly — re-themed 2026-06-12, "warm editorial")

- **Brand = warm orange on paper.** Tokens `--color-brand-50..950` are the
  orange ramp (#fff7ed→#431407) + `.brand-gradient` (135deg #f59e0b→#ea580c)
  in `app/globals.css`. Canvas `#faf7f1` (warm paper), line `#ece7de`, warm
  selection/scrollbar. **Grays are stone-* everywhere, never neutral-*.**
- Typography: Geist Sans UI, Geist Mono eyebrows/labels (uppercase tracked),
  **Fraunces** (`--font-display`, loaded globally in app/layout.tsx) for page
  titles & marketing headlines via `[font-family:var(--font-display)]
  font-light`. Brand mark = typographic `WiseSel*` (orange asterisk) — no
  sparkle-icon logos.
- Buttons are **pills** (`rounded-full`; `components/ui/Button.tsx`: primary =
  brand-gradient). Cards: `rounded-2xl`, `border-stone-200/80`, warm whisper
  shadow `[0_1px_2px_rgba(68,48,28,0.05)]`. Emerald = success semantics only.
- **Gradient rationing:** the saturated gradient stays limited to CTAs/active/
  AI moments + one big FinalSeat panel. Ambient energy comes from warm light
  fields at ~10-20% opacity, never colored fills.
- **Background art is one-per-surface — do not reuse an animation on two
  surfaces** (user-requested): intro hero = HalftoneDrift + SunriseGlow +
  DoodleField + PointerGlow (`components/intro/backgrounds.tsx` +
  `WarmBackdrop.tsx`); FinalSeat = RippleArcs; /educators hero = the flowing
  `BackgroundPaths` (its only remaining home, default tint orange); marquee =
  its own scroll. Slide themes: "Editorial Warm" (default, id
  `editorial-warm`) — the violet theme was retired.
- Status dots: emerald=Published, amber=Draft, pulsing brand=Generating.
- Landing sections: `max-w-6xl px-6` column, `py-24` rhythm, mono eyebrow +
  serif h2 + muted paragraph, one shared reveal language via
  `components/marketing/motion.tsx`.

## Animation conventions (hard-won, keep them)

- **Reduced motion:** every entrance must collapse to final state (gate
  *opacity too*, not just y) and every loop must freeze. A global
  `prefers-reduced-motion` CSS guard in `globals.css` kills CSS
  animations/transitions; framer-motion is gated via `useReducedMotion()`.
- **Loops** (aurora breathe, etc.) are gated behind `useInView` so nothing
  animates off-screen.
- Animate only transform/opacity; progress bars animate `scaleX` (origin-left),
  never width.
- **No `Math.random()`/`Date.now()` in render** — causes Next.js hydration
  mismatches (the background-paths component had to be made deterministic).
- Above-the-fold entrances run on mount, not `useInView` (the hero cluster
  broke headless full-page screenshots until this was fixed).
- React 19 lint forbids setState-directly-in-effect: use
  `useSyncExternalStore` for matchMedia (see HeroPreview pointer check) or
  derived values (see CountUp reduced-motion path).
- CountUp exposes the final value in an `sr-only` span; the animating number is
  `aria-hidden`. The hero product mock is `role="img"` + decorative, with no
  focusable children.

## How this was built / verified (patterns to reuse)

- Sequence so far: scaffold skeleton → multi-agent design panel produced the
  landing brief ("Two Doors, One Living Studio") → implementation → 43-finding
  adversarial review → ~23 fixes applied (rest intentionally declined as
  conflicting with the brief).
- Verification loop: `npm run build` + `npm run lint`, then **temporarily**
  `npm i -D playwright` (chromium already cached at
  `~/Library/Caches/ms-playwright`), screenshot from a script in the project
  root (must scroll the page to trigger `whileInView` before full-page shots),
  assert no horizontal overflow at 320/390/768/1024/1440, then
  `npm uninstall playwright`. Keep runtime deps at exactly: framer-motion,
  lucide-react, next, react, react-dom, zustand, zod, @dnd-kit/core,
  @dnd-kit/sortable, @dnd-kit/utilities, **@supabase/ssr, @supabase/supabase-js**,
  **openai**, **shiki** (Shiki = code highlighting for the code-walkthrough
  structured layout; 14 runtime deps total).
- **Auth'd flows** (persistence, studio load) are browser-verified against
  live Supabase: email confirmation is OFF, so a test self-provisions a fresh
  throwaway user via `POST {URL}/auth/v1/signup` (anon key), signs in through
  the real `/login`, then drives the studio. Make the test create its OWN
  fresh user each run (idempotent) — reusing one leaves stale courses/modules
  that break "starts empty"-type assertions. These throwaway `*@example.com`
  users can't be deleted with the anon key; clean them in Supabase → Auth.
- The editor verification scripts drove the real UI through its own
  `data-ai-*`/`data-ai-tool` attributes (39-check V2 suite: toolbar inserts,
  mouse drag/resize, layout/theme/background application, alt-required image
  upload, lint one-click fixes, AI commands, all 5 panel collapses +
  persistence + focus mode + shortcuts; later 14-check bugfix suite for
  nested-button + layout semantics). Hard-won: dnd-kit needs
  `<DndContext id="...">` or hydration breaks; **BlockFrame's onClick selects
  the block, so interactive children must stopPropagation on click** (the
  slide stage and toolbar do); SE resize handles sit on the clipped canvas
  edge when an element touches it (tests grab SW); React 19 lint forbids ref
  writes in render (use the setState-during-render derived-reset pattern);
  stage scale comes from a ResizeObserver and the stage renders invisible
  until first measure; **element views must never render interactive elements
  when not editable** (thumbnails wrap SlideStage in a <button> — a nested
  <button> breaks HTML/hydration; ImageElementView's empty-src placeholder
  renders a div in preview); **applyLayoutToSlide preserve-mode REPLACES the
  arrangement** (best-match claims slots — exact type + authored-content
  scoring — unfilled slots seed, unmatched leftovers DROP; idempotent on
  re-apply, one undoable patch — earlier keep-leftovers behavior stacked
  duplicates when switching layouts).

## Sensible next steps (not started)

1. Real LLM behind `lib/course/ai/mockClient.ts` (file header documents the
   exact swap: POST /api/ai/command → validate with `z.array(CoursePatchSchema)`).
2. Course-creation wizard (topic/level/duration → generates syllabus draft).
3. ✅ Supabase auth + course persistence (DONE 2026-06-15 — see the Supabase
   section above). Remaining backend: a real **course list/picker** (dashboard
   still shows `lib/data.ts` mock courses, not the user's real ones; studio
   only loads "latest"), image upload → storage bucket (currently object
   URLs), profile/settings wired to real auth, then Stripe + marketplace.
   Persistence is whole-doc snapshot upsert — fine at current scale; revisit
   inverse-patch/partial sync if courses get huge (AUDIT.md #14).
4. Editor gaps deliberately deferred: cross-module lesson drag (patch supports
   it, UI doesn't), rubric/resource editing (read-only), quiz question delete,
   slide thumbnail drag-reorder; remaining cut list after the V3 Part-A
   upgrade (marquee/multi-select, snapping, aspect-lock, groups, shadows,
   distribute, auto-grow all landed — see CHANGELOG.md): table cell editing
   UI (render + patches only), image crop UI (model field exists), rotation
   UI (render-only; selection/snap math is AABB-approximated for rotated
   elements), nudge patch coalescing (each arrow press = one undo step),
   theme re-tint of explicitly styled elements.
5. Real client-side PPTX export (e.g. pptxgenjs) for the Exports page.
   **Export-fidelity ledger** (canvas features whose PPTX mappings are
   non-obvious — pay this list when export lands, and add a render-vs-export
   visual diff to the verification loop): `justify` text-align · drop-shadow
   (PPTX outer shadow ≠ CSS drop-shadow semantics) · dashed/dotted strokes ·
   triangle geometry · nested groups (`groupPath` → nested `<p:grpSp>`) ·
   grow-only auto-height text boxes · **sticker elements** (lucide glyph → an
   embedded image/path) · **renderer-owned structured layouts** (each
   `slide.template` component's arrangement must be re-derived as native PPTX
   shapes/text boxes — costs more than flat layouts) · **Shiki code** (token
   spans → run-level colored text) · **`diagram` slides** (`DiagramView` already
   emits pure deterministic SVG → the EASIEST export: embed the SVG, or rasterize
   to PNG; the alt text + caption carry over verbatim). The `metrics_overview`
   chart slot is deferred to the charts-as-data workstream — do NOT fake it in
   export.
6. `/pricing` marketing page — the landing nav currently points Pricing at
   `/settings`, which is a known wart.
