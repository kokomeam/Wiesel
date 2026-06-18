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

  // 11. PHASED PIPELINE — PLAN → (approve) → GENERATE → CRITIQUE, one change-set.
  console.log("\n# phased pipeline — plan → approve → generate → critique");
  const pModuleId = crypto.randomUUID();
  const pLessonId = crypto.randomUUID();
  await supabase.from("modules").insert({ id: pModuleId, course_id: courseId, title: "Trees", order: 2 });
  await supabase.from("lessons").insert({ id: pLessonId, module_id: pModuleId, course_id: courseId, title: "Intro to binary trees", objective: "Define a tree and its parts; insertion cost.", order: 0 });
  const pConvo = await getOrCreateConversation(supabase, courseId, pLessonId);

  const OUTLINE = {
    slides: [
      { concept: "What a tree is", prerequisites: [], layout: "key_concept", depth: "definition", notes: "Define node, root, leaf." },
      { concept: "Insertion", prerequisites: ["node"], layout: "process_steps", depth: "mechanism", notes: "O(log n) average." },
      { concept: "Recap", prerequisites: [], layout: "outline_list", depth: "analysis", notes: "Summarize the parts." },
    ],
  };
  const genDeckCall = {
    name: "write_slide_deck",
    arguments: { blockId: null, lessonId: pLessonId, title: "Binary Trees", slides: [
      { layout: "title", content: [{ role: "title", text: [{ text: "Binary Trees", bold: null, italic: null }], items: null }], notes: null },
    ] },
  };
  const critLectureCall = {
    name: "write_lecture_text",
    arguments: { blockId: null, lessonId: pLessonId, title: "Recap", tone: "concise", paragraphs: [{ kind: "key_idea", text: "A tree has a root, internal nodes, and leaves." }] },
  };

  // 11a. PLAN pause path (STRONG_GENERATE message → classifier short-circuits, no model call).
  const pauseMock = createMockModelClient([{ text: JSON.stringify(OUTLINE) }], { finalText: "" });
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
  check("PLAN pauses — no change_set yet", !evPlan.some((e) => e.type === "change_set"));
  check("PLAN call used effort:high + responseFormat (per-call)", pauseMock.getCalls()[0]?.effort === "high" && !!pauseMock.getCalls()[0]?.responseFormat);
  check("PLAN call used the cheap default model gpt-5.4-mini (per-call)", pauseMock.getCalls()[0]?.model === "gpt-5.4-mini", pauseMock.getCalls()[0]?.model);
  // B: the static system carries NO course context (cacheable); the variable
  // context rides in a leading developer input message.
  const planCall = pauseMock.getCalls()[0];
  check("B: PLAN system is static (no COURSE CONTEXT leak into the cached prefix)", !(planCall?.system ?? "").includes("COURSE CONTEXT"));
  check("B: PLAN context rides in a leading developer input message", (planCall?.input ?? []).some((i) => "role" in i && i.role === "developer" && i.content.includes("COURSE CONTEXT")));

  // 11b. Approve → GENERATE (medium) → CRITIQUE (high) → ONE change-set.
  const resumeMock = createMockModelClient([
    { text: "Authoring the deck.", toolCalls: [genDeckCall] },
    { text: "", toolCalls: [] }, // ends GENERATE loop
    { text: "Adding a recap note.", toolCalls: [critLectureCall] },
    { text: "", toolCalls: [] }, // ends CRITIQUE loop
  ], { finalText: "Done — generated and reviewed." });
  const evApprove: AgentEvent[] = [];
  await resumeGeneratePlan({
    supabase, model: resumeMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    plan: lessonPlan ?? { kind: "lesson", lessonId: pLessonId, outline: OUTLINE }, decision: "approve", emit: (e) => evApprove.push(e),
  });
  const phaseSeq = evApprove.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  // CRITIQUE is OFF by default → generate then a critique_skipped marker.
  check("approve runs GENERATE then critique_skipped (critique off by default)", JSON.stringify(phaseSeq) === JSON.stringify(["generate", "critique_skipped"]), JSON.stringify(phaseSeq));
  check("a critique_skipped phase carries the disabled_by_config reason", evApprove.some((e) => e.type === "phase" && e.phase === "critique_skipped" && e.reason === "disabled_by_config"));
  const csApprove = evApprove.filter((e) => e.type === "change_set");
  check("the pipeline still produces exactly ONE change-set (no critique)", csApprove.length === 1, `got ${csApprove.length}`);
  check("GENERATE used effort:medium + the cheap default model (per-call)", resumeMock.getCalls()[0]?.effort === "medium" && resumeMock.getCalls()[0]?.model === "gpt-5.4-mini", `${resumeMock.getCalls()[0]?.effort}/${resumeMock.getCalls()[0]?.model}`);
  const pLessonDoc = await loadCourseDoc(supabase, courseId);
  const pBlocks = pLessonDoc?.modules.find((m) => m.id === pModuleId)?.lessons[0].blocks ?? [];
  check("generated deck persisted; no critique pass ran", pBlocks.some((b) => b.type === "slide_deck") && !pBlocks.some((b) => b.type === "lecture_text"), `got ${pBlocks.map((b) => b.type).join(",")}`);

  // 11c. Auto-approve collapses the pause: plan → generate → critique in one call.
  const autoMock = createMockModelClient([
    { text: JSON.stringify(OUTLINE) },          // PLAN
    { text: "Authoring.", toolCalls: [genDeckCall] },
    { text: "", toolCalls: [] },
    { text: "Reviewing.", toolCalls: [critLectureCall] },
    { text: "", toolCalls: [] },
  ], { finalText: "Done." });
  const cConvo = await getOrCreateConversation(supabase, courseId, pLessonId);
  const evAuto: AgentEvent[] = [];
  await runGenerateLessonTurn({
    supabase, model: autoMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: cConvo,
    userMessage: "Generate the whole lesson", autoApprove: true, emit: (e) => evAuto.push(e),
  });
  const autoPhases = evAuto.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("auto-approve runs plan→generate→critique_skipped, no pause", JSON.stringify(autoPhases) === JSON.stringify(["plan", "generate", "critique_skipped"]), JSON.stringify(autoPhases));
  check("auto-approve emits no plan_outline (no approval gate)", !evAuto.some((e) => e.type === "plan_outline"));
  check("auto-approve produces exactly one change-set", evAuto.filter((e) => e.type === "change_set").length === 1);

  // 11d. Classifier routes a small edit to the single-turn path (no phases).
  const editMock = createMockModelClient([
    { text: '{"mode":"edit"}' },                // classifier (structured, minimal)
    { text: "Tweaked the wording.", toolCalls: [critLectureCall] },
    { text: "", toolCalls: [] },
  ], { finalText: "Done." });
  const evEdit: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: editMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    userMessage: "Tighten the wording on the recap", emit: (e) => evEdit.push(e),
  });
  check("an edit request routes to the single-turn path (no phase events)", !evEdit.some((e) => e.type === "phase"));
  check("the edit still stages one change-set", evEdit.filter((e) => e.type === "change_set").length === 1);
  check("classifier call used effort:minimal + model gpt-5.4-mini + responseFormat", editMock.getCalls()[0]?.effort === "minimal" && editMock.getCalls()[0]?.model === "gpt-5.4-mini" && !!editMock.getCalls()[0]?.responseFormat);
  check("the edit path is now LAYERED (teaching bar in the system prompt)", (editMock.getCalls()[1]?.system ?? "").includes("TEACHING BAR"));

  // 11e. MODULE BUILD — "add a … module" routes to a module plan; approve →
  //      generate every lesson (layered, NO critique) → ONE change-set.
  const mModuleMock = createMockModelClient([
    { text: JSON.stringify({
      moduleTitle: "Searching",
      lessons: [
        { title: "Linear search", objective: "Scan an array in order.", slides: OUTLINE.slides },
        { title: "Binary search", objective: "Halve a sorted range.", slides: OUTLINE.slides },
      ],
    }) },
  ], { finalText: "" });
  const evMod: AgentEvent[] = [];
  await runContentAgentTurn({
    supabase, model: mModuleMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    // NAMES its lessons — the old `!/lessons/` guard misrouted this to a single lesson.
    userMessage: "Create a search algorithms module; only do the first 2 lessons for now", emit: (e) => evMod.push(e),
  });
  const modPlanEvt = evMod.find((e) => e.type === "plan_outline");
  const modulePlan = modPlanEvt && modPlanEvt.type === "plan_outline" ? modPlanEvt.plan : null;
  check("a module request short-circuits to a MODULE plan (no model call)", mModuleMock.getCalls()[0]?.effort === "high" && !!modulePlan && modulePlan.kind === "module");
  check("module plan_outline carries 2 lessons", !!modulePlan && modulePlan.kind === "module" && modulePlan.outline.lessons.length === 2);
  check("module plan pauses — no change_set yet", !evMod.some((e) => e.type === "change_set"));

  // Approve the module plan → generate each lesson (no critique), one change-set.
  const mGenMock = createMockModelClient([
    { text: "L1.", toolCalls: [{ name: "write_slide_deck", arguments: { blockId: null, lessonId: null, title: "Linear", slides: [{ layout: "title", content: [{ role: "title", text: [{ text: "Linear search", bold: null, italic: null }], items: null }], notes: null }] } }] },
    { text: "", toolCalls: [] },
    { text: "L2.", toolCalls: [{ name: "write_slide_deck", arguments: { blockId: null, lessonId: null, title: "Binary", slides: [{ layout: "title", content: [{ role: "title", text: [{ text: "Binary search", bold: null, italic: null }], items: null }], notes: null }] } }] },
    { text: "", toolCalls: [] },
  ], { finalText: "" });
  const evModGen: AgentEvent[] = [];
  await resumeGeneratePlan({
    supabase, model: mGenMock, courseId, lessonId: pLessonId, ownerId: userId, conversationId: pConvo,
    plan: modulePlan ?? undefined, decision: "approve", emit: (e) => evModGen.push(e),
  });
  const modPhases = evModGen.filter((e) => e.type === "phase").map((e) => (e.type === "phase" ? e.phase : ""));
  check("module approve generates per lesson, NO critique", JSON.stringify(modPhases) === JSON.stringify(["generate", "generate"]), JSON.stringify(modPhases));
  check("module build is ONE change-set across both lessons", evModGen.filter((e) => e.type === "change_set").length === 1);
  // GENERATE is STRUCTURED-only: no flat deck/slide ops, no structural churn —
  // so it can't downgrade to a flat tip/text deck or mangle the tree.
  const genToolNames = new Set((mGenMock.getCalls()[0]?.tools ?? []).map((t) => t.name));
  check(
    "GENERATE toolset excludes flat deck/slide ops + structural deletes",
    !genToolNames.has("write_slide_deck") && !genToolNames.has("update_slide") && !genToolNames.has("set_slide_layout") && !genToolNames.has("create_lesson") && !genToolNames.has("delete_lesson") && !genToolNames.has("delete_module"),
    [...genToolNames].join(",")
  );
  check("GENERATE toolset includes structured authoring (+ create_block, write_quiz)", genToolNames.has("add_structured_slide") && genToolNames.has("create_block") && genToolNames.has("write_quiz"));
  check("module generate ran at effort:medium, layered", mGenMock.getCalls()[0]?.effort === "medium" && (mGenMock.getCalls()[0]?.system ?? "").includes("TEACHING BAR"));
  const modDoc = await loadCourseDoc(supabase, courseId);
  const newMod = modDoc?.modules.find((m) => m.title === "Searching");
  check("module + 2 lessons created, each with a deck", !!newMod && newMod.lessons.length === 2 && newMod.lessons.every((l) => l.blocks.some((b) => b.type === "slide_deck")));

  // 11f. CALL BUDGET (D) — a model that NEVER stops calling tools must be capped
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
