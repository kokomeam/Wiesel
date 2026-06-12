# Course Studio — Part B Audit

First-principles review of the slide editor against Google Slides /
PowerPoint / Canva, AFTER the Part A upgrade (see CHANGELOG.md — 46/46
browser checks). Lens: what makes professional editors feel professional —
(1) you never lose work, (2) what you see is exactly what ships, (3) direct
manipulation is precise and complete, (4) text is a first-class medium,
(5) everyone can operate it, (6) it stays fast at real scale.

Each finding: severity · what's wrong · reference behavior · proposed fix +
effort (S < ½ day · M ≈ 1–2 days · L ≈ 3–5 days · XL > a week) ·
CONFIDENCE + the assumption it rests on.

**Nothing below is implemented. Awaiting your go/no-go per item.**

---

## P0 — trust breakers

### 1. The course document is not persisted — refresh loses everything
- **What**: `lib/course/store.ts` keeps the doc in memory only (the UI store
  persists panel state, the doc store persists nothing). Reload = the seed
  course returns; hours of editing vanish silently.
- **Reference**: every professional editor autosaves continuously and says
  so ("Saved to Drive").
- **Fix**: until Supabase lands, persist `doc` (+ undo trimmed out) to
  localStorage with the same `skipHydration` pattern uiStore already uses;
  add a tiny "Saved" indicator near the title; version the storage key and
  reuse `migrate.ts` to invalidate stale schemas. **Effort: S–M.**
- **CONFIDENCE: high.** Assumption: localStorage (~5 MB) is enough for a
  mock-scale doc — image uploads are object URLs that die on reload anyway
  (documented Supabase swap point), so persisting the doc does not make
  images survive; that's acceptable interim behavior worth stating in-UI.

### 2. Text clips invisibly when styles change (auto-grow only covers typing)
- **What**: B7's auto-grow runs on TEXT commits. Raising font size, widening
  letter-spacing, narrowing the box, or switching font leaves the box
  unchanged and the content is silently cut by `overflow: hidden` — on
  canvas, thumbnails, and any future export. The 10-check linter has no
  "text is clipped" rule, so nothing ever tells you.
- **Reference**: Google Slides reflows and grows the box (or shrinks text in
  PowerPoint's "shrink on overflow" mode) — content is never silently lost.
- **Fix**: (a) run the existing hidden-twin measurement after style/resize
  commits on text-like elements and emit the same grow-only resize;
  (b) add a linter check "text overflows its box" with a one-click
  grow-to-fit fix for anything that slips through. **Effort: S–M** (the
  measurer from B7 is reusable as-is).
- **CONFIDENCE: high.** Assumption: grow-only stays the policy (your Part A
  decision); shrink-text-to-fit would be a separate opt-in.

---

## P1 — professional-feel gaps

### 3. Rotation exists in the model but the editor lies about it
- **What**: `rotation` renders (CSS transform) and AI patches can set it,
  but selection ring, resize handles, snapping, marquee hit-testing and the
  multi-select bbox all use the UNROTATED rectangle. A rotated element's
  handles float off its visual corners; snapping aligns edges that aren't
  where they appear.
- **Reference**: GS/Canva rotate the entire selection chrome with the
  element and snap on the rotated bounds; both ship a rotate handle.
- **Fix**: either (a) full rotation support — rotate handle, rotated chrome,
  rotated-aware snap/hit math (**L**) — or (b) interim honesty: remove
  rotation from the AI manifest/rules so nothing can set it until (a)
  (**S**). I recommend (b) now, (a) when prioritized.
- **CONFIDENCE: high** on the mismatch; **medium** on how often it bites
  (assumption: only AI paths set rotation today — no UI does).

### 4. No rich text runs — formatting is per-box only
- **What**: bold/italic/color/size apply to the WHOLE element. No per-word
  emphasis, no inline links, no mixed sizes in one box. This is the single
  largest parity gap with every reference tool, and it shapes the data
  model (string → runs/spans), the editor (textarea → contenteditable or a
  small rich-text layer), patches, lint, and future export.
- **Reference**: all three reference tools have full character-level runs.
- **Fix**: introduce a runs model (`[{text, marks}]`) with a Zod schema and
  a migration from plain strings; replace the textarea overlay with a
  minimal contenteditable bound to the same one-commit-per-blur contract.
  **Effort: XL.** Not something to slip into quietly — needs a yes.
- **CONFIDENCE: high** that it's the biggest gap; **low** on hidden cost
  (contenteditable + undo + paste sanitization is notoriously fiddly).

### 5. Multi-selection can't be styled
- **What**: with 2+ elements selected, the text-style toolbar disables and
  the Design tab shows the multi-entry placeholder — you cannot set font,
  color, fill, stroke, or shadow on a selection. Pros constantly restyle in
  bulk.
- **Reference**: GS applies any style control to every selected object it
  applies to (mixed values show blank controls).
- **Fix**: toolbar + DesignTab accept the multi-selection, fan out one
  `UPDATE_SLIDE_ELEMENT` per applicable member via `applyMany` (one undo);
  show "—" for mixed values. **Effort: M.**
- **CONFIDENCE: high.** Assumption: per-type applicability (e.g. fontSize
  only to text-like) mirrors what single-selection already gates.

### 6. Lines are horizontal boxes, not real line objects
- **What**: line/arrow render a horizontal stroke inside a rect; you cannot
  draw a diagonal, connect two shapes, or grab endpoints. Resizing the
  "height" of a line just pads its hit area.
- **Reference**: GS/PPT lines are 2-point objects with endpoint handles
  (and connectors snap to shape anchors).
- **Fix**: a `line` element variant with `{x1,y1,x2,y2}` + endpoint drag
  handles; render via SVG; snapping reuses point candidates. Connectors are
  a separate, bigger feature — defer. **Effort: L.**
- **CONFIDENCE: high** on the gap; **medium** on effort (endpoint editing
  touches drag, patches, schema, AI manifest).

### 7. No zoom
- **What**: the stage always fits the container width. Pixel-precise work
  (aligning small elements, checking 12px text) and big-monitor workflows
  have no zoom in/out, no fit toggle.
- **Reference**: GS: 50–200% menu + ⌘/Ctrl-scroll; Canva: slider + fit.
- **Fix**: a zoom factor in uiStore multiplying the ResizeObserver scale,
  toolbar - / % / + control, ⌘+/⌘−/⌘0, scroll container pans. The logical
  coordinate system means no element math changes. **Effort: M.**
- **CONFIDENCE: high.** Assumption: scroll-to-pan is acceptable (no
  spacebar-hand tool in v1).

### 8. The canvas is mouse-only — keyboard/AT users are locked out
- **What**: elements aren't focusable (no tabindex), so selection requires
  a pointer; the context menu ignores arrow keys and doesn't trap or
  restore focus; canvas actions (align, delete, paste) announce nothing to
  screen readers. Once selected, arrows/Delete/⌘D do work — entry is the
  barrier.
- **Reference**: GS supports Tab/Shift-Tab cycling through shapes, menu
  arrow-key navigation, and live announcements.
- **Fix**: roving `tabindex` + Tab cycling in z-order with visible focus,
  Enter = edit text / F2 parity, arrow-key navigation + focus trap + focus
  restore in CanvasContextMenu, one polite `aria-live` region narrating
  patch summaries (they already exist as strings). **Effort: M.**
- **CONFIDENCE: high.** Assumption: full SR semantics for drag/resize are
  out of scope; inspector X/Y/W/H fields remain the accessible fallback.

### 9. Z-order operations scramble multi-selections
- **What**: "Bring to front" on a multi-selection applies per element in
  selection order (selection ids come from document order, not z-order), so
  the moved set's internal stacking can invert; groups don't move as a
  block through z-space.
- **Reference**: GS reorders the whole selection as a unit, preserving its
  internal order.
- **Fix**: sort the selection by current zIndex before fanning out (S), or
  add a `REORDER_ELEMENTS` patch that moves the set atomically (M, cleaner
  undo semantics). **Effort: S–M.**
- **CONFIDENCE: medium** — established by code reading
  (`CanvasContextMenu.reorder`, `REORDER_SLIDE_ELEMENT` reducer), not yet
  reproduced in-browser. Verify before fixing.

---

## P2 — polish and forward-looking

### 10. Marquee ignores the entered-group scope
- **What**: rubber-banding while inside a group expands hits to closures at
  ROOT scope (`expandToClosures(..., [])` in `SlideStage.marqueeUp`),
  silently exiting the group you entered.
- **Reference**: GS marquees within the entered group.
- **Fix**: pass the current selection scope. **Effort: S.**
  **CONFIDENCE: high** (I wrote the shortcut in B4 and flagged it).

### 11. No Select All / no "select all" affordances
- **What**: ⌘A on the canvas does nothing; no Edit-menu equivalent.
- **Reference**: GS ⌘A selects all objects on the slide.
- **Fix**: stage keyboard + context menu item; respects scope (inside a
  group, ⌘A = all members). **Effort: S.** **CONFIDENCE: high.**

### 12. Paste placement is naive
- **What**: paste always offsets +24/+24 from the SOURCE coordinates — even
  onto another slide (where same-position is expected), and right-click
  Paste ignores the cursor location.
- **Reference**: GS pastes in place across slides; context-menu paste lands
  at the pointer.
- **Fix**: same-position when target slide ≠ source; context-menu paste
  centers the clipboard bbox on the menu's canvas point. **Effort: S.**
  **CONFIDENCE: high.** Assumption: clipboard records its source slide id
  (one field on the uiStore clipboard).

### 13. Element clipboard is one session, one tab
- **What**: in-memory only — gone on reload, invisible to other tabs, and
  ⌘C doesn't put anything on the OS clipboard (⌘C in GS gives you something
  pasteable into other apps).
- **Fix**: mirror the element clipboard to `navigator.clipboard` as a
  custom JSON payload + plain-text fallback (element text). **Effort: M**
  (permissions + fallbacks). **CONFIDENCE: medium** — browser clipboard
  permission UX varies; needs a spike.

### 14. Undo is 50 whole-document snapshots
- **What**: every patch pushes a `structuredClone` of the entire doc;
  history caps at 50. Long sessions on large courses = memory growth and a
  short history (50 ops is ~one minute of busy editing).
- **Reference**: reference tools keep effectively session-length history.
- **Fix**: store inverse patches (the reducer already returns summaries;
  computing inverses per action is mechanical) or structural-share with
  immer; raise the cap. **Effort: M.** **CONFIDENCE: medium** — no profiling
  yet; at mock scale this is invisible. Verify with a 100-slide doc first.

### 15. Snap guides don't show spacing/equal-gap hints
- **What**: edges/centers snap, but there are no distance chips or
  equal-spacing indicators, so rhythm-matching ("same gap as those two")
  is manual or requires Distribute.
- **Reference**: Canva/GS show equal-gap guides and px badges.
- **Fix**: extend `snap.ts` candidates with gap-equality detection; render
  measurement chips in `GuideOverlay`. **Effort: M.** **CONFIDENCE: high**
  on behavior; medium on visual-noise tuning.

### 16. Filmstrip thumbnails re-render on every keystroke
- **What**: thumbnails reuse `SlideStage` unmemoized; any doc change
  re-renders every slide's thumbnail.
- **Fix**: `memo` on a per-slide wrapper keyed by the slide object
  reference (the reducer replaces only the touched slide). **Effort: S.**
- **CONFIDENCE: medium** — unprofiled; likely matters only at 30+ slides.

### 17. Export-fidelity ledger (record now, pay later)
- **What**: no real export exists yet, but Part A added features whose PPTX
  mappings are non-obvious: `justify` text-align, drop-shadows (PPTX outer
  shadow ≠ CSS drop-shadow), dashed/dotted strokes, triangle geometry,
  nested groups (PPTX supports them — map `groupPath` to nested
  `<p:grpSp>`), grow-only auto-height.
- **Fix**: keep this list in the export ticket; when pptxgenjs lands, add a
  render-vs-export visual diff to the verification loop. **Effort: —**
  (process note). **CONFIDENCE: high** that ignoring it now creates silent
  drift later.

---

## OPEN QUESTIONS FOR YOU (red-team of my own list)

1. **Is #1 (persistence) actually P0 for a mock-data demo app?** I ranked
   for "feels professional," but if the studio is a skeleton until Supabase,
   you may prefer to skip localStorage and jump straight to real auth +
   storage. My counter: silent data loss during your own demos is the worst
   first impression the product can make.
2. **Rich text (#4) is the fork in the road.** Everything else on this list
   is additive; runs change the text model everywhere. Build now (while the
   editor is young), or accept per-box styling for the MVP? I deliberately
   did NOT start this.
3. **Rotation (#3): hide or build?** Hiding (removing it from the AI
   surface) is honest and cheap; building it properly is the single most
   math-touching item here. Which way?
4. **Severity inflation check**: #2 assumes users change font sizes often
   enough for clipping to bite; if your real flow is AI-generated slides
   with light manual tweaks, #2 drops to P1 and the lint check alone
   suffices.
5. **What I could not verify**: #9 (z-order scramble) is from code reading —
   I did not reproduce it in-browser before writing this; #14/#16 are
   unprofiled. If you approve those, verification comes first and they get
   dropped if they don't reproduce.
6. **What I may be blind to**: I built Part A, so this list skews toward
   canvas mechanics. Areas I did NOT deeply audit: the non-slide block
   editors (quiz/homework), the AI command UX (error states, suggestion
   quality), filmstrip drag-reorder absence, and collaborative/commenting
   features (assumed out of scope for a single-user mock). Say the word and
   I'll audit any of those properly.
7. **Sequencing proposal if you approve broadly**: 1 → 2 → 10/11/12 (small
   wins batch) → 5 → 8 → 7 → 9 → 3(b) — leaving 4, 6, 13–16 for explicit
   scheduling. Disagree freely; nothing starts until you pick.
