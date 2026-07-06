/**
 * No-key unit test for the SCOPED agent reconcile + touch-scope derivation — the
 * fix for "a module deleted mid-run reappears". Runs against a tiny in-memory
 * Supabase fake (no live DB, no key): `npx tsx scripts/verify-scoped-reconcile.ts`.
 *
 * Proves the core invariant: the agent's reconcile writes ONLY the subtree it
 * touched and NEVER re-inserts / orphan-deletes a module it didn't touch — so a
 * concurrently-deleted module stays deleted. Also covers new-module writes, the
 * lesson-level delete-wins prune, and scoped block pruning.
 */

import { courseDocFromRows, courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { reconcileCourseDocScoped, type ReconcileScope } from "@/lib/course/persistenceSync";
import { agentTouchScope } from "@/lib/ai/changeSetDiff";
import type { CourseDocument, LessonBlock } from "@/lib/course/types";

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

/* ─────────────────────────── doc builders ──────────────────────────── */

function blk(id: string, order: number): LessonBlock {
  return { id, type: "lecture_text", title: `Block ${id}`, order, paragraphs: [] } as unknown as LessonBlock;
}
interface L {
  id: string;
  blocks?: LessonBlock[];
}
interface M {
  id: string;
  lessons?: L[];
}
function makeDoc(id: string, modules: M[]): CourseDocument {
  return {
    id,
    title: "Test course",
    plan: { outcomes: [], prerequisites: [] },
    theme: defaultCourseTheme(),
    modules: modules.map((m, mi) => ({
      id: m.id,
      type: "module" as const,
      title: `Module ${m.id}`,
      order: mi,
      lessons: (m.lessons ?? []).map((l, li) => ({
        id: l.id,
        type: "lesson" as const,
        title: `Lesson ${l.id}`,
        order: li,
        blocks: l.blocks ?? [],
      })),
    })),
    metadata: {
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ownerId: "owner-1",
      aiReadableVersion: "1.0",
    },
  };
}

/* ─────────────────────── in-memory Supabase fake ─────────────────────── */

type Row = Record<string, unknown>;
interface Op {
  kind: "upsert" | "delete";
  table: string;
  ids?: string[]; // upserted ids
}

function makeFakeSupabase(seedDoc: CourseDocument, ownerId: string) {
  const rows = courseDocToRows(seedDoc, ownerId);
  const store: Record<string, Row[]> = {
    courses: [rows.course as Row],
    modules: rows.modules as Row[],
    lessons: rows.lessons as Row[],
    blocks: rows.blocks as Row[],
  };
  const ops: Op[] = [];

  class Query {
    table: string;
    op: "select" | "upsert" | "delete" = "select";
    eqs: [string, unknown][] = [];
    notIds: string[] | null = null;
    single = false;
    payload: Row[] = [];
    constructor(table: string) {
      this.table = table;
    }
    select() {
      this.op = "select";
      return this;
    }
    eq(col: string, val: unknown) {
      this.eqs.push([col, val]);
      return this;
    }
    not(col: string, _op: string, valStr: string) {
      // valStr looks like "(id1,id2,id3)"
      this.notIds = valStr.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
      return this;
    }
    abortSignal() {
      return this;
    }
    upsert(payload: Row[]) {
      this.op = "upsert";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private match(r: Row): boolean {
      return this.eqs.every(([c, v]) => r[c] === v);
    }
    private run(): { data: unknown; error: null } {
      const tbl = (store[this.table] ??= []);
      if (this.op === "select") {
        const found = tbl.filter((r) => this.match(r));
        return { data: this.single ? (found[0] ?? null) : found, error: null };
      }
      if (this.op === "upsert") {
        for (const row of this.payload) {
          const i = tbl.findIndex((r) => r.id === row.id);
          if (i >= 0) tbl[i] = { ...tbl[i], ...row };
          else tbl.push({ ...row });
        }
        ops.push({ kind: "upsert", table: this.table, ids: this.payload.map((r) => String(r.id)) });
        return { data: null, error: null };
      }
      // delete
      const keep = (r: Row) => {
        if (!this.match(r)) return true; // outside this delete's scope
        if (this.notIds && this.notIds.includes(String(r.id))) return true; // explicitly kept
        return false; // matched + not-kept → delete
      };
      store[this.table] = tbl.filter(keep);
      ops.push({ kind: "delete", table: this.table });
      return { data: null, error: null };
    }
    then<T>(resolve: (v: { data: unknown; error: null }) => T): T {
      return resolve(this.run());
    }
  }

  const supabase = { from: (table: string) => new Query(table) };
  return { supabase: supabase as never, store, ops };
}

function liveDoc(store: Record<string, Row[]>): CourseDocument {
  return courseDocFromRows(
    store.courses[0] as never,
    store.modules as never,
    store.lessons as never,
    store.blocks as never,
  );
}

/* ────────────────────────────── tests ─────────────────────────────── */

async function main() {
  const OWNER = "owner-1";

  console.log("# agentTouchScope (pure)");
  {
    // baseline: M1(L1[b1]), M7(L7[b7]); current: M1 gets a new block in L1; M7 untouched.
    const baseline = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] },
      { id: "M7", lessons: [{ id: "L7", blocks: [blk("b7", 0)] }] },
    ]);
    const current = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0), blk("b1b", 1)] }] },
      { id: "M7", lessons: [{ id: "L7", blocks: [blk("b7", 0)] }] },
    ]);
    const scope = agentTouchScope(baseline, current);
    check("untouched module not in newModuleIds", !scope.newModuleIds.includes("M7"));
    check("no new modules (only edited a block)", scope.newModuleIds.length === 0);
    check("touched lesson L1 captured", scope.touchedLessonIds.includes("L1"));
    check("untouched lesson L7 NOT captured", !scope.touchedLessonIds.includes("L7"));
    check("no new lessons", scope.newLessonIds.length === 0);
  }
  {
    // module build: baseline has M1 only; current adds M8 with a lesson + block.
    const baseline = makeDoc("c1", [{ id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] }]);
    const current = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] },
      { id: "M8", lessons: [{ id: "L8", blocks: [blk("b8", 0)] }] },
    ]);
    const scope = agentTouchScope(baseline, current);
    check("new module M8 in newModuleIds", scope.newModuleIds.includes("M8"));
    check("new lesson L8 in newLessonIds", scope.newLessonIds.includes("L8"));
    check("pre-existing M1/L1 untouched", scope.newModuleIds.length === 1 && !scope.touchedLessonIds.includes("L1"));
  }

  console.log("# reconcileCourseDocScoped — resurrection guard");
  {
    // DB has M1 + M7. Agent's in-memory doc (run start) had both; it added a block to
    // M1/L1. Meanwhile the user DELETED M7 from the DB. Reconcile must NOT bring M7 back.
    const seed = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] },
      { id: "M7", lessons: [{ id: "L7", blocks: [blk("b7", 0)] }] },
    ]);
    const { supabase, store, ops } = makeFakeSupabase(seed, OWNER);
    // user deletes M7 (+ its lessons/blocks) directly:
    store.modules = store.modules.filter((m) => m.id !== "M7");
    store.lessons = store.lessons.filter((l) => l.module_id !== "M7");
    store.blocks = store.blocks.filter((b) => b.lesson_id !== "L7");

    // agent's held doc still has M7; it authored a new block into M1/L1.
    const agentDoc = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0), blk("b1b", 1)] }] },
      { id: "M7", lessons: [{ id: "L7", blocks: [blk("b7", 0)] }] },
    ]);
    const scope: ReconcileScope = { newModuleIds: [], touchedLessonIds: ["L1"], newLessonIds: [] };
    const err = await reconcileCourseDocScoped(supabase, agentDoc, OWNER, scope);
    check("scoped reconcile ok", err === null, err ?? "");
    check("deleted module M7 NOT resurrected", !store.modules.some((m) => m.id === "M7"));
    check("deleted lesson L7 NOT resurrected", !store.lessons.some((l) => l.id === "L7"));
    check("NO upsert ever targeted the modules table", !ops.some((o) => o.kind === "upsert" && o.table === "modules"));
    check("NO delete ever targeted the modules table", !ops.some((o) => o.kind === "delete" && o.table === "modules"));
    check("agent's new block b1b persisted", store.blocks.some((b) => b.id === "b1b"));
  }

  console.log("# reconcileCourseDocScoped — new module write + prune");
  {
    const seed = makeDoc("c1", [{ id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] }]);
    const { supabase, store } = makeFakeSupabase(seed, OWNER);
    const agentDoc = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }] },
      { id: "M8", lessons: [{ id: "L8", blocks: [blk("b8", 0), blk("b8b", 1)] }] },
    ]);
    const scope: ReconcileScope = { newModuleIds: ["M8"], touchedLessonIds: ["L8"], newLessonIds: ["L8"] };
    const err = await reconcileCourseDocScoped(supabase, agentDoc, OWNER, scope);
    check("new-module reconcile ok", err === null, err ?? "");
    check("new module M8 written", store.modules.some((m) => m.id === "M8"));
    check("new lesson L8 written", store.lessons.some((l) => l.id === "L8"));
    check("new blocks b8 + b8b written", ["b8", "b8b"].every((id) => store.blocks.some((b) => b.id === id)));
    check("pre-existing M1/L1/b1 untouched + intact", store.blocks.some((b) => b.id === "b1"));
  }

  console.log("# reconcileCourseDocScoped — lesson-level delete-wins");
  {
    // Agent authored into pre-existing L1 (in M1). User deleted L1 mid-run (M1 survives).
    // The scoped reconcile must NOT re-insert L1 (delete-wins).
    const seed = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0)] }, { id: "L2", blocks: [blk("b2", 0)] }] },
    ]);
    const { supabase, store } = makeFakeSupabase(seed, OWNER);
    store.lessons = store.lessons.filter((l) => l.id !== "L1"); // user deleted L1
    store.blocks = store.blocks.filter((b) => b.lesson_id !== "L1");

    const agentDoc = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0), blk("b1b", 1)] }, { id: "L2", blocks: [blk("b2", 0)] }] },
    ]);
    const scope: ReconcileScope = { newModuleIds: [], touchedLessonIds: ["L1"], newLessonIds: [] };
    const err = await reconcileCourseDocScoped(supabase, agentDoc, OWNER, scope);
    check("delete-wins reconcile ok", err === null, err ?? "");
    check("deleted lesson L1 NOT resurrected", !store.lessons.some((l) => l.id === "L1"));
    check("L1's new block b1b NOT resurrected", !store.blocks.some((b) => b.id === "b1b"));
    check("sibling lesson L2 intact", store.lessons.some((l) => l.id === "L2"));
  }

  console.log("# reconcileCourseDocScoped — scoped block prune within a touched lesson");
  {
    // Agent removed b1 from L1 (kept b1b). The prune deletes b1 only within L1; other
    // lessons/modules untouched.
    const seed = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1", 0), blk("b1b", 1)] }] },
      { id: "M2", lessons: [{ id: "L2", blocks: [blk("b2", 0)] }] },
    ]);
    const { supabase, store } = makeFakeSupabase(seed, OWNER);
    const agentDoc = makeDoc("c1", [
      { id: "M1", lessons: [{ id: "L1", blocks: [blk("b1b", 0)] }] }, // b1 removed
      { id: "M2", lessons: [{ id: "L2", blocks: [blk("b2", 0)] }] },
    ]);
    const scope: ReconcileScope = { newModuleIds: [], touchedLessonIds: ["L1"], newLessonIds: [] };
    const err = await reconcileCourseDocScoped(supabase, agentDoc, OWNER, scope);
    check("block-prune reconcile ok", err === null, err ?? "");
    check("removed block b1 deleted", !store.blocks.some((b) => b.id === "b1"));
    check("kept block b1b present", store.blocks.some((b) => b.id === "b1b"));
    check("untouched lesson L2's block b2 intact", store.blocks.some((b) => b.id === "b2"));
    // final live doc still has both modules.
    const live = liveDoc(store);
    check("both modules still present after prune", live.modules.length === 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
