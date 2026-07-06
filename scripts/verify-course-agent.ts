/**
 * Course Structure agent — verification.
 * Run: `npx tsx scripts/verify-course-agent.ts` (or `npm run verify:course-agent`).
 *
 * PART A (pure, no DB): the GUARDRAILS — intent routing, signal detection, the
 *   deterministic emptiness rule, target resolution, the structure-plan validation
 *   rule table (every failure case the agent must refuse), plan execution, the
 *   structural diff, and the structural change-set revert (byte-restore).
 *
 * PART B (live Supabase + the MOCK provider, no OpenAI key): the 7 spec scenarios
 *   end-to-end — add a lesson to a specific module (+ docked deck UNTOUCHED), delete
 *   empty lessons, recreate a module IN PLACE (no duplicate module), rename a lesson
 *   (+ reject restores), ambiguous target → clarify (no change), and destructive
 *   delete staged + reject-restored.
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean them in
 * Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import type { CourseDocument, LectureTextBlock, LessonBlock, LessonNode } from "@/lib/course/types";
import { applyCoursePatch, type CoursePatch } from "@/lib/course/patches";
import { findLesson, findModule } from "@/lib/course/queries";
import { classifyIntent, type AgentMode } from "@/lib/ai/intent";
import { detectSignals, hasAnyStructureSignal, validateStructurePlan } from "@/lib/ai/courseStructure/structureValidation";
import { buildOutlineSnapshot, emptyLessonIds, serializeOutlineSnapshot } from "@/lib/ai/courseStructure/outlineSnapshot";
import { executeStructurePlan, isLessonEmpty, planCreatesLessons, planIsDestructive } from "@/lib/ai/courseStructure/structureTools";
import { resolveLesson, resolveModule } from "@/lib/ai/courseStructure/targetResolution";
import type { CourseStructurePlan, StructureOp } from "@/lib/ai/courseStructure/types";
import { diffStructure, type StructureChange } from "@/lib/ai/changeSetDiff";
import { revertChangeSet, getPendingNodes, rejectChangeSet, type RevertItem } from "@/lib/ai/changeSet";
import { runContentAgentTurn, runStructureAgentTurn } from "@/lib/ai/phases";
import { getOrCreateConversation } from "@/lib/ai/conversations";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { loadCourseDoc, reconcileCourseDoc } from "@/lib/ai/serverPersistence";
import type { AgentEvent } from "@/lib/ai/events";

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

function loadEnv(): { url: string; anon: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

const NOW = "2026-07-01T00:00:00.000Z";

/** Apply a patch, asserting success (narrows the union for fixtures). */
function applied(doc: CourseDocument, patch: CoursePatch): CourseDocument {
  const r = applyCoursePatch(doc, patch, NOW);
  if (!r.ok) throw new Error(`fixture patch failed: ${r.error}`);
  return r.doc;
}

/** Build a CourseDocument fixture from a compact spec. */
function fixtureDoc(modules: { title: string; lessons: { title: string; objective?: string; blocks?: LessonNode["blocks"] }[] }[]): CourseDocument {
  return {
    id: crypto.randomUUID(),
    title: "Algorithms",
    description: "Core CS.",
    audience: "beginners",
    level: "beginner",
    plan: { outcomes: ["Understand structures"], prerequisites: [], teachingStyle: "friendly" },
    modules: modules.map((m, mi) => {
      const mod = createModule(m.title, mi);
      mod.lessons = m.lessons.map((l, li) => {
        const lesson = createLesson(l.title, li);
        if (l.objective) lesson.objective = l.objective;
        if (l.blocks) lesson.blocks = l.blocks;
        return lesson;
      });
      return mod;
    }),
    theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
}

/** A schema-valid, NON-empty content block (a lecture with a real paragraph) — so a
 *  seeded lesson reads as "has content" and round-trips through reconcile cleanly. */
function realBlock(): LessonBlock {
  const b = createBlock("lecture_text", 0) as LectureTextBlock;
  b.paragraphs = [{ id: "p1", kind: "paragraph", text: "Real, non-placeholder lesson content." }];
  return b;
}

function mkPlan(p: Partial<CourseStructurePlan> & { ops: StructureOp[] }): CourseStructurePlan {
  return {
    intent: p.intent ?? "add_lesson",
    summary: p.summary ?? "doing the thing",
    ops: p.ops,
    generateContentFor: p.generateContentFor ?? [],
    clarification: p.clarification ?? null,
  };
}

/** Map a StructureChange to the revert row shape `revertChangeSet` reads. */
function toRevertItem(c: StructureChange): RevertItem {
  return {
    node_type: c.nodeType,
    node_id: c.nodeId,
    op: c.op,
    before: c.before,
    after: c.after,
    block_id: null,
    lesson_id: c.nodeType === "lesson" ? c.nodeId : null,
  };
}

/* ─────────────────────────────── PART A — pure ─────────────────────────────── */

function partA() {
  console.log("\n# PART A — guardrails (pure, no DB)");

  // 1. Intent routing (the bug fix): structure verbs route to "structure", NOT to
  //    deck generation; "add slides to this deck" stays content; module build stays.
  // The classifier model is only consulted when no regex matches; stub it to "edit".
  const classModel = createMockModelClient([], { structured: { intent: { mode: "edit" } } });
  const route = async (msg: string, hasDeck = true): Promise<AgentMode> => classifyIntent(classModel, { hasDeck }, msg);
  // (await below in main; classifyIntent is async)
  return async () => {
    check('routing: "add a lesson to Module 3 …" → structure (NOT generate_lesson)', (await route("Add a lesson to Module 3 that goes deeper into hashing")) === "structure");
    check('routing: "delete the empty lessons" → structure', (await route("Please delete the empty lessons")) === "structure");
    check('routing: "recreate Module 1 slides" → structure', (await route("Delete and recreate the slides for Module 1")) === "structure");
    check('routing: "rename this lesson to X" → structure', (await route("Rename this lesson to Hash Table Resizing")) === "structure");
    check('routing: "move lesson X to Module 2" → structure', (await route("Move the hashing lesson to Module 2")) === "structure");
    check('routing: "add 3 slides to this deck" → NOT structure (content edit)', (await route("Add 3 more slides to this deck about separate chaining")) !== "structure");
    check('routing: "build a module about graphs" → generate_module (not structure)', (await route("Build a module about graphs")) === "generate_module");
    // Repair / complete an EXISTING module → structure (the real-world regression).
    check('routing: the exact failing prompt ("module one is very unfinished…complete it") → structure', (await route("currently module one is very unfinished, doens't have title, has empty slides, can you please complete it for me, its just for the intro to an introductory econ class")) === "structure");
    check('routing: "module one has empty slides, fill it out" → structure', (await route("module one has empty slides, fill it out")) === "structure");
    check('routing: "finish the first module" → structure', (await route("finish the first module")) === "structure");
    check('routing: "make Module 1 an intro economics module" → structure', (await route("make Module 1 an introductory economics module about scarcity and markets")) === "structure");
    check('routing: "create a NEW module about X" → generate_module (explicit new opts out)', (await route("create a new module about graph algorithms")) === "generate_module");

    // 2. Signal detection (drives validation; a request can COMBINE actions).
    const s1 = detectSignals("Add a lesson to Module 3 about hashing");
    check("signals: add-lesson detected", s1.wantsAddLesson && !s1.wantsDeleteEmpty);
    const s2 = detectSignals("Add some lessons to Module 1 and delete the empty lessons");
    check("signals: combined add + delete-empty detected", s2.wantsAddLesson && s2.wantsDeleteEmpty);
    check("signals: delete-empty is NOT treated as an explicit lesson delete", !s2.wantsDeleteLesson);
    const s3 = detectSignals("Recreate Module 1");
    check("signals: recreate-module detected (and not delete-module)", s3.wantsRecreateModule && !s3.wantsDeleteModule);
    check("signals: empty message has no structure signal", !hasAnyStructureSignal(detectSignals("hello")));

    // 3. Deterministic emptiness.
    check("empty: a lesson with NO blocks is empty", isLessonEmpty(createLesson("New lesson", 0)));
    const withEmptyDeck = createLesson("L", 0);
    withEmptyDeck.blocks = [createBlock("slide_deck", 0, { emptySlideDeck: true })];
    check("empty: a lesson with only an empty deck is empty", isLessonEmpty(withEmptyDeck));
    const withPlaceholderDeck = createLesson("L", 0);
    withPlaceholderDeck.blocks = [createBlock("slide_deck", 0)]; // default → one placeholder slide
    check("empty: a lesson with only a default placeholder deck is empty", isLessonEmpty(withPlaceholderDeck));
    const withReal = createLesson("L", 0);
    withReal.blocks = [realBlock()];
    check("empty: a lesson with a real (templated) slide is NOT empty", !isLessonEmpty(withReal));

    // 4. Snapshot + target resolution.
    const doc = fixtureDoc([
      { title: "Arrays", lessons: [{ title: "Intro" }, { title: "Two pointers", blocks: [realBlock()] }] },
      { title: "Sorting", lessons: [] },
      { title: "Hashing", lessons: [{ title: "Hash functions", blocks: [realBlock()] }] },
    ]);
    const m3 = doc.modules[2];
    const snap = buildOutlineSnapshot(doc, { moduleId: doc.modules[0].id, lessonId: doc.modules[0].lessons[0].id });
    check("snapshot: 'Module 3' display label + number", snap.modules[2].number === 3 && snap.modules[2].displayName.startsWith("Module 3:"));
    check("snapshot: empty lesson flagged, real lesson not", snap.modules[0].lessons[0].isEmpty && !snap.modules[0].lessons[1].isEmpty);
    check("snapshot: empty-module reported as 0 empty lessons", emptyLessonIds(snap, doc.modules[1].id).length === 0);
    check("snapshot serializes with stable ids", serializeOutlineSnapshot(snap).includes(`lessonId=${doc.modules[0].lessons[0].id}`));
    const rm = resolveModule("recreate Module 3", snap);
    check("resolve: 'Module 3' → the 3rd module by number", rm.status === "clear" && rm.id === m3.id);
    const rmMiss = resolveModule("Module 9", snap);
    check("resolve: a non-existent module number → unsafe", rmMiss.status === "unsafe");
    // Word-number + ordinal module references (the "module one" the regression used).
    const rWordOne = resolveModule("complete module one", snap);
    check("resolve: 'module one' (word number) → the 1st module", rWordOne.status === "clear" && rWordOne.id === doc.modules[0].id);
    const rFirst = resolveModule("finish the first module", snap);
    check("resolve: 'the first module' → the 1st module", rFirst.status === "clear" && rFirst.id === doc.modules[0].id);
    const rLast = resolveModule("fix the last module", snap);
    check("resolve: 'the last module' → the last module", rLast.status === "clear" && rLast.id === doc.modules[doc.modules.length - 1].id);
    // Two lessons sharing a title → ambiguous.
    const ambDoc = fixtureDoc([{ title: "M", lessons: [{ title: "Intro" }, { title: "Intro" }] }]);
    const ambSnap = buildOutlineSnapshot(ambDoc);
    check("resolve: a duplicated lesson title → ambiguous", resolveLesson("the Intro lesson", ambSnap).status === "ambiguous");

    // 5. Validation rule table — the FAILURE CASES the agent must refuse.
    const v = (plan: CourseStructurePlan, msg: string) => validateStructurePlan(plan, detectSignals(msg), snap, msg);
    // add_lesson MUST create a lesson.
    const addMsg = "Add a lesson to Module 3 about resizing";
    check("validate: add-lesson with NO create_lesson is REJECTED", !v(mkPlan({ ops: [] }), addMsg).ok);
    const goodAdd = mkPlan({ ops: [{ op: "create_lesson", moduleId: m3.id, title: "Resizing", objective: null, atIndex: null, tempRef: "L1" }], generateContentFor: [{ tempRef: "L1", lessonId: null, title: "Resizing", objective: "o", contentRequest: "resizing", replaceExisting: false }] });
    check("validate: add-lesson into the NAMED module is OK", v(goodAdd, addMsg).ok);
    const wrongModuleAdd = mkPlan({ ops: [{ op: "create_lesson", moduleId: doc.modules[0].id, title: "Resizing", objective: null, atIndex: null, tempRef: "L1" }] });
    check("validate: add-lesson into the WRONG module is REJECTED", !v(wrongModuleAdd, addMsg).ok);
    // delete_empty may delete ONLY empty lessons.
    const delMsg = "Delete the empty lessons in Module 1";
    const emptyId = doc.modules[0].lessons[0].id; // "Intro" (no blocks)
    const realId = doc.modules[0].lessons[1].id; // "Two pointers" (real deck)
    check("validate: delete-empty of an EMPTY lesson is OK", v(mkPlan({ intent: "delete_empty_lessons", ops: [{ op: "delete_lesson", lessonId: emptyId }] }), delMsg).ok);
    check("validate: delete-empty that targets a NON-empty lesson is REJECTED", !v(mkPlan({ intent: "delete_empty_lessons", ops: [{ op: "delete_lesson", lessonId: realId }] }), delMsg).ok);
    check("validate: delete-empty with NO deletion is REJECTED", !v(mkPlan({ intent: "delete_empty_lessons", ops: [] }), delMsg).ok);
    // recreate_module must stay IN the module (no duplicate, no foreign module).
    const recMsg = "Recreate Module 3";
    const recOk = mkPlan({ intent: "recreate_module", ops: [{ op: "delete_lesson", lessonId: doc.modules[2].lessons[0].id }, { op: "create_lesson", moduleId: m3.id, title: "Fresh", objective: null, atIndex: null, tempRef: "R1" }], generateContentFor: [{ tempRef: "R1", lessonId: null, title: "Fresh", objective: "o", contentRequest: "x", replaceExisting: false }] });
    check("validate: recreate-module rebuilding IN PLACE is OK", v(recOk, recMsg).ok);
    const recWrong = mkPlan({ intent: "recreate_module", ops: [{ op: "create_lesson", moduleId: doc.modules[0].id, title: "Fresh", objective: null, atIndex: null, tempRef: "R1" }] });
    check("validate: recreate-module adding to a DIFFERENT module is REJECTED (the duplicate-module bug)", !v(recWrong, recMsg).ok);
    // rename MUST rename.
    check("validate: rename with NO rename_lesson is REJECTED", !v(mkPlan({ intent: "rename_lesson", ops: [] }), "Rename this lesson to X").ok);
    check("validate: a hallucinated lessonId is REJECTED", !v(mkPlan({ ops: [{ op: "delete_lesson", lessonId: "does-not-exist" }] }), "delete that lesson").ok);
    // REPAIR an existing module in place (set title + fill empty lessons) — OK; touching
    // a DIFFERENT module is rejected (the duplicate-module guard).
    const repairMsg = "module one is unfinished and has empty slides, complete it";
    const repairOk = mkPlan({ intent: "recreate_module", ops: [{ op: "rename_module", moduleId: doc.modules[0].id, title: "Intro" }], generateContentFor: [{ tempRef: null, lessonId: doc.modules[0].lessons[0].id, title: "x", objective: "o", contentRequest: "y", replaceExisting: true }] });
    check("validate: repair-module IN PLACE (rename + fill) is OK", v(repairOk, repairMsg).ok, v(repairOk, repairMsg).errors.join(";"));
    check("validate: repair-module touching a DIFFERENT module is REJECTED", !v(mkPlan({ ops: [{ op: "create_lesson", moduleId: doc.modules[1].id, title: "X", objective: null, atIndex: null, tempRef: "T" }] }), repairMsg).ok);
    check("signals: 'module one is unfinished, complete it' → wantsRepairModule", detectSignals(repairMsg).wantsRepairModule);

    // 6. Plan execution (deterministic).
    const execDoc = fixtureDoc([{ title: "M", lessons: [{ title: "Keep" }, { title: "Old" }] }]);
    const modId = execDoc.modules[0].id;
    const oldId = execDoc.modules[0].lessons[1].id;
    const execPlan = mkPlan({
      ops: [
        { op: "delete_lesson", lessonId: oldId },
        { op: "create_lesson", moduleId: modId, title: "New Lesson Title", objective: "Obj", atIndex: null, tempRef: "T1" },
        { op: "rename_lesson", lessonId: execDoc.modules[0].lessons[0].id, title: "Renamed Keep", objective: null },
      ],
    });
    const exec = executeStructurePlan(execDoc, execPlan, NOW);
    check("execute: applied with no errors", exec.applied && exec.errors.length === 0, exec.errors.join(";"));
    check("execute: records the created lesson + tempRef → real id", exec.createdLessons.length === 1 && exec.createdLessons[0].tempRef === "T1");
    const execMod = findModule(exec.doc, modId)!;
    check("execute: old lesson deleted, new lesson added, kept lesson renamed", execMod.lessons.length === 2 && execMod.lessons.some((l) => l.title === "New Lesson Title") && execMod.lessons.some((l) => l.title === "Renamed Keep") && !execMod.lessons.some((l) => l.id === oldId));
    check("execute: planCreatesLessons / planIsDestructive flags", planCreatesLessons(execPlan) && planIsDestructive(execPlan));

    // 7. Structural diff + revert (byte-restore).
    const base = fixtureDoc([{ title: "M1", lessons: [{ title: "A" }, { title: "B", blocks: [realBlock()] }] }]);
    const baseJson = JSON.stringify(base.modules);
    // Mutate: rename A, delete B, add C.
    let mod = base;
    mod = applied(mod, { action: "UPDATE_TEXT", target: { kind: "lesson", id: base.modules[0].lessons[0].id, field: "title" }, value: "A-renamed" });
    mod = applied(mod, { action: "DELETE_LESSON", lessonId: base.modules[0].lessons[1].id });
    const newLesson = createLesson("C", 99);
    mod = applied(mod, { action: "ADD_LESSON", moduleId: base.modules[0].id, lesson: newLesson });
    const sdiff = diffStructure(base, mod);
    check("diff: detects rename + delete + create (3 changes)", sdiff.length === 3 && sdiff.some((c) => c.op === "update") && sdiff.some((c) => c.op === "delete") && sdiff.some((c) => c.op === "create"), JSON.stringify(sdiff.map((c) => c.op)));
    const reverted = revertChangeSet(mod, sdiff.map(toRevertItem), NOW);
    check("revert: structural change-set restores byte-for-byte", reverted.ok && JSON.stringify(reverted.doc.modules) === baseJson, reverted.ok ? "" : reverted.error);

    // Module delete → revert re-adds the whole subtree.
    const twoMod = fixtureDoc([{ title: "Keep", lessons: [{ title: "k" }] }, { title: "Doomed", lessons: [{ title: "d", blocks: [realBlock()] }] }]);
    const twoJson = JSON.stringify(twoMod.modules);
    const delMod = applied(twoMod, { action: "DELETE_MODULE", moduleId: twoMod.modules[1].id });
    const modDiff = diffStructure(twoMod, delMod);
    check("diff: a module delete is one structural change", modDiff.length === 1 && modDiff[0].op === "delete" && modDiff[0].nodeType === "module");
    const modRevert = revertChangeSet(delMod, modDiff.map(toRevertItem), NOW);
    check("revert: a deleted module is restored with its lessons (byte-for-byte)", modRevert.ok && JSON.stringify(modRevert.doc.modules) === twoJson, modRevert.ok ? "" : modRevert.error);

    // content-only change → no structural change.
    const contentDoc = fixtureDoc([{ title: "M", lessons: [{ title: "L", blocks: [realBlock()] }] }]);
    const editedContent = structuredClone(contentDoc);
    (editedContent.modules[0].lessons[0].blocks[0] as LectureTextBlock).paragraphs.push({ id: "p2", kind: "paragraph", text: "An added paragraph (content-only change)." });
    check("diff: a content-only (block) change produces NO structural change", diffStructure(contentDoc, editedContent).length === 0);
  };
}

/* ─────────────────────────────── PART B — live ─────────────────────────────── */

// A reusable lesson PLAN + slide batch for the chained deck-generation scenario
// (mirrors verify-agent-integration's clean micro-lesson pipeline).
const BODY = "A hash table maps keys to buckets; resizing rehashes entries when the load factor grows past a threshold.";
const slide = (specId: string, title: string) => ({ slideSpecId: specId, template: { layoutId: "prose", content: { title: { text: title }, body: { text: BODY } } }, notes: "notes" });
const LESSON_PLAN = {
  objective: "Explain hash table resizing.",
  targetStudent: "beginners",
  estimatedMinutes: 10,
  microLesson: true,
  teachingArc: { hook: "tables fill up", coreConcepts: ["load factor"], workedExamples: ["resize"], commonMisconceptions: ["resizing is free"], recapGoal: "name the steps" },
  segments: [{ id: "seg", name: "Core", purpose: "concept_intro", targetSlideCount: 3 }],
  slides: [
    { segmentId: "seg", title: "Load factor", teachingGoal: "define load factor", role: "definition", kind: "core", layout: "prose", depth: "definition", keyPoints: ["entries / buckets"], notes: "n/m", visualIntent: null, requiredElements: null, speakerNotesGoal: "define it" },
    { segmentId: "seg", title: "Resizing", teachingGoal: "show a resize", role: "worked_example", kind: "enrichment", layout: "prose", depth: "mechanism", keyPoints: ["double + rehash"], notes: "amortized", visualIntent: null, requiredElements: null, speakerNotesGoal: "walk it" },
    { segmentId: "seg", title: "Recap", teachingGoal: "summarize", role: "recap", kind: "core", layout: "prose", depth: "analysis", keyPoints: ["resize when full"], notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "consolidate" },
  ],
  quizPlan: null,
  homeworkPlan: null,
};

async function partB() {
  console.log("\n# PART B — end-to-end scenarios (live Supabase + mock provider)");
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");

  const email = `struct-itest-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: signin, error: signinErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signinErr || !signin.user) throw new Error(`signin failed: ${signinErr?.message}`);
  const userId = signin.user.id;
  console.log(`# provisioned ${email}`);

  // Seed via the REAL reconcile path (so the DB matches the app's own writes).
  const seedDoc = fixtureDoc([
    { title: "Arrays", lessons: [{ title: "Intro arrays", blocks: [realBlock()] }, { title: "Two pointers", blocks: [realBlock()] }] }, // Module 1 (recreate target)
    { title: "Sorting", lessons: [{ title: "Bubble sort", blocks: [realBlock()] }] }, // Module 2 (delete target)
    { title: "Hashing", lessons: [{ title: "Hash functions", blocks: [realBlock()] }] }, // Module 3 (add target)
    { title: "Scratch", lessons: [{ title: "New lesson" /* empty */ }, { title: "Docked", blocks: [realBlock()] }] }, // empties + docked
    { title: "New module", lessons: [{ title: "New lesson" /* empty, no title */ }] }, // Module 5 (repair target)
  ]);
  const courseId = seedDoc.id;
  // reconcileCourseDoc only UPDATES the course row (the autosave path assumes it
  // exists) — so create it first, then reconcile the module/lesson/block tree.
  const { error: courseErr } = await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: seedDoc.title,
    description: seedDoc.description,
    audience: seedDoc.audience,
    level: seedDoc.level,
    plan: seedDoc.plan as never,
    theme: seedDoc.theme as never,
  });
  if (courseErr) throw new Error(`course insert: ${courseErr.message}`);
  const err = await reconcileCourseDoc(supabase, seedDoc, userId);
  if (err) throw new Error(`seed reconcile: ${err}`);
  console.log("# seeded course (4 modules)");

  const m1 = seedDoc.modules[0];
  const m2 = seedDoc.modules[1];
  const m3 = seedDoc.modules[2];
  const scratch = seedDoc.modules[3];
  const emptyLesson = scratch.lessons[0]; // "New lesson"
  const dockedLesson = scratch.lessons[1]; // "Docked" (the agent must NOT touch this)
  const untitledModule = seedDoc.modules[4]; // "New module" — repair target (no title, empty)
  const untitledLesson = untitledModule.lessons[0];
  const conversationId = await getOrCreateConversation(supabase, courseId, dockedLesson.id);

  const drive = async (userMessage: string, plan: CourseStructurePlan, script: Parameters<typeof createMockModelClient>[0] = [], extraStructured: Record<string, unknown> = {}) => {
    const events: AgentEvent[] = [];
    const model = createMockModelClient(script, { finalText: "Done.", structured: { course_structure_plan: plan, lesson_outline: LESSON_PLAN, ...extraStructured } });
    await runStructureAgentTurn({ supabase, model, courseId, lessonId: dockedLesson.id, ownerId: userId, conversationId, userMessage, emit: (e) => events.push(e), autoApprove: true });
    return events;
  };

  // ── Scenario 1: add a lesson to Module 3 (+ build its deck) — docked deck UNTOUCHED.
  console.log("\n## Scenario 1 — add a lesson to a specific module");
  const dockedBefore = JSON.stringify((await loadCourseDoc(supabase, courseId))!.modules.find((m) => m.id === scratch.id)!.lessons.find((l) => l.id === dockedLesson.id)!.blocks);
  const s1Events = await drive(
    "Add a lesson to Module 3 that goes deeper into hashing, like resizing and load factor.",
    mkPlan({ intent: "add_lesson", summary: "I'll add a lesson on resizing to Module 3 and build its deck.", ops: [{ op: "create_lesson", moduleId: m3.id, title: "Hash Table Resizing", objective: "Explain resizing and load factor.", atIndex: null, tempRef: "L1" }], generateContentFor: [{ tempRef: "L1", lessonId: null, title: "Hash Table Resizing", objective: "Explain resizing.", contentRequest: "resizing, load factor", replaceExisting: false }] }),
    [{ text: "Authoring.", toolCalls: [{ name: "add_structured_slides_batch", arguments: { deckBlockId: null, slides: [slide("s1", "Load factor"), slide("s2", "Resizing"), slide("s3", "Recap")] } }] }, { text: "", toolCalls: [] }]
  );
  const afterS1 = (await loadCourseDoc(supabase, courseId))!;
  const m3After = afterS1.modules.find((m) => m.id === m3.id)!;
  const newLesson = m3After.lessons.find((l) => l.title === "Hash Table Resizing");
  check("S1: a new lesson was created in Module 3", !!newLesson && m3After.lessons.length === 2);
  check("S1: the new lesson got a slide deck with the generated slides", !!newLesson && newLesson.blocks.some((b) => b.type === "slide_deck" && b.slides.length >= 3));
  const dockedAfter = JSON.stringify(afterS1.modules.find((m) => m.id === scratch.id)!.lessons.find((l) => l.id === dockedLesson.id)!.blocks);
  check("S1: the DOCKED lesson's deck is UNTOUCHED (the core bug)", dockedAfter === dockedBefore);
  const s1Nodes = await getPendingNodes(supabase, courseId);
  check("S1: a structural lesson-create item is staged for review", s1Nodes.some((n) => n.nodeType === "lesson" && n.op === "create" && n.nodeId === newLesson?.id));
  check("S1: a structure change-set event carried a structuralCount", s1Events.some((e) => e.type === "change_set" && (e.structuralCount ?? 0) >= 1));
  // Clean the pending sets so later scenarios assert from a clean slate.
  await acceptAll(supabase, courseId);

  // ── Scenario 2: delete empty lessons + add new ones.
  console.log("\n## Scenario 2 — delete empty lessons");
  await drive(
    "Module 4 is half empty — delete the empty lessons and add a proper one.",
    mkPlan({ intent: "delete_empty_lessons", summary: "Remove the empty lesson and add a real one.", ops: [{ op: "delete_lesson", lessonId: emptyLesson.id }, { op: "create_lesson", moduleId: scratch.id, title: "Arrays in Practice", objective: "Apply arrays.", atIndex: null, tempRef: "N1" }] })
  );
  const afterS2 = (await loadCourseDoc(supabase, courseId))!;
  const scratchAfter = afterS2.modules.find((m) => m.id === scratch.id)!;
  check("S2: the empty 'New lesson' was deleted", !scratchAfter.lessons.some((l) => l.id === emptyLesson.id));
  check("S2: no 'New lesson' titles remain", !scratchAfter.lessons.some((l) => l.title === "New lesson"));
  check("S2: a meaningfully-titled lesson was created", scratchAfter.lessons.some((l) => l.title === "Arrays in Practice"));
  check("S2: the docked (non-empty) lesson was kept", scratchAfter.lessons.some((l) => l.id === dockedLesson.id));
  await acceptAll(supabase, courseId);

  // ── Scenario 3: recreate Module 1 IN PLACE (no duplicate module).
  console.log("\n## Scenario 3 — recreate a module's lessons in place");
  const moduleCountBefore = afterS2.modules.length;
  await drive(
    "Delete and recreate the lessons for Module 1 — they're outdated.",
    mkPlan({ intent: "recreate_module", summary: "Rebuild Module 1's lessons in place.", ops: [
      { op: "delete_lesson", lessonId: m1.lessons[0].id },
      { op: "delete_lesson", lessonId: m1.lessons[1].id },
      { op: "create_lesson", moduleId: m1.id, title: "Arrays, Reborn", objective: "Fresh take.", atIndex: null, tempRef: "F1" },
    ] })
  );
  const afterS3 = (await loadCourseDoc(supabase, courseId))!;
  check("S3: NO duplicate module created (module count unchanged)", afterS3.modules.length === moduleCountBefore, `before ${moduleCountBefore}, after ${afterS3.modules.length}`);
  check("S3: no 'Module 1...' duplicate title appeared", afterS3.modules.filter((m) => m.title.includes(m1.title)).length === 1);
  const m1After = afterS3.modules.find((m) => m.id === m1.id)!;
  check("S3: Module 1 was rebuilt IN PLACE (old lessons gone, fresh one present)", !m1After.lessons.some((l) => l.id === m1.lessons[0].id) && m1After.lessons.some((l) => l.title === "Arrays, Reborn"));
  await acceptAll(supabase, courseId);

  // ── Scenario 5: rename a lesson (+ reject restores).
  console.log("\n## Scenario 5 — rename a lesson + reject restores");
  const renameTarget = m2.lessons[0]; // "Bubble sort"
  const s5Events = await drive(
    "Rename the Bubble sort lesson to Sorting Fundamentals.",
    mkPlan({ intent: "rename_lesson", summary: "Rename the lesson.", ops: [{ op: "rename_lesson", lessonId: renameTarget.id, title: "Sorting Fundamentals", objective: null }] })
  );
  const afterS5 = (await loadCourseDoc(supabase, courseId))!;
  check("S5: the lesson's metadata title was updated", findLesson(afterS5, renameTarget.id)?.lesson.title === "Sorting Fundamentals");
  const s5Cs = s5Events.find((e) => e.type === "change_set");
  const s5CsId = s5Cs && s5Cs.type === "change_set" ? s5Cs.changeSetId : null;
  check("S5: a structural rename item was staged", (await getPendingNodes(supabase, courseId)).some((n) => n.nodeId === renameTarget.id && n.op === "update"));
  if (s5CsId) await rejectChangeSet(supabase, s5CsId, userId);
  const afterReject = (await loadCourseDoc(supabase, courseId))!;
  check("S5: REJECT restores the original lesson title", findLesson(afterReject, renameTarget.id)?.lesson.title === "Bubble sort");
  await acceptAll(supabase, courseId);

  // ── Scenario 6: ambiguous target → clarify, no DB change.
  console.log("\n## Scenario 6 — ambiguous target asks instead of guessing");
  const beforeS6 = JSON.stringify((await loadCourseDoc(supabase, courseId))!.modules);
  const s6Events = await drive(
    "Fix the module.",
    mkPlan({ intent: "reorder", summary: "", ops: [], clarification: "Which module do you mean — Module 1: Arrays, or another? And what should I change?" })
  );
  check("S6: the agent asked a clarifying question", s6Events.some((e) => e.type === "assistant_message" && /which module/i.test(e.content)));
  check("S6: NO change-set was staged", !s6Events.some((e) => e.type === "change_set"));
  check("S6: the course is unchanged", JSON.stringify((await loadCourseDoc(supabase, courseId))!.modules) === beforeS6);

  // ── Scenario 7: destructive delete is staged + reject restores the structure.
  console.log("\n## Scenario 7 — destructive delete staged + reject-restored");
  const beforeS7 = (await loadCourseDoc(supabase, courseId))!;
  const m2Before = JSON.stringify(beforeS7.modules.find((m) => m.id === m2.id));
  const s7Events = await drive(
    "Delete Module 2 entirely.",
    mkPlan({ intent: "delete_module", summary: "Delete the module.", ops: [{ op: "delete_module", moduleId: m2.id }] })
  );
  const afterS7 = (await loadCourseDoc(supabase, courseId))!;
  check("S7: the module was deleted + persisted", !afterS7.modules.some((m) => m.id === m2.id));
  const s7Nodes = await getPendingNodes(supabase, courseId);
  check("S7: a structural module-delete item is staged for review", s7Nodes.some((n) => n.nodeType === "module" && n.op === "delete" && n.nodeId === m2.id));
  const s7Cs = s7Events.find((e) => e.type === "change_set");
  const s7CsId = s7Cs && s7Cs.type === "change_set" ? s7Cs.changeSetId : null;
  if (s7CsId) await rejectChangeSet(supabase, s7CsId, userId);
  const afterS7Reject = (await loadCourseDoc(supabase, courseId))!;
  const m2Restored = afterS7Reject.modules.find((m) => m.id === m2.id);
  check("S7: REJECT restores the whole module subtree", !!m2Restored && JSON.stringify(m2Restored) === m2Before);

  // ── Scenario 8: "complete module one" — repair an EXISTING module IN PLACE (the
  //    real-world regression: it must NOT create a new module). Drives the FULL
  //    runContentAgentTurn so the routing fix (classify → structure) is exercised.
  console.log("\n## Scenario 8 — complete/repair an existing module in place (no new module)");
  const moduleCountBeforeS8 = (await loadCourseDoc(supabase, courseId))!.modules.length;
  const s8Events: AgentEvent[] = [];
  const s8Plan = mkPlan({
    intent: "recreate_module",
    summary: "I'll give the last module a title and fill out its empty lesson.",
    ops: [
      { op: "rename_module", moduleId: untitledModule.id, title: "Introduction to Economics" },
      { op: "rename_lesson", lessonId: untitledLesson.id, title: "What Economics Studies", objective: "Scarcity, choice, and markets." },
    ],
    generateContentFor: [{ tempRef: null, lessonId: untitledLesson.id, title: "What Economics Studies", objective: "Scarcity and markets.", contentRequest: "scarcity, capitalism, socialism, mixed economies, diamond-water paradox", replaceExisting: true }],
  });
  const s8Model = createMockModelClient(
    [{ text: "Authoring.", toolCalls: [{ name: "add_structured_slides_batch", arguments: { deckBlockId: null, slides: [slide("s1", "What economics studies"), slide("s2", "Scarcity"), slide("s3", "Recap")] } }] }, { text: "", toolCalls: [] }],
    { finalText: "Done.", structured: { course_structure_plan: s8Plan, lesson_outline: LESSON_PLAN } }
  );
  await runContentAgentTurn({
    supabase, model: s8Model, courseId, lessonId: dockedLesson.id, ownerId: userId, conversationId,
    userMessage: "the last module is very unfinished — it has no title and only empty slides. Please complete it as an introductory economics module covering scarcity, capitalism, socialism, mixed economies, and the diamond-water paradox.",
    emit: (e: AgentEvent) => s8Events.push(e), autoApprove: true,
  });
  const afterS8 = (await loadCourseDoc(supabase, courseId))!;
  check("S8: routed to STRUCTURE — module count UNCHANGED (no duplicate module)", afterS8.modules.length === moduleCountBeforeS8, `before ${moduleCountBeforeS8}, after ${afterS8.modules.length}`);
  const repairedModule = afterS8.modules.find((m) => m.id === untitledModule.id)!;
  check("S8: the module got a real title (renamed in place, not a new module)", repairedModule.title === "Introduction to Economics");
  const repairedLesson = repairedModule.lessons.find((l) => l.id === untitledLesson.id)!;
  check("S8: the empty lesson was renamed + got a generated deck", repairedLesson.title === "What Economics Studies" && repairedLesson.blocks.some((b) => b.type === "slide_deck" && b.slides.length >= 3));
  check("S8: Structure bucket — a module rename is staged for review", (await getPendingNodes(supabase, courseId)).some((n) => n.nodeType === "module" && n.op === "update" && n.nodeId === untitledModule.id));
  await acceptAll(supabase, courseId);

  // cleanup
  await supabase.from("courses").delete().eq("id", courseId);
  console.log("# cleaned up course");
}

/** Accept every pending change-set so the next scenario starts from a clean slate. */
async function acceptAll(supabase: ReturnType<typeof createClient<Database>>, courseId: string) {
  const { data: sets } = await supabase.from("change_sets").select("id").eq("course_id", courseId).eq("status", "pending");
  for (const s of sets ?? []) await supabase.from("change_sets").update({ status: "accepted", resolved_at: NOW }).eq("id", s.id);
}

async function main() {
  const runRouting = partA();
  await runRouting();
  await partB();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
