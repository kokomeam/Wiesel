/**
 * Learner-comms PURE verification (Milestone 6) — no DB, no key, no network.
 * Run: `npx tsx scripts/verify-comms.ts`  (npm run verify:comms)
 *
 * Covers: the signed opt-out token (roundtrip, tamper, wrong-purpose), the
 * three templates (deep link + creator sign-off), the renderer (opt-out link +
 * plain-text alternative + escaping), the provider factory's env gating, the
 * mock provider's recording, and the Resend From-address pinning.
 */

// Deterministic env BEFORE any comms import reads it.
process.env.MARKETING_TOKEN_SECRET = "verify-comms-test-secret";
process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
process.env.COMMS_PROVIDER = "mock";

import { getCommsProvider, isEmailConfigured } from "@/lib/comms/factory";
import { createMockProvider, getMockSends, resetMockSends } from "@/lib/comms/mockProvider";
import { renderEmail } from "@/lib/comms/render";
import { composeFrom, fromAddress } from "@/lib/comms/resendProvider";
import { buildTemplate, type TemplateContext } from "@/lib/comms/templates";
import { createOptOutToken, optOutUrl, verifyOptOutToken } from "@/lib/comms/tokens";
import { EmailBodySchema } from "@/lib/comms/types";

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

const COURSE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function main() {
  /* ── Tokens ── */
  console.log("\n— Opt-out tokens —");
  const token = createOptOutToken(COURSE, USER);
  const verified = verifyOptOutToken(token);
  check(
    "token roundtrips",
    verified?.courseId === COURSE && verified?.userId === USER
  );
  check("tampered payload rejected", verifyOptOutToken(`x${token}`) === null);
  const [payload, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
  check(
    "tampered signature rejected",
    verifyOptOutToken(`${payload}.${sig.slice(0, -2)}zz`) === null
  );
  check("garbage rejected", verifyOptOutToken("not-a-token") === null);
  // A marketing-style token (different purpose) must never verify here.
  const foreign = Buffer.from(
    JSON.stringify({ p: "wisesel.marketing.v1", courseId: COURSE, userId: USER }),
    "utf8"
  ).toString("base64url");
  check(
    "wrong-purpose token rejected",
    verifyOptOutToken(`${foreign}.${sig}`) === null
  );
  check(
    "optOutUrl targets the comms route",
    optOutUrl(COURSE, USER).startsWith("https://example.test/api/comms/opt-out?token=")
  );

  /* ── Templates ── */
  console.log("\n— Templates —");
  const ctx: TemplateContext = {
    learnerName: "Jordan",
    creatorName: "Prof. Ada",
    courseTitle: "Intro Micro",
    courseUrl: "https://example.test/learn/intro-micro",
    lessonTitle: "Supply and demand",
    lessonUrl: "https://example.test/learn/intro-micro/lesson-1",
  };
  for (const id of ["stalled_nudge", "almost_done", "struggling_topic"] as const) {
    const draft = buildTemplate(id, ctx);
    const parsed = EmailBodySchema.safeParse(draft.body);
    const text = JSON.stringify(draft.body);
    check(`${id}: body validates`, parsed.success);
    check(`${id}: signs off as the creator`, text.includes("Prof. Ada"));
    check(`${id}: has a subject`, draft.subject.length > 0);
    check(
      `${id}: carries a deep link`,
      draft.body.some((b) => b.kind === "button" && b.href.startsWith("https://example.test/learn/"))
    );
  }
  const struggling = buildTemplate("struggling_topic", ctx);
  check(
    "struggling_topic deep-links the exact lesson",
    struggling.body.some((b) => b.kind === "button" && b.href.endsWith("/lesson-1"))
  );

  /* ── Renderer ── */
  console.log("\n— Renderer —");
  const { html, text } = renderEmail(struggling.body, {
    fromName: "Prof. Ada",
    courseTitle: "Intro Micro",
    unsubscribeUrl: optOutUrl(COURSE, USER),
  });
  check("html carries the opt-out link", html.includes("/api/comms/opt-out?token="));
  check("text alternative carries the opt-out link", text.includes("/api/comms/opt-out?token="));
  check("footer says who + why", html.includes("Prof. Ada") && html.includes("Intro Micro"));
  const hostile = renderEmail(
    [{ kind: "paragraph", text: `<script>alert("x")</script>` }],
    { fromName: "A", courseTitle: "B", unsubscribeUrl: "https://example.test/u" }
  );
  check("html escapes user content", !hostile.html.includes("<script>"));

  /* ── Providers ── */
  console.log("\n— Providers —");
  check("COMMS_PROVIDER=mock forces the mock", !isEmailConfigured() && getCommsProvider().mode === "mock");
  resetMockSends();
  const mock = createMockProvider();
  const result = await mock.send({
    to: "learner@example.com",
    subject: "Hi",
    html,
    text,
    fromName: "Prof. Ada",
    unsubscribeUrl: optOutUrl(COURSE, USER),
  });
  check("mock records the send", getMockSends().length === 1 && result.simulated);
  check(
    "recorded send keeps the unsubscribe url",
    getMockSends()[0].unsubscribeUrl.includes("/api/comms/opt-out")
  );
  check(
    "Resend From address is PINNED to the verified sender",
    fromAddress("WiseSel <onboarding@resend.dev>") === "onboarding@resend.dev" &&
      composeFrom('Evil "Name" <spoof@bad.com>', "WiseSel <onboarding@resend.dev>").endsWith(
        "<onboarding@resend.dev>"
      )
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
