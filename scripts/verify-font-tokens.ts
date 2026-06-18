/**
 * Font tokenization checks (Task 2) — pure, no key/DB.
 * Run: `npx tsx scripts/verify-font-tokens.ts`
 *
 * Proves the semantic size scale + display serif resolve correctly and that the
 * precedence is token → legacy px → per-type default (one property, shared by
 * renderer + toolbar + AI).
 */

import { resolveElementStyle } from "@/lib/course/slide/styleResolver";
import { DEFAULT_TYPE_SCALE, FONT_FAMILIES, themeTypeScale, findTheme } from "@/lib/course/slide/themes";
import type { SlideElement } from "@/lib/course/types";

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

const THEME = "editorial-warm";

function textEl(style: SlideElement["style"], type: "text" | "heading" = "text"): SlideElement {
  return {
    id: "e",
    type,
    text: "x",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    zIndex: 0,
    style,
    ai: { purpose: "", editable: true, allowedActions: [], semanticTags: [] },
  } as SlideElement;
}

function main() {
  const scale = themeTypeScale(findTheme(THEME));
  check("default type scale has 5 tokens", Object.keys(DEFAULT_TYPE_SCALE).length === 5);

  // ── Token resolves to the theme px.
  const title = resolveElementStyle(textEl({ fontScale: "title" }), THEME);
  check("fontScale 'title' → theme px", title.fontSize === scale.title, `${String(title.fontSize)} vs ${scale.title}`);
  const caption = resolveElementStyle(textEl({ fontScale: "caption" }), THEME);
  check("fontScale 'caption' → theme px", caption.fontSize === scale.caption);

  // ── Token WINS over legacy raw px.
  const both = resolveElementStyle(textEl({ fontScale: "display", fontSize: 12 }), THEME);
  check("token wins over legacy fontSize", both.fontSize === scale.display);

  // ── Legacy px still honored when no token.
  const legacy = resolveElementStyle(textEl({ fontSize: 99 }), THEME);
  check("legacy fontSize honored when no token", legacy.fontSize === 99);

  // ── Per-type default when neither.
  const def = resolveElementStyle(textEl({}, "heading"), THEME);
  check("heading default size with no token/px", def.fontSize === 44);

  // ── Display serif family resolves to Fraunces.
  const disp = resolveElementStyle(textEl({ fontFamily: "display" }), THEME);
  check("display family → Fraunces var", typeof disp.fontFamily === "string" && disp.fontFamily.includes("--font-display"));
  check("FONT_FAMILIES has a display entry", FONT_FAMILIES.display?.label === "Display");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
