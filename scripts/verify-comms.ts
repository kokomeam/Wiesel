/**
 * Learner-comms PURE verification (Milestone 6 + M7) — no DB, no key, no
 * network. Run: `npx tsx scripts/verify-comms.ts`  (npm run verify:comms)
 *
 * Covers: the signed opt-out token (roundtrip, tamper, wrong-purpose), the
 * three templates (deep link + creator sign-off), the renderer (opt-out link +
 * plain-text alternative + escaping), the provider factory's env gating, the
 * mock provider's recording, the Resend From-address pinning, and — M7 — the
 * shared Svix verifier (signature + tamper + replay tolerance), the Resend
 * event mapping (incl. hard/soft bounce classification), Svix-id → uuid
 * determinism, tag parsing/composition, and the comms extension of the
 * analytics event contract (comms events validate; the CLIENT batch schema
 * rejects them; column mapping carries the course-only envelope).
 */

// Deterministic env BEFORE any comms import reads it.
process.env.MARKETING_TOKEN_SECRET = "verify-comms-test-secret";
process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
process.env.COMMS_PROVIDER = "mock";

import { createHmac } from "node:crypto";
import {
  AnalyticsBatchSchema,
  AnalyticsEventSchema,
  buildCommsDeliveryEvent,
  mapEventToColumns,
} from "@/lib/analytics/events";
import { getCommsProvider, isEmailConfigured } from "@/lib/comms/factory";
import { createMockProvider, getMockSends, resetMockSends } from "@/lib/comms/mockProvider";
import { renderEmail } from "@/lib/comms/render";
import {
  composeFrom,
  createResendProvider,
  describeTransportError,
  fromAddress,
} from "@/lib/comms/resendProvider";
import { learnerCommsTags } from "@/lib/comms/service";
import { buildTemplate, type TemplateContext } from "@/lib/comms/templates";
import { createOptOutToken, optOutUrl, verifyOptOutToken } from "@/lib/comms/tokens";
import { CommsError, EmailBodySchema } from "@/lib/comms/types";
import { mapResendEvent, parseResendTags, uuidFromSvixId } from "@/lib/comms/webhook";
import { SVIX_TOLERANCE_SECONDS, verifySvixSignature } from "@/lib/webhooks/svix";

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

  /* ── Resend provider retry/idempotency (the "fetch failed" fix) ── */
  console.log("\n— Resend provider resilience —");
  process.env.RESEND_API_KEY = "re_verify_comms_test";
  const sendInput = {
    to: "learner@example.com",
    subject: "Hi",
    html,
    text,
    fromName: "Prof. Ada",
    unsubscribeUrl: optOutUrl(COURSE, USER),
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
  };
  const okResponse = () =>
    new Response(JSON.stringify({ id: "re_sent_1" }), { status: 200 });
  const transportError = () => {
    const err = new TypeError("fetch failed");
    (err as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
    return err;
  };
  /** Scripted fetch: each entry is a Response to return or an Error to throw.
   *  Records every attempt's headers; sleep records backoff delays. */
  function scriptedProvider(script: Array<Response | Error>) {
    const headers: Array<Record<string, string>> = [];
    const delays: number[] = [];
    let call = 0;
    const provider = createResendProvider({
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        headers.push({ ...(init?.headers as Record<string, string>) });
        const step = script[Math.min(call++, script.length - 1)];
        if (step instanceof Error) throw step;
        return step;
      }) as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    return { provider, headers, delays, calls: () => call };
  }

  check(
    "describeTransportError unwraps the undici cause code",
    describeTransportError(transportError()) === "fetch failed (ECONNRESET)"
  );

  const recovers = scriptedProvider([transportError(), okResponse()]);
  const recovered = await recovers.provider.send(sendInput);
  check(
    "transport error retries with backoff and succeeds",
    recovered.providerMessageId === "re_sent_1" &&
      recovers.calls() === 2 &&
      recovers.delays.length === 1,
    `calls=${recovers.calls()} delays=${JSON.stringify(recovers.delays)}`
  );
  check(
    "Idempotency-Key rides on EVERY attempt",
    recovers.headers.every((h) => h["Idempotency-Key"] === sendInput.idempotencyKey)
  );

  const exhausted = scriptedProvider([transportError()]);
  const exhaustedErr = await exhausted.provider.send(sendInput).then(
    () => null,
    (e: unknown) => e
  );
  check(
    "persistent transport failure throws a DESCRIPTIVE error after 3 attempts",
    exhausted.calls() === 3 &&
      exhaustedErr instanceof CommsError &&
      exhaustedErr.code === "provider_error" &&
      exhaustedErr.message.includes("ECONNRESET") &&
      exhaustedErr.message.includes("3 attempts"),
    exhaustedErr instanceof Error ? exhaustedErr.message : String(exhaustedErr)
  );

  const serverFlake = scriptedProvider([
    new Response("upstream boom", { status: 500 }),
    okResponse(),
  ]);
  const serverRecovered = await serverFlake.provider.send(sendInput);
  check(
    "5xx retries and succeeds",
    serverRecovered.providerMessageId === "re_sent_1" && serverFlake.calls() === 2
  );

  const badRequest = scriptedProvider([
    new Response(JSON.stringify({ message: "domain is not verified" }), { status: 422 }),
  ]);
  const badRequestErr = await badRequest.provider.send(sendInput).then(
    () => null,
    (e: unknown) => e
  );
  check(
    "non-429 4xx is NEVER retried (our request's fault)",
    badRequest.calls() === 1 &&
      badRequestErr instanceof CommsError &&
      badRequestErr.message.includes("422") &&
      badRequestErr.message.includes("domain is not verified")
  );
  delete process.env.RESEND_API_KEY;

  /* ── M7: Svix verifier (shared with the marketing webhook) ── */
  console.log("\n— Svix verifier (M7) —");
  const secretKey = Buffer.from("verify-comms-svix-secret", "utf8").toString("base64");
  const secret = `whsec_${secretKey}`;
  const svixId = "msg_verify_comms_1";
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
  const nowMs = 1_700_000_000_000;
  const ts = String(Math.floor(nowMs / 1000));
  const sign = (id: string, t: string, b: string, sec = secret) =>
    "v1," +
    createHmac("sha256", Buffer.from(sec.replace(/^whsec_/, ""), "base64"))
      .update(`${id}.${t}.${b}`)
      .digest("base64");

  check(
    "valid signature verifies",
    verifySvixSignature({ secret, svixId, svixTimestamp: ts, svixSignature: sign(svixId, ts, body), rawBody: body, nowMs })
  );
  check(
    "extra invalid sigs + one valid (space-separated) verifies",
    verifySvixSignature({
      secret, svixId, svixTimestamp: ts,
      svixSignature: `v1,${Buffer.from("garbagegarbagegarbagegarbagegarbage12345678=").toString("base64")} ${sign(svixId, ts, body)}`,
      rawBody: body, nowMs,
    })
  );
  check(
    "tampered body rejected",
    !verifySvixSignature({ secret, svixId, svixTimestamp: ts, svixSignature: sign(svixId, ts, body), rawBody: body + " ", nowMs })
  );
  check(
    "wrong secret rejected",
    !verifySvixSignature({ secret: "whsec_" + Buffer.from("other").toString("base64"), svixId, svixTimestamp: ts, svixSignature: sign(svixId, ts, body), rawBody: body, nowMs })
  );
  check(
    "missing headers rejected",
    !verifySvixSignature({ secret, svixId: null, svixTimestamp: ts, svixSignature: sign(svixId, ts, body), rawBody: body, nowMs }) &&
      !verifySvixSignature({ secret, svixId, svixTimestamp: null, svixSignature: sign(svixId, ts, body), rawBody: body, nowMs }) &&
      !verifySvixSignature({ secret, svixId, svixTimestamp: ts, svixSignature: null, rawBody: body, nowMs })
  );
  const staleTs = String(Math.floor(nowMs / 1000) - SVIX_TOLERANCE_SECONDS - 60);
  check(
    "stale timestamp rejected (replay protection — the gap the marketing route had)",
    !verifySvixSignature({ secret, svixId, svixTimestamp: staleTs, svixSignature: sign(svixId, staleTs, body), rawBody: body, nowMs })
  );
  const futureTs = String(Math.floor(nowMs / 1000) + SVIX_TOLERANCE_SECONDS + 60);
  check(
    "far-future timestamp rejected",
    !verifySvixSignature({ secret, svixId, svixTimestamp: futureTs, svixSignature: sign(svixId, futureTs, body), rawBody: body, nowMs })
  );
  const nearTs = String(Math.floor(nowMs / 1000) - 200);
  check(
    "timestamp within tolerance accepted",
    verifySvixSignature({ secret, svixId, svixTimestamp: nearTs, svixSignature: sign(svixId, nearTs, body), rawBody: body, nowMs })
  );
  check(
    "non-numeric timestamp rejected",
    !verifySvixSignature({ secret, svixId, svixTimestamp: "not-a-number", svixSignature: sign(svixId, "not-a-number", body), rawBody: body, nowMs })
  );

  /* ── M7: Svix-id → deterministic uuid ── */
  console.log("\n— Svix-id → uuid (M7) —");
  const u1 = uuidFromSvixId("msg_abc");
  check(
    "derived id is a well-formed uuid (v5 bits set)",
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u1)
  );
  check("derivation is deterministic (retry-stable)", uuidFromSvixId("msg_abc") === u1);
  check("distinct svix ids → distinct uuids", uuidFromSvixId("msg_abd") !== u1);

  /* ── M7: tag parsing + composition ── */
  console.log("\n— Resend tags (M7) —");
  check(
    "array-shaped tags parse",
    parseResendTags({ tags: [{ name: "send_source", value: "learner_comms" }, { name: "message_id", value: "m1" }] })
      .send_source === "learner_comms"
  );
  check(
    "object-shaped tags parse",
    parseResendTags({ tags: { send_source: "learner_comms", message_id: "m1" } }).message_id === "m1"
  );
  check("absent tags → empty map", Object.keys(parseResendTags({})).length === 0);
  check(
    "non-string tag values dropped",
    parseResendTags({ tags: { n: 5, ok: "yes" } }).n === undefined &&
      parseResendTags({ tags: { n: 5, ok: "yes" } }).ok === "yes"
  );
  const composed = learnerCommsTags(
    "33333333-3333-4333-8333-333333333333",
    COURSE,
    USER
  );
  check(
    "learnerCommsTags: send_source + message/course/user ids",
    composed.length === 4 &&
      composed.find((t) => t.name === "send_source")?.value === "learner_comms" &&
      composed.find((t) => t.name === "message_id")?.value === "33333333-3333-4333-8333-333333333333" &&
      composed.find((t) => t.name === "course_id")?.value === COURSE &&
      composed.find((t) => t.name === "user_id")?.value === USER
  );
  check(
    "tag names + values stay inside Resend's charset (ASCII letters/digits/_/-)",
    composed.every((t) => /^[A-Za-z0-9_-]+$/.test(t.name) && /^[A-Za-z0-9_-]+$/.test(t.value))
  );

  /* ── M7: Resend event mapping ── */
  console.log("\n— Resend event mapping (M7) —");
  check(
    "email.sent → trail-only note",
    JSON.stringify(mapResendEvent("email.sent", {})) === JSON.stringify({ kind: "trail", note: "sent" })
  );
  check(
    "email.delivery_delayed → trail-only note",
    JSON.stringify(mapResendEvent("email.delivery_delayed", {})) ===
      JSON.stringify({ kind: "trail", note: "delivery_delayed" })
  );
  const delivered = mapResendEvent("email.delivered", {});
  check(
    "email.delivered → comms_email_delivered/'delivered'",
    delivered?.kind === "event" &&
      delivered.eventType === "comms_email_delivered" &&
      delivered.deliveryStatus === "delivered"
  );
  const opened = mapResendEvent("email.opened", {});
  check(
    "email.opened → comms_email_open/'opened'",
    opened?.kind === "event" && opened.eventType === "comms_email_open" && opened.deliveryStatus === "opened"
  );
  const clicked = mapResendEvent("email.clicked", { click: { link: "https://example.test/learn/x" } });
  check(
    "email.clicked → comms_email_click + url",
    clicked?.kind === "event" &&
      clicked.eventType === "comms_email_click" &&
      clicked.url === "https://example.test/learn/x"
  );
  const longUrl = mapResendEvent("email.clicked", { click: { link: "https://e.test/" + "a".repeat(600) } });
  check("click url capped at 500", longUrl?.kind === "event" && (longUrl.url?.length ?? 0) === 500);
  const hardB = mapResendEvent("email.bounced", { bounce: { type: "Permanent", subType: "General" } });
  check(
    "Permanent bounce → hard + subtype",
    hardB?.kind === "event" && hardB.bounceType === "hard" && hardB.bounceSubtype === "General"
  );
  const softB = mapResendEvent("email.bounced", { bounce: { type: "Transient", subType: "MailboxFull" } });
  check("Transient bounce → soft", softB?.kind === "event" && softB.bounceType === "soft");
  const undB = mapResendEvent("email.bounced", { bounce: { type: "Undetermined" } });
  check("Undetermined bounce → soft (never suppress on uncertainty)", undB?.kind === "event" && undB.bounceType === "soft");
  const complained = mapResendEvent("email.complained", {});
  check(
    "email.complained → comms_email_complaint/'complained'",
    complained?.kind === "event" &&
      complained.eventType === "comms_email_complaint" &&
      complained.deliveryStatus === "complained"
  );
  check("unknown event type → null (ignored)", mapResendEvent("email.something_new", {}) === null);

  /* ── M7: the analytics contract extension ── */
  console.log("\n— Comms events in the analytics contract (M7) —");
  const MESSAGE = "44444444-4444-4444-8444-444444444444";
  const commsEvent = buildCommsDeliveryEvent(
    { eventType: "comms_email_bounce", courseId: COURSE, messageId: MESSAGE, bounceType: "hard", bounceSubtype: "General" },
    { clientEventId: uuidFromSvixId("msg_contract_1") }
  );
  check(
    "buildCommsDeliveryEvent validates + stamps",
    AnalyticsEventSchema.safeParse(commsEvent).success && commsEvent.clientTs.length > 0
  );
  check(
    "the CLIENT batch schema REJECTS comms events (delivery telemetry is webhook-only)",
    !AnalyticsBatchSchema.safeParse({ events: [commsEvent] }).success
  );
  const row = mapEventToColumns(commsEvent, USER);
  check(
    "comms row: course-only envelope (null publication/version/lesson)",
    row.publication_id === null && row.version === null && row.lesson_id === null && row.course_id === COURSE
  );
  check(
    "comms row: metadata carries messageId + bounce detail",
    (row.metadata as Record<string, unknown>)?.messageId === MESSAGE &&
      (row.metadata as Record<string, unknown>)?.bounceType === "hard" &&
      (row.metadata as Record<string, unknown>)?.bounceSubtype === "General"
  );
  const clickEvent = buildCommsDeliveryEvent(
    { eventType: "comms_email_click", courseId: COURSE, messageId: MESSAGE, url: "https://example.test/learn/x" },
    { clientEventId: uuidFromSvixId("msg_contract_2") }
  );
  check(
    "click row: metadata carries the url",
    (mapEventToColumns(clickEvent, USER).metadata as Record<string, unknown>)?.url ===
      "https://example.test/learn/x"
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
