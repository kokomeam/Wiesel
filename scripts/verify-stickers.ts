/**
 * Sticker primitive library checks (Task 4) — pure, no key/DB.
 * Run: `npx tsx scripts/verify-stickers.ts`
 *
 * Proves the ONE registry is consistent and that a sticker is a first-class
 * element: every id has an icon, the factory builds a schema-valid sticker,
 * and the SAME CoursePatch pipeline (ADD/UPDATE_SLIDE_ELEMENT) the UI + AI use
 * can place and re-icon it — with the per-type key gate blocking nonsense.
 */

import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { addElementPatch, updateElementPatch } from "@/lib/course/commands";
import { createBlock, createElement, createLesson, createModule } from "@/lib/course/factories";
import { SlideElementSchema, SlideSchema } from "@/lib/course/schemas";
import {
  DEFAULT_STICKER_ID,
  STICKER_IDS,
  STICKER_REGISTRY,
  findSticker,
  isStickerId,
} from "@/lib/course/slide/stickers";
import { STICKER_ICONS } from "@/components/editor/slide/elements/StickerElement";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};

const NOW = "2026-06-16T00:00:00.000Z";

function deckDoc(): { doc: CourseDocument; deck: SlideDeckBlock } {
  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  const lesson = createLesson("L", 0);
  lesson.blocks = [deck];
  const mod = createModule("M", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "c",
    title: "Sticker test",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "o", aiReadableVersion: "1.0" },
  };
  return { doc, deck };
}

function main() {
  // ── 1. Registry ↔ icon parity (single source of truth).
  check("registry is non-empty", STICKER_REGISTRY.length >= 14, `${STICKER_REGISTRY.length}`);
  check("ids are unique", new Set(STICKER_IDS).size === STICKER_IDS.length);
  const missingIcon = STICKER_IDS.filter((id) => !(id in STICKER_ICONS));
  check("every sticker id has a lucide icon", missingIcon.length === 0, missingIcon.join(","));
  const orphanIcons = Object.keys(STICKER_ICONS).filter((id) => !isStickerId(id));
  check("no icon without a registry entry", orphanIcons.length === 0, orphanIcons.join(","));
  check("DEFAULT_STICKER_ID is a real id", isStickerId(DEFAULT_STICKER_ID));
  check("every entry has a label + keywords", STICKER_REGISTRY.every((s) => s.label && s.keywords.length > 0));

  // ── 2. Factory builds a schema-valid sticker element.
  const fresh = createElement("sticker", 0);
  check("createElement('sticker') is type sticker", fresh.type === "sticker");
  check("fresh sticker uses the default id", fresh.type === "sticker" && fresh.stickerId === DEFAULT_STICKER_ID);
  check("fresh sticker passes the element schema", SlideElementSchema.safeParse(fresh).success);

  // ── 3. Placed + re-iconed through the SAME patch pipeline.
  const { doc, deck } = deckDoc();
  const slide = deck.slides[0];
  const added = applyCoursePatch(doc, addElementPatch(deck.id, slide.id, "sticker", slide.elements.length), NOW);
  check("ADD_SLIDE_ELEMENT(sticker) applies", added.ok, added.ok ? "" : added.error);
  if (!added.ok) return finish();

  const placedSlide = (added.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0];
  const stickerEl = placedSlide.elements.find((e) => e.type === "sticker");
  check("sticker is on the slide", !!stickerEl);
  check("placed slide still validates (persistence-safe)", SlideSchema.safeParse(placedSlide).success);
  if (!stickerEl) return finish();

  const reicon = applyCoursePatch(
    added.doc,
    updateElementPatch(deck.id, slide.id, stickerEl.id, { stickerId: "target" }),
    NOW
  );
  check("UPDATE_SLIDE_ELEMENT can change the sticker id", reicon.ok, reicon.ok ? "" : reicon.error);
  if (reicon.ok) {
    const el = (reicon.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].elements.find(
      (e) => e.id === stickerEl.id
    );
    check("sticker id is now 'target'", el?.type === "sticker" && el.stickerId === "target");
  }

  // ── 4. Per-type key gate: a sticker has no text slot, so a stray text update
  //       is dropped (not written onto the element).
  const stray = applyCoursePatch(
    added.doc,
    // cast: deliberately sending a key not valid for this element type
    updateElementPatch(deck.id, slide.id, stickerEl.id, { text: "nope" } as never) as CoursePatch,
    NOW
  );
  if (stray.ok) {
    const el = (stray.doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].elements.find(
      (e) => e.id === stickerEl.id
    );
    check("stray 'text' update is ignored on a sticker", el !== undefined && !("text" in el));
  } else {
    check("stray 'text' update is ignored on a sticker", true);
  }

  // ── 5. Lookups.
  check("findSticker returns the def", findSticker("lightbulb")?.label === "Idea");
  check("findSticker(unknown) is undefined", findSticker("not-real") === undefined);

  finish();
}

function finish() {
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
