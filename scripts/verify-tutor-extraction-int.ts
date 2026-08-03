/**
 * Concept-graph EXTRACTION — INTEGRATION suite (live Supabase + the MOCK model).
 * CI-SAFE: no OpenAI key. Self-provisions a FRESH throwaway fixture each run.
 * TUTOR-1 Wave 1.3.
 *
 * Runs the REAL runGraphExtraction with the ADMIN client + a deterministic mock
 * model whose structured outputs are derived from the SEEDED course's real
 * lesson/block ids, then asserts the Wave 1.3/1.4 acceptance criteria against
 * the live DB:
 *
 *   AC-T1.3  run ok; concept_edges form a per-kind DAG (walk → no cycle); zero
 *            same-title active-node dupes; 100% of prerequisite edges carry
 *            non-empty evidence_refs; ≥1 assumed_prior_nodes row; the
 *            snapshot_concept_map rows carry the right (course, publication,
 *            version).
 *   AC-T1.4  per-lesson node counts within [1,4] OR the flags name the offender.
 *   AC-T1.5 + AC-W1M.2  exactly ONE pending change_set; its concept_graph items
 *            cover EVERY persisted row; the fate finding is 'proposed' w/
 *            change_set_id. Byte-snapshot the course doc → REJECT via the route's
 *            exact sequence → ALL graph rows gone, finding 'dismissed', doc
 *            byte-identical. RE-RUN → ACCEPT via the route's sequence → rows
 *            remain, finding 'accepted', change_set 'accepted'.
 *   pending guard  a second run over a pending set → alreadyPending, no new rows.
 *   cost telemetry  admin-read tutor_model_call rows ≥ model calls; a double-emit
 *            with one providerResponseId does NOT duplicate; the AUTHOR client
 *            reads ZERO tutor_% rows (R-9 live check).
 *
 * Run: `npx tsx scripts/verify-tutor-extraction-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on this dev machine's IPv6-broken
// network the TLS socket resets before the handshake. Pin IPv4-first.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors). */
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

import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { PublicationSnapshotSchema } from "@/lib/course/publish/schemas";
import { loadCourseDoc } from "@/lib/course/persistenceSync";
import { stableStringify } from "@/lib/course/publish/hash";
import { runGraphExtraction } from "@/lib/tutor/graph/extraction";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { emitTutorModelCall } from "@/lib/tutor/telemetry";
import {
  PROPOSAL_RESPONSE_NAME,
} from "@/lib/tutor/graph/propose";
import { MERGE_RESPONSE_NAME } from "@/lib/tutor/graph/canonicalize";
import { EDGE_RESPONSE_NAME } from "@/lib/tutor/graph/edges";
import { seedTutorFixture } from "./seed-fixture-tutor";

// Load .env.local → process.env (getCachedSnapshot's admin client + the mirror).
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

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

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");
  if (!service) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / SECRET_KEY (admin client) in .env.local");
  return { url, anon, service };
}

/**
 * Direct snapshot loader for the int suite — the SAME immutable-body query
 * getCachedSnapshot runs, WITHOUT Next's `unstable_cache` wrapper (which throws
 * "incrementalCache missing" outside the Next server runtime, so a bare-tsx CI
 * script can't use the default path). Production (the Inngest route) runs inside
 * the Next runtime where the cache is present, so this override is test-only. We
 * pass it via deps.loadSnapshot; nothing about the pipeline under test changes.
 */
function directSnapshotLoader(admin: SupabaseClient<Database>) {
  return async (publicationId: string) => {
    const { data, error } = await admin
      .from("course_publications")
      .select("version, snapshot")
      .eq("id", publicationId)
      .maybeSingle();
    if (error) throw new Error(`directSnapshotLoader: ${error.message}`);
    if (!data) throw new Error(`publication ${publicationId} not found`);
    return { snapshot: PublicationSnapshotSchema.parse(data.snapshot), version: data.version };
  };
}

/** Walk a per-kind edge set → true if there is a directed cycle within one kind. */
function hasCycleForKind(edges: { source_node_id: string; target_node_id: string }[]): boolean {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const e of edges) {
    nodes.add(e.source_node_id);
    nodes.add(e.target_node_id);
    adj.set(e.source_node_id, [...(adj.get(e.source_node_id) ?? []), e.target_node_id]);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);
  const dfs = (n: string): boolean => {
    color.set(n, GRAY);
    for (const nb of adj.get(n) ?? []) {
      const c = color.get(nb) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(nb)) return true;
    }
    color.set(n, BLACK);
    return false;
  };
  for (const n of nodes) if (color.get(n) === WHITE && dfs(n)) return true;
  return false;
}

/**
 * Build the mock model's structured responses from the seeded course. Each
 * per-lesson PROPOSAL call gets the SAME batch (keyed by response NAME) — the
 * batch derives ≥2 concepts and REAL anchors from the FIRST lesson's blocks, plus
 * a same-title dup, an assumed prior, and a distinct second concept. The edge
 * inference builds a small DAG plus one deliberate cycle + one evidenceless + one
 * transitive edge, all of which the pure hardening passes then resolve.
 */
function buildMockResponses(doc: CourseDocument) {
  const lesson0 = doc.modules[0].lessons[0];
  const deck0 = lesson0.blocks.find((b) => b.type === "slide_deck") as SlideDeckBlock | undefined;
  const block0 = deck0?.id ?? lesson0.blocks[0].id;
  const slide0 = deck0?.slides[0]?.id ?? null;

  const proposal = {
    concepts: [
      {
        title: "Scarcity",
        description: "Wants exceed the resources available to satisfy them.",
        lessonAnchors: [{ blockId: block0, slideId: slide0 }],
        confidence: 0.95,
        isAssumedPrior: false,
        evidenceQuote: "Scarcity means wants exceed resources.",
      },
      {
        title: "scarcity", // exact-title dup (case-insensitive) → pre-merges away
        description: "The core scarcity idea, restated.",
        lessonAnchors: [{ blockId: block0, slideId: null }],
        confidence: 0.5,
        isAssumedPrior: false,
        evidenceQuote: "Restated scarcity.",
      },
      {
        title: "Opportunity Cost",
        description: "The value of the next-best alternative forgone.",
        lessonAnchors: [{ blockId: block0, slideId: null }],
        confidence: 0.9,
        isAssumedPrior: false,
        evidenceQuote: "Opportunity cost is the next-best alternative.",
      },
      {
        title: "Arithmetic",
        description: "Basic arithmetic — assumed background, never taught here.",
        lessonAnchors: [{ blockId: block0, slideId: null }],
        confidence: 0.7,
        isAssumedPrior: true,
        evidenceQuote: "Uses arithmetic without teaching it.",
      },
    ],
  };

  // Merge: with canonSimThreshold forced very low every distinct-title unit
  // clusters, so the model sees (0 Scarcity, 1 Opportunity Cost, 2 Arithmetic).
  // Decline all merges (empty groups) — the exact-title dup already collapsed
  // pre-model, so no model merge is needed to prove dedup; keeping them separate
  // gives us ≥2 taught nodes for the DAG.
  const merge = { groups: [] as unknown[] };

  // Edge inference over the taught canonicals (0 Scarcity, 1 Opportunity Cost).
  // A valid prerequisite + a self-loop + an evidenceless edge + a cycle-closing
  // edge + a redundant transitive edge — all resolved by the pure passes so the
  // persisted set is a DAG with only evidence-bearing prerequisites.
  const edges = {
    edges: [
      { sourceIndex: 0, targetIndex: 1, kind: "prerequisite", confidence: 0.9, evidenceQuote: "Scarcity precedes opportunity cost." },
      { sourceIndex: 1, targetIndex: 0, kind: "prerequisite", confidence: 0.3, evidenceQuote: "would close a cycle → the weakest edge is dropped" },
      { sourceIndex: 0, targetIndex: 0, kind: "related", confidence: 0.9, evidenceQuote: "self-loop → dropped" },
      { sourceIndex: 1, targetIndex: 0, kind: "related", confidence: 0.9, evidenceQuote: "" }, // evidenceless → dropped
    ],
  };

  return {
    [PROPOSAL_RESPONSE_NAME]: proposal,
    [MERGE_RESPONSE_NAME]: merge,
    [EDGE_RESPONSE_NAME]: edges,
  };
}

async function main() {
  const { url, anon, service } = env();

  // 1 — seed a FRESH throwaway fixture (published Microeconomics course).
  const fx = await seedTutorFixture({ url, anon });
  const lessonCount = fx.doc.modules.reduce((n, m) => n + m.lessons.length, 0);
  console.log(`# seeded fixture: course ${fx.courseId}, ${lessonCount} lessons, pub ${fx.publicationId} v${fx.version}`);

  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });
  const author = fx.author.client;
  const loadSnapshot = directSnapshotLoader(admin);

  // The extraction's fate finding references an agent_runs row (FK
  // agent_findings.run_id → agent_runs.id) — the real caller (Inngest/cron)
  // creates that row and passes its id. Mirror it: mint a queued run per
  // extraction so the fate row's FK resolves.
  const newRun = async (): Promise<string> => {
    const { data, error } = await admin
      .from("agent_runs")
      .insert({ course_id: fx.courseId, trigger: "scheduled", status: "running" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`agent_runs insert: ${error?.message}`);
    return data.id;
  };

  const responses = buildMockResponses(fx.doc);
  const model = createMockModelClient([], { structured: responses });
  const runId = await newRun();

  // 2 — run the extraction with the ADMIN client. canonSimThreshold forced low so
  //     the mock's un-clusterable embeddings still exercise the merge step.
  const result = await runGraphExtraction(
    { supabase: admin, model, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId }
  );

  // Cost telemetry lands one row per distinct model call (runId-scoped cid ⇒
  // retry-stable + per-run-unique). A model call is a runTurn (proposals/merge/
  // edge — getCalls) OR an embed (getEmbedCalls, a separate method). Capture both
  // counts for this first run to assert every call emitted a row.
  const mockRec = model as unknown as { getCalls(): unknown[]; getEmbedCalls(): unknown[] };
  const run1ModelCalls = mockRec.getCalls().length + mockRec.getEmbedCalls().length;
  const run1TutorRows = ((await admin.from("learning_events").select("id,client_event_id").eq("course_id", fx.courseId).like("event_type", "tutor_%")).data ?? []);

  /* ─────────────────────────── AC-T1.3 ──────────────────────────────────── */
  console.log("\n# AC-T1.3 — DAG, dedup, evidence, priors, snapshot map");
  check("run ok", result.ok, JSON.stringify({ checkpoint: result.checkpoint, flags: result.flags }));
  check("≥2 taught concept_nodes persisted", result.nodeCount >= 2, `nodeCount=${result.nodeCount}`);

  const nodes = (await admin.from("concept_nodes").select("id,title,status").eq("course_id", fx.courseId)).data ?? [];
  const activeNodes = nodes.filter((n) => n.status === "active");
  check("all persisted nodes are active", activeNodes.length === nodes.length && nodes.length >= 2);

  // zero same-title active-node dupes (case/whitespace-insensitive).
  const titleKeys = activeNodes.map((n) => n.title.trim().toLowerCase().replace(/\s+/g, " "));
  check("zero same-title active-node dupes", new Set(titleKeys).size === titleKeys.length, JSON.stringify(titleKeys));

  const edges = (await admin.from("concept_edges").select("id,source_node_id,target_node_id,kind,evidence_refs").eq("course_id", fx.courseId)).data ?? [];
  const kinds = new Set(edges.map((e) => e.kind));
  let anyCycle = false;
  for (const k of kinds) {
    if (hasCycleForKind(edges.filter((e) => e.kind === k))) anyCycle = true;
  }
  check("persisted concept_edges form a per-kind DAG (no cycle)", !anyCycle);
  check("no self-loop survived", edges.every((e) => e.source_node_id !== e.target_node_id));

  const prereqEdges = edges.filter((e) => e.kind === "prerequisite");
  check("≥1 prerequisite edge persisted", prereqEdges.length >= 1, `prereq=${prereqEdges.length}`);
  check(
    "100% of prerequisite edges carry non-empty evidence_refs",
    prereqEdges.every((e) => Array.isArray(e.evidence_refs) && (e.evidence_refs as unknown[]).length > 0)
  );

  const priors = (await admin.from("assumed_prior_nodes").select("id,title").eq("course_id", fx.courseId)).data ?? [];
  check("≥1 assumed_prior_nodes row", priors.length >= 1, `priors=${priors.length}`);
  check(
    "a pure assumed-prior is NOT ALSO a concept_node (no double-persist)",
    !activeNodes.some((n) => n.title.trim().toLowerCase() === "arithmetic")
  );

  const mapRows = (await admin.from("snapshot_concept_map").select("node_id,course_id,publication_id,version").eq("course_id", fx.courseId)).data ?? [];
  check("snapshot_concept_map rows exist (one per node)", mapRows.length === activeNodes.length && mapRows.length >= 2);
  check(
    "snapshot_concept_map rows carry the right (course, publication, version)",
    mapRows.every((r) => r.course_id === fx.courseId && r.publication_id === fx.publicationId && r.version === fx.version)
  );

  /* ─────────────────────────── AC-T1.4 ──────────────────────────────────── */
  console.log("\n# AC-T1.4 — per-lesson grain [1,4] or flagged");
  // Anchors carry lessonId; per-lesson node count = distinct nodes anchored there.
  const nodeAnchors = (await admin.from("concept_nodes").select("id,anchors").eq("course_id", fx.courseId)).data ?? [];
  const perLesson = new Map<string, number>();
  for (const n of nodeAnchors) {
    const seen = new Set<string>();
    for (const a of ((n.anchors as { lessonId?: string }[] | null) ?? [])) {
      if (a.lessonId && !seen.has(a.lessonId)) {
        seen.add(a.lessonId);
        perLesson.set(a.lessonId, (perLesson.get(a.lessonId) ?? 0) + 1);
      }
    }
  }
  const offenders = [...perLesson.entries()].filter(([, c]) => c < 1 || c > 4);
  const flaggedOffenders = offenders.every(([lessonId]) =>
    result.flags.some((f) => f.includes(lessonId))
  );
  check(
    "per-lesson node counts within [1,4] OR flags name the offender",
    offenders.length === 0 || flaggedOffenders,
    JSON.stringify(offenders)
  );

  /* ──────────────────── AC-T1.5 + AC-W1M.2 — reject then accept ──────────── */
  console.log("\n# AC-T1.5 + AC-W1M.2 — ONE pending set; items cover rows; reject → accept");
  const pendingSets = (await admin.from("change_sets").select("id,status").eq("course_id", fx.courseId).eq("status", "pending")).data ?? [];
  check("exactly ONE pending change_set", pendingSets.length === 1, `pending=${pendingSets.length}`);
  const changeSetId = pendingSets[0]?.id ?? result.changeSetId!;

  const items = (await admin.from("change_set_items").select("node_id,node_type,op,after").eq("change_set_id", changeSetId)).data ?? [];
  const persistedRowCount = activeNodes.length + edges.length + priors.length + mapRows.length;
  check(
    "concept_graph items cover EVERY persisted row",
    items.length === persistedRowCount && items.every((i) => i.node_type === "concept_graph"),
    `items=${items.length} rows=${persistedRowCount}`
  );

  const finding = (await admin.from("agent_findings").select("id,status,change_set_id").eq("change_set_id", changeSetId).eq("status", "proposed").maybeSingle()).data;
  check("fate finding is 'proposed' with the change_set_id", !!finding && finding.change_set_id === changeSetId);

  // Byte-snapshot the course doc BEFORE reject (the graph rows are off-doc; the doc
  // must be byte-identical after a reject that only removes graph rows).
  const docBefore = await loadCourseDoc(author, fx.courseId);
  const docBeforeStr = stableStringify(docBefore);

  // Reject through the ROUTE's exact sequence: rejectChangeSet(author, id, userId)
  // then the finding transition to 'dismissed'.
  await rejectChangeSet(author, changeSetId, fx.author.userId);
  await author.from("agent_findings").update({ status: "dismissed" }).eq("change_set_id", changeSetId).eq("status", "proposed");

  const nodesAfterReject = (await admin.from("concept_nodes").select("id").eq("course_id", fx.courseId)).data ?? [];
  const edgesAfterReject = (await admin.from("concept_edges").select("id").eq("course_id", fx.courseId)).data ?? [];
  const priorsAfterReject = (await admin.from("assumed_prior_nodes").select("id").eq("course_id", fx.courseId)).data ?? [];
  const mapAfterReject = (await admin.from("snapshot_concept_map").select("node_id").eq("course_id", fx.courseId)).data ?? [];
  check(
    "reject removes ALL graph rows (0 nodes/edges/priors/map)",
    nodesAfterReject.length === 0 && edgesAfterReject.length === 0 && priorsAfterReject.length === 0 && mapAfterReject.length === 0,
    JSON.stringify({ n: nodesAfterReject.length, e: edgesAfterReject.length, p: priorsAfterReject.length, m: mapAfterReject.length })
  );
  const dismissed = (await admin.from("agent_findings").select("status").eq("change_set_id", changeSetId).maybeSingle()).data;
  check("the fate finding transitioned to 'dismissed'", dismissed?.status === "dismissed");
  const rejectedSet = (await admin.from("change_sets").select("status").eq("id", changeSetId).maybeSingle()).data;
  check("the change_set is 'rejected'", rejectedSet?.status === "rejected");

  const docAfter = await loadCourseDoc(author, fx.courseId);
  check("the course doc is byte-identical after reject (graph rows are off-doc)", stableStringify(docAfter) === docBeforeStr);

  // RE-RUN extraction → a fresh pending set → ACCEPT via the route's sequence.
  console.log("\n# re-run → accept");
  const model2 = createMockModelClient([], { structured: responses });
  const rerun = await runGraphExtraction(
    { supabase: admin, model: model2, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId: await newRun() }
  );
  check("re-run ok + not alreadyPending (the prior set was rejected)", rerun.ok && !rerun.alreadyPending, JSON.stringify({ ap: rerun.alreadyPending }));
  const changeSet2 = rerun.changeSetId!;
  await acceptChangeSet(author, changeSet2);
  await author.from("agent_findings").update({ status: "accepted" }).eq("change_set_id", changeSet2).eq("status", "proposed");

  const nodesAfterAccept = (await admin.from("concept_nodes").select("id").eq("course_id", fx.courseId)).data ?? [];
  check("accept LEAVES the graph rows in place", nodesAfterAccept.length >= 2, `nodes=${nodesAfterAccept.length}`);
  const acceptedFinding = (await admin.from("agent_findings").select("status").eq("change_set_id", changeSet2).maybeSingle()).data;
  check("the fate finding is 'accepted'", acceptedFinding?.status === "accepted");
  const acceptedSet = (await admin.from("change_sets").select("status").eq("id", changeSet2).maybeSingle()).data;
  check("the change_set is 'accepted'", acceptedSet?.status === "accepted");

  /* ──────────────────────── pending guard ───────────────────────────────── */
  console.log("\n# pending guard — a second run over a pending set does nothing");
  // Re-run to open a THIRD pending set, then re-run AGAIN → alreadyPending.
  const model3 = createMockModelClient([], { structured: responses });
  const openPending = await runGraphExtraction(
    { supabase: admin, model: model3, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId: await newRun() }
  );
  check("a run after accept opens a NEW pending set", openPending.ok && !openPending.alreadyPending);
  const nodeCountBeforeGuard = ((await admin.from("concept_nodes").select("id").eq("course_id", fx.courseId)).data ?? []).length;
  const changeSetCountBefore = ((await admin.from("change_sets").select("id").eq("course_id", fx.courseId)).data ?? []).length;

  const model4 = createMockModelClient([], { structured: responses });
  const guarded = await runGraphExtraction(
    { supabase: admin, model: model4, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId: await newRun() }
  );
  check("a second run over a pending set returns alreadyPending", guarded.alreadyPending === true);
  const nodeCountAfterGuard = ((await admin.from("concept_nodes").select("id").eq("course_id", fx.courseId)).data ?? []).length;
  const changeSetCountAfter = ((await admin.from("change_sets").select("id").eq("course_id", fx.courseId)).data ?? []).length;
  check("alreadyPending persists NO new nodes", nodeCountAfterGuard === nodeCountBeforeGuard);
  check("alreadyPending stages NO new change_sets", changeSetCountAfter === changeSetCountBefore);

  /* ──────────────────────── cost telemetry (R-9) ────────────────────────── */
  console.log("\n# cost telemetry — tutor_model_call rows + double-emit + R-9");
  const tutorEvents = (await admin.from("learning_events").select("id,client_event_id,event_type").eq("course_id", fx.courseId).like("event_type", "tutor_%")).data ?? [];
  check("admin reads ≥1 tutor_model_call row", tutorEvents.length >= 1, `tutor rows=${tutorEvents.length}`);
  check("every tutor telemetry row is a tutor_model_call", tutorEvents.every((e) => e.event_type === "tutor_model_call"));
  // The first run emitted a cost row per model call (runId-scoped cid ⇒ every call
  // lands, none collide across runs). A missing row would mean a swallowed emit.
  check(
    "the first run persisted a tutor_model_call row for EVERY model call",
    run1TutorRows.length === run1ModelCalls && run1ModelCalls >= 3,
    `rows=${run1TutorRows.length} calls=${run1ModelCalls}`
  );

  // Double-emit with ONE providerResponseId does not duplicate (client_event_id
  // idempotency). Count rows for a fixed synthetic id, emit it twice, re-count.
  const providerId = `int-double-emit:${crypto.randomUUID()}`;
  const countFor = async () =>
    ((await admin.from("learning_events").select("id").eq("course_id", fx.courseId).eq("event_type", "tutor_model_call")).data ?? []).length;
  const before = await countFor();
  const emitArgs = {
    courseId: fx.courseId,
    learnerUserId: null,
    jobType: "graph_extraction" as const,
    // Read the model from config, not a literal — keeps the model-literal grep
    // guard (verify-tutor-models.ts) confined to modelConfig.ts.
    model: TUTOR_MODELS.graph_extraction.model,
    usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50 },
    latencyMs: 42,
    providerResponseId: providerId,
    emittedBy: fx.author.userId,
  };
  await emitTutorModelCall(admin, emitArgs);
  await emitTutorModelCall(admin, emitArgs); // same providerResponseId → no-op
  const after = await countFor();
  check("a double-emit with one providerResponseId adds exactly ONE row", after === before + 1, `before=${before} after=${after}`);

  // R-9 live check: the AUTHOR (RLS-scoped) client reads ZERO tutor_% rows —
  // tutor cost telemetry is admin-only.
  const authorTutor = (await author.from("learning_events").select("id").eq("course_id", fx.courseId).like("event_type", "tutor_%")).data ?? [];
  check("the AUTHOR client reads ZERO tutor_% rows (R-9)", authorTutor.length === 0, `author saw ${authorTutor.length}`);

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(
    JSON.stringify({
      counts: {
        nodes: activeNodes.length,
        edges: edges.length,
        priors: priors.length,
        snapshotMap: mapRows.length,
        tutorTelemetryRows: tutorEvents.length,
      },
    })
  );
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
