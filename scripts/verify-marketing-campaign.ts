/**
 * Autonomous Email Campaign layer — full verification against LIVE Supabase.
 *
 * Covers the amendment set end-to-end: blueprints (A1) · quality rubric (A2) ·
 * campaign brief + merge vars + voice profile (A3) · segments/profile/score
 * (A4) · click attribution + signed tokens (A5) · double opt-in + lapse (A7) ·
 * hard/soft bounce taxonomy (A8) · sender identity w/ mailing address (A9) ·
 * guardrail small-sample protection + send ramp (A10) · MPP-honest analytics
 * (A11) · send windows (A12) · agent resume message (A13) · localization (A14)
 * · the campaign lifecycle state machine + compliance gate + launch checklist.
 *
 * Author-scoped (no service key needed); mock provider + fixed clock drive the
 * engine. Run: `npx tsx scripts/verify-marketing-campaign.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { BLUEPRINTS, CAMPAIGN_GOALS, clampLength, getBlueprint, stagesForLength } from "@/lib/marketing/blueprints";
import { scoreEmailStep } from "@/lib/marketing/quality";
import { findMissingFallbacks, renderMergeVars } from "@/lib/marketing/mergeVars";
import { clickUrl, consentConfirmUrl, signToken, unsubscribeUrl, verifyToken } from "@/lib/marketing/tokens";
import { detectCourseLanguage, footerStrings, resolveCopyLocale } from "@/lib/marketing/language";
import { renderEmailText } from "@/lib/marketing/email/render";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockEmailProvider, fixedClock } from "@/lib/marketing/services/mock";
import { composeFromHeader } from "@/lib/marketing/services/resend";
import { acceptMarketingAction, approveMarketingAction, executeMarketingTool, rejectMarketingAction } from "@/lib/marketing/tools";
import { CONSENT_CONFIRMATION_TEXT } from "@/lib/marketing/tools/leads";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { evaluateLaunchChecklist } from "@/lib/marketing/campaignLifecycle";
import { evaluateCampaignGuardrails, getAuthorSendRamp, GUARDRAILS } from "@/lib/marketing/guardrails";
import { lastClickAttribution, recordAttributedClick, recordEnrollmentEvent } from "@/lib/marketing/attribution";
import { sweepLapsedConsent } from "@/lib/marketing/consent";
import { engagementScore, getLeadSegment, loadLeadProfile } from "@/lib/marketing/segments";
import { loadAction } from "@/lib/marketing/gate";
import { loadCampaign, loadEmailSequence, loadVoiceProfile } from "@/lib/marketing/persistence";
import { describeSendWindow, runSchedulerTick, sendTimingSentence, sendWindowState } from "@/lib/marketing/scheduler";
import { getAnalyticsSummary, OPEN_RATE_CAVEAT } from "@/lib/marketing/analytics";
import { resumeMessage } from "@/lib/marketing/agent/resume";
import { DEFAULT_SEND_WINDOW } from "@/lib/marketing/types";
import type { MarketingActionRow } from "@/lib/marketing/types";

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

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

async function main() {
  /* ════════════════════ pure checks (no DB) ════════════════════ */

  console.log("# A1 · sequence blueprints");
  check("all 6 goals have blueprints", CAMPAIGN_GOALS.length === 6 && CAMPAIGN_GOALS.every((g) => !!getBlueprint(g)));
  const launch = BLUEPRINTS.launch_course;
  check("launch: default 5, min 4, max 7", launch.defaultLength === 5 && launch.minLength === 4 && launch.maxLength === 7);
  check("launch allows the deadline double-send; welcome doesn't", launch.allowDeadlineDoubleSend && !BLUEPRINTS.welcome_interest_list.allowDeadlineDoubleSend);
  check("clampLength clamps into [min,max]", clampLength(launch, 1) === 4 && clampLength(launch, 99) === 7 && clampLength(launch, null) === 5);
  const four = stagesForLength(launch, 4);
  check("shrinking keeps the earliest funnel stages", four.length === 4 && four[0].key === "welcome_problem" && four[3].key === "offer_cta");

  console.log("\n# A2 · copy quality rubric");
  const goodBody = {
    blocks: [
      { kind: "paragraph" as const, text: "Most people learning watercolor stall at the same place: mixing mud instead of color. It costs weeks of frustration and most give up before their first real painting ever happens for them." },
      { kind: "paragraph" as const, text: "This course fixes that in the first module. You will mix a basic palette on day one, then paint a simple landscape with it — the exact two skills that unlock everything after them and make daily practice feel easy." },
      { kind: "paragraph" as const, text: "Every lesson is short and hands-on, so you paint more than you watch. By the end of the week the fear is gone and the habit is real, which is the whole point of starting now rather than later." },
      { kind: "button" as const, label: "Get the free first lesson", href: "/p/watercolor" },
    ],
  };
  const good = scoreEmailStep({
    subject: "Mix a real palette in your first lesson",
    previewText: "The two skills that unlock everything else in watercolor.",
    body: goodBody,
    framework: "PAS",
    isOfferStage: false,
    course: { modules: [{ title: "Color mixing", lessonCount: 3 }], outcomes: ["Mix a basic palette", "Paint a simple landscape"] },
  });
  check("well-formed email scores high (≥ 80)", good.score >= 80, String(good.score));
  check("concrete course detail is credited", good.passedCriteria.some((c) => c.includes("concrete course detail")));
  const bad = scoreEmailStep({
    subject: "ACT NOW!!! 🔥 AMAZING DEAL",
    previewText: null,
    body: { blocks: [{ kind: "paragraph", text: "Buy now! Click here! Risk free guarantee!" }, { kind: "button", label: "Click here", href: "#" }, { kind: "button", label: "Click here 2", href: "#" }] },
    framework: "offer_transformation_deadline",
    isOfferStage: true,
    course: { modules: [], outcomes: [] },
  });
  check("spammy email fails hard (< 40)", bad.score < 40, String(bad.score));
  check("specific criteria named: emoji, caps, spam words, CTA count", ["Subject: no emoji", "Subject: not ALL CAPS", "No spam-trigger vocabulary", "Exactly one primary CTA"].every((c) => bad.failedCriteria.includes(c)));

  console.log("\n# A3b · merge variables");
  check("firstName falls back to 'there'", renderMergeVars("Hi {{firstName}}!", {}) === "Hi there!");
  check("real value wins over fallback", renderMergeVars("Hi {{firstName}}!", { firstName: "Maria" }) === "Hi Maria!");
  check("inline fallback used when no value", renderMergeVars("Join {{courseName|\"the course\"}}", {}) === "Join the course");
  const missing = findMissingFallbacks(["Get it: {{freeLessonUrl}}"], [{ firstName: "A" }]);
  check("no-fallback var with missing data is BLOCKING", missing.length === 1 && missing[0].varName === "freeLessonUrl" && missing[0].blocking);
  const covered = findMissingFallbacks(["Get it: {{freeLessonUrl}}"], [{ freeLessonUrl: "https://x/y" }]);
  check("same var with data for every lead is not blocking", covered.length === 1 && !covered[0].blocking);

  console.log("\n# A5 · signed tokens");
  const tok = signToken({ purpose: "click", subscriberId: "sub-1", campaignId: "c-1", touchId: "t-1" });
  const decoded = verifyToken(tok);
  check("sign → verify roundtrip", decoded?.purpose === "click" && decoded.subscriberId === "sub-1" && decoded.campaignId === "c-1");
  check("tampered token rejected", verifyToken(tok.slice(0, -4) + "AAAA") === null);
  check("expired token rejected", verifyToken(signToken({ purpose: "click", subscriberId: "s", exp: Date.now() - 1000 })) === null);
  check("garbage rejected without throwing", verifyToken("not-a-token") === null && verifyToken(null) === null);
  check("unsubscribe URL is signed (?t=)", unsubscribeUrl("sub-1").includes("/api/marketing/unsubscribe?t="));
  const cUrl = clickUrl("https://dest.example/x", { subscriberId: "s", campaignId: "c", touchId: "t", courseId: "co" });
  check("click URL carries token + destination + course scope", cUrl.includes("/api/marketing/click?t=") && cUrl.includes("u=https%3A%2F%2Fdest.example%2Fx") && cUrl.includes("&c=co"));
  check("consent-confirm URL is signed", consentConfirmUrl("sub-1").includes("/api/marketing/consent-confirm?t="));

  console.log("\n# resend From composition (pure) — verified domain is never impersonated");
  check("bare env address gets the identity's display name", composeFromHeader("Ana Painter", "hi@wisesel.pro") === "Ana Painter <hi@wisesel.pro>");
  check("env display name is REPLACED, address kept", composeFromHeader("Ana Painter", "WiseSel <hi@wisesel.pro>") === "Ana Painter <hi@wisesel.pro>");
  check("no identity name → env From used as-is", composeFromHeader(null, "WiseSel <hi@wisesel.pro>") === "WiseSel <hi@wisesel.pro>");
  check("header-breaking characters are stripped from the name", composeFromHeader('Eve <evil@x.com>"', "hi@wisesel.pro") === "Eve evil@x.com <hi@wisesel.pro>");

  console.log("\n# A13 · agent resume messages (pure)");
  const fakeAction = { toolName: "launch_campaign", summary: "Launch 'X' — 3 subscribers." } as MarketingActionRow;
  check("approved message confirms execution", resumeMessage(fakeAction, "approved").includes("Approved & executed: launch_campaign"));
  check("approved message demands the end-of-run wrap-up with timing", resumeMessage(fakeAction, "approved").includes("wrap-up") && resumeMessage(fakeAction, "approved").includes("send window"));
  check("denied message carries the reason + no-retry instruction", resumeMessage(fakeAction, "denied", "wrong list").includes("Reason: wrong list") && resumeMessage(fakeAction, "denied").includes("Do not retry"));

  console.log("\n# A12 · send-window state + delivery-timing sentence (pure)");
  // Fixed times, all UTC: 2026-06-18 is a Thursday.
  const thu0930 = Date.parse("2026-06-18T09:30:00.000Z");
  const thu0000 = Date.parse("2026-06-18T00:00:00.000Z");
  const fri1541 = Date.parse("2026-06-19T15:41:00.000Z");
  const sat1000 = Date.parse("2026-06-20T10:00:00.000Z");
  check("inside the default window → openNow", sendWindowState(thu0930, DEFAULT_SEND_WINDOW).openNow);
  const beforeOpen = sendWindowState(thu0000, DEFAULT_SEND_WINDOW);
  check(
    "Thu 00:00 → next opening Thu 09:00 UTC",
    !beforeOpen.openNow && beforeOpen.nextOpenMs === Date.parse("2026-06-18T09:00:00.000Z"),
    String(beforeOpen.nextOpenMs && new Date(beforeOpen.nextOpenMs).toISOString())
  );
  const friLate = sendWindowState(fri1541, DEFAULT_SEND_WINDOW);
  check(
    "Fri 15:41 skips the weekend → Mon 09:00 UTC",
    friLate.nextOpenMs === Date.parse("2026-06-22T09:00:00.000Z"),
    String(friLate.nextOpenMs && new Date(friLate.nextOpenMs).toISOString())
  );
  check("skipWeekends=false opens on Saturday", sendWindowState(sat1000, { ...DEFAULT_SEND_WINDOW, skipWeekends: false }).openNow);
  check("degenerate window (start=end) never opens", sendWindowState(thu0000, { ...DEFAULT_SEND_WINDOW, startHour: 9, endHour: 9 }).nextOpenMs === null);
  check("describeSendWindow names hours, tz, weekdays", describeSendWindow(DEFAULT_SEND_WINDOW) === "09:00–11:00 UTC, weekdays");
  check("timing sentence (closed) says HELD + next opening", sendTimingSentence(thu0000, DEFAULT_SEND_WINDOW).includes("HELD until the send window opens") && sendTimingSentence(thu0000, DEFAULT_SEND_WINDOW).includes("Thu, Jun 18, 09:00 (UTC)"));
  check("timing sentence (open) says the window is open now", sendTimingSentence(thu0930, DEFAULT_SEND_WINDOW).includes("open now"));

  console.log("\n# A14 · language + localized footers");
  check("CJK course detects zh", detectCourseLanguage({ title: "期权交易入门", description: null, outcomes: [] }) === "zh");
  check("kana beats CJK for ja", detectCourseLanguage({ title: "オプション取引", description: null, outcomes: [] }) === "ja");
  check("latin defaults to en; brief override wins", detectCourseLanguage({ title: "Options", description: null, outcomes: [] }) === "en" && resolveCopyLocale({ title: "Options", description: null, outcomes: [] }, { language: "es" }) === "es");
  check("unknown locale falls back to English strings", footerStrings("xx").unsubscribe === "Unsubscribe" && footerStrings("zh").unsubscribe === "退订");
  const zhText = renderEmailText({ blocks: [{ kind: "paragraph", text: "你好" }] }, { unsubscribeUrl: "https://u/1", locale: "zh", senderName: "王老师", mailingAddress: "北京市 100000" });
  check("footer is localized + carries sender + mailing address (A9)", zhText.includes("退订") && zhText.includes("王老师") && zhText.includes("北京市 100000"));

  /* ════════════════════ live-DB flow ════════════════════ */

  const { url, anon } = loadEnv();
  const email = `mkt-cmp-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: signin, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !signin.user) throw new Error(`signin: ${error?.message}`);
  const userId = signin.user.id;
  console.log("\n# provisioned author");

  const courseId = crypto.randomUUID();
  await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: "Watercolor for Beginners",
    description: "Loosen up and paint with confidence.",
    plan: { outcomes: ["Mix a basic palette", "Paint a simple landscape"], prerequisites: [], teachingStyle: "encouraging" } as never,
  });

  const clock = fixedClock("2026-06-18T00:00:00.000Z"); // a Thursday
  const provider = createMockEmailProvider();
  const services = createMarketingServices({ email: provider, clock });
  const baseCtx = (campaignId: string | null): MarketingToolContext => ({
    supabase,
    courseId,
    campaignId,
    ownerId: userId,
    services,
    requestedBy: "user",
  });

  // ── campaign + brief + fake-scarcity guard ─────────────────────────────
  console.log("\n# campaign lifecycle — create → brief → blueprint guard");
  const created = await executeMarketingTool("create_campaign", { name: "Launch — Watercolor", goal: "launch_course" }, baseCtx(null));
  await acceptMarketingAction(supabase, created.actionId!);
  const campaignId = (created.data as { campaignId: string }).campaignId;
  const ctx = baseCtx(campaignId);
  check("campaign starts draft", (await loadCampaign(supabase, campaignId))?.status === "draft");

  let scarcityBlocked = false;
  try {
    await executeMarketingTool("generate_email_sequence", { goal: "promote_discount", length: null }, ctx);
  } catch (e) {
    scarcityBlocked = e instanceof Error && e.message.includes("real offer deadline");
  }
  check("promote_discount without a real deadline is refused (fake-scarcity rule)", scarcityBlocked);

  const briefOut = await executeMarketingTool(
    "update_campaign_brief",
    { campaignId, audienceNotes: "Busy parents", proofPoints: "Taught 500 students", offerDetails: null, thingsToAvoid: "never promise gallery sales", freeform: null, language: null, offerDeadlineIso: "2026-06-30T00:00:00.000Z" },
    ctx
  );
  await acceptMarketingAction(supabase, briefOut.actionId!);
  check("brief persisted on config", (await loadCampaign(supabase, campaignId))?.config.brief?.proofPoints === "Taught 500 students");

  // ── analyst cites course vs brief ──────────────────────────────────────
  const analysis = await executeMarketingTool("analyze_course_for_marketing", { campaignId }, ctx);
  const findings = analysis.data as { credibility: { source: string }; outcomes: { source: string } };
  check("analyst cites brief vs course provenance (A3a)", findings.credibility.source === "brief" && findings.outcomes.source === "course");

  // ── lead list + consent-gated import + double opt-in (A7) ──────────────
  console.log("\n# leads — consent gate, double opt-in, lapse");
  const listOut = await executeMarketingTool("create_lead_list", { name: "Import test", sourceType: "manual_import" }, ctx);
  await acceptMarketingAction(supabase, listOut.actionId!);
  const listId = (listOut.data as { listId: string }).listId;

  let badConsentRejected = false;
  try {
    await executeMarketingTool("import_leads", { listId, contacts: [{ email: "x@example.com", name: null }], consentConfirmationText: "sure whatever" }, ctx);
  } catch {
    badConsentRejected = true;
  }
  check("import without the exact consent text is refused", badConsentRejected);

  const salt = crypto.randomUUID().slice(0, 6);
  const leadEmails = {
    normal: `lead-ok-${salt}@example.com`,
    hard: `lead-hard-bounce-${salt}@example.com`,
    soft: `lead-soft-bounce-${salt}@example.com`,
    lapse: `lead-lapse-${salt}@example.com`,
  };
  const imp = await executeMarketingTool(
    "import_leads",
    {
      listId,
      contacts: [
        { email: leadEmails.normal, name: "Maria Lopez" },
        { email: leadEmails.hard, name: null },
        { email: leadEmails.soft, name: null },
        { email: leadEmails.lapse, name: null },
        { email: "not-an-email", name: null },
      ],
      consentConfirmationText: CONSENT_CONFIRMATION_TEXT,
    },
    ctx
  );
  await acceptMarketingAction(supabase, imp.actionId!);
  check("4 imported, 1 rejected (invalid email)", (imp.data as { imported: number; rejected: number }).imported === 4 && (imp.data as { rejected: number }).rejected === 1);
  const { data: pendingSubs } = await supabase.from("subscriber").select("id,email,consent_status").eq("campaign_id", campaignId);
  check("imports land consent=pending (can't be emailed)", (pendingSubs ?? []).every((s) => s.consent_status === "pending"));

  const normalSub = pendingSubs!.find((s) => s.email === leadEmails.normal)!;
  const confirmReq = await executeMarketingTool("send_consent_confirmation", { subscriberId: normalSub.id }, ctx);
  check("consent confirmation is gated (pending approval — it reaches an inbox)", confirmReq.status === "pending_approval");
  await approveMarketingAction(confirmReq.actionId!, { supabase, ownerId: userId, services });
  const { data: requested } = await supabase.from("subscriber").select("consent_requested_at").eq("id", normalSub.id).single();
  check("confirmation send stamps consent_requested_at", !!requested?.consent_requested_at);
  let rateLimited = false;
  try {
    await executeMarketingTool("send_consent_confirmation", { subscriberId: normalSub.id }, ctx);
  } catch (e) {
    rateLimited = e instanceof Error && e.message.includes("rate-limited");
  }
  check("second confirmation request is rate-limited", rateLimited);

  // Simulate the confirm-link click for 3 of 4 (what the route does); the 4th
  // stays pending for the lapse test.
  for (const e2 of [leadEmails.normal, leadEmails.hard, leadEmails.soft]) {
    const sub = pendingSubs!.find((s) => s.email === e2)!;
    await supabase.from("subscriber").update({ consent_status: "confirmed" }).eq("id", sub.id);
    await supabase.from("analytics_event").insert({ course_id: courseId, campaign_id: campaignId, subscriber_id: sub.id, type: "consent_confirmed", source: "double_opt_in" });
  }
  await supabase.from("lead_list").update({ consent_confirmed: true }).eq("id", listId);

  // Lapse is measured against REAL row timestamps (created_at = DB now()), so
  // the sweep cutoff must be real-time-based, not fixed-clock-based.
  const lapse = await sweepLapsedConsent(supabase, { nowMs: Date.now() + 31 * DAY });
  check("pending consent lapses after 30 days (row retained)", lapse.lapsed >= 1);
  const { data: lapsedRow } = await supabase.from("subscriber").select("consent_status").eq("campaign_id", campaignId).eq("email", leadEmails.lapse).single();
  check("lapsed contact is marked lapsed, never marketable", lapsedRow?.consent_status === "lapsed");

  // ── campaign-less import (course-level contacts) + bulk consent ────────
  console.log("\n# leads — campaign-less import + bulk consent confirmations");
  const soloListOut = await executeMarketingTool("create_lead_list", { name: "Standalone list", sourceType: "manual_import" }, baseCtx(null));
  await acceptMarketingAction(supabase, soloListOut.actionId!);
  const soloListId = (soloListOut.data as { listId: string }).listId;
  const soloSalt = crypto.randomUUID().slice(0, 6);
  const soloEmails = [`solo-a-${soloSalt}@example.com`, `solo-b-${soloSalt}@example.com`];
  const soloImp = await executeMarketingTool(
    "import_leads",
    { listId: soloListId, contacts: soloEmails.map((e2) => ({ email: e2, name: null })), consentConfirmationText: CONSENT_CONFIRMATION_TEXT },
    baseCtx(null)
  );
  await acceptMarketingAction(supabase, soloImp.actionId!);
  check("import into a campaign-less list succeeds (course-level contacts)", (soloImp.data as { imported: number }).imported === 2);
  const { data: soloSubs } = await supabase.from("subscriber").select("id,campaign_id,consent_status").in("email", soloEmails).eq("course_id", courseId);
  check(
    "campaign-less imports land with null campaign_id + pending consent",
    (soloSubs ?? []).length === 2 && soloSubs!.every((s) => s.campaign_id === null && s.consent_status === "pending")
  );

  const soloReImp = await executeMarketingTool(
    "import_leads",
    { listId: soloListId, contacts: soloEmails.map((e2) => ({ email: e2, name: null })), consentConfirmationText: CONSENT_CONFIRMATION_TEXT },
    baseCtx(null)
  );
  await acceptMarketingAction(supabase, soloReImp.actionId!);
  const { count: soloCount } = await supabase.from("subscriber").select("id", { count: "exact", head: true }).in("email", soloEmails).eq("course_id", courseId);
  check("re-import dedupes course-wide (still 2 subscriber rows)", soloCount === 2);

  const bulkReq = await executeMarketingTool("send_consent_confirmations", { listId: soloListId }, baseCtx(null));
  check("bulk consent request is gated (pending approval — one approval per batch)", bulkReq.status === "pending_approval");
  await approveMarketingAction(bulkReq.actionId!, { supabase, ownerId: userId, services });
  const { data: askedSubs } = await supabase.from("subscriber").select("consent_requested_at").in("email", soloEmails).eq("course_id", courseId);
  check("bulk send stamps consent_requested_at on every pending member", (askedSubs ?? []).length === 2 && askedSubs!.every((s) => !!s.consent_requested_at));
  let bulkEmpty = false;
  try {
    await executeMarketingTool("send_consent_confirmations", { listId: soloListId }, baseCtx(null));
  } catch (e) {
    bulkEmpty = e instanceof Error && e.message.includes("No contacts");
  }
  check("bulk request with nobody left to ask is refused", bulkEmpty);

  // ── sender identity (A9) + schedule + landing (for resolvable CTAs) ────
  console.log("\n# sender identity + schedule + landing page");
  const sender = await executeMarketingTool(
    "create_sender_identity",
    { fromName: "Ana Painter", fromEmail: "ana@mail.wisesel.pro", replyTo: null, mailingAddress: "123 Studio Way, Portland OR", businessName: null },
    ctx
  );
  await acceptMarketingAction(supabase, sender.actionId!);
  const senderId = (sender.data as { senderIdentityId: string }).senderIdentityId;

  // Idempotency: an identical re-create (double-submit) returns the SAME id.
  const senderDup = await executeMarketingTool(
    "create_sender_identity",
    { fromName: "Ana Painter", fromEmail: "ana@mail.wisesel.pro", replyTo: null, mailingAddress: "123 Studio Way, Portland OR", businessName: null },
    ctx
  );
  if (senderDup.actionId) await acceptMarketingAction(supabase, senderDup.actionId);
  check("create_sender_identity is idempotent on identical fields (no duplicate)", (senderDup.data as { senderIdentityId: string }).senderIdentityId === senderId);

  for (const [tool, args] of [
    ["attach_sender_identity_to_campaign", { campaignId, senderIdentityId: senderId }],
    ["attach_lead_list_to_campaign", { campaignId, listId }],
  ] as const) {
    const out = await executeMarketingTool(tool, args, ctx);
    await acceptMarketingAction(supabase, out.actionId!);
  }
  // 9–11 weekday window FIRST (the window test), opened later for the flow.
  const sched = await executeMarketingTool("create_sending_schedule", { campaignId, startHour: 9, endHour: 11, timezone: "UTC", skipWeekends: true }, ctx);
  await acceptMarketingAction(supabase, sched.actionId!);
  const lp = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  await acceptMarketingAction(supabase, lp.actionId!);

  // ── generate the blueprint sequence ────────────────────────────────────
  console.log("\n# generate — blueprint-driven, quality-scored");
  const gen = await executeMarketingTool("generate_email_sequence", { goal: null, length: null }, ctx);
  await acceptMarketingAction(supabase, gen.actionId!);
  const seqId = (gen.data as { sequenceId: string }).sequenceId;
  const seq = (await loadEmailSequence(supabase, seqId))!;
  check("launch blueprint default = 5 steps", seq.touches.length === 5, String(seq.touches.length));
  check("steps carry stage names + frameworks", seq.touches.every((t) => !!t.stageName && !!t.purpose));
  check("every step is quality-scored at write (advisory)", seq.touches.every((t) => t.qualityScore !== null && t.qualityScore.score >= 0 && t.qualityScore.score <= 100));
  check("blueprint recorded on config for analytics", (await loadCampaign(supabase, campaignId))?.config.blueprintKey === "launch_course");
  check("campaign advanced draft → generated", (await loadCampaign(supabase, campaignId))?.status === "generated");

  // ── send_test_email renders through the SAME pipeline as a real send ──
  console.log("\n# send_test_email — owner-addressed auto-logs under assisted (default)");
  const testTouch = seq.touches[0];
  const sendsBefore = provider.getSends().length;
  const testReq = await executeMarketingTool("send_test_email", { to: email, subject: testTouch.subject, body: testTouch.body }, ctx);
  check("owner-addressed test send auto-logs (executed, no card)", testReq.status === "executed", testReq.status);
  check("the send happened WITHOUT a separate approval", provider.getSends().length === sendsBefore + 1);
  const testAction = await loadAction(supabase, testReq.actionId!);
  check(
    "autonomy audit recorded route 'auto_log'",
    (testAction?.autonomyDecision as { route?: string } | null)?.route === "auto_log"
  );
  const lastSend = provider.getSends().at(-1)!;
  check("test send subject is tagged [TEST]", lastSend.subject.startsWith("[TEST]"));
  check("test send footer carries the sender name + mailing address (A9)", lastSend.text!.includes("Ana Painter") && lastSend.text!.includes("123 Studio Way"));
  check("test send unsubscribe is a real signed link, not '#'", lastSend.unsubscribeUrl !== "#" && lastSend.unsubscribeUrl.includes("/api/marketing/unsubscribe?t="));
  check("test send CTA is click-wrapped (A5), not the raw destination", lastSend.body.blocks.some((b) => b.kind === "button" && b.href.includes("/api/marketing/click?t=")));
  check(
    "test send carries the sender identity as From display name + Reply-To",
    lastSend.fromName === "Ana Painter" && lastSend.replyTo === "ana@mail.wisesel.pro"
  );

  const variants = await executeMarketingTool("generate_email_variants", { sequenceId: seqId, touchId: seq.touches[0].id, axis: "subject" }, ctx);
  await acceptMarketingAction(supabase, variants.actionId!);
  check("variants generated for manual selection (no A/B)", ((variants.data as { variants: string[] }).variants ?? []).length === 3);

  const del = await executeMarketingTool("delete_email_step", { sequenceId: seqId, touchId: seq.touches[4].id }, ctx);
  await acceptMarketingAction(supabase, del.actionId!);
  check("pre-launch step delete works (5 → 4)", (await loadEmailSequence(supabase, seqId))?.touches.length === 4);

  // ── compliance: merge-var blocking + steps-not-approved ────────────────
  console.log("\n# compliance gate");
  const t0 = (await loadEmailSequence(supabase, seqId))!.touches[0];
  const mv = await executeMarketingTool(
    "write_email_touch",
    { sequenceId: seqId, touchId: t0.id, position: null, delaySeconds: null, triggerEvent: null, subject: t0.subject, previewText: t0.previewText, body: { blocks: [{ kind: "paragraph", text: "Grab your lesson: {{freeLessonUrl}}" }, { kind: "button", label: "Open the lesson", href: "/p/x" }] } },
    ctx
  );
  await acceptMarketingAction(supabase, mv.actionId!);
  const rev1 = await executeMarketingTool("review_campaign_compliance", { campaignId }, ctx);
  await acceptMarketingAction(supabase, rev1.actionId!);
  const report1 = rev1.data as { findings: { key: string; severity: string }[] };
  check("compliance blocks: steps not approved", report1.findings.some((f) => f.key === "steps_not_approved" && f.severity === "blocking"));
  check("compliance blocks: merge var w/o fallback + missing data (A3b)", report1.findings.some((f) => f.key.startsWith("merge_var_freeLessonUrl") && f.severity === "blocking"));
  check("campaign complianceStatus = blocked", (await loadCampaign(supabase, campaignId))?.complianceStatus === "blocked");

  // fix the merge var, approve all steps
  const fix = await executeMarketingTool(
    "write_email_touch",
    { sequenceId: seqId, touchId: t0.id, position: null, delaySeconds: null, triggerEvent: null, subject: t0.subject, previewText: t0.previewText, body: { blocks: [{ kind: "paragraph", text: "Hi {{firstName}} — your first watercolor lesson is ready." }, { kind: "button", label: "Open the lesson", href: "/p/x" }] } },
    ctx
  );
  await acceptMarketingAction(supabase, fix.actionId!);
  for (const t of (await loadEmailSequence(supabase, seqId))!.touches) {
    const ap = await executeMarketingTool("approve_email_step", { sequenceId: seqId, touchId: t.id, approved: true }, ctx);
    await acceptMarketingAction(supabase, ap.actionId!);
  }
  check("approving a step moves the campaign into review", (await loadCampaign(supabase, campaignId))?.status === "in_review");

  const rev2 = await executeMarketingTool("review_campaign_compliance", { campaignId }, ctx);
  await acceptMarketingAction(supabase, rev2.actionId!);
  const c2 = await loadCampaign(supabase, campaignId);
  check("after fixes, compliance is not blocked (advisory quality never blocks)", c2?.complianceStatus !== "blocked", c2?.complianceStatus);

  // ── edit-after-approval resets review ──────────────────────────────────
  const tEdit = (await loadEmailSequence(supabase, seqId))!.touches[1];
  const editOut = await executeMarketingTool(
    "write_email_touch",
    { sequenceId: seqId, touchId: tEdit.id, position: null, delaySeconds: null, triggerEvent: null, subject: "A calmer subject line", previewText: tEdit.previewText, body: tEdit.body },
    ctx
  );
  await acceptMarketingAction(supabase, editOut.actionId!);
  const afterEdit = (await loadEmailSequence(supabase, seqId))!.touches.find((t) => t.id === tEdit.id)!;
  check("editing an approved step returns it to draft (edge case)", afterEdit.approvalStatus === "draft");
  const reap = await executeMarketingTool("approve_email_step", { sequenceId: seqId, touchId: tEdit.id, approved: true }, ctx);
  await acceptMarketingAction(supabase, reap.actionId!);

  // ── approve campaign + launch through the gate ─────────────────────────
  console.log("\n# approve + launch (the two human gates)");
  const appr = await executeMarketingTool("approve_campaign", { campaignId }, ctx);
  await acceptMarketingAction(supabase, appr.actionId!);
  check("campaign approved with approver + timestamp", (await loadCampaign(supabase, campaignId))?.status === "approved" && !!(await loadCampaign(supabase, campaignId))?.approvedAt);
  const checklist = await evaluateLaunchChecklist(supabase, (await loadCampaign(supabase, campaignId))!);
  check("launch checklist: every item ok", checklist.canLaunch, JSON.stringify(checklist.items.filter((i) => !i.ok)));

  const launchOut = await executeMarketingTool("launch_campaign", { campaignId }, ctx);
  check("launch pends with audience=3 (confirmed only; pending/lapsed excluded)", launchOut.status === "pending_approval" && (launchOut.approvalPreview as { audience: number }).audience === 3);
  check(
    "launch preview states the delivery timing (held: clock is Thu 00:00, window 9–11)",
    (launchOut.summary ?? "").includes("HELD until the send window opens"),
    launchOut.summary ?? ""
  );
  const launchExec = await approveMarketingAction(launchOut.actionId!, { supabase, ownerId: userId, services });
  check(
    "executed launch summary repeats the timing + data carries nextWindowOpensAt",
    (launchExec.summary ?? "").includes("HELD until the send window opens") &&
      (launchExec.data as { nextWindowOpensAt?: string | null })?.nextWindowOpensAt === "2026-06-18T09:00:00.000Z",
    `${launchExec.summary} · ${JSON.stringify(launchExec.data)}`
  );
  const live = await loadCampaign(supabase, campaignId);
  check("campaign active + approved audience snapshotted (A4c)", live?.status === "active" && (live?.config.approvedAudienceIds ?? []).length === 3);

  // ── send window holds, then delivers (A12) ─────────────────────────────
  console.log("\n# send window (A12) + bounce taxonomy (A8)");
  const tickHeld = await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 3 * HOUR }); // Thu 03:00
  check("03:00 tick holds everything (9–11 window)", tickHeld.sent === 0 && tickHeld.heldByWindow === 3, JSON.stringify(tickHeld));

  const open = await executeMarketingTool("create_sending_schedule", { campaignId, startHour: 0, endHour: 23, timezone: "UTC", skipWeekends: false }, ctx);
  await acceptMarketingAction(supabase, open.actionId!);
  const tick1 = await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 3 * HOUR });
  check("open window: 1 delivered, 1 hard bounce failed, 1 soft retried", tick1.sent === 1 && tick1.failed === 1, JSON.stringify(tick1));
  const seqSend = provider.getSends().at(-1)!;
  check(
    "sequence sends carry the sender identity as From display name + Reply-To",
    seqSend.fromName === "Ana Painter" && seqSend.replyTo === "ana@mail.wisesel.pro"
  );

  const { data: hardSub } = await supabase.from("subscriber").select("status").eq("campaign_id", campaignId).eq("email", leadEmails.hard).single();
  check("hard bounce → terminal suppression", hardSub?.status === "bounced");
  const { data: softSend } = await supabase.from("scheduled_send").select("status,bounce_type,soft_bounce_count").eq("subscriber_id", pendingSubs!.find((s) => s.email === leadEmails.soft)!.id).eq("sequence_id", seqId).limit(1).single();
  check("soft bounce → still pending, count=1, backoff scheduled", softSend?.status === "pending" && softSend?.bounce_type === "soft" && softSend?.soft_bounce_count === 1);

  // retries: +31m (count 2), +3h (count 3 → escalates to hard)
  await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 3 * HOUR + 31 * 60 * 1000 });
  const tickEsc = await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 7 * HOUR });
  check("3rd consecutive soft bounce escalates to hard", tickEsc.failed >= 1, JSON.stringify(tickEsc));
  const { data: softSub } = await supabase.from("subscriber").select("status").eq("campaign_id", campaignId).eq("email", leadEmails.soft).single();
  check("escalated subscriber is suppressed", softSub?.status === "bounced");

  // ── click attribution (A5) + segments/score/profile (A4) ───────────────
  console.log("\n# attribution (A5) + segments + engagement (A4)");
  const normalId = pendingSubs!.find((s) => s.email === leadEmails.normal)!.id;
  await recordAttributedClick(supabase, { courseId, campaignId, touchId: t0.id, subscriberId: normalId });
  const attr = await lastClickAttribution(supabase, courseId, normalId);
  check("last-click attribution finds the campaign + touch", attr.campaignId === campaignId && attr.touchId === t0.id);

  const segBefore = await getLeadSegment(supabase, courseId, "clicked_not_enrolled", { campaignId });
  check("clicked_not_enrolled contains the clicker (fixes the Screen-2 orphan)", segBefore.leads.some((l) => l.subscriberId === normalId));
  const enrollment = await recordEnrollmentEvent(supabase, { courseId, subscriberId: normalId });
  check("enrollment carries last-click attribution (7d window)", enrollment.campaignId === campaignId);
  const segAfter = await getLeadSegment(supabase, courseId, "clicked_not_enrolled", { campaignId });
  check("segment drops them after enrollment (pure query, never materialized)", !segAfter.leads.some((l) => l.subscriberId === normalId));
  const mppSeg = await getLeadSegment(supabase, courseId, "opened_not_clicked", {});
  check("open-based segments carry the MPP caveat (A11)", !!mppSeg.caveat && mppSeg.caveat.includes("Privacy"));

  const score = await engagementScore(supabase, courseId, normalId);
  check("engagement score computed at read time (clicks × 3)", score.score > 0 && score.clicks >= 1, JSON.stringify(score));
  const profile = await loadLeadProfile(supabase, normalId);
  check("lead profile: timeline + consent record + per-campaign engagement", !!profile && profile.timeline.length > 0 && profile.consentStatus === "confirmed" && profile.perCampaign.length >= 1);
  const bouncedProfile = await loadLeadProfile(supabase, pendingSubs!.find((s) => s.email === leadEmails.hard)!.id);
  check("suppressed profile shows the reason", bouncedProfile?.suppressed === true && bouncedProfile.suppressionReason === "bounced");

  // ── pause actually stops sends → resume continues (edge case) ──────────
  console.log("\n# pause/resume + completion");
  const pauseOut = await executeMarketingTool("pause_campaign", { campaignId }, ctx);
  await acceptMarketingAction(supabase, pauseOut.actionId!);
  const tickPaused = await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 2 * DAY + HOUR });
  check("paused campaign sends NOTHING (scheduler gates on sequence status)", tickPaused.sent === 0, JSON.stringify(tickPaused));
  const resumeOut = await executeMarketingTool("resume_campaign", { campaignId }, ctx);
  await acceptMarketingAction(supabase, resumeOut.actionId!);
  const tickResumed = await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 2 * DAY + HOUR });
  check("resume continues only unsent steps (1 remaining subscriber)", tickResumed.sent === 1, JSON.stringify(tickResumed));

  // run out the remaining touches (days 4, 7 — the 5th was deleted)
  await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 4 * DAY + HOUR });
  await runSchedulerTick(supabase, services, { courseId, nowMs: clock.epochMs() + 7 * DAY + HOUR });
  check("campaign completes when the last enrollment finishes", (await loadCampaign(supabase, campaignId))?.status === "completed", (await loadCampaign(supabase, campaignId))?.status);

  // ── guardrails + ramp (A10) + analytics honesty (A11) ─────────────────
  console.log("\n# guardrails (A10) + analytics (A11)");
  const trip = await evaluateCampaignGuardrails(supabase, campaignId);
  check(`small-sample protection: no trip under ${GUARDRAILS.minSendsBeforeEvaluating} sends`, trip === null);
  const ramp = await getAuthorSendRamp(supabase, userId);
  check("per-creator ramp reports a cap", ramp.cap >= 200 && ramp.remaining <= ramp.cap, JSON.stringify(ramp));
  const summary = await getAnalyticsSummary(supabase, courseId);
  check("click rate is per delivered (primary metric)", summary.rates.clickRate !== null);
  check("open-rate caveat travels with the summary", summary.openRateCaveat === OPEN_RATE_CAVEAT);
  check("hard-bounce rate counts hard bounces only (outbox classification)", summary.rates.hardBounceRate !== null && summary.rates.hardBounceRate > 0);

  // ── voice profile (A3c) — staged + revert restores ─────────────────────
  console.log("\n# voice profile (A3c)");
  const v1 = await executeMarketingTool("update_voice_profile", { rules: ["Plain words.", "Short sentences."] }, ctx);
  await acceptMarketingAction(supabase, v1.actionId!);
  const v2 = await executeMarketingTool("update_voice_profile", { rules: ["Hype everything!!!"] }, ctx);
  check("voice update stages reversibly", v2.status === "staged");
  await rejectMarketingAction(supabase, v2.actionId!, { nowIso: services.clock.now() });
  const voice = await loadVoiceProfile(supabase, userId);
  check("reject restores the prior voice rules", JSON.stringify(voice?.rules) === JSON.stringify(["Plain words.", "Short sentences."]));

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
