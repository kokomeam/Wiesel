/**
 * Verify the PURE slide-asset lookahead helpers (PERF-1 C5) — no key, no DB,
 * no browser. Run: npx tsx scripts/verify-lookahead.ts
 *
 * Covers collectSlideImageUrls across every image-bearing case (the three
 * image template layouts, background images, freeform image elements, hidden/
 * pending/non-network URLs, template-shadows-elements) and planLookahead
 * (bounds, dedupe within and across slides, current-slide exclusion, order,
 * ahead clamp at the deck end).
 */

import { collectSlideImageUrls, planLookahead } from "@/lib/learn/lookahead";
import type { Slide, SlideElement, SlideTemplate } from "@/lib/course/types";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ─────────────────────────────── Fixtures ──────────────────────────────── */

let nextId = 0;
function makeSlide(over: Partial<Slide> = {}): Slide {
  return {
    id: `slide-${nextId++}`,
    type: "slide",
    layout: "title",
    style: {
      background: { type: "solid", color: "#ffffff" },
      theme: {
        id: "editorial-warm",
        name: "Editorial Warm",
        accentColor: "#ea580c",
        fontFamily: "sans",
      },
    },
    elements: [],
    order: 0,
    ai: { formattingRules: [], qualityChecks: [], allowedActions: [] },
    ...over,
  };
}

function imageElement(src: string, over: Partial<SlideElement> = {}): SlideElement {
  return {
    id: `el-${nextId++}`,
    type: "image",
    src,
    alt: "an image",
    objectFit: "cover",
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    zIndex: 1,
    style: {},
    ai: { purpose: "test image", editable: true, allowedActions: [], semanticTags: [] },
    ...over,
  } as SlideElement;
}

function textElement(): SlideElement {
  return {
    id: `el-${nextId++}`,
    type: "text",
    text: "hello",
    x: 0,
    y: 0,
    width: 320,
    height: 80,
    zIndex: 1,
    style: {},
    ai: { purpose: "test text", editable: true, allowedActions: [], semanticTags: [] },
  };
}

const URL_A = "https://cdn.example.com/a.png";
const URL_B = "https://cdn.example.com/b.png";
const URL_C = "https://cdn.example.com/c.png";
const URL_D = "https://cdn.example.com/d.png";

function imageTemplate(
  layoutId: "illustration" | "image_reference" | "image_supporting",
  imageUrl: string
): SlideTemplate {
  if (layoutId === "illustration") {
    return { layoutId, content: { imageUrl, alt: "fig" } };
  }
  return { layoutId, content: { imageUrl, alt: "fig", title: { text: "Figure" } } };
}

/* ──────────────────────── collectSlideImageUrls ────────────────────────── */

console.log("\ncollectSlideImageUrls");

check("empty slide → no urls", collectSlideImageUrls(makeSlide()).length === 0);

check(
  "illustration template imageUrl collected",
  eq(collectSlideImageUrls(makeSlide({ template: imageTemplate("illustration", URL_A) })), [URL_A])
);

check(
  "image_reference template imageUrl collected",
  eq(collectSlideImageUrls(makeSlide({ template: imageTemplate("image_reference", URL_B) })), [
    URL_B,
  ])
);

check(
  "image_supporting template imageUrl collected",
  eq(collectSlideImageUrls(makeSlide({ template: imageTemplate("image_supporting", URL_C) })), [
    URL_C,
  ])
);

check(
  "pending image template (imageUrl '') → no urls",
  collectSlideImageUrls(makeSlide({ template: imageTemplate("image_reference", "") })).length === 0
);

check(
  "non-image template (prose) → no urls",
  collectSlideImageUrls(
    makeSlide({
      template: {
        layoutId: "prose",
        content: { title: { text: "T" }, body: { text: "B" } },
      },
    })
  ).length === 0
);

check(
  "background image collected",
  eq(
    collectSlideImageUrls(
      makeSlide({
        style: {
          background: { type: "image", imageSrc: URL_A },
          theme: {
            id: "editorial-warm",
            name: "Editorial Warm",
            accentColor: "#ea580c",
            fontFamily: "sans",
          },
        },
      })
    ),
    [URL_A]
  )
);

check(
  "background renders under templates too — background FIRST, then template image",
  eq(
    collectSlideImageUrls(
      makeSlide({
        style: {
          background: { type: "image", imageSrc: URL_A },
          theme: {
            id: "editorial-warm",
            name: "Editorial Warm",
            accentColor: "#ea580c",
            fontFamily: "sans",
          },
        },
        template: imageTemplate("image_supporting", URL_B),
      })
    ),
    [URL_A, URL_B]
  )
);

check(
  "image elements collected in array order",
  eq(
    collectSlideImageUrls(
      makeSlide({ elements: [textElement(), imageElement(URL_A), imageElement(URL_B)] })
    ),
    [URL_A, URL_B]
  )
);

check(
  "hidden image element (visible:false) skipped",
  eq(
    collectSlideImageUrls(
      makeSlide({ elements: [imageElement(URL_A, { visible: false }), imageElement(URL_B)] })
    ),
    [URL_B]
  )
);

check(
  "template present → freeform element images NOT collected (SlideStage ignores them)",
  eq(
    collectSlideImageUrls(
      makeSlide({
        template: imageTemplate("illustration", URL_A),
        elements: [imageElement(URL_B)],
      })
    ),
    [URL_A]
  )
);

check(
  "empty / data: / blob: srcs are not warmable",
  collectSlideImageUrls(
    makeSlide({
      elements: [
        imageElement(""),
        imageElement("data:image/png;base64,AAAA"),
        imageElement("blob:https://app.example.com/123"),
      ],
    })
  ).length === 0
);

check(
  "duplicate url within one slide deduped (background + element)",
  eq(
    collectSlideImageUrls(
      makeSlide({
        style: {
          background: { type: "image", imageSrc: URL_A },
          theme: {
            id: "editorial-warm",
            name: "Editorial Warm",
            accentColor: "#ea580c",
            fontFamily: "sans",
          },
        },
        elements: [imageElement(URL_A), imageElement(URL_B)],
      })
    ),
    [URL_A, URL_B]
  )
);

/* ─────────────────────────── planLookahead ─────────────────────────────── */

console.log("\nplanLookahead");

const deck: Slide[] = [
  makeSlide({ template: imageTemplate("image_reference", URL_A) }), // 0
  makeSlide({ template: imageTemplate("image_supporting", URL_B) }), // 1
  makeSlide({ elements: [imageElement(URL_C)] }), // 2
  makeSlide(), // 3 (no images)
  makeSlide({ template: imageTemplate("illustration", URL_D) }), // 4
];

check("default ahead=2: N+1 then N+2, in order", eq(planLookahead(deck, 0), [URL_B, URL_C]));

check("ahead=1 warms only N+1", eq(planLookahead(deck, 0, { ahead: 1 }), [URL_B]));

check("ahead=0 warms nothing", planLookahead(deck, 0, { ahead: 0 }).length === 0);

check(
  "imageless slide inside the window contributes nothing",
  eq(planLookahead(deck, 2), [URL_D])
);

check("clamps at deck end (N+2 past the last slide)", eq(planLookahead(deck, 3), [URL_D]));

check("last slide → nothing ahead", planLookahead(deck, 4).length === 0);

check("index past the end → nothing", planLookahead(deck, 99).length === 0);

check("empty deck → nothing", planLookahead([], 0).length === 0);

check(
  "index -1 (before the deck) warms the first `ahead` slides",
  eq(planLookahead(deck, -1), [URL_A, URL_B])
);

check(
  "current slide's urls excluded (already fetching via its own <img>)",
  eq(
    planLookahead(
      [
        makeSlide({ template: imageTemplate("illustration", URL_A) }),
        makeSlide({ template: imageTemplate("illustration", URL_A) }),
        makeSlide({ template: imageTemplate("illustration", URL_B) }),
      ],
      0
    ),
    [URL_B]
  )
);

check(
  "same url on N+1 and N+2 deduped across slides",
  eq(
    planLookahead(
      [
        makeSlide(),
        makeSlide({ template: imageTemplate("illustration", URL_A) }),
        makeSlide({ template: imageTemplate("illustration", URL_A) }),
      ],
      0
    ),
    [URL_A]
  )
);

check(
  "multi-image slides keep per-slide paint order across the window",
  eq(
    planLookahead(
      [
        makeSlide(),
        makeSlide({
          style: {
            background: { type: "image", imageSrc: URL_A },
            theme: {
              id: "editorial-warm",
              name: "Editorial Warm",
              accentColor: "#ea580c",
              fontFamily: "sans",
            },
          },
          elements: [imageElement(URL_B)],
        }),
        makeSlide({ elements: [imageElement(URL_C), imageElement(URL_D)] }),
      ],
      0
    ),
    [URL_A, URL_B, URL_C, URL_D]
  )
);

check(
  "planLookahead never mutates its input",
  (() => {
    const slides = [makeSlide({ elements: [imageElement(URL_A)] }), makeSlide()];
    const before = JSON.stringify(slides);
    planLookahead(slides, 0);
    return JSON.stringify(slides) === before;
  })()
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
