/**
 * Publishing integration test against LIVE Supabase — no OpenAI key needed.
 * Run: `npx tsx scripts/verify-publish-int.ts`  (npm run verify:publish:int)
 *
 * Provisions throwaway users (author / student / outsider) and drives the REAL
 * publish service + RLS end-to-end:
 *   • publish → v1 live, slug derived, courses.status mirrored
 *   • RLS matrix — anon reads a public publication; quiz_answer_keys is
 *     invisible to EVERY client role (author included); keys exist via the
 *     service-role client; unlisted requires auth; unpublished versions are
 *     owner-only
 *   • acceptance: editing the draft provably does NOT alter the published
 *     snapshot; the answer-key deep scan of the anon-read snapshot is clean
 *   • republish → v2, v1 retired; identical republish → no version bump
 *   • DB immutability trigger + no-insert policy + RPC authorship check
 *   • slug: collision suffixing, requested-slug conflict, redirect-safe rename
 *   • enrollments: self-enroll on a live course; owner reads; outsider can't;
 *     can't enroll someone else; can't enroll without a live publication;
 *     unpublish/restore flips enrollability
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean them
 * in Supabase → Auth. Courses are deleted at the end (cascades publications,
 * answer keys, enrollments).
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  newRowId,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { loadCourseDoc } from "@/lib/course/persistenceSync";
import { diffIsEmpty } from "@/lib/course/publish/diff";
import {
  getLatestPublication,
  getPublishStatus,
  publishCourse,
  PublishServiceError,
  updatePublicationSettings,
} from "@/lib/course/publish/service";
import { findAnswerKeyLeaks } from "@/lib/course/publish/snapshot";
import type { CourseDocument, QuizBlock } from "@/lib/course/types";

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

function loadEnv(): { url: string; anon: string; service?: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(url: string, anon: string, tag: string): Promise<{ client: DB; userId: string }> {
  const email = `publish-itest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  return { client, userId: data.user.id };
}

/** A publishable course document (deck + gradable quiz + lecture). */
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
    description: "Integration fixture.",
    plan: { outcomes: [], prerequisites: [] },
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

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string): Promise<void> {
  const rows = courseDocToRows(doc, ownerId);
  const { error: ce } = await client.from("courses").insert(rows.course);
  if (ce) throw new Error(`course insert: ${ce.message}`);
  const { error: me } = await client.from("modules").insert(rows.modules);
  if (me) throw new Error(`modules insert: ${me.message}`);
  const { error: le } = await client.from("lessons").insert(rows.lessons);
  if (le) throw new Error(`lessons insert: ${le.message}`);
  const { error: be } = await client.from("blocks").insert(rows.blocks);
  if (be) throw new Error(`blocks insert: ${be.message}`);
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");
  const outsider = await provisionUser(url, anon, "outsider");
  const anonClient = createClient<Database>(url, anon); // never signed in
  const admin = service
    ? createClient<Database>(url, service, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

  const courseId = newRowId();
  const title = `Publish itest ${crypto.randomUUID().slice(0, 6)}`;
  const doc = makeDoc(courseId, author.userId, title);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const secondCourseId = newRowId();
  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
    await author.client.from("courses").delete().eq("id", secondCourseId);
  };

  try {
    /* ── 1. first publish ── */
    console.log("\n1. First publish");
    const status0 = await getPublishStatus(author.client, doc);
    check("no publication before publish", status0.publication === null);
    check("pre-flight passes", status0.preflight.ok, JSON.stringify(status0.preflight.errors));
    check("draftChanged before first publish", status0.draftChanged);

    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("version 1", v1.publication.version === 1);
    check("live", v1.publication.status === "live");
    check("slug derived from title", v1.publication.slug.startsWith("publish-itest"));
    check("first-publish diff", v1.diff.firstPublish && v1.diff.blocks.added === 3);
    check("not alreadyCurrent", !v1.alreadyCurrent);

    const { data: courseRow } = await author.client
      .from("courses").select("status").eq("id", courseId).single();
    check("courses.status mirrored to published", courseRow?.status === "published");

    /* ── 2. RLS matrix ── */
    console.log("\n2. RLS matrix");
    const { data: anonPub } = await anonClient
      .from("course_publications")
      .select("*")
      .eq("slug", v1.publication.slug)
      .eq("status", "live")
      .maybeSingle();
    check("anon reads the live public publication", !!anonPub && anonPub.version === 1);
    check(
      "anon-read snapshot has ZERO answer-key leaks",
      !!anonPub && findAnswerKeyLeaks(anonPub.snapshot).length === 0
    );
    const snapshotText = JSON.stringify(anonPub?.snapshot ?? {});
    check(
      "correct answer value absent from payload",
      !snapshotText.includes("correctChoiceId") && !snapshotText.includes("B was correct")
    );

    const { data: anonKeys } = await anonClient
      .from("quiz_answer_keys").select("*").eq("publication_id", v1.publication.id);
    check("anon can't read answer keys", (anonKeys ?? []).length === 0);
    const { data: authorKeys } = await author.client
      .from("quiz_answer_keys").select("*").eq("publication_id", v1.publication.id);
    check("even the AUTHOR's client can't read answer keys", (authorKeys ?? []).length === 0);
    if (admin) {
      const { data: adminKeys } = await admin
        .from("quiz_answer_keys").select("*").eq("publication_id", v1.publication.id);
      check("keys DO exist (service role)", (adminKeys ?? []).length === 1);
      const keys = adminKeys?.[0]?.keys as { questions: { correctChoiceId?: string }[] };
      check("stored key holds the correct choice", !!keys?.questions?.[0]?.correctChoiceId);
    } else {
      console.log("  (service key absent — skipping key-existence checks)");
    }

    /* ── 3. draft edits don't change what students receive ── */
    console.log("\n3. Draft independence (acceptance)");
    const draftQuizId = doc.modules[0].lessons[0].blocks[1].id;
    // The block payload lives in content jsonb (the title column is a mirror),
    // so a real edit updates BOTH — exactly like the autosave reconcile does.
    const { data: quizRow } = await author.client
      .from("blocks").select("content").eq("id", draftQuizId).single();
    await author.client
      .from("blocks")
      .update({
        title: "EDITED after publish",
        content: { ...(quizRow!.content as object), title: "EDITED after publish" },
      })
      .eq("id", draftQuizId);
    await author.client.from("courses").update({ title: `${title} EDITED` }).eq("id", courseId);

    const { data: pubAfterEdit } = await anonClient
      .from("course_publications")
      .select("snapshot, content_hash")
      .eq("id", v1.publication.id)
      .single();
    check(
      "published snapshot byte-identical after draft edits",
      JSON.stringify(pubAfterEdit?.snapshot) === JSON.stringify(anonPub?.snapshot)
    );
    check("published hash unchanged", pubAfterEdit?.content_hash === v1.publication.contentHash);

    const editedDoc = await loadCourseDoc(author.client, courseId);
    if (!editedDoc) throw new Error("reload failed");
    const statusAfterEdit = await getPublishStatus(author.client, editedDoc);
    check("status reports unpublished draft changes", statusAfterEdit.draftChanged);
    check(
      "diff sees the changed block",
      statusAfterEdit.diff.blocks.changed >= 1 && !statusAfterEdit.diff.firstPublish
    );

    /* ── 4. republish + identical republish ── */
    console.log("\n4. Republish");
    const v2 = await publishCourse(author.client, editedDoc);
    check("version bumped to 2", v2.publication.version === 2);
    check("slug inherited", v2.publication.slug === v1.publication.slug);
    check("diff counts the edit", v2.diff.blocks.changed >= 1);

    const { data: allVersions } = await author.client
      .from("course_publications")
      .select("version, status")
      .eq("course_id", courseId)
      .order("version");
    check(
      "previous version retired",
      allVersions?.length === 2 &&
        allVersions[0].status === "unpublished" &&
        allVersions[1].status === "live"
    );
    const { data: anonOld } = await anonClient
      .from("course_publications").select("id").eq("course_id", courseId);
    check("anon sees only the live version", (anonOld ?? []).length === 1);

    const v2again = await publishCourse(author.client, editedDoc);
    check("identical republish doesn't bump the version", v2again.alreadyCurrent && v2again.publication.version === 2);
    check("identical republish diff is empty", diffIsEmpty(v2again.diff));

    /* ── 5. immutability + insert lockdown + RPC auth ── */
    console.log("\n5. DB hardening");
    const { error: mutErr } = await author.client
      .from("course_publications")
      .update({ snapshot: { hacked: true } })
      .eq("id", v2.publication.id);
    check("snapshot mutation rejected by trigger", !!mutErr, mutErr?.message);
    const { error: verErr } = await author.client
      .from("course_publications")
      .update({ version: 99 })
      .eq("id", v2.publication.id);
    check("version mutation rejected", !!verErr);

    const { error: insErr } = await author.client.from("course_publications").insert({
      course_id: courseId,
      version: 99,
      slug: "sneaky-insert",
      snapshot: {},
      content_hash: "x",
      created_by: author.userId,
    });
    check("direct insert rejected (RPC-only)", !!insErr);

    const { error: rpcErr } = await student.client.rpc("publish_course", {
      p_course_id: courseId,
      p_snapshot: {},
      p_answer_keys: [],
      p_content_hash: "x",
    });
    check("RPC rejects a non-author", !!rpcErr && rpcErr.message.includes("not the course author"));

    /* ── 6. visibility: unlisted ── */
    console.log("\n6. Unlisted visibility");
    await updatePublicationSettings(author.client, courseId, {
      action: "set_visibility",
      visibility: "unlisted",
    });
    const { data: anonUnlisted } = await anonClient
      .from("course_publications").select("id").eq("id", v2.publication.id).maybeSingle();
    check("anon can't read an unlisted publication", !anonUnlisted);
    const { data: studentUnlisted } = await student.client
      .from("course_publications").select("id").eq("id", v2.publication.id).maybeSingle();
    check("signed-in student CAN read it (link possession)", !!studentUnlisted);
    await updatePublicationSettings(author.client, courseId, {
      action: "set_visibility",
      visibility: "public",
    });

    /* ── 7. enrollments ── */
    console.log("\n7. Enrollments");
    const { error: enrollErr } = await student.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: student.userId });
    check("student self-enrolls on a live course", !enrollErr, enrollErr?.message);
    const { error: imposterErr } = await student.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: author.userId });
    check("can't enroll someone else", !!imposterErr);
    const { data: own } = await student.client
      .from("enrollments").select("*").eq("course_id", courseId);
    check("student reads own enrollment", own?.length === 1 && own[0].status === "active");
    const { data: ownerView } = await author.client
      .from("enrollments").select("*").eq("course_id", courseId);
    check("course owner reads enrollments", ownerView?.length === 1);
    const { data: outsiderView } = await outsider.client
      .from("enrollments").select("*").eq("course_id", courseId);
    check("outsider sees nothing", (outsiderView ?? []).length === 0);
    const { error: dropErr } = await student.client
      .from("enrollments")
      .update({ status: "dropped", comms_opt_out: true })
      .eq("course_id", courseId)
      .eq("user_id", student.userId);
    check("student updates own enrollment", !dropErr);

    /* ── 8. unpublish / restore ── */
    console.log("\n8. Unpublish / restore");
    const unpublished = await updatePublicationSettings(author.client, courseId, { action: "unpublish" });
    check("unpublished", unpublished.status === "unpublished");
    const { data: anonGone } = await anonClient
      .from("course_publications").select("id").eq("course_id", courseId);
    check("anon can't see an unpublished course", (anonGone ?? []).length === 0);
    const { data: authorStill } = await author.client
      .from("course_publications").select("id").eq("course_id", courseId);
    check("author still sees all versions", authorStill?.length === 2);
    const { data: courseRow2 } = await author.client
      .from("courses").select("status").eq("id", courseId).single();
    check("courses.status back to draft", courseRow2?.status === "draft");
    const { error: enrollWhileDown } = await outsider.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: outsider.userId });
    check("can't enroll while unpublished", !!enrollWhileDown);

    const restored = await updatePublicationSettings(author.client, courseId, { action: "restore" });
    check("restored to live", restored.status === "live" && restored.version === 2);

    /* ── 9. slug collision + rename ── */
    console.log("\n9. Slugs");
    // Publish the same-title course FIRST (while course 1 still holds the slug).
    const doc2 = makeDoc(secondCourseId, author.userId, title); // SAME title
    await seedCourse(author.client, doc2, author.userId);
    const otherPub = await publishCourse(author.client, doc2);
    check(
      "same-title course gets a suffixed slug",
      otherPub.publication.slug !== v1.publication.slug &&
        otherPub.publication.slug.startsWith(v1.publication.slug.slice(0, 10))
    );

    const renamed = await updatePublicationSettings(author.client, courseId, {
      action: "set_slug",
      slug: `renamed-${crypto.randomUUID().slice(0, 6)}`,
    });
    check("slug renamed", renamed.slug.startsWith("renamed-"));
    check("old slug kept for redirects", renamed.previousSlugs.includes(v1.publication.slug));

    let conflictCode = "";
    try {
      await updatePublicationSettings(author.client, secondCourseId, {
        action: "set_slug",
        slug: renamed.slug,
      });
    } catch (e) {
      conflictCode = e instanceof PublishServiceError ? e.code : "other";
    }
    check("requested duplicate slug is rejected", conflictCode === "slug_taken");

    /* ── 10. latest-publication lookup sanity ── */
    const latest = await getLatestPublication(author.client, courseId);
    check("latest publication is v2 live", latest?.version === 2 && latest?.status === "live");
  } finally {
    await cleanup();
    console.log("\n# cleaned up courses (cascade removed publications/keys/enrollments)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
