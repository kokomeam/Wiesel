/**
 * LIVE smoke test: one real agent turn with the REAL OpenAI model against live
 * Supabase. Run: `npx tsx scripts/verify-agent-live.ts`
 *
 * Reads OPENAI_API_KEY (+ optional OPENAI_MODEL) from .env.local, provisions a
 * throwaway course, asks the agent to author a deck + a knowledge check, and
 * asserts it produced valid, low-stakes blocks. Costs a few cents. Throwaway
 * *@example.com users can't be anon-deleted — clean in Supabase → Auth.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { LessonBlockSchema } from "@/lib/course/schemas";
import { runAgentTurn } from "@/lib/ai/agentLoop";
import { getOrCreateConversation } from "@/lib/ai/conversations";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { loadCourseDoc } from "@/lib/ai/serverPersistence";
import type { AgentEvent } from "@/lib/ai/events";

// Load .env.local into process.env (the OpenAI provider reads it at call-time).
const ENV: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) {
    ENV[m[1]] = m[2].replace(/^["']|["']$/g, "");
    process.env[m[1]] = ENV[m[1]];
  }
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${d}`); }
};
const GRADEBOOK = ["difficulty", "points", "passingScore", "timeLimitMinutes", "attemptsAllowed", "dueAt", "whenToShowAnswers"];
function deepHasKey(v: unknown, keys: string[]): boolean {
  if (Array.isArray(v)) return v.some((x) => deepHasKey(x, keys));
  if (v && typeof v === "object") return Object.entries(v).some(([k, val]) => keys.includes(k) || deepHasKey(val, keys));
  return false;
}

async function main() {
  check("OPENAI_API_KEY loaded + isOpenAIConfigured()", isOpenAIConfigured());
  console.log(`# model: ${process.env.OPENAI_MODEL ?? "gpt-5.4-mini (default)"}`);

  const url = ENV.NEXT_PUBLIC_SUPABASE_URL, anon = ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const email = `agent-live-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);

  const supabase = createClient<Database>(url, anon);
  const { data: si, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !si.user) throw new Error(`signin: ${error?.message}`);
  const userId = si.user.id;

  const courseId = crypto.randomUUID(), moduleId = crypto.randomUUID(), lessonId = crypto.randomUUID();
  await supabase.from("courses").insert({
    id: courseId, author_id: userId, title: "Intro to Two-Pointer Technique",
    description: "A beginner module on the two-pointer array pattern.", audience: "beginner competitive programmers", level: "beginner",
    plan: { outcomes: ["Recognize when two pointers applies", "Implement an O(n) two-pointer scan"], prerequisites: ["arrays", "loops"], teachingStyle: "friendly, concrete, example-first" } as never,
    theme: defaultCourseTheme() as never,
  });
  await supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: "Foundations", order: 0 });
  await supabase.from("lessons").insert({ id: lessonId, module_id: moduleId, course_id: courseId, title: "What is the two-pointer technique?", objective: "Explain the core idea and why it is linear time.", order: 0 });
  console.log(`# seeded course; asking the real model…\n`);

  const model = createOpenAIModelClient();
  const conversationId = await getOrCreateConversation(supabase, courseId, lessonId);

  async function runTurn(label: string, userMessage: string) {
    console.log(`\n# ${label}`);
    const events: AgentEvent[] = [];
    await runAgentTurn({
      supabase, model, courseId, lessonId, ownerId: userId, conversationId, userMessage,
      emit: (e) => {
        events.push(e);
        if (e.type === "tool_result") console.log(`  · ${e.tool}: ${e.summary}`);
        if (e.type === "error") console.log(`  · error: ${e.message}`);
      },
    });
    return events;
  }
  const deckOf = (doc: Awaited<ReturnType<typeof loadCourseDoc>>) =>
    doc?.modules[0].lessons[0].blocks.find((b) => b.type === "slide_deck");

  // ── Turn 1: author a deck that varies layouts + uses a bolded term ──
  const t1 = await runTurn(
    "turn 1 — author a deck (varied layouts + a bolded term)",
    "Create a 3-slide intro deck for this lesson. Use the definition layout for the core term, and a different layout for the other slides. Bold the key term where it's defined. Don't add a quiz."
  );
  check("no error events (turn 1)", !t1.some((e) => e.type === "error"));

  const doc1 = await loadCourseDoc(supabase, courseId);
  const deck1 = deckOf(doc1);
  check("a slide_deck was created", !!deck1);
  if (deck1 && deck1.type === "slide_deck") {
    const layouts = deck1.slides.map((s) => s.layout);
    console.log(`  → layouts: ${layouts.join(", ")}`);
    check("slide deck is schema-valid", LessonBlockSchema.safeParse(deck1).success);
    check("layouts VARY (not all the same)", new Set(layouts).size >= 2, layouts.join(","));
    check("emphasis stored as runs (bold:true)", JSON.stringify(deck1).includes('"bold":true'), "no bold run");
    check("NO '**' markdown leaked", !JSON.stringify(deck1).includes("**"));
    check("NO gradebook fields", !deepHasKey(deck1, GRADEBOOK));
  }

  // ── Turn 2: targeted, non-destructive layout switch on slide 1 ──
  const slideCountBefore = deck1 && deck1.type === "slide_deck" ? deck1.slides.length : 0;
  const slide1IdBefore = deck1 && deck1.type === "slide_deck" ? deck1.slides[0].id : "";
  const t2 = await runTurn(
    "turn 2 — switch ONLY slide 1 to two-column",
    "Switch the first slide of that deck to the two_column layout. Do not change any other slide."
  );
  check("no error events (turn 2)", !t2.some((e) => e.type === "error"));
  check("used a slide tool (set_slide_layout/get_deck)", t2.some((e) => e.type === "tool_result" && /set_slide_layout|get_deck/.test(e.tool)));

  const doc2 = await loadCourseDoc(supabase, courseId);
  const deck2 = deckOf(doc2);
  if (deck2 && deck2.type === "slide_deck") {
    check("deck slide count unchanged (non-destructive)", deck2.slides.length === slideCountBefore, `${slideCountBefore} → ${deck2.slides.length}`);
    const s1 = deck2.slides.find((s) => s.id === slide1IdBefore);
    check("slide 1 kept its id + switched layout", !!s1 && s1.layout === "two_column", `layout=${s1?.layout}`);
    check("deck still schema-valid after edit", LessonBlockSchema.safeParse(deck2).success);
  }

  await supabase.from("courses").delete().eq("id", courseId);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
