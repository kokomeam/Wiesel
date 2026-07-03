/**
 * TEMPORARY interactive smoke for the rich-list keyboard editor (real browser).
 * Prereqs: dev server at $BASE_URL + the temp route app/zz-materialize-preview
 * in edit mode, and `npm i -D playwright`.
 * Run: `npx tsx scripts/verify-list-browser.ts`
 *
 * Drives the materialized outline list: double-click to edit, Enter adds a row,
 * Tab indents, typing "- " sets a dash marker — asserting the DOM reflects each.
 */

import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1 });
  let pass = 0;
  let fail = 0;
  const check = (n: string, c: boolean, d = "") => {
    if (c) { pass++; console.log(`  ✓ ${n}`); }
    else { fail++; console.log(`  ✗ ${n} ${d}`); }
  };

  await page.goto(`${BASE}/zz-materialize-preview?layout=outline_list&mode=elements&edit=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-stage-body]", { timeout: 15000 });
  await page.waitForTimeout(500);

  // Count list rows currently rendered (display <li>).
  const rowCount = () => page.locator("#stage-wrap li").count();
  const editableCount = () => page.locator('#stage-wrap [data-ai-tool="edit-list-item"]').count();

  const before = await rowCount();
  check("list renders rows", before > 0, `${before}`);

  // Double-click the first list row to enter edit mode.
  await page.locator("#stage-wrap li").first().dblclick();
  await page.waitForTimeout(250);
  const editable = await editableCount();
  check("double-click opens per-item contenteditable rows", editable === before, `${editable}/${before}`);

  // Focus the first editable item, go to end, press Enter → a new row.
  const first = page.locator('#stage-wrap [data-ai-tool="edit-list-item"]').first();
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const afterEnter = await editableCount();
  check("Enter on a non-empty item adds a new row", afterEnter === editable + 1, `${afterEnter} vs ${editable}`);

  // Type into the new (empty) row, then Tab to indent it.
  await page.keyboard.type("a new bullet");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
  const indented = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("#stage-wrap li"));
    // the indented row has a non-zero marginLeft
    return rows.some((r) => parseFloat((r as HTMLElement).style.marginLeft || "0") > 0);
  });
  check("Tab indents the current item (non-zero indent)", indented);

  // Verify the typed text persisted into a row.
  const hasText = await page.locator("#stage-wrap").innerText();
  check("typed bullet text is present", hasText.includes("a new bullet"));

  // ── Toggle a list INSIDE a plain TEXT box with ⌘⇧8.
  await page.goto(`${BASE}/zz-materialize-preview?layout=prose&mode=elements&edit=1&el=text`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-stage-body]", { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.locator("#stage-wrap [data-ai-selected]").first().dblclick();
  await page.waitForSelector("#stage-wrap [contenteditable]", { timeout: 8000 });
  await page.locator("#stage-wrap [contenteditable]").first().click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+Shift+Digit8`);
  await page.waitForTimeout(350);
  const gotBullet = (await page.locator("#stage-wrap").innerText()).includes("•");
  check("⌘⇧8 toggles a plain text box into a bulleted list", gotBullet);

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
