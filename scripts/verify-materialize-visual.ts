/**
 * TEMPORARY before/after visual pass for materialize-on-eject.
 * Prereqs: a dev server at $BASE_URL (default http://localhost:3000) + the temp
 * route app/zz-materialize-preview, and `npm i -D playwright`.
 * Run: `npx tsx scripts/verify-materialize-visual.ts`
 *
 * For each supported layout it screenshots the structured slide (before) and the
 * ejected element-backed slide (after), saves both PNGs for manual inspection,
 * and asserts no materialized element overflows the 1280×720 frame.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "scripts/.materialize-visual";
const LAYOUTS = ["concept_example", "comparison_columns", "outline_list", "prose", "image_supporting"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 });
  let pass = 0;
  let fail = 0;

  for (const layout of LAYOUTS) {
    for (const mode of ["structured", "elements"] as const) {
      await page.goto(`${BASE}/zz-materialize-preview?layout=${layout}&mode=${mode}`, { waitUntil: "networkidle" });
      await page.waitForSelector("[data-stage-body]", { timeout: 15000 });
      await page.waitForTimeout(450); // fonts + first measure settle
      const wrap = page.locator("#stage-wrap");
      const file = `${OUT}/${layout}-${mode === "structured" ? "before" : "after"}.png`;
      await wrap.screenshot({ path: file });
      console.log(`  · saved ${file}`);

      if (mode === "elements") {
        // No materialized element may exceed the 1280×720 frame.
        const overflow = await page.evaluate(() => {
          const wrapEl = document.getElementById("stage-wrap")!.getBoundingClientRect();
          const els = Array.from(document.querySelectorAll('[data-ai-component="slide-element"]'));
          const bad: string[] = [];
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.left < wrapEl.left - 2 || r.top < wrapEl.top - 2 || r.right > wrapEl.right + 2 || r.bottom > wrapEl.bottom + 2) {
              bad.push(el.getAttribute("data-ai-label") ?? "element");
            }
          }
          return { count: els.length, bad };
        });
        const ok = overflow.bad.length === 0 && overflow.count > 0;
        if (ok) {
          pass++;
          console.log(`  ✓ ${layout}: ${overflow.count} elements, none overflow the frame`);
        } else {
          fail++;
          console.log(`  ✗ ${layout}: ${overflow.bad.length} overflow / ${overflow.count} total — ${overflow.bad.slice(0, 3).join(", ")}`);
        }
      }
    }
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed · screenshots in ${OUT}/\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
