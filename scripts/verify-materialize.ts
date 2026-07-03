/**
 * Materialize-on-eject checks (pure, no key / no DB).
 * Run: `npx tsx scripts/verify-materialize.ts`
 *
 * Proves the deterministic "structured layout → editable elements" step:
 *  - canMaterializeSlide gates correctly (5 supported layouts; structured-but-
 *    unsupported and already-freeform slides return null / false → graceful);
 *  - materializeSlide yields schema-valid elements, in-bounds frames, sane
 *    z-order (card/decor backgrounds behind their text), stamped roles/origin;
 *  - no visible instructional content is dropped (every source text appears);
 *  - the eject flows through the REAL validated patch pipeline (SET_SLIDE_CONTENT
 *    drops the template, installs the elements), the result survives a JSON
 *    (jsonb) persistence round-trip, a user move sets userModified.frame and
 *    persists, and a later content edit does NOT reset that geometry;
 *  - a block-level revert (the Reject path) cleanly restores the structured slide.
 */

import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import {
  moveElementPatch,
  setSlideContentPatch,
  updateElementPatch,
} from "@/lib/course/commands";
import {
  createBlock,
  createLesson,
  createModule,
  createSlide,
  createStructuredSlide,
} from "@/lib/course/factories";
import { SlideElementSchema, SlideSchema } from "@/lib/course/schemas";
import { SLIDE_H, SLIDE_W } from "@/lib/course/slide/geometry";
import { CARD, cardTint, ceChipBg, ceFootBg } from "@/lib/course/slide/structured/styleConstants";
import {
  MATERIALIZABLE_LAYOUT_IDS,
  canMaterializeSlide,
  materializeSlide,
} from "@/lib/course/slide/materialize";
import type {
  CourseDocument,
  Slide,
  SlideDeckBlock,
  SlideElement,
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

function docWith(slide: Slide): { doc: CourseDocument; blockId: string; slideId: string } {
  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  deck.slides = [slide];
  const lesson = createLesson("L", 0);
  lesson.blocks = [deck];
  const mod = createModule("M", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "course-1",
    title: "Materialize test",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" } as never,
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "owner", aiReadableVersion: "1.0" },
  };
  return { doc, blockId: deck.id, slideId: slide.id };
}

function apply(doc: CourseDocument, patch: CoursePatch): CourseDocument {
  const res = applyCoursePatch(doc, patch, NOW);
  if (!res.ok) throw new Error(`patch ${patch.action} failed: ${res.error}`);
  return res.doc;
}

function slideOf(doc: CourseDocument): Slide {
  return (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0];
}

/** All RichText `.text` values anywhere in a structured content tree. */
function collectTexts(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectTexts(n, out));
    return;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string" && o.text.trim()) out.push(o.text.trim());
    for (const k of Object.keys(o)) if (k !== "text") collectTexts(o[k], out);
  }
}

function elementText(el: SlideElement): string {
  if (el.type === "bullet_list") return el.items.join("\n");
  if (el.type === "text" || el.type === "heading" || el.type === "callout") return el.text;
  if (el.type === "image") return [el.alt, el.caption].filter(Boolean).join("\n");
  return "";
}

function inBounds(el: SlideElement): boolean {
  return (
    el.width > 0 &&
    el.height > 0 &&
    el.x >= 0 &&
    el.y >= 0 &&
    el.x + el.width <= SLIDE_W + 0.5 &&
    el.y + el.height <= SLIDE_H + 0.5
  );
}

function main() {
  console.log("\nMaterialize-on-eject\n");

  // ── 1. Gate: exactly the 5 supported layouts materialize; others don't.
  check("5 materializable layouts registered", MATERIALIZABLE_LAYOUT_IDS.length === 5);
  for (const id of MATERIALIZABLE_LAYOUT_IDS) {
    check(`canMaterializeSlide true for ${id}`, canMaterializeSlide(createStructuredSlide(id)));
  }
  const unsupported = createStructuredSlide("process_steps");
  check("canMaterializeSlide false for an unsupported structured layout", !canMaterializeSlide(unsupported));
  check("materializeSlide null for an unsupported structured layout", materializeSlide(unsupported) === null);
  const freeform = createSlide("title");
  check("canMaterializeSlide false for a freeform slide", !canMaterializeSlide(freeform));
  check("materializeSlide null for a freeform slide", materializeSlide(freeform) === null);
  check("an unsupported structured slide is left untouched (still has its template)", !!unsupported.template);

  // ── 2. Per-layout structural guarantees.
  for (const id of MATERIALIZABLE_LAYOUT_IDS) {
    const slide = createStructuredSlide(id);
    const els = materializeSlide(slide);
    check(`${id}: materializeSlide returns elements`, !!els && els.length > 0, `${els?.length ?? 0}`);
    if (!els) continue;

    const allValid = els.every((el) => SlideElementSchema.safeParse(el).success);
    check(`${id}: every element validates against SlideElementSchema`, allValid);

    const allBound = els.every(inBounds);
    check(`${id}: every frame is within the 1280×720 canvas`, allBound);

    const zOrdered = els.every((el, i) => el.zIndex === i);
    check(`${id}: zIndex is a clean 0..n-1 stack`, zOrdered);

    const allStamped = els.every((el) => el.origin === "ai" && typeof el.role === "string" && el.role.length > 0);
    check(`${id}: every element carries origin:'ai' + a role`, allStamped);

    // Content coverage — no dropped instructional text (case-insensitive,
    // substring tolerant of folded/upper-cased decoration).
    const srcTexts: string[] = [];
    collectTexts(slide.template!.content, srcTexts);
    const haystack = els.map(elementText).join("\n").toLowerCase();
    const missing = srcTexts.filter((t) => !haystack.includes(t.toLowerCase()));
    check(`${id}: all source text appears in the materialized elements`, missing.length === 0, missing.slice(0, 2).join(" | "));

    // Bullet-marker layouts → editable bullet_list; numbered layouts keep their
    // custom markers (NOT downgraded to a generic bullet list).
    if (id === "prose" || id === "image_supporting") {
      check(`${id}: bullet content materializes as an editable bullet_list`, els.some((el) => el.type === "bullet_list"));
    }
    if (id === "outline_list") {
      const list = els.find((el): el is Extract<SlideElement, { type: "bullet_list" }> => el.type === "bullet_list")?.list;
      check(
        `${id}: rich list preserves numbered "01" markers + dash sub-points`,
        !!list &&
          list.items.some((it) => !!it.markerText && /\d/.test(it.markerText)) &&
          list.items.some((it) => it.markerKind === "dash" && it.level === 1)
      );
    }
  }

  // ── 2b. Visual-fidelity guarantees (the polish that was lost before).
  {
    const ce = materializeSlide(createStructuredSlide("concept_example"))!;
    const accent = "#ea580c"; // editorial-warm default
    const card = ce.find((e) => e.role === "example.card")!;
    check("concept_example: example card keeps its PEACH tint (not white)", card.style.backgroundColor === cardTint(accent));
    check("concept_example: card keeps border + radius + shadow", card.style.borderRadius === CARD.radius && !!card.style.borderColor && !!card.style.shadow);
    const chips = ce.filter((e) => e.role?.endsWith(".chip"));
    check("concept_example: numbered step chips are filled circles", chips.length > 0 && chips.every((c) => c.style.backgroundColor === ceChipBg(accent) && c.style.borderRadius === 999));
    const badges = ce.filter((e) => e.role === "concept.badge" || e.role === "example.badge");
    check("concept_example: badges are pills (bg + full radius + border)", badges.length === 2 && badges.every((b) => !!b.style.backgroundColor && b.style.borderRadius === 999 && !!b.style.borderColor));
    check("concept_example: 'in practice' connector materializes (arrow halo)", ce.some((e) => e.type === "sticker" && e.role === "connector.arrow"));
    const footBox = ce.find((e) => e.role === "footnote.box");
    check("concept_example: footnote is an accent-tinted box (not a green TIP callout)", !!footBox && footBox.style.backgroundColor === ceFootBg(accent) && !ce.some((e) => e.type === "callout"));

    const cc = materializeSlide(createStructuredSlide("comparison_columns"))!;
    const ccCard = cc.find((e) => e.role === "col.0.card")!;
    check("comparison_columns: cards are white with a colour top bar", ccCard.style.backgroundColor === CARD.bg && cc.some((e) => e.role === "col.0.bar" && e.style.backgroundColor === accent));
    check("comparison_columns: points are colour-dot rows (not plain bullets)", cc.some((e) => e.role?.endsWith(".dot")) && !cc.some((e) => e.type === "bullet_list"));
  }

  // ── 3. Z-order: card/decor backgrounds sit BEHIND their grouped text.
  {
    const els = materializeSlide(createStructuredSlide("concept_example"))!;
    const card = els.find((e) => e.role === "example.card")!;
    const title = els.find((e) => e.role === "concept.title")!;
    const cardContent = els.find((e) => e.role?.startsWith("example.") && e.role !== "example.card")!;
    check("concept_example: example.card bg is behind its content", !!card && !!cardContent && card.zIndex < cardContent.zIndex);
    check("concept_example: a concept group + an example group exist", (card.groupPath?.length ?? 0) === 1 && (title.groupPath?.length ?? 0) === 1 && card.groupPath![0] !== title.groupPath![0]);
  }
  {
    const els = materializeSlide(createStructuredSlide("comparison_columns"))!;
    const card0 = els.find((e) => e.role === "col.0.card")!;
    const name0 = els.find((e) => e.role === "col.0.name")!;
    check("comparison_columns: col.0 card bg is behind its name", !!card0 && !!name0 && card0.zIndex < name0.zIndex);
    check("comparison_columns: a column is one group (card + name share a groupPath)", (card0.groupPath?.[0] ?? "a") === (name0.groupPath?.[0] ?? "b"));
  }

  // ── 4. image_supporting: the image becomes a real image element.
  {
    const els = materializeSlide(createStructuredSlide("image_supporting"))!;
    const img = els.find((e) => e.type === "image");
    check("image_supporting: an image element is produced", !!img && img.role === "image.main");
    check("image_supporting: the image keeps a fixed 1:1-ish box", !!img && Math.abs(img.width - img.height) < 2);
  }

  // ── 5. Eject through the REAL patch pipeline (SET_SLIDE_CONTENT).
  {
    const slide = createStructuredSlide("prose");
    const init = docWith(slide);
    let doc = init.doc;
    const { blockId, slideId } = init;
    const before = structuredClone(doc.modules[0].lessons[0].blocks[0]) as SlideDeckBlock;
    const els = materializeSlide(slide)!;
    doc = apply(doc, setSlideContentPatch(blockId, slideId, slide.template!.layoutId, els, "structured"));
    const ejected = slideOf(doc);
    check("eject: template is cleared (slide now renders the element path)", !ejected.template);
    check("eject: ambient backdrop is preserved (structured glow/dots)", ejected.backdrop === "structured");
    check("eject: elements installed", ejected.elements.length === els.length && ejected.elements.length > 0);
    check("eject: slide id / order preserved", ejected.id === slideId && ejected.order === 0);
    check("eject: the whole ejected slide re-validates against SlideSchema", SlideSchema.safeParse(ejected).success);

    // Persistence (jsonb) round-trip: geometry + new fields survive.
    const roundTripped: Slide = JSON.parse(JSON.stringify(ejected));
    check("persist: ejected slide survives a JSON round-trip byte-for-byte", JSON.stringify(roundTripped) === JSON.stringify(ejected));

    // A user moves an element → userModified.frame, geometry persists.
    const target = ejected.elements.find((e) => e.role === "title")!;
    doc = apply(doc, moveElementPatch(blockId, slideId, target.id, 200, 300));
    let moved = slideOf(doc).elements.find((e) => e.id === target.id)!;
    check("move: element lands at the new position", moved.x === 200 && moved.y === 300);
    check("move: userModified.frame is set", moved.userModified?.frame === true);
    const afterReload: Slide = JSON.parse(JSON.stringify(slideOf(doc)));
    const reloadedMoved = afterReload.elements.find((e) => e.id === target.id)!;
    check("persist: moved geometry + userModified survive reload", reloadedMoved.x === 200 && reloadedMoved.userModified?.frame === true);

    // A later CONTENT edit must NOT reset the user-moved frame.
    const bullets = slideOf(doc).elements.find((e) => e.type === "bullet_list");
    if (bullets) {
      doc = apply(doc, updateElementPatch(blockId, slideId, bullets.id, { items: ["Edited point", "New point"] }));
    }
    moved = slideOf(doc).elements.find((e) => e.id === target.id)!;
    check("content edit elsewhere does not move the user-positioned title", moved.x === 200 && moved.y === 300);
    if (bullets) {
      const edited = slideOf(doc).elements.find((e) => e.id === bullets.id)! as Extract<SlideElement, { type: "bullet_list" }>;
      check("bullet edit: items updated + userModified.content set", edited.items.length === 2 && edited.userModified?.content === true && edited.userModified?.frame !== true);
    }

    // Reject path: a block-level restore returns the structured slide cleanly.
    doc = apply(doc, { action: "SET_BLOCK_CONTENT", blockId, block: before });
    const reverted = slideOf(doc);
    check("reject: block restore brings the structured template back", !!reverted.template && reverted.template.layoutId === "prose");
    check("reject: reverted slide carries no leftover materialized elements", reverted.elements.length === 0);
  }

  // ── 6. "Add a bullet" persists through the pipeline (Google-Slides feel).
  {
    const slide = createStructuredSlide("image_supporting");
    const init = docWith(slide);
    let doc = init.doc;
    const { blockId, slideId } = init;
    doc = apply(doc, setSlideContentPatch(blockId, slideId, "image_supporting", materializeSlide(slide)!));
    const list = slideOf(doc).elements.find((e) => e.type === "bullet_list") as Extract<SlideElement, { type: "bullet_list" }>;
    const n0 = list.items.length;
    doc = apply(doc, updateElementPatch(blockId, slideId, list.id, { items: [...list.items, "A brand-new bullet"] }));
    const list2 = slideOf(doc).elements.find((e) => e.id === list.id) as Extract<SlideElement, { type: "bullet_list" }>;
    check("bullet add: a new bullet persists through CoursePatch", list2.items.length === n0 + 1 && list2.items.at(-1) === "A brand-new bullet");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
