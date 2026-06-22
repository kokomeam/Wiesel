/**
 * End-to-end integration test of the agent loop against LIVE Supabase, driven
 * by the deterministic MOCK provider (no OpenAI key needed).
 * Run: `npx tsx scripts/verify-agent-integration.ts`
 *
 * Provisions a throwaway user + course, runs an agent turn that authors a deck
 * and a quiz, and asserts: blocks persist, a pending change-set + items are
 * recorded, the blocks reload from the DB, Accept resolves the set, and Reject
 * of a later edit restores the prior content.
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean them
 * in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { runAgentTurn, resumeAgentTurn, runConversationLoop, loopContext } from "@/lib/ai/agentLoop";
import { runContentAgentTurn, runGenerateLessonTurn, resumeGeneratePlan } from "@/lib/ai/phases";
import { getOrCreateConversation } from "@/lib/ai/conversations";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { loadCourseDoc } from "@/lib/ai/serverPersistence";
import { getPendingBlocks, acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import type { AgentEvent } from "@/lib/ai/events";
import { findBlock, findLesson } from "@/lib/course/queries";
import { createBlock } from "@/lib/course/factories";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
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

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");

  // 1. fresh throwaway user (email confirmation is OFF)
  const email = `agent-itest-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  console.log(`# provisioned ${email}`);

  const supabase = createClient<Database>(url, anon);
  const { data: signin, error: signinErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signinErr || !signin.user) throw new Error(`signin failed: ${signinErr?.message}`);
  const userId = signin.user.id;

  // 2. seed a course + module + lesson
  const courseId = crypto.randomUUID();
  const moduleId = crypto.randomUUID();
  const lessonId = crypto.randomUUID();
  {
    const { error } = await supabase.from("courses").insert({
      id: courseId, author_id: userId, title: "Two Pointers 101",
      description: "Core array patterns.", audience: "beginner CP", level: "beginner",
      plan: { outcomes: ["Apply two pointers"], prerequisites: [], teachingStyle: "friendly" } as never,
      theme: defaultCourseTheme() as never,
    });
    if (error) throw new Error(`course insert: ${error.message}`);
    const { error: me } = await supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: "Foundations", order: 0 });
    if (me) throw new Error(`module insert: ${me.message}`);
    const { error: le } = await supabase.from("lessons").insert({ id: lessonId, module_id: moduleId, course_id: courseId, title: "What is two pointers?", order: 0 });
    if (le) throw new Error(`lesson insert: ${le.message}`);
  }
  console.log("# seeded course/module/lesson");

  // 3. run an agent turn (mock authors a deck + a quiz, then a final message)
  console.log("\n# agent turn 1 — author deck + quiz");
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => events.push(e);
  const model = createMockModelClient(
    [
      {
        text: "I'll add a short intro deck and a quick knowledge check.",
        toolCalls: [
          { name: "write_slide_deck", arguments: { blockId: null, lessonId: null, title: "Intro deck", slides: [
            { layout: "title_bullets", content: [
              { role: "title", text: [{ text: "Two Pointers", bold: null, italic: null }], items: null },
              { role: "main_points", text: null, items: ["Walk from both ends", "Each step justified"] },
            ], notes: "Zipper analogy." },
            { layout: "title", content: [
              { role: "title", text: [{ text: "Why O(n)", bold: null, italic: null }], items: null },
              { role: "subtitle", text: [{ text: "No backtracking; each element seen once", bold: null, italic: null }], items: null },
            ], notes: null },
          ] } },
          { name: "write_quiz", arguments: { blockId: null, lessonId: null, title: "Quick check", questions: [
            { kind: "multiple_choice", prompt: "How many pointers?", explanation: "Two.", choices: ["One", "Two", "Three"], correctIndex: 1 },
            { kind: "true_false", prompt: "It can be O(n).", explanation: "Yes.", correctAnswer: true },
          ] } },
        ],
      },
    ],
    { finalText: "Done — added a 2-slide deck and a 2-question check. Want me to expand the deck?" }
  );

  const conversationId = await getOrCreateConversation(supabase, courseId, lessonId);
  await runAgentTurn({ supabase, model, courseId, lessonId, ownerId: userId, conversationId, userMessage: "Write an intro deck and a knowledge check.", emit });

  const toolResults = events.filter((e) => e.type === "tool_result");
  check("two tool_result events", toolResults.length === 2, `got ${toolResults.length}`);
  check("all tool results ok", toolResults.every((e) => e.type === "tool_result" && e.ok));
  const changeSetEvent = events.find((e) => e.type === "change_set");
  check("change_set event emitted", !!changeSetEvent && changeSetEvent.type === "change_set" && changeSetEvent.count === 2, JSON.stringify(changeSetEvent));
  check("done event", events.at(-1)?.type === "done");

  // 4. verify persistence: reload doc from DB
  const reloaded = await loadCourseDoc(supabase, courseId);
  const lessonBlocks = reloaded?.modules[0].lessons[0].blocks ?? [];
  check("2 blocks persisted + reload", lessonBlocks.length === 2, `got ${lessonBlocks.length}`);
  check("a slide_deck + a quiz", lessonBlocks.some((b) => b.type === "slide_deck") && lessonBlocks.some((b) => b.type === "quiz"));

  // 5. pending blocks
  const pending = await getPendingBlocks(supabase, courseId);
  check("2 pending blocks", pending.length === 2, `got ${pending.length}`);
  const changeSetId = (changeSetEvent && changeSetEvent.type === "change_set") ? changeSetEvent.changeSetId : "";

  // 6. accept → pending cleared
  console.log("\n# accept the change-set");
  await acceptChangeSet(supabase, changeSetId);
  const afterAccept = await getPendingBlocks(supabase, courseId);
  check("no pending after accept", afterAccept.length === 0, `got ${afterAccept.length}`);

  // 7. turn 2 updates the quiz, then we REJECT and expect restore
  console.log("\n# agent turn 2 — overwrite quiz, then reject restores it");
  const quizBlock = lessonBlocks.find((b) => b.type === "quiz")!;
  const beforeReject = await loadCourseDoc(supabase, courseId);
  const quizBefore = JSON.stringify(findBlock(beforeReject!, quizBlock.id)?.block);

  const events2: AgentEvent[] = [];
  const model2 = createMockModelClient([
    { text: "Replacing the quiz.", toolCalls: [
      { name: "write_quiz", arguments: { blockId: quizBlock.id, lessonId: null, title: "REPLACED", questions: [
        { kind: "true_false", prompt: "changed?", explanation: "yes", correctAnswer: false },
      ] } },
    ] },
  ], { finalText: "Replaced the quiz." });
  await runAgentTurn({ supabase, model: model2, courseId, lessonId, ownerId: userId, conversationId, userMessage: "Replace the quiz.", emit: (e) => events2.push(e) });

  const cs2 = events2.find((e) => e.type === "change_set");
  const afterEdit = await loadCourseDoc(supabase, courseId);
  check("quiz overwritten (title REPLACED)", findBlock(afterEdit!, quizBlock.id)?.block.title === "REPLACED");

  const cs2Id = (cs2 && cs2.type === "change_set") ? cs2.changeSetId : "";
  await rejectChangeSet(supabase, cs2Id, userId);
  const afterRejectDoc = await loadCourseDoc(supabase, courseId);
  const quizAfter = JSON.stringify(findBlock(afterRejectDoc!, quizBlock.id)?.block);
  check("reject restored the quiz exactly", quizAfter === quizBefore, "content differs after restore");
  check("no pending after reject resolved", (await getPendingBlocks(supabase, courseId)).length === 0);

  // 8. delete pause→confirm: the agent calls delete_module, PAUSES, the user
  //    confirms, and only then is the module removed + persisted.
  console.log("\n# agent turn 3 — delete a module (pause → confirm)");
  const delModuleId = crypto.randomUUID();
  const delLessonId = crypto.randomUUID();
  await supabase.from("modules").insert({ id: delModuleId, course_id: courseId, title: "Scratch", order: 1 });
  await supabase.from("lessons").insert({ id: delLessonId, module_id: delModuleId, course_id: courseId, title: "Temp", order: 0 });

  const events3: AgentEvent[] = [];
  const model3 = createMockModelClient(
    [{ text: "Deleting the Scratch module.", toolCalls: [{ name: "delete_module", arguments: { moduleId: delModuleId } }] }],
    { finalText: "(should not reach here on a pause)" }
  );
  await runAgentTurn({ supabase, model: model3, courseId, lessonId, ownerId: userId, conversationId, userMessage: "Delete the Scratch module.", emit: (e) => events3.push(e) });

  const confirmReq = events3.find((e) => e.type === "confirmation_request");
  check("delete_module PAUSES with a confirmation_request", !!confirmReq && confirmReq.type === "confirmation_request", JSON.stringify(events3.map((e) => e.type)));
  check("module NOT yet deleted while paused", !!(await loadCourseDoc(supabase, courseId))?.modules.some((m) => m.id === delModuleId));
  check("no change_set emitted for the paused delete", !events3.some((e) => e.type === "change_set"));

  const events4: AgentEvent[] = [];
  if (confirmReq && confirmReq.type === "confirmation_request") {
    const model4 = createMockModelClient([], { finalText: "Removed the Scratch module." });
    await resumeAgentTurn({
      supabase, model: model4, courseId, lessonId, ownerId: userId, conversationId,
      toolCallId: confirmReq.toolCallId, toolMessageId: confirmReq.toolMessageId,
      kind: confirmReq.kind, label: confirmReq.label, patch: confirmReq.patch,
      decision: "confirm", emit: (e) => events4.push(e),
    });
  }
  const afterConfirm = await loadCourseDoc(supabase, courseId);
  check("module DELETED + persisted after confirm", !afterConfirm?.modules.some((m) => m.id === delModuleId));
  check("a 'Deleted' tool_result emitted on resume", events4.some((e) => e.type === "tool_result" && /Deleted/.test(e.summary)));

  // 9. delete pause→cancel: the agent calls delete_lesson, the user cancels, and
  //    the lesson is KEPT.
  console.log("\n# agent turn 4 — delete a lesson (pause → cancel keeps it)");
  const events5: AgentEvent[] = [];
  const model5 = createMockModelClient(
    [{ text: "Deleting this lesson.", toolCalls: [{ name: "delete_lesson", arguments: { lessonId } }] }],
    { finalText: "(unused)" }
  );
  await runAgentTurn({ supabase, model: model5, courseId, lessonId, ownerId: userId, conversationId, userMessage: "Delete this lesson.", emit: (e) => events5.push(e) });
  const confirmReq2 = events5.find((e) => e.type === "confirmation_request");
  check("delete_lesson PAUSES with a confirmation_request", !!confirmReq2 && confirmReq2.type === "confirmation_request");

  const events6: AgentEvent[] = [];
  if (confirmReq2 && confirmReq2.type === "confirmation_request") {
    const model6 = createMockModelClient([], { finalText: "Okay, I kept it." });
    await resumeAgentTurn({
      supabase, model: model6, courseId, lessonId, ownerId: userId, conversationId,
      toolCallId: confirmReq2.toolCallId, toolMessageId: confirmReq2.toolMessageId,
      kind: confirmReq2.kind, label: confirmReq2.label, patch: confirmReq2.patch,
      decision: "cancel", emit: (e) => events6.push(e),
    });
  }
  const afterCancel = await loadCourseDoc(supabase, courseId);
  check("lesson KEPT after cancel", !!findLesson(afterCancel!, lessonId));
  check("a 'Kept' tool_result emitted on cancel", events6.some((e) => e.type === "tool_result" && /Kept/.test(e.summary)));

  // 10. REGRESSION — change_sets_lesson_id_fkey. The docked `lessonId` is
  //     client-supplied and can be a not-yet-persisted / stale id with no
  //     `lessons` row. A tool still SUCCEEDS (it edits a block in a REAL lesson,
  //     found by id), then staging must NOT crash: the change_set's lesson_id is
  //     coalesced to an existing lesson (or NULL), never the bogus docked id.
  console.log("\n# agent turn 5 — divergent (non-existent) docked lessonId");
  const bogusLessonId = crypto.randomUUID(); // valid UUID shape, no lessons row
  const eventsFk: AgentEvent[] = [];
  const modelFk = createMockModelClient(
    [
      { text: "Adding a recap quiz.", toolCalls: [
        // Tool targets the REAL lesson explicitly; the TURN's docked lesson is bogus.
        { name: "write_quiz", arguments: { blockId: null, lessonId, title: "Recap check", questions: [
          { kind: "true_false", prompt: "Recap?", explanation: "Yes.", correctAnswer: true },
        ] } },
      ] },
    ],
    { finalText: "Added a recap." }
  );
  await runAgentTurn({ supabase, model: modelFk, courseId, lessonId: bogusLessonId, ownerId: userId, conversationId, userMessage: "Add a recap.", emit: (e) => eventsFk.push(e) });

  check("divergent lessonId: tool still succeeds", eventsFk.some((e) => e.type === "tool_result" && e.ok));
  check("divergent lessonId: no error event (no FK crash)", !eventsFk.some((e) => e.type === "error"), JSON.stringify(eventsFk.filter((e) => e.type === "error")));
  const csFk = eventsFk.find((e) => e.type === "change_set");
  check("divergent lessonId: change_set still emitted", !!csFk && csFk.type === "change_set");
  if (csFk && csFk.type === "change_set") {
    const { data: row } = await supabase.from("change_sets").select("lesson_id").eq("id", csFk.changeSetId).single();
    check("change_set lesson_id is NOT the bogus docked id", row?.lesson_id !== bogusLessonId, String(row?.lesson_id));
    check("change_set lesson_id coalesced to the real (changed) lesson", row?.lesson_id === lessonId, String(row?.lesson_id));
  }

  // conversations_lesson_id_fkey twin: a brand-new thread for a non-existent
  // lesson stores lesson_id = NULL instead of violating the FK.
  const convBogus = await getOrCreateConversation(supabase, courseId, crypto.randomUUID());
  const { data: convRow } = await supabase.from("conversations").select("lesson_id").eq("id", convBogus).single();
  check("new conversation for a non-existent lesson stores lesson_id NULL", convRow?.lesson_id === null, String(convRow?.lesson_id));

  // 11. PHASED PIPELINE — PLAN → GENERATE → VALIDATE/REPAIR → (light review) → stage.
  console.log("\n# phased pipeline — plan → generate → validate/repair → stage");
  const pModuleId = crypto.randomUUID();
  const pLessonId = crypto.randomUUID();
  await supabase.from("modules").insert({ id: pModuleId, course_id: courseId, title: "Trees", order: 2 });
  await supabase.from("lessons").insert({ id: pLessonId, module_id: pModuleId, course_id: courseId, title: "Intro to binary trees", objective: "Define a tree and its parts; insertion cost.", order: 0 });
  const pConvo = await getOrCreateConversation(supabase, courseId, pLessonId);

  // A real-enough teaching paragraph so generated slides aren't flagged "thin".
  const BODY = "A binary tree is a hierarchy where each node has up to two children, called left and right, rooted at a single top node.";
  /** A prose slide for an add_structured_slides_batch entry, stamped with a spec id. */
  const slide = (specId: string | null, title: string, notes: string | null = "Speaker notes for this slide.") => ({
    slideSpecId: specId,
    template: { layoutId: "prose", content: { title: { text: title }, body: { text: BODY } } },
    notes,
  });
  /** A structured-authoring batch into the docked lesson's deck (deckBlockId null). */
  const batchCall = (slides: ReturnType<typeof slide>[]) => ({
    name: "add_structured_slides_batch",
    arguments: { deckBlockId: null, slides },
  });

  // A full lesson PLAN (microLesson so the depth floor doesn't re-ask). 3 specs → s1..s3.
  const LESSON_PLAN = {
    objective: "Define a binary tree and its parts.",
    targetStudent: "beginners with no CS background",
    estimatedMinutes: 10,
    microLesson: true,
    teachingArc: { hook: "trees are everywhere", coreConcepts: ["node", "root"], workedExamples: ["insert a value"], commonMisconceptions: ["a tree is a list"], recapGoal: "name the parts" },
    segments: [{ id: "seg", name: "Core", purpose: "concept_intro", targetSlideCount: 3 }],
    slides: [
      { segmentId: "seg", title: "What a tree is", teachingGoal: "define a tree", role: "definition", kind: "core", layout: "prose", depth: "definition", keyPoints: ["nodes and edges"], notes: "node/root/leaf", visualIntent: null, requiredElements: null, speakerNotesGoal: "define the parts" },
      { segmentId: "seg", title: "Insertion", teachingGoal: "insert a value", role: "worked_example", kind: "enrichment", layout: "prose", depth: "mechanism", keyPoints: ["compare and descend"], notes: "O(log n)", visualIntent: null, requiredElements: null, speakerNotesGoal: "walk the insert" },
      { segmentId: "seg", title: "Recap", teachingGoal: "summarize", role: "recap", kind: "core", layout: "prose", depth: "analysis", keyPoints: ["root, nodes, leaves"], notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "consolidate" },
    ],
    quizPlan: null,
    homeworkPlan: null,
  };
  // The compact module SKELETON the first plan call returns (lesson briefs, NO
  // per-slide content). Each lesson's rich contract is planned lazily on approve.
  const brief = (title: string, objective: string, quiz = false) => ({
    title, objective, rationale: `teaches ${title.toLowerCase()}`, prerequisiteLessons: [], skillsIntroduced: [title], skillsPracticed: [],
    estimatedMinutes: 10, minSlides: 6, maxSlides: 9, suggestedBlocks: quiz ? ["slide_deck", "quiz"] : ["slide_deck"], recommendQuiz: quiz, recommendHomework: false, dependencyNotes: null,
  });
  const SKELETON = {
    moduleTitle: "Searching", moduleObjective: "Find things in arrays.", summary: "Two ways to search.", audienceLevel: "beginners", prerequisites: [],
    lessons: [brief("Linear search", "Scan an array in order."), brief("Binary search", "Halve a sorted range.", true)],
    assessmentGoal: null, pacingNotes: null,
  };

  // 11a. PLAN pause path (LESSON_BUILD message → classifier short-circuits, no model call).
  const pauseMock = createMockModelClient([{ text: JSON.stringify(LESSON_PLAN) }], { finalText: "" });
  const evPlan: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: pauseMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Build a full lesson deck on binary trees", emit: (e) => evPlan.push(e),
  });
  const planEvt = evPlan.find((e) => e.type === "phase" && e.phase === "plan");
  const outlineEvt = evPlan.find((e) => e.type === "plan_outline");
  const lessonPlan = outlineEvt && outlineEvt.type === "plan_outline" ? outlineEvt.plan : null;
  check("PLAN emits a phase:plan event", !!planEvt);
  check("PLAN emits a lesson plan_outline with the 3 planned slides", !!lessonPlan && lessonPlan.kind === "lesson" && lessonPlan.outline.slides.length === 3);
  check("a micro lesson plan does NOT trigger the depth re-ask (one PLAN call)", pauseMock.getCalls().length === 1, `${pauseMock.getCalls().length}`);
  check("PLAN pauses — no change_set yet", !evPlan.some((e) => e.type === "change_set"));
  check("PLAN call used effort:high + responseFormat (per-call)", pauseMock.getCalls()[0]?.effort === "high" && !!pauseMock.getCalls()[0]?.responseFormat);
  check("PLAN call used the cheap default model gpt-5.4-mini (per-call)", pauseMock.getCalls()[0]?.model === "gpt-5.4-mini", pauseMock.getCalls()[0]?.model);
  const planCall = pauseMock.getCalls()[0];
  check("B: PLAN system is static (no COURSE CONTEXT leak into the cached prefix)", !(planCall?.system ?? "").includes("COURSE CONTEXT"));
  check("B: PLAN context rides in a leading developer input message", (planCall?.input ?? []).some((i) => "role" in i && i.role === "developer" && i.content.includes("COURSE CONTEXT")));

  // 11b. Approve → GENERATE → VALIDATE (clean) → ONE change-set.
  const resumeMock = createMockModelClient([
    { text: "Authoring the deck.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), slide("s3", "Recap")])] },
    { text: "", toolCalls: [] }, // ends GENERATE loop
  ], { finalText: "Done — generated." });
  const evApprove: AgentEvent[] = [];
  await resumeGeneratePlan({
    supabase, model: resumeMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    plan: lessonPlan ?? { kind: "lesson", lessonId: pLessonId, outline: LESSON_PLAN }, decision: "approve", emit: (e) => evApprove.push(e),
  });
  const phaseSeq = evApprove.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("approve runs GENERATE then VALIDATE (critique replaced)", JSON.stringify(phaseSeq) === JSON.stringify(["generate", "validate"]), JSON.stringify(phaseSeq));
  const valEvt = evApprove.find((e) => e.type === "validation");
  check("a clean deck passes validation (validation ok, no repair)", !!valEvt && valEvt.type === "validation" && valEvt.ok && !valEvt.repaired);
  const csApprove = evApprove.filter((e) => e.type === "change_set");
  check("the pipeline produces exactly ONE change-set", csApprove.length === 1, `got ${csApprove.length}`);
  check("GENERATE used effort:high + the cheap default model (per-call)", resumeMock.getCalls()[0]?.effort === "high" && resumeMock.getCalls()[0]?.model === "gpt-5.4-mini", `${resumeMock.getCalls()[0]?.effort}/${resumeMock.getCalls()[0]?.model}`);
  const pLessonDoc = await loadCourseDoc(supabase, courseId);
  const pDeck = pLessonDoc?.modules.find((m) => m.id === pModuleId)?.lessons[0].blocks.find((b) => b.type === "slide_deck");
  check("generated deck persisted with the 3 planned structured slides", !!pDeck && pDeck.type === "slide_deck" && pDeck.slides.length === 3 && pDeck.slides.every((s) => !!s.template), `${pDeck && pDeck.type === "slide_deck" ? pDeck.slides.length : "none"}`);
  check("no default placeholder slide survived (pre-created empty deck)", !!pDeck && pDeck.type === "slide_deck" && pDeck.slides.every((s) => !!s.ai?.specId));

  // 11c. Auto-approve (fresh lesson): plan → generate → validate in one call.
  const aLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: aLessonId, module_id: pModuleId, course_id: courseId, title: "Auto lesson", objective: "x", order: 1 });
  const cConvo = await getOrCreateConversation(supabase, courseId, aLessonId);
  const autoMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },          // PLAN
    { text: "Authoring.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), slide("s3", "Recap")])] },
    { text: "", toolCalls: [] },
  ], { finalText: "Done." });
  const evAuto: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: autoMock, courseId, lessonId: aLessonId, ownerId: userId, conversationId: cConvo,
    userMessage: "Generate the whole lesson", autoApprove: true, emit: (e) => evAuto.push(e),
  });
  const autoPhases = evAuto.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("auto-approve runs plan→generate→validate, no pause", JSON.stringify(autoPhases) === JSON.stringify(["plan", "generate", "validate"]), JSON.stringify(autoPhases));
  check("auto-approve emits no plan_outline (no approval gate)", !evAuto.some((e) => e.type === "plan_outline"));
  check("auto-approve produces exactly one change-set", evAuto.filter((e) => e.type === "change_set").length === 1);

  // 11d. Classifier routes a small edit to the single-turn path (no phases).
  const editLectureCall = {
    name: "write_lecture_text",
    arguments: { blockId: null, lessonId: pLessonId, title: "Recap", tone: "concise", paragraphs: [{ kind: "key_idea", text: "A tree has a root, internal nodes, and leaves." }] },
  };
  const editMock = createMockModelClient([
    { text: '{"mode":"edit"}' },                // classifier (structured, low effort)
    { text: "Tweaked the wording.", toolCalls: [editLectureCall] },
    { text: "", toolCalls: [] },
  ], { finalText: "Done." });
  const evEdit: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: editMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Tighten the wording on the recap", emit: (e) => evEdit.push(e),
  });
  check("an edit request routes to the single-turn path (no phase events)", !evEdit.some((e) => e.type === "phase"));
  check("the edit still stages one change-set", evEdit.filter((e) => e.type === "change_set").length === 1);
  check("classifier call used effort:low (NOT minimal) + model gpt-5.4-mini + responseFormat", editMock.getCalls()[0]?.effort === "low" && editMock.getCalls()[0]?.model === "gpt-5.4-mini" && !!editMock.getCalls()[0]?.responseFormat, editMock.getCalls()[0]?.effort);
  check("the edit path is now LAYERED (teaching bar in the system prompt)", (editMock.getCalls()[1]?.system ?? "").includes("TEACHING BAR"));

  // 11e. MISSING-SPEC REPAIR — GENERATE builds only s1+s2 and then STALLS (the
  //      coverage driver nudges, but the model produces nothing new, so the
  //      no-progress guard stops it short of the plan). VALIDATE finds s3 missing,
  //      a targeted REPAIR pass builds it, re-validation passes.
  const rLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: rLessonId, module_id: pModuleId, course_id: courseId, title: "Repair lesson", objective: "x", order: 2 });
  const rConvo = await getOrCreateConversation(supabase, courseId, rLessonId);
  const repairMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },                                  // PLAN
    { text: "Partial.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion")])] }, // GENERATE (missing s3)
    { text: "", toolCalls: [] },                                            // generate: no progress 1 (driver nudges)
    { text: "", toolCalls: [] },                                            // generate: no progress 2
    { text: "", toolCalls: [] },                                            // generate: no progress 3 → guard stops generate at 2/3
    { text: "Fixing the gap.", toolCalls: [batchCall([slide("s3", "Recap")])] }, // REPAIR builds s3 → 3/3
  ], { finalText: "Done." });
  const evRepair: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: repairMock, courseId, lessonId: rLessonId, ownerId: userId, conversationId: rConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evRepair.push(e),
  });
  const rPhases = evRepair.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("a short deck triggers a repair phase (plan→generate→validate→repair→validate)", JSON.stringify(rPhases) === JSON.stringify(["plan", "generate", "validate", "repair", "validate"]), JSON.stringify(rPhases));
  const rValEvents = evRepair.filter((e) => e.type === "validation");
  check("validation reports the missing slide, then passes after repair", rValEvents.length >= 2 && rValEvents.some((e) => e.type === "validation" && !e.ok) && rValEvents[rValEvents.length - 1].type === "validation" && (rValEvents[rValEvents.length - 1] as Extract<AgentEvent, { type: "validation" }>).ok);
  check("repair did NOT emit a checkpoint (the contract was met)", !evRepair.some((e) => e.type === "checkpoint"));
  const rDoc = await loadCourseDoc(supabase, courseId);
  const rDeck = rDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === rLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("the repaired deck has all 3 planned slides", !!rDeck && rDeck.type === "slide_deck" && rDeck.slides.length === 3, `${rDeck && rDeck.type === "slide_deck" ? rDeck.slides.length : "none"}`);

  // 11f. PLACEHOLDER REMOVAL — seed a deck that already holds a default placeholder
  //      slide; generation authors the real slides into it; validation strips the
  //      placeholder deterministically before staging.
  const phLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: phLessonId, module_id: pModuleId, course_id: courseId, title: "Placeholder lesson", objective: "x", order: 3 });
  const phDeckId = crypto.randomUUID();
  // A FULL slide_deck payload (type/order/ai/slides) whose one slide is the studio
  // default "Section title" placeholder — the content jsonb must carry the whole
  // block, not just slides (see courseDocFromRows).
  const phBlock = createBlock("slide_deck"); // slides: [createSlide("title")]
  const phContent = JSON.parse(JSON.stringify({ ...phBlock, id: undefined }));
  await supabase.from("blocks").insert({ id: phDeckId, lesson_id: phLessonId, course_id: courseId, type: "slide_deck", order: 0, title: "Deck", content: phContent });
  const phConvo = await getOrCreateConversation(supabase, courseId, phLessonId);
  const phMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },
    { text: "Authoring.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), slide("s3", "Recap")])] },
    { text: "", toolCalls: [] },
  ], { finalText: "Done." });
  const evPh: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: phMock, courseId, lessonId: phLessonId, ownerId: userId, conversationId: phConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evPh.push(e),
  });
  const phValEvt = evPh.filter((e) => e.type === "validation").pop();
  check("placeholder removal is reported in the validation event", !!phValEvt && phValEvt.type === "validation" && phValEvt.placeholdersRemoved >= 1 && phValEvt.ok, JSON.stringify(phValEvt));
  const phDoc = await loadCourseDoc(supabase, courseId);
  const phDeck = phDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === phLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("the staged deck has the 3 real slides and NO placeholder", !!phDeck && phDeck.type === "slide_deck" && phDeck.slides.length === 3 && phDeck.slides.every((s) => !!s.ai?.specId), `${phDeck && phDeck.type === "slide_deck" ? phDeck.slides.length : "none"}`);

  // 11g. LIGHT REVIEW — a deck with several lint warnings (no speaker notes) trips
  //      the threshold; ONE review call returns soft suggestions (no regeneration).
  const lrLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: lrLessonId, module_id: pModuleId, course_id: courseId, title: "Review lesson", objective: "x", order: 4 });
  const lrConvo = await getOrCreateConversation(supabase, courseId, lrLessonId);
  const FOUR_SPEC_PLAN = { ...LESSON_PLAN, slides: [...LESSON_PLAN.slides, { segmentId: "seg", title: "Edge case", teachingGoal: "x", role: "edge_case", kind: "enrichment", layout: "prose", depth: "analysis", keyPoints: ["a"], notes: "", visualIntent: null, requiredElements: null, speakerNotesGoal: "x" }] };
  const lrMock = createMockModelClient([
    { text: JSON.stringify(FOUR_SPEC_PLAN) },
    // 4 slides built in one batch → coverage complete → the driver ends GENERATE
    // (planMet) without needing a trailing empty turn. All WITHOUT speaker notes →
    // ≥4 lint warnings → review fires.
    { text: "Authoring.", toolCalls: [batchCall([slide("s1", "A", null), slide("s2", "B", null), slide("s3", "C", null), slide("s4", "D", null)])] },
    // The single light-review call (responseFormat) returns suggestions.
    { text: JSON.stringify({ coherent: true, matchesPlan: true, topSuggestions: [{ title: "Add speaker notes", detail: "Each slide should carry a spoken explanation." }] }) },
  ], { finalText: "Done." });
  const evLr: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: lrMock, courseId, lessonId: lrLessonId, ownerId: userId, conversationId: lrConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evLr.push(e),
  });
  const lrPhases = evLr.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("a rough deck triggers the optional light-review phase", lrPhases.includes("review"), JSON.stringify(lrPhases));
  const qr = evLr.find((e) => e.type === "quality_report");
  check("a quality_report carries lint warnings + review suggestions", !!qr && qr.type === "quality_report" && qr.warnings.length >= 4 && qr.suggestions.length >= 1, JSON.stringify(qr && qr.type === "quality_report" ? { w: qr.warnings.length, s: qr.suggestions.length } : null));
  check("the light review used the cheap model at medium effort (one call, no tools)", lrMock.getCalls().some((c) => c.effort === "medium" && c.model === "gpt-5.4-mini" && (c.tools?.length ?? 0) === 0 && !!c.responseFormat));

  // 11g-2. COVERAGE DRIVER — the model "stops" (a no-tool turn) after building only
  //        ONE slide, but specs remain, so the driver NUDGES it to keep building
  //        until the plan is complete. No repair phase needed; no checkpoint.
  const cdLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: cdLessonId, module_id: pModuleId, course_id: courseId, title: "Driver lesson", objective: "x", order: 5 });
  const cdConvo = await getOrCreateConversation(supabase, courseId, cdLessonId);
  const cdMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },                                                                  // PLAN
    { text: "Authoring the opener.", toolCalls: [batchCall([slide("s1", "What a tree is")])] },             // 1/3
    { text: "I think that covers it.", toolCalls: [] },                                                     // model tries to STOP early → driver nudges
    { text: "Continuing.", toolCalls: [batchCall([slide("s2", "Insertion"), slide("s3", "Recap")])] },     // → 3/3 (planMet)
  ], { finalText: "Done." });
  const evCd: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: cdMock, courseId, lessonId: cdLessonId, ownerId: userId, conversationId: cdConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evCd.push(e),
  });
  const cdPhases = evCd.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("coverage driver completes a deck the model tried to abandon early (no repair needed)", JSON.stringify(cdPhases) === JSON.stringify(["plan", "generate", "validate"]), JSON.stringify(cdPhases));
  check("the driver injected a 'STILL TO BUILD' continuation nudge", cdMock.getCalls().some((c) => (c.input ?? []).some((i) => "role" in i && i.role === "user" && /STILL TO BUILD/.test(i.content))));
  check("driven generation met the contract → no checkpoint", !evCd.some((e) => e.type === "checkpoint"));
  const cdDoc = await loadCourseDoc(supabase, courseId);
  const cdDeck = cdDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === cdLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("the driven deck has all 3 planned slides", !!cdDeck && cdDeck.type === "slide_deck" && cdDeck.slides.length === 3, `${cdDeck && cdDeck.type === "slide_deck" ? cdDeck.slides.length : "none"}`);

  // 11g-3. NO-PROGRESS GUARD — the model builds s1 then produces nothing more.
  //        GENERATE stalls (silently), REPAIR can't make progress either, and the
  //        PIPELINE emits exactly ONE final "couldn't satisfy the plan" checkpoint.
  const npLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: npLessonId, module_id: pModuleId, course_id: courseId, title: "Stall lesson", objective: "x", order: 6 });
  const npConvo = await getOrCreateConversation(supabase, courseId, npLessonId);
  const npMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },
    { text: "Only the opener.", toolCalls: [batchCall([slide("s1", "What a tree is")])] }, // then every later turn is empty (no progress)
  ], { finalText: "" });
  const evNp: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: npMock, courseId, lessonId: npLessonId, ownerId: userId, conversationId: npConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evNp.push(e),
  });
  const npCheckpoints = evNp.filter((e) => e.type === "checkpoint");
  check("a stalled generation+repair emits exactly ONE pipeline-owned checkpoint", npCheckpoints.length === 1, `${npCheckpoints.length}`);
  check("the checkpoint names the unmet plan", npCheckpoints[0]?.type === "checkpoint" && /couldn't fully satisfy|missing/i.test(npCheckpoints[0].reason), npCheckpoints[0]?.type === "checkpoint" ? npCheckpoints[0].reason : "(none)");
  // FLUSH-ON-EXIT on the stall (the practical "turn cap"): the partial work is NOT
  // discarded — it's staged AND persisted, so the user can keep / continue it.
  check("the stalled run still STAGED its partial work (flush-on-exit)", evNp.some((e) => e.type === "change_set"));
  const npDoc = await loadCourseDoc(supabase, courseId);
  const npDeck = npDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === npLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("the stalled deck kept the one real slide it built", !!npDeck && npDeck.type === "slide_deck" && npDeck.slides.length === 1, `${npDeck && npDeck.type === "slide_deck" ? npDeck.slides.length : "none"}`);
  const npPending = await getPendingBlocks(supabase, courseId);
  check("the stalled run's partial deck is in the Accept/Reject gate (pending)", npPending.some((p) => p.blockId === npDeck?.id));
  // Coverage was measured by SAVED slides: 1 saved → 1/3, and a 0-new-slide pass is
  // what tripped the no-progress stop (not an endless repair loop). Repair passes
  // are bounded — never an unbounded stream of repair phases on a stalled deck.
  const npRepairPhases = evNp.filter((e) => e.type === "phase" && e.phase === "repair").length;
  check("a 0-new-slide stall stops via the guard, not an unbounded repair loop", npRepairPhases <= 4, `${npRepairPhases}`);

  // 11j. CLAMP-NOT-REJECT — the model authors a slide with an OVER-LENGTH slot.
  //      It's auto-shortened server-side and SAVED (stamped with its specId), so
  //      coverage closes (3/3) and NO repair loop fires. (BUG B: the strictness
  //      death-spiral fix — a formatting overflow no longer blocks the contract.)
  const clLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: clLessonId, module_id: pModuleId, course_id: courseId, title: "Clamp lesson", objective: "x", order: 7 });
  const clConvo = await getOrCreateConversation(supabase, courseId, clLessonId);
  // s3's title is way over the prose-title cap (60) — used to be rejected → churn.
  const longTitle = "x".repeat(90);
  const overLongS3 = { slideSpecId: "s3", template: { layoutId: "prose", content: { title: { text: longTitle }, body: { text: BODY } } }, notes: "notes" };
  const clMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },
    { text: "Authoring (s3 title is long).", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), overLongS3])] },
  ], { finalText: "Done." });
  const evCl: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: clMock, courseId, lessonId: clLessonId, ownerId: userId, conversationId: clConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evCl.push(e),
  });
  const clPhases = evCl.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("an over-length slot is clamped+saved → coverage closes, NO repair phase", JSON.stringify(clPhases) === JSON.stringify(["plan", "generate", "validate"]), JSON.stringify(clPhases));
  check("the clamp run met the contract → no checkpoint", !evCl.some((e) => e.type === "checkpoint"));
  const clValEvt = evCl.filter((e) => e.type === "validation").pop();
  check("the clamp run passed validation cleanly", !!clValEvt && clValEvt.type === "validation" && clValEvt.ok && !clValEvt.repaired);
  const clDoc = await loadCourseDoc(supabase, courseId);
  const clDeck = clDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === clLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("all 3 planned slides saved (the over-length one included)", !!clDeck && clDeck.type === "slide_deck" && clDeck.slides.length === 3 && clDeck.slides.every((s) => !!s.ai?.specId), `${clDeck && clDeck.type === "slide_deck" ? clDeck.slides.length : "none"}`);
  const clS3 = clDeck && clDeck.type === "slide_deck" ? clDeck.slides.find((s) => s.ai?.specId === "s3") : undefined;
  const clS3Title = clS3?.template?.layoutId === "prose" ? clS3.template.content.title.text : "";
  check("the over-length title was auto-shortened to the cap (≤60), not rejected", clS3Title.length > 0 && clS3Title.length <= 60 && clS3Title.length < longTitle.length, `${clS3Title.length}`);

  // 11k. FLUSH-ON-EXIT (abort) — the user presses Stop mid-generation (after s1+s2).
  //      The loop sees the aborted signal between turns and stops; flush-on-exit
  //      STAGES + PERSISTS the partial work — it is never discarded.
  const abLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: abLessonId, module_id: pModuleId, course_id: courseId, title: "Abort lesson", objective: "x", order: 8 });
  const abConvo = await getOrCreateConversation(supabase, courseId, abLessonId);
  const abortController = new AbortController();
  const baseAbortMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },                                                                  // PLAN
    { text: "Built s1+s2.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion")])] }, // GENERATE turn 1 → then Stop
    { text: "s3 next.", toolCalls: [batchCall([slide("s3", "Recap")])] },                                   // never reached (aborted between turns)
  ], { finalText: "" });
  let sawBatch = 0;
  const abortMock: typeof baseAbortMock = {
    ...baseAbortMock,
    async runTurn(params, onEvent) {
      const res = await baseAbortMock.runTurn(params, onEvent);
      // Simulate the user pressing Stop right after the first authored batch.
      if (res.toolCalls.some((t) => t.name === "add_structured_slides_batch") && ++sawBatch === 1) abortController.abort();
      return res;
    },
  };
  const evAb: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: abortMock, courseId, lessonId: abLessonId, ownerId: userId, conversationId: abConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evAb.push(e), signal: abortController.signal,
  });
  check("an aborted run did NOT build the post-Stop slide (s3 skipped)", abortMock.getCalls().length <= 3);
  check("flush-on-exit STAGED the partial work after Stop (change_set emitted)", evAb.some((e) => e.type === "change_set"));
  const abDoc = await loadCourseDoc(supabase, courseId);
  const abDeck = abDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === abLessonId)?.blocks.find((b) => b.type === "slide_deck");
  check("the partial deck (s1+s2) was PERSISTED to the DB on abort", !!abDeck && abDeck.type === "slide_deck" && abDeck.slides.length === 2, `${abDeck && abDeck.type === "slide_deck" ? abDeck.slides.length : "none"}`);
  const abPending = await getPendingBlocks(supabase, courseId);
  check("the aborted run's partial work is in the Accept/Reject gate (pending)", abPending.some((p) => p.blockId === abDeck?.id));

  // 11g-4. AI IMAGE GENERATION (end to end) — the model calls add_image for a
  //        concept slide; the bytes are generated (mock PNG) and STORED to the live
  //        course-assets bucket, and the slide lands as an `illustration` with a
  //        real public URL (no blob), required alt text, and its plan spec stamp.
  const imgLessonId = crypto.randomUUID();
  await supabase.from("lessons").insert({ id: imgLessonId, module_id: pModuleId, course_id: courseId, title: "Image lesson", objective: "x", order: 7 });
  const imgConvo = await getOrCreateConversation(supabase, courseId, imgLessonId);
  const addImageCall = (specId: string, prompt: string, alt: string) => ({ name: "add_image", arguments: { deckBlockId: null, slideSpecId: specId, prompt, alt, title: null, caption: "What to notice." } });
  const imgMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },
    { text: "With a visual.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion")]), addImageCall("s3", "A branching tree of nodes", "An illustration of a branching tree of connected nodes.")] },
  ], { finalText: "Done." });
  const evImg: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: imgMock, courseId, lessonId: imgLessonId, ownerId: userId, conversationId: imgConvo,
    userMessage: "Generate the lesson", autoApprove: true, emit: (e) => evImg.push(e),
  });
  check("add_image asked the image model once, with a no-embedded-text prompt", imgMock.getImageCalls().length === 1 && /no embedded text/i.test(imgMock.getImageCalls()[0]?.prompt ?? ""), `${imgMock.getImageCalls().length}`);
  const imgDoc = await loadCourseDoc(supabase, courseId);
  const imgDeck = imgDoc?.modules.find((m) => m.id === pModuleId)?.lessons.find((l) => l.id === imgLessonId)?.blocks.find((b) => b.type === "slide_deck");
  const illus = imgDeck && imgDeck.type === "slide_deck" ? imgDeck.slides.find((s) => s.template?.layoutId === "illustration") : undefined;
  check("the deck has all 3 planned slides incl. the generated illustration", !!imgDeck && imgDeck.type === "slide_deck" && imgDeck.slides.length === 3 && !!illus, `${imgDeck && imgDeck.type === "slide_deck" ? imgDeck.slides.length : "none"}`);
  const illusContent = illus?.template?.layoutId === "illustration" ? illus.template.content : null;
  check("the illustration carries a STORED public course-assets URL (not a blob/data URL)", !!illusContent && /\/storage\/v1\/object\/public\/course-assets\//.test(illusContent.imageUrl) && illusContent.source === "ai_generated", illusContent?.imageUrl?.slice(0, 64));
  check("the illustration kept required alt text + its plan spec stamp", !!illusContent && illusContent.alt.length > 0 && illus?.ai?.specId === "s3");

  // 11h. MODULE BUILD — the FIRST call is a COMPACT SKELETON (low effort, lean),
  //      NOT a slide-by-slide plan. Approve → each lesson gets a LAZY rich plan →
  //      generate → validate. ONE change-set.
  const mModuleMock = createMockModelClient([{ text: JSON.stringify(SKELETON) }], { finalText: "" });
  const evMod: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: mModuleMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Create a search algorithms module; only do the first 2 lessons for now", emit: (e) => evMod.push(e),
  });
  const modPlanEvt = evMod.find((e) => e.type === "plan_outline");
  const modulePlan = modPlanEvt && modPlanEvt.type === "plan_outline" ? modPlanEvt.plan : null;
  check("module request → a COMPACT module SKELETON plan at LOW effort", mModuleMock.getCalls()[0]?.effort === "low" && !!modulePlan && modulePlan.kind === "module", mModuleMock.getCalls()[0]?.effort);
  check("the skeleton carries 2 lesson briefs (title + objective + slide range)", !!modulePlan && modulePlan.kind === "module" && modulePlan.skeleton.lessons.length === 2 && modulePlan.skeleton.lessons.every((l) => !!l.title && l.minSlides >= 3));
  check("the skeleton has NO per-slide content (lesson briefs only)", !!modulePlan && modulePlan.kind === "module" && modulePlan.skeleton.lessons.every((l) => !("slides" in l)));
  check("module skeleton plan was NON-streaming (reliability over token streaming)", mModuleMock.getCalls()[0]?.stream === false);
  check("module skeleton plan pauses — no change_set yet", !evMod.some((e) => e.type === "change_set"));

  // Approve → per lesson: RICH plan → generate → validate. One change-set.
  const mGenMock = createMockModelClient([
    { text: JSON.stringify(LESSON_PLAN) },                                  // L1 rich plan (lazy)
    { text: "L1.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), slide("s3", "Recap")])] }, // generate planMet → break
    { text: JSON.stringify(LESSON_PLAN) },                                  // L2 rich plan (lazy)
    { text: "L2.", toolCalls: [batchCall([slide("s1", "What a tree is"), slide("s2", "Insertion"), slide("s3", "Recap")])] }, // generate planMet → break
  ], { finalText: "" });
  const evModGen: AgentEvent[] = [];
  await resumeGeneratePlan({
    supabase, model: mGenMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    plan: modulePlan ?? undefined, decision: "approve", emit: (e) => evModGen.push(e),
  });
  const modPhases = evModGen.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("module approve runs RICH-plan→generate→validate PER LESSON", JSON.stringify(modPhases) === JSON.stringify(["plan", "generate", "validate", "plan", "generate", "validate"]), JSON.stringify(modPhases));
  check("the rich per-lesson plan ran at HIGH effort (full lesson contract)", mGenMock.getCalls()[0]?.effort === "high" && !!mGenMock.getCalls()[0]?.responseFormat);
  check("module build is ONE change-set across both lessons", evModGen.filter((e) => e.type === "change_set").length === 1);
  const genCall = mGenMock.getCalls().find((c) => (c.tools?.length ?? 0) > 0);
  const genToolNames = new Set((genCall?.tools ?? []).map((t) => t.name));
  check(
    "GENERATE toolset excludes flat deck/slide ops + structural deletes",
    !genToolNames.has("write_slide_deck") && !genToolNames.has("update_slide") && !genToolNames.has("set_slide_layout") && !genToolNames.has("create_lesson") && !genToolNames.has("delete_lesson") && !genToolNames.has("delete_module"),
    [...genToolNames].join(",")
  );
  check("GENERATE toolset includes structured authoring (+ create_block, write_quiz)", genToolNames.has("add_structured_slides_batch") && genToolNames.has("create_block") && genToolNames.has("write_quiz"));
  check("module generate ran at effort:high, layered", genCall?.effort === "high" && (genCall?.system ?? "").includes("TEACHING BAR"));
  const modDoc = await loadCourseDoc(supabase, courseId);
  const newMod = modDoc?.modules.find((m) => m.title === "Searching");
  const modDeckCounts = newMod?.lessons.map((l) => { const d = l.blocks.find((b) => b.type === "slide_deck"); return d && d.type === "slide_deck" ? d.slides.length : -1; });
  check("module + 2 lessons created, each with a 3-slide deck", !!newMod && newMod.lessons.length === 2 && (modDeckCounts ?? []).every((n) => n === 3), `lessons=${newMod?.lessons.length} deckCounts=${JSON.stringify(modDeckCounts)}`);

  // 11h-b. SKELETON TIMEOUT → ULTRA-LEAN FALLBACK. The first call times out (a
  //        transport error, NOT a schema problem); the system retries with the
  //        tiny fallback schema and still produces an approvable lesson map.
  const fbMock = createMockModelClient([
    { error: { message: "Request timed out.", kind: "transport_timeout" } },        // skeleton times out
    { text: JSON.stringify({ moduleTitle: "Sorting", moduleObjective: "Order data.", lessons: [{ title: "Bubble sort", objective: "Swap adjacent pairs." }, { title: "Merge sort", objective: "Divide and merge." }], estimatedLessonCount: 2, notes: null }) }, // fallback ok
  ], { finalText: "" });
  const evFb: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: fbMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Build a sorting algorithms module", emit: (e) => evFb.push(e),
  });
  check("a skeleton timeout falls back to the ultra-lean planner (2 plan calls)", fbMock.getCalls().length === 2, `${fbMock.getCalls().length}`);
  const fbPlanEvt = evFb.find((e) => e.type === "plan_outline");
  const fbPlan = fbPlanEvt && fbPlanEvt.type === "plan_outline" ? fbPlanEvt.plan : null;
  check("the fallback still yields an approvable 2-lesson skeleton", !!fbPlan && fbPlan.kind === "module" && fbPlan.skeleton.lessons.length === 2, JSON.stringify(fbPlan));
  check("the fallback call ran in BACKGROUND mode (poll, not a held connection)", fbMock.getCalls()[1]?.background === true);

  // 11h-c. BOTH skeleton + fallback time out → a CLEAR timeout error, NOT "invalid
  //        JSON", and no plan card.
  const failMock = createMockModelClient([
    { error: { message: "Request timed out.", kind: "transport_timeout" } },
    { error: { message: "Request timed out.", kind: "transport_timeout" } },
  ], { finalText: "" });
  const evFail: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: failMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Build a graph algorithms module", emit: (e) => evFail.push(e),
  });
  const failErr = evFail.find((e) => e.type === "error");
  check("both planning attempts timing out → a clear TIMEOUT message", !!failErr && failErr.type === "error" && /timed out/i.test(failErr.message), failErr && failErr.type === "error" ? failErr.message : "(no error)");
  check("a timeout is NOT mis-reported as 'invalid JSON'", !!failErr && failErr.type === "error" && !/invalid json/i.test(failErr.message));
  check("no plan card is shown when planning fully failed", !evFail.some((e) => e.type === "plan_outline"));

  // 11i. CALL BUDGET (D) — a model that NEVER stops calling tools must be capped
  //      by the shared per-run budget and emit a checkpoint, not loop forever.
  console.log("\n# call budget — runaway guard caps + checkpoints");
  const READ_CALL = { name: "get_course_context", arguments: {} }; // no-op, never pauses
  const budgetMock = createMockModelClient(
    [
      { text: "step 1", toolCalls: [READ_CALL] },
      { text: "step 2", toolCalls: [READ_CALL] },
      { text: "step 3", toolCalls: [READ_CALL] },
      { text: "step 4", toolCalls: [READ_CALL] }, // never reached (budget = 3)
      { text: "step 5", toolCalls: [READ_CALL] },
    ],
    { finalText: "(never reached — the loop never empties)" }
  );
  const bConvo = await getOrCreateConversation(supabase, courseId, pLessonId);
  const evBudget: AgentEvent[] = [];
  const bCtx = loopContext({
    supabase, model: budgetMock, courseId, lessonId: pLessonId, ownerId: userId,
    conversationId: bConvo, emit: (e) => evBudget.push(e), callBudget: { remaining: 3 },
  });
  const bDoc = (await loadCourseDoc(supabase, courseId))!;
  await runConversationLoop(bCtx, bDoc, structuredClone(bDoc), false, { callLabel: "budget-test" });
  check("call budget caps the run at exactly 3 model calls", budgetMock.getCalls().length === 3, `got ${budgetMock.getCalls().length}`);
  check("budget exhaustion drained remaining to 0", bCtx.callBudget?.remaining === 0, String(bCtx.callBudget?.remaining));
  check("budget exhaustion emits a checkpoint", evBudget.some((e) => e.type === "checkpoint"), JSON.stringify(evBudget.map((e) => e.type)));

  // 12. cleanup
  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up course");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
