/**
 * verify-accounts-bundle — AC-MA-05 (build half): no provider secret,
 * encryption key, or vendor host reaches any CLIENT bundle. Runs a real
 * `next build` (set SKIP_ACCOUNTS_BUNDLE_BUILD=1 to scan an existing .next)
 * then greps every client chunk under .next/static. Server bundles
 * legitimately contain these strings — only client chunks are scanned.
 * Run: npx tsx scripts/verify-accounts-bundle.ts
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const STATIC_DIR = join(ROOT, ".next", "static");

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs)$/.test(entry)) yield p;
  }
}

function envValue(name: string): string | null {
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    const m = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].replace(/^["']|["']$/g, "").trim() || null : null;
  } catch {
    return null;
  }
}

function main() {
  console.log("verify-accounts-bundle — client-chunk secret scan");
  if (process.env.SKIP_ACCOUNTS_BUNDLE_BUILD !== "1" || !existsSync(STATIC_DIR)) {
    console.log("  building (next build)…");
    try {
      execSync("npx next build", { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      console.error("next build failed:\n", e.stdout?.toString().slice(-3000), e.stderr?.toString().slice(-3000));
      process.exit(1);
    }
  }
  if (!existsSync(STATIC_DIR)) throw new Error(".next/static missing after build");

  const needles: Array<{ label: string; value: string }> = [
    { label: "env name UPLOAD_POST_API_KEY", value: "UPLOAD_POST_API_KEY" },
    { label: "env name SOCIAL_ACCOUNTS_ENC_KEY", value: "SOCIAL_ACCOUNTS_ENC_KEY" },
    { label: "vendor host api.upload-post.com", value: "api.upload-post.com" },
    // AC-MD.7: the dev Inngest banner text is served by the dev-status route
    // (dev branch only) — it must never be baked into a client chunk.
    { label: "the dev Inngest banner text", value: "publishing won't fire" },
  ];
  const apiKey = envValue("UPLOAD_POST_API_KEY");
  if (apiKey) needles.push({ label: "the LIVE provider API key value", value: apiKey });
  const encKey = envValue("SOCIAL_ACCOUNTS_ENC_KEY");
  if (encKey) needles.push({ label: "the LIVE encryption key value", value: encKey });

  const hits = new Map<string, string[]>();
  let scanned = 0;
  for (const file of walk(STATIC_DIR)) {
    scanned++;
    const content = readFileSync(file, "utf8");
    for (const n of needles) {
      if (content.includes(n.value)) {
        const list = hits.get(n.label) ?? [];
        list.push(file.replace(ROOT, ""));
        hits.set(n.label, list);
      }
    }
  }
  console.log(`  scanned ${scanned} client chunks under .next/static`);
  check("scanned a real client build (chunks present)", scanned > 0);
  for (const n of needles) {
    const found = hits.get(n.label);
    check(`client bundles never contain ${n.label}`, !found, (found ?? []).slice(0, 3).join(", "));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
