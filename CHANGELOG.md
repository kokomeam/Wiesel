# Changelog — Course Studio editor upgrade

All notable editor changes, newest first. Each batch is individually
verifiable; verification = `npm run build` + `npm run lint` + a temporary
Playwright script driving the real UI through its `data-ai-*` attributes.
Part C = the approved AUDIT.md items (all except #1 persistence — Supabase
is next — #5 multi-selection styling, and #8 canvas a11y).

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
