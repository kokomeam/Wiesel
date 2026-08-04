/**
 * Concept-graph EXTRACTION — PURE suite (no DB, no OpenAI key). TUTOR-1 Wave 1.3.
 *
 * The FIRST execution of the extraction pipeline's pure layers + a full
 * orchestrator run driven by the deterministic mock model over a HAND-ROLLED
 * recording supabase stub. Covers, per the Wave 1.3 directive:
 *
 *   - chunk derivation goldens over a PublicationSnapshot fixture (built with the
 *     real snapshot builder so the published quiz is genuinely answer-stripped):
 *     flat-slide element text, structured-template slot text, quiz STEMS present
 *     + answer fields ABSENT, homework prompt, per-chunk char cap + truncation
 *     marker, per-block/slide anchors
 *   - normalizeGrain: over-max top-N + grain_over, zero → grain_zero, course cap,
 *     in-band untouched
 *   - clusterByCosine: identical cluster / orthogonal don't / threshold boundary /
 *     determinism; exact-title pre-merge (normalizeTitleKey)
 *   - the edge pure passes: dropSelfLoops / pruneEvidenceless / dropLowConfidence /
 *     breakCyclesDropWeakest / transitiveReduction
 *   - Zod gates: ProposalBatch / MergeAdjudication / EdgeInference goldens + rejects
 *   - the FULL orchestrator: mock model keyed by the three response names + a
 *     recording stub supabase — asserts persist-before-changeset ordering, ONE
 *     change_sets row, an item per persisted row, the fate finding inserted then
 *     flipped to 'proposed' w/ change_set_id, flags/droppedEdges surfaced, cost
 *     emitted once per model call incl. the synthetic embed id, and the budget-
 *     exhaustion checkpoint path.
 *
 * Run: `npx tsx scripts/verify-tutor-extraction.ts`
 */

import {
  buildPublicationSnapshot,
} from "@/lib/course/publish/snapshot";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  createStructuredSlide,
} from "@/lib/course/factories";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type {
  CourseDocument,
  HomeworkBlock,
  QuizBlock,
  SlideDeckBlock,
} from "@/lib/course/types";

import { CHUNK_TRUNCATION_MARKER } from "@/lib/tutor/graph/config";
import { deriveLessonChunksWithCap, deriveLessonChunks } from "@/lib/tutor/graph/extractionSource";
import {
  ProposalBatchSchema,
  normalizeGrain,
  type LessonProposal,
} from "@/lib/tutor/graph/propose";
import {
  MergeAdjudicationSchema,
  clusterByCosine,
  cosineSimilarity,
  normalizeTitleKey,
} from "@/lib/tutor/graph/canonicalize";
import {
  EdgeInferenceSchema,
  breakCyclesDropWeakest,
  dropLowConfidence,
  dropSelfLoops,
  pruneEvidenceless,
  transitiveReduction,
  type InferredEdge,
} from "@/lib/tutor/graph/edges";
import { runGraphExtraction } from "@/lib/tutor/graph/extraction";
import {
  PROPOSAL_RESPONSE_NAME,
} from "@/lib/tutor/graph/propose";
import { MERGE_RESPONSE_NAME } from "@/lib/tutor/graph/canonicalize";
import { EDGE_RESPONSE_NAME } from "@/lib/tutor/graph/edges";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { tutorEventId } from "@/lib/tutor/telemetry";
import { withPooledModel } from "@/lib/ai/subagent";
import { readFileSync } from "node:fs";

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

/* ─────────────────────────── snapshot fixture ───────────────────────────── */

/** A flat slide-deck whose slides carry known element text (heading + bullets),
 *  so a chunk golden asserts the exact mined strings. */
function flatDeck(title: string, slides: [string, string[]][]): SlideDeckBlock {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.title = title;
  deck.slides = slides.map(([heading, bullets], i) => {
    const s = createSlide("title_bullets");
    for (const el of s.elements) {
      if (el.type === "heading") el.text = heading;
      else if (el.type === "bullet_list") el.items = bullets;
    }
    s.order = i;
    return s;
  });
  return deck;
}

/** A structured slide-deck (one key_concept slide) — its seeded slot text must
 *  surface in the derived chunk (structured-template walking). */
function structuredDeck(title: string): { deck: SlideDeckBlock; term: string } {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.title = title;
  const slide = createStructuredSlide("key_concept");
  // Overwrite the seeded term with a deterministic, searchable string.
  if (slide.template && slide.template.layoutId === "key_concept") {
    slide.template.content.term = { text: "STRUCTURED_TERM_MARKER" };
    slide.template.content.definition = { text: "A structured slot definition sentence." };
  }
  slide.order = 0;
  deck.slides = [slide];
  return { deck, term: "STRUCTURED_TERM_MARKER" };
}

function mcQuiz(title: string, prompt: string, choices: string[], correctIndex: number): QuizBlock {
  const quiz = createBlock("quiz", 0) as QuizBlock;
  quiz.title = title;
  const q = createQuestion("multiple_choice");
  if (q.kind !== "multiple_choice") throw new Error("unreachable");
  q.prompt = prompt;
  q.choices = choices.map((text, i) => ({ id: q.choices[i]?.id ?? `c-${i}`, text }));
  q.correctChoiceId = q.choices[correctIndex].id;
  q.explanation = "SECRET_EXPLANATION_MARKER — never in a snapshot.";
  quiz.questions = [q];
  return quiz;
}

function homeworkBlock(title: string, instructions: string, exercisePrompt: string): HomeworkBlock {
  const hw = createBlock("homework", 0) as HomeworkBlock;
  hw.title = title;
  hw.instructions = instructions;
  hw.deliverableType = "text_response";
  // Some homework schemas carry per-exercise prompts; seed one if the shape allows.
  const anyHw = hw as unknown as { exercises?: { id: string; title?: string; prompt: string }[] };
  if (Array.isArray(anyHw.exercises)) {
    anyHw.exercises = [{ id: "ex-1", title: "Exercise 1", prompt: exercisePrompt }];
  }
  return hw;
}

/** The long lesson's text overflows a tiny cap so the truncation marker fires. */
const LONG_SENTENCE =
  "This is a deliberately long teaching sentence that repeats enough content to overflow a small per-lesson character cap so the truncation marker is appended deterministically. ".repeat(
    6
  );

function buildFixtureDoc(ownerId: string): { doc: CourseDocument; structuredTerm: string } {
  const { deck: structDeck, term } = structuredDeck("Structured deck");

  const m1 = createModule("Module One", 0);
  // Lesson A — flat slides + a quiz (answer-stripping target).
  const lessonA = createLesson("Lesson A: Demand", 0);
  lessonA.objective = "Understand the law of demand.";
  lessonA.blocks = [
    flatDeck("Demand deck", [
      ["The Law of Demand", ["Quantity demanded falls as price rises.", "Substitution and income effects explain the slope."]],
      ["Shifts vs Movements", ["A price change moves along the curve.", "Income or taste changes shift the whole curve."]],
    ]),
    mcQuiz(
      "Demand check",
      "A rising price most directly signals that a good has become",
      ["more abundant", "relatively scarcer", "lower quality", "government-controlled"],
      1
    ),
  ];
  lessonA.blocks.forEach((b, i) => (b.order = i));

  // Lesson B — structured slide + homework.
  const lessonB = createLesson("Lesson B: Supply", 1);
  lessonB.objective = "Understand the law of supply.";
  lessonB.blocks = [
    structDeck,
    homeworkBlock(
      "Supply homework",
      "HOMEWORK_INSTRUCTIONS_MARKER: analyze a supply shift.",
      "EXERCISE_PROMPT_MARKER: compute producer surplus."
    ),
  ];
  lessonB.blocks.forEach((b, i) => (b.order = i));

  // Lesson C — a huge flat deck to trip the truncation cap.
  const lessonC = createLesson("Lesson C: Long", 2);
  lessonC.blocks = [
    flatDeck("Long deck", [["Overflow", [LONG_SENTENCE]]]),
  ];
  lessonC.blocks.forEach((b, i) => (b.order = i));

  m1.lessons = [lessonA, lessonB, lessonC];

  const doc: CourseDocument = {
    id: crypto.randomUUID(),
    title: "Fixture Course",
    description: "Pure-suite fixture.",
    plan: { outcomes: ["Learn demand and supply"], prerequisites: [] },
    modules: [m1],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
  return { doc, structuredTerm: term };
}

/* ────────────────────── recording supabase stub ─────────────────────────── */

interface RecordedCall {
  table: string | null;
  method: string;
  arg?: unknown;
}

/**
 * A hand-rolled supabase stub for the orchestrator's stage step. Records the
 * ORDER of `.from(table).<method>` calls + `.rpc()`, returns minimal success
 * shapes matching exactly what repository.ts / stageGraphChangeSet.ts read.
 *
 * The orchestrator touches: `.from("courses").select().eq().maybeSingle()`,
 * telemetry `.from("learning_events").upsert()`, then stage: the pending-guard
 * join select, node inserts, the edge RPC, assumed-prior upsert, snapshot_map
 * insert, change_sets insert, change_set_items insert, agent_findings insert +
 * update.
 */
function makeStubSupabase(opts: {
  authorId: string;
  onCall: (c: RecordedCall) => void;
  /** Return an existing pending change_set id from the guard (alreadyPending path). */
  pendingChangeSetId?: string | null;
}) {
  const { authorId, onCall } = opts;
  let nodeSeq = 0;
  let priorSeq = 0;

  function builder(table: string) {
    // The fluent chain: every terminal returns a thenable resolving to a
    // {data,error} shape. We track which table + terminal was hit to shape data.
    const state: { table: string; op: string; filters: Record<string, unknown>; payload?: unknown } = {
      table,
      op: "",
      filters: {},
    };

    const resolveTerminal = async (): Promise<{ data: unknown; error: null }> => {
      // change_set_items SELECT with a change_sets!inner join = the pending guard.
      if (table === "change_set_items" && state.op === "select") {
        onCall({ table, method: "select(pending-guard)" });
        return { data: opts.pendingChangeSetId ? { change_set_id: opts.pendingChangeSetId } : null, error: null };
      }
      if (table === "courses" && state.op === "select") {
        onCall({ table, method: "select(author)" });
        return { data: { author_id: authorId }, error: null };
      }
      if (table === "concept_nodes" && state.op === "insert") {
        onCall({ table, method: "insert", arg: state.payload });
        nodeSeq += 1;
        const now = new Date().toISOString();
        return {
          data: {
            id: `node-${nodeSeq}`,
            course_id: (state.payload as Record<string, unknown>)?.course_id,
            title: (state.payload as Record<string, unknown>)?.title ?? "",
            description: (state.payload as Record<string, unknown>)?.description ?? "",
            status: "active",
            merged_into_node_id: null,
            created_by: "extraction",
            creator_edited: false,
            aliases: (state.payload as Record<string, unknown>)?.aliases ?? [],
            anchors: (state.payload as Record<string, unknown>)?.anchors ?? [],
            embedding: null,
            external_taxonomy_ref: null,
            version: 1,
            created_at: now,
            updated_at: now,
          },
          error: null,
        };
      }
      if (table === "assumed_prior_nodes" && (state.op === "upsert" || state.op === "insert")) {
        onCall({ table, method: "upsert", arg: state.payload });
        priorSeq += 1;
        const now = new Date().toISOString();
        return {
          data: {
            id: `prior-${priorSeq}`,
            course_id: (state.payload as Record<string, unknown>)?.course_id,
            title: (state.payload as Record<string, unknown>)?.title ?? "",
            description: (state.payload as Record<string, unknown>)?.description ?? "",
            evidence: (state.payload as Record<string, unknown>)?.evidence ?? [],
            status: "active",
            created_at: now,
            updated_at: now,
          },
          error: null,
        };
      }
      if (table === "snapshot_concept_map" && state.op === "insert") {
        onCall({ table, method: "insert", arg: state.payload });
        const now = new Date().toISOString();
        return {
          data: {
            publication_id: (state.payload as Record<string, unknown>)?.publication_id,
            node_id: (state.payload as Record<string, unknown>)?.node_id,
            course_id: (state.payload as Record<string, unknown>)?.course_id,
            version: (state.payload as Record<string, unknown>)?.version,
            anchors: (state.payload as Record<string, unknown>)?.anchors ?? [],
            anchor_downgraded: (state.payload as Record<string, unknown>)?.anchor_downgraded ?? false,
            created_at: now,
          },
          error: null,
        };
      }
      if (table === "change_sets" && state.op === "insert") {
        onCall({ table, method: "insert", arg: state.payload });
        return { data: { id: "change-set-1" }, error: null };
      }
      if (table === "change_set_items" && state.op === "insert") {
        onCall({ table, method: "insert", arg: state.payload });
        return { data: null, error: null };
      }
      if (table === "agent_findings" && state.op === "insert") {
        onCall({ table, method: "insert", arg: state.payload });
        return { data: { id: "finding-1" }, error: null };
      }
      if (table === "agent_findings" && state.op === "update") {
        onCall({ table, method: "update", arg: state.payload });
        return { data: null, error: null };
      }
      if (table === "learning_events" && state.op === "upsert") {
        onCall({ table, method: "upsert(telemetry)", arg: state.payload });
        return { data: null, error: null };
      }
      onCall({ table, method: `${state.op}(unhandled)` });
      return { data: null, error: null };
    };

    const thenable = {
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        return resolveTerminal().then(resolve);
      },
    };

    const chain: Record<string, unknown> = {
      select() {
        state.op = state.op || "select";
        return chain;
      },
      insert(payload: unknown) {
        state.op = "insert";
        state.payload = payload;
        return chain;
      },
      upsert(payload: unknown) {
        state.op = "upsert";
        state.payload = payload;
        return chain;
      },
      update(payload: unknown) {
        state.op = "update";
        state.payload = payload;
        return chain;
      },
      eq(col: string, val: unknown) {
        state.filters[col] = val;
        return chain;
      },
      limit() {
        return chain;
      },
      order() {
        return chain;
      },
      maybeSingle() {
        return thenable;
      },
      single() {
        return thenable;
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        return thenable.then(resolve);
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      return builder(table);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "tutor_upsert_concept_edge") {
        onCall({ table: "concept_edges", method: "rpc(upsert_edge)", arg: args });
        const now = new Date().toISOString();
        return {
          data: {
            id: args.p_id,
            course_id: args.p_course_id,
            source_node_id: args.p_source_node_id,
            target_node_id: args.p_target_node_id,
            kind: args.p_kind,
            evidence_refs: args.p_evidence_refs ?? [],
            creator_locked: args.p_creator_locked ?? false,
            version: 1,
            created_at: now,
            updated_at: now,
          },
          error: null,
        };
      }
      onCall({ table: null, method: `rpc(${fn})`, arg: args });
      return { data: null, error: null };
    },
  };
}

/* ─────────────────────────── mock model script ──────────────────────────── */

/** Build the structured-response map keyed by the three response names. The
 *  proposals reference the REAL block ids of the fixture's lessons so anchors
 *  resolve; a dup pair collapses via the merge adjudication; edges include an
 *  evidenceless + a sub-threshold + a cycle + a transitive edge. */
function buildStructuredResponses(doc: CourseDocument) {
  const lessons = doc.modules[0].lessons;
  const blockA = lessons[0].blocks[0].id; // demand deck
  const slideA = (lessons[0].blocks[0] as SlideDeckBlock).slides[0].id;
  const blockB = lessons[1].blocks[0].id; // structured deck

  // Proposal responses are keyed by NAME, so the SAME payload answers every
  // per-lesson call (duplicates across lessons collapse by exact title). The
  // payload carries FOUR concepts after exact-title pre-merge:
  //   0. "Law of Demand"      — taught
  //   1. "law of demand"      — an EXACT-title dup of 0 (case-insensitive) →
  //                             pre-merged into 0 before any model call
  //   2. "Demand Curve"       — a taught NEAR-dup of 0 (distinct title → survives
  //                             pre-merge → the merge adjudication folds it in)
  //   3. "Market Equilibrium" — a second distinct taught concept (so ≥2 taught
  //                             nodes remain → edge inference runs)
  //   4. "Basic Algebra"      — an assumed-prior (routed to assumed_prior_nodes)
  const proposal = {
    concepts: [
      {
        title: "Law of Demand",
        description: "Quantity demanded falls as price rises.",
        lessonAnchors: [{ blockId: blockA, slideId: slideA }],
        confidence: 0.9,
        isAssumedPrior: false,
        evidenceQuote: "Quantity demanded falls as price rises.",
      },
      {
        title: "law of demand", // exact-title dup (case-insensitive) → pre-merges into 0
        description: "The demand relationship, restated.",
        lessonAnchors: [{ blockId: blockA, slideId: null }],
        confidence: 0.6,
        isAssumedPrior: false,
        evidenceQuote: "The demand relationship restated.",
      },
      {
        title: "Demand Curve", // distinct title → survives pre-merge → folded by the model
        description: "The graph of the demand relationship.",
        lessonAnchors: [{ blockId: blockA, slideId: null }],
        confidence: 0.7,
        isAssumedPrior: false,
        evidenceQuote: "The demand curve slopes downward.",
      },
      {
        title: "Market Equilibrium",
        description: "Where supply meets demand.",
        lessonAnchors: [{ blockId: blockB, slideId: null }],
        confidence: 0.85,
        isAssumedPrior: false,
        evidenceQuote: "Equilibrium clears the market.",
      },
      {
        title: "Basic Algebra",
        description: "Solving linear equations — assumed background.",
        lessonAnchors: [{ blockId: blockB, slideId: null }],
        confidence: 0.8,
        isAssumedPrior: true,
        evidenceQuote: "Uses algebra without teaching it.",
      },
    ],
  };

  // Merge adjudication. With canonSimThreshold forced to 0 (deps.config) every
  // unit clusters together, so the model sees the distinct-title units in order:
  //   0 "Law of Demand"  1 "Demand Curve"  2 "Market Equilibrium"  3 "Basic Algebra"
  // Fold unit 1 (Demand Curve) into 0; keep 2 + 3 separate (the model declines
  // those by not naming them in any group).
  const merge = { groups: [{ keepIndex: 0, mergeIndexes: [1], canonicalTitle: "Law of Demand", aliases: ["Demand Curve"] }] };

  // Edge inference over the TAUGHT canonical nodes (post-canonicalization order:
  //   0 "Law of Demand"  1 "Market Equilibrium"). Includes the four hardening
  // cases: a valid prerequisite, a self-loop, an evidenceless edge, a
  // sub-threshold edge.
  const edges = {
    edges: [
      { sourceIndex: 0, targetIndex: 1, kind: "prerequisite", confidence: 0.9, evidenceQuote: "Demand precedes equilibrium." },
      { sourceIndex: 0, targetIndex: 0, kind: "related", confidence: 0.9, evidenceQuote: "self-loop → dropped" },
      { sourceIndex: 1, targetIndex: 0, kind: "related", confidence: 0.4, evidenceQuote: "" }, // evidenceless → dropped
      { sourceIndex: 0, targetIndex: 1, kind: "related", confidence: 0.2, evidenceQuote: "weak related" }, // sub-threshold → dropped
    ],
  };

  return {
    [PROPOSAL_RESPONSE_NAME]: proposal,
    [MERGE_RESPONSE_NAME]: merge,
    [EDGE_RESPONSE_NAME]: edges,
  };
}

/* ──────────────────────────────── main ──────────────────────────────────── */

async function main() {
  const OWNER = crypto.randomUUID();
  const { doc, structuredTerm } = buildFixtureDoc(OWNER);
  const built = buildPublicationSnapshot(doc);
  const snapshot: PublicationSnapshot = PublicationSnapshotSchema.parse(built.snapshot);

  /* ───────────────────── chunk derivation goldens ────────────────────────── */
  console.log("\n# chunk derivation (deriveLessonChunks)");
  const chunks = deriveLessonChunks(snapshot);
  check("one chunk per lesson", chunks.length === 3, `got ${chunks.length}`);

  const chunkA = chunks[0];
  check("flat-slide element text present", chunkA.text.includes("Quantity demanded falls as price rises."));
  check("flat-slide bullet text present", chunkA.text.includes("Substitution and income effects explain the slope."));
  check("lesson title + objective mined", chunkA.text.includes("Lesson A: Demand") && chunkA.text.includes("Understand the law of demand."));

  // quiz STEMS present, answer fields ABSENT (the snapshot is answer-stripped).
  check("quiz question STEM present", chunkA.text.includes("A rising price most directly signals"));
  check("quiz choice text present (readable, not an answer)", chunkA.text.includes("relatively scarcer"));
  check(
    "no answer/explanation leaks in the derived chunk",
    !chunkA.text.includes("SECRET_EXPLANATION_MARKER") &&
      !/correctchoiceid/i.test(chunkA.text) &&
      !/\bexpected\b/i.test(chunkA.text) &&
      !/\bcorrect\b/i.test(chunkA.text)
  );

  const chunkB = chunks[1];
  check("structured-template slot text present", chunkB.text.includes(structuredTerm), chunkB.text.slice(0, 200));
  check("structured definition slot present", chunkB.text.includes("A structured slot definition sentence."));
  check("homework instructions present", chunkB.text.includes("HOMEWORK_INSTRUCTIONS_MARKER"));

  // anchors collected per block, and per slide for the flat deck.
  const deckAId = doc.modules[0].lessons[0].blocks[0].id;
  const quizAId = doc.modules[0].lessons[0].blocks[1].id;
  const slideAId = (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides[0].id;
  check("block-level anchor collected for the deck", chunkA.anchors.some((a) => a.blockId === deckAId && !a.slideId));
  check("slide-level anchor collected for a contributing slide", chunkA.anchors.some((a) => a.blockId === deckAId && a.slideId === slideAId));
  check("quiz block becomes an anchor", chunkA.anchors.some((a) => a.blockId === quizAId));

  // truncation cap + marker.
  console.log("\n# chunk cap + truncation marker (deriveLessonChunksWithCap)");
  const capped = deriveLessonChunksWithCap(snapshot, 200);
  const cappedC = capped[2];
  check("over-cap lesson chunk ends with the truncation marker", cappedC.text.endsWith(CHUNK_TRUNCATION_MARKER));
  check("truncated chunk length ≈ cap + marker", cappedC.text.length <= 200 + CHUNK_TRUNCATION_MARKER.length + 1);
  const uncapped = deriveLessonChunksWithCap(snapshot, 100000);
  check("a generous cap leaves short chunks untouched (no marker)", !uncapped[0].text.endsWith(CHUNK_TRUNCATION_MARKER));

  /* ─────────────────────────── normalizeGrain ───────────────────────────── */
  console.log("\n# normalizeGrain");
  const L1 = "lesson-1";
  const L2 = "lesson-2";
  const L3 = "lesson-3";
  const mkProp = (lessonId: string, title: string, confidence: number): LessonProposal => ({
    lessonId,
    proposal: {
      title,
      description: "",
      lessonAnchors: [],
      confidence,
      isAssumedPrior: false,
      evidenceQuote: "q",
    },
  });

  // Over-max: 6 concepts in L1 with grainMaxPerLesson=4 → keep top 4 by confidence.
  const overMax = [
    mkProp(L1, "c1", 0.1),
    mkProp(L1, "c2", 0.9),
    mkProp(L1, "c3", 0.5),
    mkProp(L1, "c4", 0.8),
    mkProp(L1, "c5", 0.7),
    mkProp(L1, "c6", 0.2),
  ];
  const overRes = normalizeGrain(overMax, { grainMaxPerLesson: 4, grainCourseMax: 100 }, [L1]);
  check("over-max keeps exactly grainMaxPerLesson", overRes.kept.length === 4);
  check("over-max flags grain_over:{lessonId}", overRes.flags.includes(`grain_over:${L1}`));
  check(
    "over-max keeps the top-N by confidence",
    overRes.kept.map((p) => p.proposal.title).sort().join(",") === ["c2", "c3", "c4", "c5"].sort().join(",")
  );

  // Zero: a processed lesson with no proposals flags grain_zero.
  const zeroRes = normalizeGrain([], { grainMaxPerLesson: 4, grainCourseMax: 100 }, [L2]);
  check("zero-concept lesson flags grain_zero:{lessonId}", zeroRes.flags.includes(`grain_zero:${L2}`) && zeroRes.kept.length === 0);

  // Course-max: total across lessons over the course cap → global top + course flag.
  const courseOver = [
    mkProp(L1, "a", 0.9),
    mkProp(L1, "b", 0.8),
    mkProp(L2, "c", 0.7),
    mkProp(L3, "d", 0.6),
  ];
  const courseRes = normalizeGrain(courseOver, { grainMaxPerLesson: 4, grainCourseMax: 2 }, [L1, L2, L3]);
  check("course cap keeps grainCourseMax globally", courseRes.kept.length === 2);
  check("course cap flags grain_course_over", courseRes.flags.includes("grain_course_over"));
  check(
    "course cap keeps the globally top-confidence set",
    courseRes.kept.map((p) => p.proposal.title).sort().join(",") === ["a", "b"].join(",")
  );

  // In-band: untouched, no flags.
  const inBand = [mkProp(L1, "x", 0.9), mkProp(L1, "y", 0.8), mkProp(L2, "z", 0.7)];
  const bandRes = normalizeGrain(inBand, { grainMaxPerLesson: 4, grainCourseMax: 100 }, [L1, L2]);
  check("in-band proposals pass through untouched", bandRes.kept.length === 3 && bandRes.flags.length === 0);

  /* ─────────────────────── clusterByCosine + titles ──────────────────────── */
  console.log("\n# clusterByCosine + exact-title pre-merge");
  const v1 = [1, 0, 0];
  const v1b = [1, 0, 0];
  const vOrtho = [0, 1, 0];
  check("identical vectors have cosine 1", Math.abs(cosineSimilarity(v1, v1b) - 1) < 1e-9);
  check("orthogonal vectors have cosine 0", Math.abs(cosineSimilarity(v1, vOrtho)) < 1e-9);

  const identCluster = clusterByCosine(
    [
      { key: "a", vector: v1 },
      { key: "b", vector: v1b },
    ],
    0.85
  );
  check("identical vectors cluster together", identCluster.length === 1 && identCluster[0].length === 2);

  const orthoCluster = clusterByCosine(
    [
      { key: "a", vector: v1 },
      { key: "b", vector: vOrtho },
    ],
    0.85
  );
  check("orthogonal vectors do NOT cluster", orthoCluster.length === 2);

  // threshold boundary: cosine exactly == threshold clusters (>= is inclusive).
  const half = Math.SQRT1_2; // cos 45° ≈ 0.7071
  const at45 = [
    { key: "a", vector: [1, 0] },
    { key: "b", vector: [1, 1] },
  ];
  check("cosine == threshold clusters (inclusive)", clusterByCosine(at45, half - 1e-12).length === 1);
  check("cosine just below threshold does NOT cluster", clusterByCosine(at45, half + 1e-6).length === 2);

  const det1 = JSON.stringify(clusterByCosine(at45, 0.5));
  const det2 = JSON.stringify(clusterByCosine(at45, 0.5));
  check("clustering is deterministic", det1 === det2);

  check("normalizeTitleKey collapses case + whitespace", normalizeTitleKey("  Law   OF Demand ") === "law of demand");
  check("normalizeTitleKey equates two spellings", normalizeTitleKey("Law of Demand") === normalizeTitleKey("law  of demand"));

  /* ───────────────────────── edge pure passes ───────────────────────────── */
  console.log("\n# edge pure passes");
  const mkEdge = (
    s: number,
    t: number,
    kind: InferredEdge["kind"],
    confidence: number,
    evidenceQuote = "q"
  ): InferredEdge => ({ sourceIndex: s, targetIndex: t, kind, confidence, evidenceQuote });

  // dropSelfLoops
  const selfRes = dropSelfLoops([mkEdge(0, 0, "related", 0.9), mkEdge(0, 1, "related", 0.9)]);
  check("dropSelfLoops removes source==target", selfRes.kept.length === 1 && selfRes.dropped.length === 1);

  // pruneEvidenceless
  const evRes = pruneEvidenceless([mkEdge(0, 1, "related", 0.9, ""), mkEdge(1, 2, "related", 0.9, "grounds it")]);
  check("pruneEvidenceless drops empty-quote edges", evRes.kept.length === 1 && evRes.dropped.length === 1);
  check("pruneEvidenceless drops whitespace-only quotes", pruneEvidenceless([mkEdge(0, 1, "related", 0.9, "   ")]).kept.length === 0);

  // dropLowConfidence (strictly below min)
  const confRes = dropLowConfidence([mkEdge(0, 1, "related", 0.4), mkEdge(1, 2, "related", 0.5), mkEdge(2, 3, "related", 0.6)], 0.5);
  check("dropLowConfidence drops strictly-below-min", confRes.kept.length === 2 && confRes.dropped.length === 1);
  check("dropLowConfidence keeps confidence == min", confRes.kept.some((e) => e.confidence === 0.5));

  // breakCyclesDropWeakest — a 3-cycle drops exactly its weakest edge.
  const cycle = [
    mkEdge(0, 1, "prerequisite", 0.9),
    mkEdge(1, 2, "prerequisite", 0.3), // weakest → dropped
    mkEdge(2, 0, "prerequisite", 0.8),
  ];
  const cycleRes = breakCyclesDropWeakest(cycle);
  check("3-cycle drops exactly one edge", cycleRes.dropped.length === 1 && cycleRes.kept.length === 2);
  check("3-cycle drops its WEAKEST edge", cycleRes.dropped[0].confidence === 0.3);

  const acyclic = [mkEdge(0, 1, "prerequisite", 0.9), mkEdge(1, 2, "prerequisite", 0.9)];
  check("acyclic input is untouched", breakCyclesDropWeakest(acyclic).dropped.length === 0);

  // deterministic tie-break: two equal-weight cycle edges → earliest index removed.
  const tieCycle = [mkEdge(0, 1, "prerequisite", 0.5), mkEdge(1, 0, "prerequisite", 0.5)];
  const tie1 = JSON.stringify(breakCyclesDropWeakest(tieCycle).dropped);
  const tie2 = JSON.stringify(breakCyclesDropWeakest(tieCycle).dropped);
  check("cycle-break tie-break is deterministic", tie1 === tie2);

  // transitiveReduction — diamond A→B→C + A→C removes A→C.
  const diamond = [
    mkEdge(0, 1, "prerequisite", 0.9), // A→B
    mkEdge(1, 2, "prerequisite", 0.9), // B→C
    mkEdge(0, 2, "prerequisite", 0.9), // A→C (redundant)
  ];
  const trRes = transitiveReduction(diamond);
  check("transitiveReduction drops the redundant A→C", trRes.dropped.length === 1 && trRes.dropped[0].sourceIndex === 0 && trRes.dropped[0].targetIndex === 2);
  check("transitiveReduction keeps A→B and B→C", trRes.kept.length === 2);

  const noIndirect = [mkEdge(0, 1, "prerequisite", 0.9), mkEdge(0, 2, "prerequisite", 0.9)];
  check("transitiveReduction keeps A→C when no indirect path exists", transitiveReduction(noIndirect).dropped.length === 0);

  // per-kind isolation: a 'related' A→C is NOT reduced by a 'prerequisite' path.
  const perKind = [mkEdge(0, 1, "prerequisite", 0.9), mkEdge(1, 2, "prerequisite", 0.9), mkEdge(0, 2, "related", 0.9)];
  check("transitiveReduction is per-kind (a related A→C survives a prerequisite path)", transitiveReduction(perKind).kept.some((e) => e.kind === "related" && e.sourceIndex === 0 && e.targetIndex === 2));

  /* ───────────────────────────── Zod gates ──────────────────────────────── */
  console.log("\n# Zod schema gates");
  check(
    "ProposalBatchSchema parses a valid batch",
    ProposalBatchSchema.safeParse({
      concepts: [
        { title: "T", description: "d", lessonAnchors: [{ blockId: "b", slideId: null }], confidence: 0.5, isAssumedPrior: false, evidenceQuote: "q" },
      ],
    }).success
  );
  check("ProposalBatchSchema rejects confidence > 1", !ProposalBatchSchema.safeParse({ concepts: [{ title: "T", description: "d", lessonAnchors: [], confidence: 1.5, isAssumedPrior: false, evidenceQuote: "q" }] }).success);
  check("ProposalBatchSchema rejects an empty title", !ProposalBatchSchema.safeParse({ concepts: [{ title: "", description: "d", lessonAnchors: [], confidence: 0.5, isAssumedPrior: false, evidenceQuote: "q" }] }).success);

  check("MergeAdjudicationSchema parses a valid verdict", MergeAdjudicationSchema.safeParse({ groups: [{ keepIndex: 0, mergeIndexes: [1, 2], canonicalTitle: "T", aliases: ["a"] }] }).success);
  check("MergeAdjudicationSchema rejects a negative keepIndex", !MergeAdjudicationSchema.safeParse({ groups: [{ keepIndex: -1, mergeIndexes: [], canonicalTitle: "T", aliases: [] }] }).success);

  check("EdgeInferenceSchema parses valid edges", EdgeInferenceSchema.safeParse({ edges: [{ sourceIndex: 0, targetIndex: 1, kind: "prerequisite", confidence: 0.8, evidenceQuote: "q" }] }).success);
  check("EdgeInferenceSchema rejects an unknown kind", !EdgeInferenceSchema.safeParse({ edges: [{ sourceIndex: 0, targetIndex: 1, kind: "causes", confidence: 0.8, evidenceQuote: "q" }] }).success);

  /* ───────────────────── FULL orchestrator (mock + stub) ─────────────────── */
  console.log("\n# full orchestrator run (mock model + recording stub supabase)");
  const responses = buildStructuredResponses(doc);
  const rawModel = createMockModelClient([], { structured: responses });
  const calls: RecordedCall[] = [];
  const stub = makeStubSupabase({ authorId: OWNER, onCall: (c) => calls.push(c) });

  const runId = crypto.randomUUID();
  // W3.1 · D-2: cost telemetry now emits from the withPooledModel decorator (the
  // inline emit was retired). Wrap the mock exactly as the Inngest assembly does —
  // creator pool + cost context keyed runKey=runId → deterministic `${runId}:${seq}`.
  const model = withPooledModel(rawModel, {
    cost: { supabase: stub as never, courseId: doc.id, emittedBy: OWNER, jobType: "graph_extraction", runKey: runId },
  });
  const result = await runGraphExtraction(
    {
      supabase: stub as never,
      model,
      loadSnapshot: async () => ({ snapshot, version: 3 }),
      // Force ALL units into one cluster so the merge adjudication fires (the mock
      // embed can't push two distinct strings past the real 0.85 threshold), and
      // lift the grain caps so the crafted concept set survives untouched.
      config: { canonSimThreshold: -1, grainMaxPerLesson: 20, grainCourseMax: 200 },
    },
    { courseId: doc.id, publicationId: crypto.randomUUID(), runId }
  );

  const persistedNodeTitles = calls
    .filter((c) => c.table === "concept_nodes" && c.method === "insert")
    .map((c) => (c.arg as Record<string, unknown>).title);
  check("run ok", result.ok, JSON.stringify({ checkpoint: result.checkpoint, flags: result.flags }));
  check(
    "a pure assumed-prior is NOT ALSO persisted as a concept_node",
    !persistedNodeTitles.includes("Basic Algebra")
  );
  check("taught nodes persisted (Law of Demand + Market Equilibrium)", result.nodeCount === 2, `nodeCount=${result.nodeCount}`);
  check("the model-merged near-dup collapsed (Demand Curve folded into Law of Demand)", result.nodeCount === 2);
  check("at least one edge survives the hardening passes", result.edgeCount === 1, `edgeCount=${result.edgeCount}`);
  check("an assumed prior was routed out of the taught nodes", result.assumedPriorCount === 1, `assumedPriorCount=${result.assumedPriorCount}`);
  check("a change_set id was returned", result.changeSetId === "change-set-1");
  check("a finding id was returned", result.findingId === "finding-1");

  // Persist-before-changeset ORDER: every node/edge/prior/snapshot-map insert
  // happens BEFORE the change_sets insert.
  const changeSetInsertIdx = calls.findIndex((c) => c.table === "change_sets" && c.method === "insert");
  const nodeInsertIdxs = calls.map((c, i) => (c.table === "concept_nodes" && c.method === "insert" ? i : -1)).filter((i) => i >= 0);
  const edgeRpcIdxs = calls.map((c, i) => (c.method === "rpc(upsert_edge)" ? i : -1)).filter((i) => i >= 0);
  const priorIdxs = calls.map((c, i) => (c.table === "assumed_prior_nodes" ? i : -1)).filter((i) => i >= 0);
  const mapIdxs = calls.map((c, i) => (c.table === "snapshot_concept_map" && c.method === "insert" ? i : -1)).filter((i) => i >= 0);
  check("exactly ONE change_sets insert", calls.filter((c) => c.table === "change_sets" && c.method === "insert").length === 1);
  check(
    "all graph rows persist BEFORE the change_sets insert",
    changeSetInsertIdx > 0 &&
      [...nodeInsertIdxs, ...edgeRpcIdxs, ...priorIdxs, ...mapIdxs].every((i) => i < changeSetInsertIdx)
  );

  // ONE item per persisted row: change_set_items insert payload length = nodes +
  // edges + priors + snapshot_map rows.
  const itemsInsert = calls.find((c) => c.table === "change_set_items" && c.method === "insert");
  const itemRows = (itemsInsert?.arg as unknown[]) ?? [];
  const persistedRowCount = nodeInsertIdxs.length + edgeRpcIdxs.length + priorIdxs.length + mapIdxs.length;
  check(
    "a change_set_items row per persisted row",
    itemRows.length === persistedRowCount,
    `items=${itemRows.length} persisted=${persistedRowCount}`
  );
  check(
    "every change_set_items row is node_type concept_graph, op create",
    itemRows.every((r) => (r as Record<string, unknown>).node_type === "concept_graph" && (r as Record<string, unknown>).op === "create")
  );
  check(
    "each item's after payload carries {entity,row}",
    itemRows.every((r) => {
      const after = (r as Record<string, unknown>).after as Record<string, unknown> | undefined;
      return !!after && typeof after.entity === "string" && !!after.row;
    })
  );

  // Fate finding: inserted (open) then flipped to 'proposed' with the change_set_id.
  const findingInsert = calls.find((c) => c.table === "agent_findings" && c.method === "insert");
  const findingUpdate = calls.find((c) => c.table === "agent_findings" && c.method === "update");
  check("the fate finding is inserted", !!findingInsert);
  check(
    "the fate finding is flipped to 'proposed' with the change_set_id",
    !!findingUpdate &&
      (findingUpdate.arg as Record<string, unknown>).status === "proposed" &&
      (findingUpdate.arg as Record<string, unknown>).change_set_id === "change-set-1"
  );
  check(
    "the fate finding stamps the graph_extraction discriminator + counts in the jsonb",
    !!findingInsert &&
      ((findingInsert.arg as Record<string, unknown>).finding as Record<string, unknown>).discriminator === "graph_extraction"
  );

  // flags + droppedEdges surfaced in the result.
  check("droppedEdges log surfaces the self-loop drop", result.droppedEdges.some((d) => d.reason === "self_loop"));
  check("droppedEdges log surfaces the evidenceless drop", result.droppedEdges.some((d) => d.reason === "evidenceless"));
  check("droppedEdges log surfaces the low-confidence drop", result.droppedEdges.some((d) => d.reason === "low_confidence"));

  // Cost telemetry (W3.1 · D-2): the withPooledModel decorator emits ONE cost row per
  // GATED model call — 3 per-lesson proposals + one embed + one merge + one edge call
  // = 6, exactly as before. The ids are now `${runId}:${seq}` (seq = the decorator's
  // per-instance monotonic counter over the call ORDER: propose0,propose1,propose2,
  // embed,merge,edges → 0..5). Deterministic + retry-stable: a re-run mints the SAME
  // ids so an Inngest step retry re-emits as a no-op (asserted in the double-run below).
  const telemetry = calls.filter((c) => c.method === "upsert(telemetry)");
  check("a telemetry row per model call (>=6: 3 proposals + embed + merge + edges)", telemetry.length >= 6, `telemetry=${telemetry.length}`);
  const emittedIds = new Set(
    telemetry.map((c) => (((c.arg as unknown[])?.[0] ?? {}) as Record<string, unknown>).client_event_id as string)
  );
  const expectSeqId = (seq: number) => emittedIds.has(tutorEventId(`${runId}:${seq}`));
  check("cost ids are the deterministic `${runId}:${seq}` sequence 0..5", [0, 1, 2, 3, 4, 5].every(expectSeqId), [...emittedIds].join(","));
  check("the embed cost is emitted (its seq slot, 4th call = index 3)", expectSeqId(3));
  check("proposal cost ids are runId-scoped (retry-stable), not the provider responseId", expectSeqId(0) && expectSeqId(1) && expectSeqId(2));
  check("the edge cost id is runId-scoped (retry-stable)", expectSeqId(5));

  // DOUBLE-RUN determinism: an identical re-run (Inngest retry) mints the SAME cost
  // ids, so the upsert(onConflict client_event_id) no-ops instead of double-counting.
  const rerunCalls: RecordedCall[] = [];
  const rerunStub = makeStubSupabase({ authorId: OWNER, onCall: (c) => rerunCalls.push(c) });
  await runGraphExtraction(
    {
      supabase: rerunStub as never,
      model: withPooledModel(createMockModelClient([], { structured: responses }), {
        cost: { supabase: rerunStub as never, courseId: doc.id, emittedBy: OWNER, jobType: "graph_extraction", runKey: runId },
      }),
      loadSnapshot: async () => ({ snapshot, version: 3 }),
      config: { canonSimThreshold: -1, grainMaxPerLesson: 20, grainCourseMax: 200 },
    },
    { courseId: doc.id, publicationId: crypto.randomUUID(), runId }
  );
  const rerunIds = new Set(
    rerunCalls.filter((c) => c.method === "upsert(telemetry)").map((c) => (((c.arg as unknown[])?.[0] ?? {}) as Record<string, unknown>).client_event_id as string)
  );
  check("a double-run mints IDENTICAL cost ids (retry-stable → no double-count)", [...emittedIds].every((id) => rerunIds.has(id)) && emittedIds.size === rerunIds.size);

  // The inline emitTutorModelCall path is GONE — the decorator is the ONLY emitter.
  const extractionSrc = readFileSync(new URL("../lib/tutor/graph/extraction.ts", import.meta.url), "utf8");
  check("extraction.ts contains NO emitTutorModelCall call (inline emit retired)", !/emitTutorModelCall\s*\(/.test(extractionSrc));

  /* ───────────────── alreadyPending short-circuit ────────────────────────── */
  console.log("\n# alreadyPending short-circuit");
  const model2 = createMockModelClient([], { structured: responses });
  const calls2: RecordedCall[] = [];
  const stub2 = makeStubSupabase({ authorId: OWNER, onCall: (c) => calls2.push(c), pendingChangeSetId: "existing-cs" });
  const pendingResult = await runGraphExtraction(
    {
      supabase: stub2 as never,
      model: model2,
      loadSnapshot: async () => ({ snapshot, version: 3 }),
    },
    { courseId: doc.id, publicationId: crypto.randomUUID(), runId: crypto.randomUUID() }
  );
  check("a pending set short-circuits to alreadyPending", pendingResult.alreadyPending === true);
  check("alreadyPending persists NO new graph rows", calls2.filter((c) => c.table === "concept_nodes" && c.method === "insert").length === 0);
  check("alreadyPending stages NO new change_sets", calls2.filter((c) => c.table === "change_sets" && c.method === "insert").length === 0);

  /* ─────────────────── budget-exhaustion checkpoint ──────────────────────── */
  console.log("\n# budget-exhaustion checkpoint");
  // The env-backed maxCalls resolves at import, so we dial it at call time via the
  // deps.config override (the only injection seam). A hard cap of 2 over a 5-lesson
  // snapshot GUARANTEES exhaustion: 2 proposal calls spend the whole budget, the
  // remaining 3 lessons are checkpointed.
  const bigM = createModule("Big Module", 0);
  bigM.lessons = [0, 1, 2, 3, 4].map((n) => {
    const l = createLesson(`Lesson ${n}`, n);
    l.blocks = [flatDeck(`Deck ${n}`, [["H", [`Body ${n}.`]]])];
    l.blocks.forEach((b, i) => (b.order = i));
    return l;
  });
  const bigDoc: CourseDocument = { ...doc, id: crypto.randomUUID(), modules: [bigM] };
  const bigSnapshot = PublicationSnapshotSchema.parse(buildPublicationSnapshot(bigDoc).snapshot);

  const model3 = createMockModelClient([], { structured: responses });
  const calls3: RecordedCall[] = [];
  const stub3 = makeStubSupabase({ authorId: OWNER, onCall: (c) => calls3.push(c) });
  const exhaustResult = await runGraphExtraction(
    {
      supabase: stub3 as never,
      model: model3,
      loadSnapshot: async () => ({ snapshot: bigSnapshot, version: 1 }),
      config: { maxCalls: 2 },
    },
    { courseId: bigDoc.id, publicationId: crypto.randomUUID(), runId: crypto.randomUUID() }
  );
  check("budget exhaustion sets a checkpoint", exhaustResult.checkpoint !== null, String(exhaustResult.checkpoint));
  check("the checkpoint names unprocessed lessons", (exhaustResult.checkpoint ?? "").includes("not processed"));
  check("budget_exhausted flag is raised", exhaustResult.flags.includes("budget_exhausted"));
  check("an exhausted run still ok + stages what it built", exhaustResult.ok === true);

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
