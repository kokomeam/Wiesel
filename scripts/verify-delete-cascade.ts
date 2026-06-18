/**
 * Proves a course delete removes EVERYTHING related (ON DELETE CASCADE) — the
 * same DELETE the `deleteCourse` server action runs, RLS-scoped to the author.
 * Run: `npx tsx scripts/verify-delete-cascade.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${d}`); }
};

function env() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const e: Record<string, string> = {};
  for (const l of raw.split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: e.NEXT_PUBLIC_SUPABASE_URL, anon: e.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

const TABLES = ["modules", "lessons", "blocks", "conversations", "messages", "change_sets", "change_set_items"] as const;

async function countFor(supabase: ReturnType<typeof createClient<Database>>, courseId: string) {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const { count } = await supabase.from(t).select("id", { count: "exact", head: true }).eq("course_id", courseId);
    out[t] = count ?? 0;
  }
  const { count: courseCount } = await supabase.from("courses").select("id", { count: "exact", head: true }).eq("id", courseId);
  out.courses = courseCount ?? 0;
  return out;
}

async function main() {
  const { url, anon } = env();
  const email = `delete-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const r = await fetch(`${url}/auth/v1/signup`, {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`signup: ${await r.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: si, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !si.user) throw new Error(`signin: ${error?.message}`);
  const userId = si.user.id;

  // Seed a course with a module/lesson/block...
  const now = "2026-06-15T00:00:00.000Z";
  const lesson = createLesson("L1", 0);
  const block = createBlock("lecture_text");
  lesson.blocks = [block];
  const mod = createModule("M1", 0);
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: crypto.randomUUID(), title: "To Be Deleted", plan: { outcomes: [], prerequisites: [] },
    modules: [mod], theme: defaultCourseTheme(), metadata: { createdAt: now, updatedAt: now, ownerId: userId, aiReadableVersion: "1.0" },
  };
  const rows = courseDocToRows(doc, userId);
  await supabase.from("courses").insert(rows.course);
  await supabase.from("modules").insert(rows.modules);
  await supabase.from("lessons").insert(rows.lessons);
  await supabase.from("blocks").insert(rows.blocks);

  // ...AND an agent conversation + message + change-set + item.
  const { data: conv } = await supabase.from("conversations").insert({ course_id: doc.id, lesson_id: lesson.id, title: "chat" }).select("id").single();
  await supabase.from("messages").insert({ conversation_id: conv!.id, course_id: doc.id, role: "user", content: { text: "hi" } as never });
  const { data: cs } = await supabase.from("change_sets").insert({ course_id: doc.id, lesson_id: lesson.id, summary: "1 added" }).select("id").single();
  await supabase.from("change_set_items").insert({ change_set_id: cs!.id, course_id: doc.id, block_id: block.id, lesson_id: lesson.id, op: "create", after: {} as never });

  const before = await countFor(supabase, doc.id);
  console.log("# seeded:", JSON.stringify(before));
  check("all related rows exist before delete", before.courses === 1 && TABLES.every((t) => before[t] >= 1), JSON.stringify(before));

  // The delete the action performs (RLS scopes it to the author).
  const { error: delErr } = await supabase.from("courses").delete().eq("id", doc.id);
  check("delete succeeded (no error)", !delErr, delErr?.message ?? "");

  const after = await countFor(supabase, doc.id);
  console.log("# after delete:", JSON.stringify(after));
  check("course row gone", after.courses === 0);
  for (const t of TABLES) check(`${t} cascade-deleted (0 rows)`, after[t] === 0, `${after[t]} left`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
