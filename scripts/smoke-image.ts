/**
 * Live smoke for ITEM 0/3: confirm the pinned gpt-image-2 snapshot actually generates
 * (a wrong id silently degrades every image to prose). Generates ONE supporting +
 * ONE reference image through the real proxied client + the per-weight params, and
 * reports the openai_image outcome + latency. Needs OPENAI_API_KEY (+ a proxy on a
 * proxy-only box). Run: `HTTPS_PROXY=http://127.0.0.1:7890 npx tsx scripts/smoke-image.ts`
 */

import { readFileSync } from "node:fs";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { buildImagePrompt } from "@/lib/ai/visuals/imageIntent";
import { VISUAL_WEIGHT } from "@/lib/ai/visuals/config";

// Load .env.local (tsx doesn't auto-load it for a bare script).
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* ignore */ }

async function main() {
  if (!isOpenAIConfigured()) {
    console.log("OPENAI_API_KEY not set — skipping live image smoke.");
    return;
  }
  const model = createOpenAIModelClient();
  console.log(`image model = ${process.env.OPENAI_IMAGE_MODEL ?? "(default)"}`);

  const cases = [
    { weight: "supporting" as const, prompt: buildImagePrompt({ visualWeight: "supporting", prompt: "a single tree representing hierarchy", subject: "a tree" }) },
    { weight: "reference" as const, prompt: buildImagePrompt({ visualWeight: "reference", prompt: "a labeled binary tree", subject: "a binary tree", requiredLabels: ["root", "leaf"] }) },
  ];
  for (const c of cases) {
    const cfg = VISUAL_WEIGHT[c.weight];
    const t = Date.now();
    const img = await model.generateImage!({ prompt: c.prompt, size: cfg.size, background: cfg.background, quality: cfg.quality });
    console.log(`${c.weight}: ${img ? `OK (${img.width}x${img.height}, ${img.base64.length} b64 chars)` : "NULL (failed/degrade)"} in ${Date.now() - t}ms`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
