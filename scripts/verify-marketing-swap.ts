/**
 * Phase 5 test: the mock→real email provider swap. Structural (no real Resend
 * key, no network) — proves the env-gated factory selects the right provider and
 * that BOTH implement the identical EmailProvider contract (zero contract change
 * between modes). Run: `npx tsx scripts/verify-marketing-swap.ts`
 */

import { createEmailProvider, isEmailConfigured } from "@/lib/marketing/services/factory";
import type { EmailProvider } from "@/lib/marketing/services/types";

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

function contractOk(p: EmailProvider): boolean {
  return (
    (p.mode === "mock" || p.mode === "resend") &&
    typeof p.isConfigured === "function" &&
    typeof p.send === "function"
  );
}

function main() {
  const original = process.env.RESEND_API_KEY;

  // ── no key → mock ─────────────────────────────────────────────────────
  delete process.env.RESEND_API_KEY;
  check("no key → isEmailConfigured() false", isEmailConfigured() === false);
  const mock = createEmailProvider();
  check("no key → mock provider selected", mock.mode === "mock");
  check("mock implements the EmailProvider contract", contractOk(mock));

  // ── key set → resend ──────────────────────────────────────────────────
  process.env.RESEND_API_KEY = "re_dummy_key_for_selection_test";
  check("key set → isEmailConfigured() true", isEmailConfigured() === true);
  const real = createEmailProvider();
  check("key set → resend provider selected", real.mode === "resend");
  check("resend implements the SAME EmailProvider contract", contractOk(real));
  // Consumers only ever touch the EmailProvider contract members — both
  // providers expose all of them, so the swap changes nothing downstream. (The
  // mock additionally carries test-only helpers like getSends/reset.)
  const contractKeys = ["mode", "isConfigured", "send"] as const;
  check(
    "both expose the full EmailProvider contract (zero contract change)",
    contractKeys.every((k) => k in mock && k in real)
  );

  // restore
  if (original === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = original;

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
