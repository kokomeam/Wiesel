/**
 * Email CTA destination suite — the "where does the button actually take a
 * subscriber?" layer, born from a live incident: an automated email's CTA
 * landed on vercel.com's 404 (NEXT_PUBLIC_SITE_URL pointed at the Vercel
 * DASHBOARD in the sending environment) and, separately, {{ctaUrl}} was
 * hard-coded null at send time so LLM-written buttons rendered a literal
 * merge token into the tracked link.
 *
 *   - siteUrlFinding matrix: unset/garbage/vercel.com → BLOCKING;
 *     localhost → warning; a real domain → clean
 *   - destination rule: course preview (/learn/{slug}) once a LIVE
 *     publication exists, the campaign landing page (/p/{slug}) before —
 *     mailing-list traffic goes to the CONVERSION surface, never back to a
 *     lead-capture form; {{freeLessonUrl}} keeps pointing at the capture page
 *   - generation wiring: generate_email_sequence / generate_followup bake the
 *     resolved ctaPath into template button hrefs (pre-publish → /p/,
 *     post-publish → /learn/)
 *   - send-time wiring: renderSendableEmail resolves a {{ctaUrl}} button into
 *     a click-wrapped ABSOLUTE URL — no literal merge token survives
 *   - compliance wiring: review_campaign_compliance flags
 *     site_url_misconfigured as BLOCKING under a vercel.com site URL
 *   - the click route 302s RELATIVE destinations (NextResponse.redirect
 *     rejects bare relative paths — the pre-fix behavior was a 500)
 *
 * Run: `npx tsx scripts/verify-marketing-cta.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { CourseDocument, QuizBlock } from "@/lib/course/types";
import { createBlock, createLesson, createModule, createQuestion, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import {
  coursePreviewPath,
  resolveCtaDestinations,
  resolveSendTimeButtonHref,
  siteUrlFinding,
} from "@/lib/marketing/ctaDestination";
import { renderSendableEmail } from "@/lib/marketing/scheduler";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { publicUrl } from "@/lib/marketing/tokens";
import { GET as clickGET } from "@/app/api/marketing/click/route";

dns.setDefaultResultOrder("ipv4first");

const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};

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

async function provisionUser(url: string, anon: string) {
  const email = `cta-itest-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin: ${error?.message}`);
  return { client, userId: data.user.id };
}

/** A publishable course doc (deck + gradable quiz + lecture) — the publish
 *  suite's minimal fixture shape. */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const m = createModule("Foundations", 0);
  const l = createLesson("Opening moves", 0);
  const deck = createBlock("slide_deck", 0);
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const q = createQuestion("multiple_choice");
  if (q.kind !== "multiple_choice") throw new Error("unreachable");
  q.prompt = "Pick B.";
  q.correctChoiceId = q.choices[1].id;
  q.explanation = "B was correct.";
  quiz.questions = [q];
  const lecture = createBlock("lecture_text", 2);
  l.blocks = [deck, quiz, lecture];
  m.lessons = [l];
  return {
    id: courseId,
    title,
    description: "CTA destination fixture.",
    plan: { outcomes: ["Ship a thing"], prerequisites: [] },
    modules: [m],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

function buttonHrefs(body: unknown): string[] {
  const blocks = (body as { blocks?: { kind: string; href?: string }[] })?.blocks ?? [];
  return blocks.filter((b) => b.kind === "button" && b.href).map((b) => b.href!);
}

/* ─────────────────────── site URL sanity matrix ────────────────────── */

function siteUrlChecks() {
  console.log("# siteUrlFinding — the every-link-404s failure class");
  const original = process.env.NEXT_PUBLIC_SITE_URL;
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = v;
  };

  set(undefined);
  check("unset → BLOCKING", siteUrlFinding()?.severity === "blocking");
  set("not a url");
  check("garbage → BLOCKING", siteUrlFinding()?.severity === "blocking");
  set("https://vercel.com/wisesel");
  const vercel = siteUrlFinding();
  check("vercel.com (the dashboard) → BLOCKING", vercel?.severity === "blocking");
  check("…and the detail teaches the fix", (vercel?.detail ?? "").includes("deployment domain"));
  set("http://localhost:3000");
  check("localhost → warning (dev-only links)", siteUrlFinding()?.severity === "warning");
  set("https://wisesel.vercel.app");
  check("a real deployment domain → clean", siteUrlFinding() === null);
  check("publicUrl composes absolute links", publicUrl("/learn/x") === "https://wisesel.vercel.app/learn/x");

  set(original);
}

/* ────────────── send-time button-href resolution (pure) ────────────── */

function sendTimeHrefChecks() {
  console.log("\n# resolveSendTimeButtonHref — send time wins over baked hrefs");
  const cta = "https://site.test/learn/course-x";
  const landing = "https://site.test/p/landing-y";
  const both = { ctaUrl: cta, freeLessonUrl: landing };

  check('baked "#" (the homepage incident) → rescued to ctaUrl', resolveSendTimeButtonHref("#", both) === cta);
  check("baked empty href → rescued to ctaUrl", resolveSendTimeButtonHref("", both) === cta);
  check('baked "/" → rescued to ctaUrl', resolveSendTimeButtonHref("/", both) === cta);
  check(
    "{{ctaUrl}} with a live destination renders it",
    resolveSendTimeButtonHref("{{ctaUrl}}", both) === cta
  );
  check(
    "unresolvable {{ctaUrl}} (null) falls back to freeLessonUrl, never a literal token",
    resolveSendTimeButtonHref("{{ctaUrl}}", { ctaUrl: null, freeLessonUrl: landing }) === landing
  );
  check(
    '"#" with NO destination at all passes through (compliance blocks that launch)',
    resolveSendTimeButtonHref("#", { ctaUrl: null, freeLessonUrl: null }) === "#"
  );
  check(
    "an authored {{freeLessonUrl}} button STAYS on the capture page",
    resolveSendTimeButtonHref("{{freeLessonUrl}}", both) === landing
  );
  check(
    "a baked RELATIVE landing path upgrades to the live preview",
    resolveSendTimeButtonHref("/p/landing-y", both) === cta
  );
  check(
    "a baked ABSOLUTE landing URL upgrades to the live preview",
    resolveSendTimeButtonHref(landing, both) === cta
  );
  check(
    "pre-publish (ctaUrl IS the landing) a landing href is untouched",
    resolveSendTimeButtonHref("/p/landing-y", { ctaUrl: landing, freeLessonUrl: landing }) === "/p/landing-y"
  );
  check(
    "an unrelated landing path is untouched",
    resolveSendTimeButtonHref("/p/some-other-page", both) === "/p/some-other-page"
  );
  check(
    "an already-correct preview path is untouched",
    resolveSendTimeButtonHref("/learn/course-x", both) === "/learn/course-x"
  );
  check(
    "an external URL is untouched",
    resolveSendTimeButtonHref("https://example.com/z", both) === "https://example.com/z"
  );
}

/* ───────────────────────── click route redirect ────────────────────── */

async function clickRouteChecks() {
  console.log("\n# click route — relative destinations must 302, never 500");
  const relative = await clickGET(
    new Request("http://localhost:3000/api/marketing/click?u=%2Flearn%2Ffoo")
  );
  check("relative u → 302", relative.status === 302);
  check(
    "relative u resolves against the request origin",
    relative.headers.get("location") === "http://localhost:3000/learn/foo",
    String(relative.headers.get("location"))
  );
  const absolute = await clickGET(
    new Request("http://localhost:3000/api/marketing/click?u=" + encodeURIComponent("https://example.com/learn/foo"))
  );
  check(
    "absolute u passes through untouched",
    absolute.status === 302 && absolute.headers.get("location") === "https://example.com/learn/foo"
  );
  const garbage = await clickGET(
    new Request("http://localhost:3000/api/marketing/click?u=" + encodeURIComponent("javascript:alert(1)"))
  );
  check(
    "non-http destination is neutralized to the app root",
    garbage.status === 302 && garbage.headers.get("location") === "http://localhost:3000/",
    String(garbage.headers.get("location"))
  );
}

/* ────────────────────────────── live flow ──────────────────────────── */

async function main() {
  siteUrlChecks();
  sendTimeHrefChecks();
  await clickRouteChecks();

  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  const author = await provisionUser(url, anon);
  console.log("\n# provisioned a throwaway creator");

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `CTA itest ${crypto.randomUUID().slice(0, 6)}`);
  const rows = courseDocToRows(doc, author.userId);
  await author.client.from("courses").insert(rows.course);
  await author.client.from("modules").insert(rows.modules);
  await author.client.from("lessons").insert(rows.lessons);
  await author.client.from("blocks").insert(rows.blocks);

  const campaignId = newRowId();
  await author.client.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "CTA test" });
  const landingSlug = `cta-itest-${crypto.randomUUID().slice(0, 8)}`;
  await author.client.from("landing_page").insert({
    campaign_id: campaignId,
    course_id: courseId,
    slug: landingSlug,
    title: "Landing",
    status: "published",
  });

  const services = createMarketingServices();
  const ctx: MarketingToolContext = {
    supabase: author.client as never,
    courseId,
    campaignId,
    ownerId: author.userId,
    services,
    requestedBy: "user",
  };

  /* ── before publish: landing page is the (only possible) destination ── */
  console.log("\n# pre-publish — the landing page is the fallback destination");
  check("no live publication yet", (await coursePreviewPath(author.client as never, courseId)) === null);
  const before = await resolveCtaDestinations(author.client as never, { courseId, campaignId });
  check("ctaPath falls back to the landing page", before.ctaPath === `/p/${landingSlug}`);
  check("freeLessonUrl points at the capture page", before.freeLessonUrl === publicUrl(`/p/${landingSlug}`));

  const gen1 = await executeMarketingTool("generate_email_sequence", { goal: null, length: null }, ctx);
  const seq1 = (gen1.data as { sequenceId: string }).sequenceId;
  const { data: touches1 } = await author.client.from("email_touch").select("body").eq("sequence_id", seq1);
  const hrefs1 = (touches1 ?? []).flatMap((t) => buttonHrefs(t.body));
  check("pre-publish sequence buttons → the landing page", hrefs1.length > 0 && hrefs1.every((h) => h === `/p/${landingSlug}`), hrefs1.join(","));

  /* ── publish, then regenerate: the course preview takes over ── */
  console.log("\n# post-publish — the CTA upgrades to the course preview (/learn)");
  const pub = await publishCourse(author.client as never, doc, { visibility: "public" });
  const learnPath = `/learn/${pub.publication.slug}`;
  check("live publication exists", pub.publication.status === "live");
  check("coursePreviewPath resolves it", (await coursePreviewPath(author.client as never, courseId)) === learnPath);

  const after = await resolveCtaDestinations(author.client as never, { courseId, campaignId });
  check("ctaPath prefers the course preview over the landing page", after.ctaPath === learnPath);
  check("ctaUrl is the ABSOLUTE preview URL", after.ctaUrl === publicUrl(learnPath));
  check("freeLessonUrl STILL points at the capture page", after.freeLessonUrl === publicUrl(`/p/${landingSlug}`));

  const gen2 = await executeMarketingTool("generate_followup", { triggerEvent: null }, ctx);
  const seq2 = (gen2.data as { sequenceId: string }).sequenceId;
  const { data: touches2 } = await author.client.from("email_touch").select("body").eq("sequence_id", seq2);
  const hrefs2 = (touches2 ?? []).flatMap((t) => buttonHrefs(t.body));
  check("post-publish followup buttons → the course preview", hrefs2.length > 0 && hrefs2.every((h) => h === learnPath), hrefs2.join(","));

  /* ── send-time render: {{ctaUrl}} resolves, click-wrapped, absolute ── */
  console.log("\n# send-time render — no literal {{ctaUrl}} ever reaches an inbox");
  const rendered = renderSendableEmail({
    subject: "Try {{courseName}}",
    body: { blocks: [{ kind: "button", label: "Enroll in {{courseName}}", href: "{{ctaUrl}}" }] } as never,
    vars: {
      firstName: "Ada",
      courseName: doc.title,
      creatorName: null,
      freeLessonUrl: after.freeLessonUrl,
      ctaUrl: after.ctaUrl,
      offerDeadline: null,
    },
    dims: { subscriberId: newRowId(), campaignId, courseId },
    unsubscribeUrl: publicUrl("/api/marketing/unsubscribe?t=x"),
  });
  const renderedHref = buttonHrefs(rendered.body)[0] ?? "";
  check("the merge token is GONE from the rendered href", !renderedHref.includes("{{"));
  check("the href is the click-wrapped tracker", renderedHref.includes("/api/marketing/click?t="));
  check(
    "the wrapped destination is the absolute course preview",
    renderedHref.includes(encodeURIComponent(after.ctaUrl!)),
    renderedHref.slice(0, 120)
  );

  /* ── the live incident: a body generated PRE-publish must send to the
     preview page, not the capture page (and a "#" must never reach a click
     link — the click route coerces "#" to the HOMEPAGE) ── */
  console.log("\n# queued-send upgrade — pre-publish bodies deliver to /learn after publish");
  const staleVars = {
    firstName: "Ada",
    courseName: doc.title,
    creatorName: null,
    freeLessonUrl: after.freeLessonUrl,
    ctaUrl: after.ctaUrl,
    offerDeadline: null,
  };
  const staleBody = (touches1 ?? [])
    .map((t) => t.body as { blocks?: { kind: string; href?: string }[] })
    .find((b) => (b.blocks ?? []).some((bl) => bl.kind === "button"));
  const upgraded = renderSendableEmail({
    subject: "s",
    body: staleBody as never,
    vars: staleVars,
    dims: { subscriberId: newRowId(), campaignId, courseId },
    unsubscribeUrl: publicUrl("/api/marketing/unsubscribe?t=x"),
  });
  const upgradedHrefs = buttonHrefs(upgraded.body);
  check(
    "a landing-page href baked pre-publish now delivers the course preview",
    upgradedHrefs.length > 0 && upgradedHrefs.every((h) => h.includes(encodeURIComponent(after.ctaUrl!))),
    upgradedHrefs[0]?.slice(0, 140) ?? "(no buttons)"
  );
  const homepageIncident = renderSendableEmail({
    subject: "s",
    body: { blocks: [{ kind: "button", label: "Enroll", href: "#" }] } as never,
    vars: staleVars,
    dims: { subscriberId: newRowId(), campaignId, courseId },
    unsubscribeUrl: publicUrl("/api/marketing/unsubscribe?t=x"),
  });
  const rescuedHref = buttonHrefs(homepageIncident.body)[0] ?? "";
  check(
    'a baked "#" CTA is rescued to the course preview (never the homepage)',
    rescuedHref.includes(encodeURIComponent(after.ctaUrl!)),
    rescuedHref.slice(0, 140)
  );

  /* ── compliance wiring: the dashboard-URL misconfig BLOCKS the launch ── */
  console.log("\n# compliance — site_url_misconfigured blocks before a send");
  const originalSite = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = "https://vercel.com/wisesel";
  const review = await executeMarketingTool("review_campaign_compliance", { campaignId }, ctx);
  process.env.NEXT_PUBLIC_SITE_URL = originalSite;
  const reviewFindings = (review.data as { findings?: { key: string; severity: string }[] })?.findings ?? [];
  const siteFinding = reviewFindings.find((f) => f.key === "site_url_misconfigured");
  check("review flags site_url_misconfigured", siteFinding !== undefined, JSON.stringify(reviewFindings.map((f) => f.key)));
  check("…as BLOCKING", siteFinding?.severity === "blocking");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
