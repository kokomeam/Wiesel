/**
 * Learner-comms integration test against LIVE Supabase (Milestone 6).
 * Run: `npx tsx scripts/verify-comms-int.ts`  (npm run verify:comms:int)
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local. Uses the MOCK provider —
 * nothing leaves the machine.
 *
 * Proves the acceptance: draft → edit → approve → send works end-to-end, and
 * OPT-OUT IS ENFORCED AT THE SEND SEAM (flip comms_opt_out → approveAndSend
 * refuses, the row stays draft, the provider records nothing) — not just in
 * the UI. Also the signed opt-out route flow and the author-only RLS surface.
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean
 * them in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";

// Env FIRST (tsx doesn't autoload .env.local); everything reads at call time.
{
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  process.env.COMMS_PROVIDER = "mock"; // never send for real in tests
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getMockSends, resetMockSends } from "@/lib/comms/mockProvider";
import { approveAndSend, createDraft, updateDraft } from "@/lib/comms/service";
import { createOptOutToken } from "@/lib/comms/tokens";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";

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

type DB = SupabaseClient<Database>;

async function provision(url: string, anon: string, tag: string) {
  const email = `comms-itest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email };
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:comms:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provision(url, anon, "author");
  const learner = await provision(url, anon, "learner");
  const admin: DB = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Minimal course (no publication needed — enrollment is admin-seeded).
  const courseId = crypto.randomUUID();
  const lesson = createLesson("Only lesson", 0);
  lesson.blocks = [createBlock("lecture_text", 0)];
  const mod = createModule("Only module", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: courseId,
    title: "Comms fixture course",
    description: "",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: author.userId,
      aiReadableVersion: "1.0",
    },
  };
  const rows = courseDocToRows(doc, author.userId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await author.client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
  const enroll = await admin
    .from("enrollments")
    .insert({ course_id: courseId, user_id: learner.userId });
  if (enroll.error) throw new Error(enroll.error.message);

  try {
    /* ── 1. draft → edit → approve → send ── */
    console.log("\n— draft → edit → approve → send —");
    resetMockSends();
    const draft = await createDraft(author.client, {
      courseId,
      userId: learner.userId,
      subject: "Checking in",
      body: [
        { kind: "paragraph", text: "Hi there," },
        { kind: "paragraph", text: "Original middle paragraph." },
        { kind: "paragraph", text: "— The Creator" },
      ],
    });
    check("draft created (author RLS insert)", draft.status === "draft");

    const edited = await updateDraft(author.client, draft.id, {
      subject: "Checking in — edited",
      body: [
        { kind: "paragraph", text: "Hi there," },
        { kind: "paragraph", text: "EDITED middle paragraph." },
        { kind: "paragraph", text: "— The Creator" },
      ],
    });
    check("draft edited", edited.subject === "Checking in — edited");

    const sent = await approveAndSend(admin, draft.id);
    check("approve → send succeeds", sent.ok);
    const sends = getMockSends();
    check("exactly one provider send", sends.length === 1);
    check(
      "sent to the learner's REAL email (server-resolved)",
      sends[0]?.to === learner.email
    );
    check(
      "the EDITED body was rendered at send time",
      sends[0]?.html.includes("EDITED middle paragraph") === true &&
        !sends[0]?.html.includes("Original middle")
    );
    check(
      "opt-out link present in the sent email",
      sends[0]?.html.includes("/api/comms/opt-out?token=") === true &&
        sends[0]?.unsubscribeUrl.includes("/api/comms/opt-out")
    );
    const sentRow = await admin
      .from("learner_messages")
      .select("status, sent_at, provider_message_id")
      .eq("id", draft.id)
      .single();
    check(
      "row settled: sent + timestamps + provider id",
      sentRow.data?.status === "sent" &&
        !!sentRow.data?.sent_at &&
        !!sentRow.data?.provider_message_id
    );
    const resend = await approveAndSend(admin, draft.id);
    check("a sent message can't send again", !resend.ok && resend.reason === "bad_status");

    /* ── 2. OPT-OUT ENFORCED AT THE SEAM (the acceptance) ── */
    console.log("\n— opt-out at the send seam —");
    const flip = await admin
      .from("enrollments")
      .update({ comms_opt_out: true })
      .eq("course_id", courseId)
      .eq("user_id", learner.userId);
    if (flip.error) throw new Error(flip.error.message);

    const blockedDraft = await createDraft(author.client, {
      courseId,
      userId: learner.userId,
      subject: "Should never send",
      body: [{ kind: "paragraph", text: "Hello" }],
    });
    const blocked = await approveAndSend(admin, blockedDraft.id);
    check("approveAndSend refuses an opted-out learner", !blocked.ok && blocked.reason === "opted_out");
    const blockedRow = await admin
      .from("learner_messages")
      .select("status")
      .eq("id", blockedDraft.id)
      .single();
    check("…and the row STAYS draft (not failed)", blockedRow.data?.status === "draft");
    check("…and the provider recorded NOTHING new", getMockSends().length === 1);

    /* ── 3. The opt-out route (signed token → flag flip) ── */
    console.log("\n— opt-out route —");
    const reset = await admin
      .from("enrollments")
      .update({ comms_opt_out: false })
      .eq("course_id", courseId)
      .eq("user_id", learner.userId);
    if (reset.error) throw new Error(reset.error.message);

    const { GET, POST } = await import("@/app/api/comms/opt-out/route");
    const token = createOptOutToken(courseId, learner.userId);
    const confirmPage = await GET(
      new Request(`https://example.test/api/comms/opt-out?token=${encodeURIComponent(token)}`)
    );
    const confirmHtml = await confirmPage.text();
    check(
      "GET renders a confirm form (never flips)",
      confirmHtml.includes("<form") && confirmHtml.includes("Unsubscribe")
    );
    const afterGet = await admin
      .from("enrollments")
      .select("comms_opt_out")
      .eq("course_id", courseId)
      .eq("user_id", learner.userId)
      .single();
    check("GET did not flip the flag", afterGet.data?.comms_opt_out === false);

    const postRes = await POST(
      new Request(`https://example.test/api/comms/opt-out?token=${encodeURIComponent(token)}`, {
        method: "POST",
      })
    );
    check("POST confirms the unsubscribe", (await postRes.text()).includes("unsubscribed"));
    const afterPost = await admin
      .from("enrollments")
      .select("comms_opt_out")
      .eq("course_id", courseId)
      .eq("user_id", learner.userId)
      .single();
    check("POST flipped comms_opt_out", afterPost.data?.comms_opt_out === true);

    const badPost = await POST(
      new Request(`https://example.test/api/comms/opt-out?token=garbage`, { method: "POST" })
    );
    check("a tampered token is rejected", (await badPost.text()).includes("isn't valid"));

    /* ── 4. RLS surface ── */
    console.log("\n— RLS —");
    const learnerRead = await learner.client
      .from("learner_messages")
      .select("id")
      .eq("course_id", courseId);
    check(
      "learners read no messages (author-only table)",
      learnerRead.error === null && (learnerRead.data ?? []).length === 0
    );
    const learnerInsert = await learner.client.from("learner_messages").insert({
      course_id: courseId,
      user_id: learner.userId,
      subject: "forged",
      body: [{ kind: "paragraph", text: "x" }] as never,
    });
    check("non-authors can't insert messages", learnerInsert.error !== null);
  } finally {
    console.log("\n— Cleanup —");
    const del = await author.client.from("courses").delete().eq("id", courseId);
    check("fixture course deleted (messages cascade)", del.error === null, del.error?.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
