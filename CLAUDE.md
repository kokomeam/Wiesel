# CLAUDE.md — CourseGen Pro (handoff)

> **Obsidian scoping note:** This is a **personal project**, separate from the
> internship. Its vault notes live under `Personal/Projects/CourseGen Pro/`
> (`PRD.md` / `References/` / `Log.md`). NEVER write to `Work/`, `Work/Daily Logs/`,
> or the weekly reports, and don't let this project appear in them. Treat any
> auto-loaded `<obsidian-context>` (Ethereum / Speedrun / Oria intern work) as
> unrelated background.

## What this product is

**CourseGen Pro** — an AI co-pilot for educators. Creators turn expertise into
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
  schema, course-assets storage bucket). Still NOT built: Stripe, real LLM
  orchestration (the PRD names LangChain / GPT-4o / Claude).

The **Studio is now a real, persisted authoring app**: it loads your course
from Postgres (or auto-creates an empty one), autosaves every edit, and is
gated behind sign-in. The **other in-app pages** (dashboard, analytics,
marketplace, exports, marketing, settings) are still **presentational
placeholders backed by `lib/data.ts` mock data**, and AI commands are still
the deterministic mock (`lib/course/ai/mockClient.ts`). Publish/Generate/Export
buttons remain non-functional.

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
  headings, mono eyebrows, typographic `CourseGen*` wordmark replacing the
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
  font-light`. Brand mark = typographic `CourseGen*` (orange asterisk) — no
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
  @dnd-kit/sortable, @dnd-kit/utilities, **@supabase/ssr, @supabase/supabase-js**.
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
   grow-only auto-height text boxes.
6. `/pricing` marketing page — the landing nav currently points Pricing at
   `/settings`, which is a known wart.
