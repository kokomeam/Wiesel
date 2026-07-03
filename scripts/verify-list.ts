/**
 * Rich-list primitive checks (pure, no key / no DB).
 * Run: `npx tsx scripts/verify-list.ts`
 *
 * Covers: the data model + backward compat (legacy items-only vs rich list),
 * the pure list ops that back every keyboard behaviour (split/indent/outdent/
 * merge/marker/markdown + auto-numbering), the validated patch round-trip
 * (items↔list invariant, legacy reset), and store undo/redo.
 */

import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { setElementListPatch, setListContentPatch, updateElementPatch } from "@/lib/course/commands";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { SlideElementSchema, SlideSchema } from "@/lib/course/schemas";
import {
  TEXT_LIST_SPACING,
  computeMarkers,
  detectMarkdownPrefix,
  effectiveMarkerKind,
  flattenToItems,
  indentItem,
  listFromElement,
  listIsAllPlain,
  listToText,
  mergeWithPrev,
  newListItem,
  outdentItem,
  removeItem,
  setItemMarker,
  setListMarker,
  splitItem,
  textToList,
  toggleItemMarker,
} from "@/lib/course/slide/list";
import { useEditorStore } from "@/lib/course/store";
import type {
  CourseDocument,
  Slide,
  SlideDeckBlock,
  SlideElement,
  SlideListContent,
} from "@/lib/course/types";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};

const NOW = "2026-06-29T00:00:00.000Z";

function bulletEl(overrides: Partial<Extract<SlideElement, { type: "bullet_list" }>> = {}): Extract<SlideElement, { type: "bullet_list" }> {
  return {
    id: "bl-1",
    type: "bullet_list",
    x: 80,
    y: 80,
    width: 800,
    height: 300,
    zIndex: 0,
    style: { fontSize: 22 },
    ai: { purpose: "", editable: true, allowedActions: [], semanticTags: [] },
    items: ["one", "two"],
    ...overrides,
  };
}

function richContent(): SlideListContent {
  return {
    defaultMarkerKind: "number",
    markerColor: "#ea580c",
    items: [
      { id: "a", text: "First step", level: 0, markerText: "01", textColor: "#431407" },
      { id: "b", text: "supporting detail", level: 1, markerKind: "dash", textColor: "#78716c" },
      { id: "c", text: "Second step", level: 0, markerText: "02" },
    ],
    levelStyles: [{ markerKind: "number" }, { markerKind: "dash", fontSize: 16 }],
  };
}

function docWithEl(el: SlideElement): { doc: CourseDocument; blockId: string; slideId: string } {
  const slide: Slide = {
    id: "s1",
    type: "slide",
    layout: "blank",
    style: { background: { type: "solid", color: "#fff" }, theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c", fontFamily: "sans" } },
    elements: [el],
    order: 0,
    ai: { formattingRules: [], qualityChecks: [], allowedActions: [] },
  };
  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  deck.slides = [slide];
  const lesson = createLesson("L", 0);
  lesson.blocks = [deck];
  const mod = createModule("M", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "c",
    title: "List test",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "o", aiReadableVersion: "1.0" },
  };
  return { doc, blockId: deck.id, slideId: slide.id };
}

function apply(doc: CourseDocument, patch: CoursePatch): CourseDocument {
  const res = applyCoursePatch(doc, patch, NOW);
  if (!res.ok) throw new Error(`${patch.action}: ${res.error}`);
  return res.doc;
}

function blOf(doc: CourseDocument): Extract<SlideElement, { type: "bullet_list" }> {
  const el = (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].elements[0];
  if (el.type !== "bullet_list") throw new Error("not a bullet_list");
  return el;
}

function main() {
  console.log("\nRich list primitive\n");

  // ── 1. Model + backward compat.
  check("legacy bullet_list (items only) validates", SlideElementSchema.safeParse(bulletEl()).success);
  check("rich bullet_list (with list) validates", SlideElementSchema.safeParse(bulletEl({ list: richContent() })).success);
  check("nested levels validate", SlideElementSchema.safeParse(bulletEl({ list: richContent() })).success);
  const legacy = listFromElement(bulletEl());
  check("listFromElement upgrades legacy items → disc level-0 (deterministic ids)", legacy.items.length === 2 && legacy.items[0].id === "bl-1::0" && legacy.items[0].level === 0 && legacy.defaultMarkerKind === "disc");
  check("listFromElement returns the rich list when present", listFromElement(bulletEl({ list: richContent() })).items.length === 3);
  check("flattenToItems matches the plain fallback", JSON.stringify(flattenToItems(richContent())) === JSON.stringify(["First step", "supporting detail", "Second step"]));
  const rt: SlideListContent = JSON.parse(JSON.stringify(richContent()));
  check("marker/text colors round-trip through JSON", rt.items[0].textColor === "#431407" && rt.markerColor === "#ea580c");

  // ── 2. Marker computation.
  const markers = computeMarkers(richContent());
  check("computeMarkers honours markerText '01' + dash glyph", markers[0] === "01" && markers[1] === "—" && markers[2] === "02");
  const autoNum = computeMarkers({ defaultMarkerKind: "number", items: [{ id: "a", text: "x", level: 0 }, { id: "b", text: "y", level: 0 }] });
  check("auto-numbering: 1. then 2.", autoNum[0] === "1." && autoNum[1] === "2.");
  const nested = computeMarkers({ defaultMarkerKind: "number", items: [{ id: "a", text: "x", level: 0 }, { id: "b", text: "y", level: 1 }, { id: "c", text: "z", level: 1 }, { id: "d", text: "w", level: 0 }] });
  check("numbering restarts on descend + resumes on ascend", nested[0] === "1." && nested[1] === "1." && nested[2] === "2." && nested[3] === "2.");
  const alpha = computeMarkers({ defaultMarkerKind: "alpha", items: [{ id: "a", text: "x", level: 0 }, { id: "b", text: "y", level: 0 }] });
  check("alpha markers a. b.", alpha[0] === "a." && alpha[1] === "b.");

  // ── 3. Structural ops (the keyboard behaviours).
  const c0 = richContent();
  const splitEnd = splitItem(c0, "a", "First step".length);
  check("Enter at end of a non-empty item → new EMPTY item at the same level", splitEnd.content.items.length === 4 && splitEnd.content.items[1].text === "" && splitEnd.content.items[1].level === 0 && splitEnd.caret === "start");
  const splitMid = splitItem(c0, "a", 5);
  check("Enter mid-item splits head/tail", splitMid.content.items[0].text === "First" && splitMid.content.items[1].text === " step");
  const ind = indentItem(c0, "c"); // "Second step" after a level-1 item → max level 2; +1 → level 1
  check("Tab indents one level (capped at prev+1)", ind.content.items[2].level === 1);
  const indFirst = indentItem(c0, "a");
  check("Tab on the first item is a no-op (can't indent the first)", indFirst.content.items[0].level === 0);
  const outd = outdentItem(c0, "b");
  check("Shift+Tab outdents one level", outd.content.items[1].level === 0);
  const merge = mergeWithPrev(c0, "b");
  check("Backspace at start merges into the previous item", merge.content.items.length === 2 && merge.content.items[0].text === "First stepsupporting detail" && merge.caret === "First step".length);
  const emptyNested = { defaultMarkerKind: "disc" as const, items: [{ id: "a", text: "x", level: 0 }, { id: "b", text: "", level: 1 }] };
  check("Enter/Backspace on an EMPTY nested item → outdent", outdentItem(emptyNested, "b").content.items[1].level === 0);
  const emptyTop = { defaultMarkerKind: "disc" as const, items: [{ id: "a", text: "x", level: 0 }, { id: "b", text: "", level: 0 }] };
  check("Enter/Backspace on an EMPTY level-0 item → remove it", removeItem(emptyTop, "b").content.items.length === 1);
  check("setItemMarker overrides one item", setItemMarker(c0, "a", "circle").items[0].markerKind === "circle");
  const allNum = setListMarker(c0, "number");
  check("setListMarker retargets the whole list + clears per-item overrides", allNum.defaultMarkerKind === "number" && allNum.items.every((it) => it.markerKind === undefined && it.markerText === undefined));

  // ── 4. Markdown shortcuts.
  const md = (s: string) => detectMarkdownPrefix(s);
  check("'- ' → dash", md("- ")?.kind === "dash");
  check("'-- ' → dash", md("-- ")?.kind === "dash");
  check("'— ' → dash", md("— ")?.kind === "dash");
  check("'1. ' → number (auto)", md("1. ")?.kind === "number" && md("1. ")?.markerText === undefined);
  check("'1) ' → number", md("1) ")?.kind === "number");
  check("'01 ' → two-digit number marker", md("01 ")?.kind === "number" && md("01 ")?.markerText === "01");
  check("'01. ' → two-digit number marker", md("01. ")?.markerText === "01");
  check("'• ' → disc", md("• ")?.kind === "disc");
  check("'○ ' / 'o ' → circle", md("○ ")?.kind === "circle" && md("o ")?.kind === "circle");
  check("no trigger mid-text", md("hello - world") === null);

  // ── 5. Patch round-trip + invariant.
  {
    const init = docWithEl(bulletEl());
    let doc = init.doc;
    const { blockId, slideId } = init;
    doc = apply(doc, setListContentPatch(blockId, slideId, "bl-1", richContent()));
    const el = blOf(doc);
    check("patch: setListContentPatch installs the rich list", !!el.list && el.list.items.length === 3);
    check("patch: items[] fallback stays in sync (= flatten(list))", JSON.stringify(el.items) === JSON.stringify(["First step", "supporting detail", "Second step"]));
    check("patch: the whole slide re-validates", SlideSchema.safeParse((doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0]).success);

    // A legacy plain-items rewrite resets the rich layer.
    doc = apply(doc, updateElementPatch(blockId, slideId, "bl-1", { items: ["just", "plain"] }));
    const el2 = blOf(doc);
    check("patch: legacy items rewrite clears the rich list", el2.list === undefined && JSON.stringify(el2.items) === JSON.stringify(["just", "plain"]));

    // A rejected field gate: list still only allowed on bullet_list (sanity — text key rejected).
    const bad = applyCoursePatch(doc, updateElementPatch(blockId, slideId, "bl-1", { text: "no" } as never) as CoursePatch, NOW);
    check("patch: an invalid key for bullet_list is rejected", !bad.ok);
  }

  // ── 6. Store undo/redo across a list edit.
  {
    const { doc, blockId, slideId } = docWithEl(bulletEl({ list: richContent() }));
    const store = useEditorStore.getState();
    store.hydrate(doc, "c");
    const before = blOf(useEditorStore.getState().doc).list!.items.length;
    const added = splitItem(richContent(), "c", "Second step".length).content;
    useEditorStore.getState().apply(setListContentPatch(blockId, slideId, "bl-1", added), "human");
    check("store: list edit applied (item added)", blOf(useEditorStore.getState().doc).list!.items.length === before + 1);
    useEditorStore.getState().undo();
    check("store: undo restores the previous list", blOf(useEditorStore.getState().doc).list!.items.length === before);
    useEditorStore.getState().redo();
    check("store: redo re-applies the list edit", blOf(useEditorStore.getState().doc).list!.items.length === before + 1);
  }

  // ── 7. New item factory.
  check("newListItem mints a fresh id", newListItem("x", 1).id.startsWith("li-"));

  // ── 8. Text box ⇄ list (lists inside a text element).
  {
    const tl = textToList("alpha\nbeta\ngamma", undefined, new Set([1]), "disc");
    check("textToList: one item per line", tl.items.length === 3 && tl.items[1].text === "beta");
    check("textToList: marks ONLY the selected line", effectiveMarkerKind(tl, tl.items[0]) === "none" && effectiveMarkerKind(tl, tl.items[1]) === "disc" && effectiveMarkerKind(tl, tl.items[2]) === "none");
    check("textToList: tight paragraph spacing for a text box", tl.paragraphSpacing === TEXT_LIST_SPACING);

    const tl2 = textToList("bold\nplain", [{ text: "bold", marks: { bold: true } }, { text: "\nplain" }], new Set([0, 1]), "number");
    check("textToList: per-line runs preserved", tl2.items[0].runs?.[0]?.marks?.bold === true && (tl2.items[1].runs === undefined || !tl2.items[1].runs[0].marks));

    check("listToText: rejoins lines with newlines", listToText(tl).text === "alpha\nbeta\ngamma");
    const on = toggleItemMarker(tl, tl.items[0].id, "disc");
    check("toggleItemMarker: plain → disc", effectiveMarkerKind(on, on.items[0]) === "disc");
    const off = toggleItemMarker(on, on.items[0].id, "disc");
    check("toggleItemMarker: disc → off (plain)", effectiveMarkerKind(off, off.items[0]) === "none");
    check("listIsAllPlain on an all-'none' list", listIsAllPlain(textToList("a\nb", undefined, new Set(), "disc")));
  }

  // ── 9. Text-element list patch round-trip (the toggle commit).
  {
    const textEl: SlideElement = {
      id: "t1",
      type: "text",
      x: 0, y: 0, width: 400, height: 100, zIndex: 0,
      style: { fontSize: 22 },
      ai: { purpose: "", editable: true, allowedActions: [], semanticTags: [] },
      text: "one\ntwo",
      runs: [{ text: "one\ntwo", marks: { bold: true } }],
    };
    const init = docWithEl(textEl);
    let doc = init.doc;
    const { blockId, slideId } = init;
    const list = textToList("one\ntwo", undefined, new Set([0, 1]), "disc");
    doc = apply(doc, setElementListPatch(blockId, slideId, textEl, list));
    const el = (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].elements[0];
    check("patch: text element gains a list", el.type === "text" && !!el.list && el.list.items.length === 2);
    check("patch: text fallback derived from the list + runs cleared", el.type === "text" && el.text === "one\ntwo" && el.runs === undefined);
    check("patch: the slide still validates", SlideSchema.safeParse((doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0]).success);

    // A plain text rewrite (e.g. toggling the last marker off → collapse) clears the list.
    doc = apply(doc, updateElementPatch(blockId, slideId, "t1", { text: "back to plain" }));
    const el2 = (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].elements[0];
    check("patch: a plain text rewrite clears the list", el2.type === "text" && el2.list === undefined && el2.text === "back to plain");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
