/**
 * The concept-graph EXTRACTION orchestrator (TUTOR-1 Wave 1.3 · Directive §1.2 step 7).
 *
 * Wires the pure pipeline modules + the model calls into one run:
 *   author_id ← course (admin)
 *   snapshot ← getCachedSnapshot(publicationId)
 *   chunks   ← deriveLessonChunks
 *   propose  ← per-lesson structured proposal, under a CallBudget counter
 *              (TUTOR_EXTRACTION_MAX_CALLS); exhaustion STOPS proposing and
 *              CHECKPOINTS the unprocessed lessons — never silently half-done.
 *   grain    ← normalizeGrain (pure)
 *   canon    ← exact-title pre-merge → ONE batched embed → clusterByCosine →
 *              per-cluster Terra merge-adjudication
 *   anchors  ← resolve each node's anchors against the snapshot (an unknown
 *              blockId drops the anchor; a slideId that doesn't resolve DOWNGRADES
 *              to block level → snapshot_map anchorDowngraded=true — R-13)
 *   edges    ← Terra edge-inference → the pure passes (prune / drop-low / break-
 *              cycles / transitive-reduction)
 *   priors   ← from isAssumedPrior canonicals, deduped by title
 *   stage    ← stageExtractionResult (persist rows, then ONE change-set + fate row)
 *
 * EVERY model call routes through runStructuredCall with the TUTOR_MODELS config
 * and is cost-emitted via emitTutorModelCall (embeds use the DETERMINISTIC
 * synthetic response id `embed:{runId}:{batchIndex}` — the embeddings API returns
 * none — so a step retry re-emits as a no-op). A thrown error settles into
 * {ok:false, checkpoint:<error>} — the Inngest wrapper owns retries.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { runStructuredCall } from "@/lib/ai/subagent";
import { TUTOR_MODELS, computeCostUsd } from "@/lib/ai/modelConfig";
import { emitTutorModelCall } from "@/lib/tutor/telemetry";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import { resolveExtractionConfig, type ExtractionConfig } from "./config";
import { deriveLessonChunksWithCap, type LessonChunkAnchor } from "./extractionSource";
import {
  PROPOSAL_RESPONSE_NAME,
  PROPOSAL_SYSTEM_PROMPT,
  ProposalBatchSchema,
  buildProposalInput,
  normalizeGrain,
  type LessonProposal,
} from "./propose";
import {
  MERGE_RESPONSE_NAME,
  MERGE_SYSTEM_PROMPT,
  MergeAdjudicationSchema,
  clusterByCosine,
  foldConcept,
  normalizeTitleKey,
  type CanonicalConcept,
} from "./canonicalize";
import {
  EDGE_RESPONSE_NAME,
  EDGE_SYSTEM_PROMPT,
  EdgeInferenceSchema,
  breakCyclesDropWeakest,
  dropLowConfidence,
  dropSelfLoops,
  pruneEvidenceless,
  transitiveReduction,
  type InferredEdge,
} from "./edges";
import {
  stageExtractionResult,
  type StageEdgeInput,
  type StageNodeInput,
  type StageSnapshotMapInput,
} from "./stageGraphChangeSet";

type DB = SupabaseClient<Database>;

/* ─────────────────────────────── types ──────────────────────────────────── */

export interface GraphExtractionDeps {
  supabase: DB;
  model: ModelClient;
  nowIso?: () => string;
  /** Injectable snapshot loader (defaults to getCachedSnapshot — the admin-client
   *  + Next-data-cache path). Overridden by the pure suite to run the orchestrator
   *  with NO DB read for the source snapshot (mirrors the nowIso injection seam);
   *  production/Inngest never passes it. */
  loadSnapshot?: (
    publicationId: string
  ) => Promise<{ snapshot: PublicationSnapshot; version: number }>;
  /** Config overrides merged over the env-resolved defaults. The env-backed
   *  constants resolve at import, so this is the ONLY way a test dials a knob
   *  (e.g. maxCalls) at call time; production never passes it. */
  config?: Partial<ExtractionConfig>;
}

export interface GraphExtractionResult {
  ok: boolean;
  alreadyPending?: boolean;
  changeSetId: string | null;
  findingId: string | null;
  nodeCount: number;
  edgeCount: number;
  assumedPriorCount: number;
  flags: string[];
  droppedEdges: { reason: string; count: number }[];
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number };
  /** Non-null when the run STOPPED early (budget exhaustion or a thrown error) —
   *  the human-readable reason, listing unprocessed lessons on exhaustion. */
  checkpoint: string | null;
}

export interface RunGraphExtractionArgs {
  courseId: string;
  publicationId: string;
  runId: string;
}

/* ──────────────────────────── model-call budget ─────────────────────────── */

interface CallBudget {
  remaining: number;
}

interface UsageTotals {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

function addUsage(
  totals: UsageTotals,
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number },
  model: string
): void {
  totals.inputTokens += usage.inputTokens;
  totals.cachedTokens += usage.cachedTokens;
  totals.outputTokens += usage.outputTokens;
  // Mirror the per-call cost into the run total using the SAME pricing table
  // emitTutorModelCall uses (computeCostUsd → null for an unpriced model = +0).
  totals.costUsd += computeCostUsd(usage, model) ?? 0;
}

/* ─────────────────────────── cost-emit helper ───────────────────────────── */

/**
 * Emit ONE model call's cost + accumulate its usage. Wraps emitTutorModelCall so
 * every call site is one line. For embeds pass a synthetic providerResponseId
 * (`embed:{runId}:{batchIndex}`) since the embeddings API returns none.
 */
async function emitAndAccumulate(
  deps: GraphExtractionDeps,
  args: {
    courseId: string;
    authorId: string;
    jobType: "graph_extraction" | "embedding";
    model: string;
    usage: { inputTokens: number; cachedTokens: number; outputTokens: number };
    latencyMs: number;
    providerResponseId: string;
  },
  totals: UsageTotals
): Promise<void> {
  await emitTutorModelCall(deps.supabase, {
    courseId: args.courseId,
    learnerUserId: null,
    jobType: args.jobType,
    model: args.model,
    usage: args.usage,
    latencyMs: args.latencyMs,
    providerResponseId: args.providerResponseId,
    emittedBy: args.authorId,
  });
  addUsage(totals, args.usage, args.model);
}

/* ───────────────────────────── anchor resolution ────────────────────────── */

/** Build the sets of valid blockIds + (blockId→slideIds) present in the snapshot,
 *  so a proposal's anchors can be resolved (R-13). */
function buildSnapshotAnchorIndex(snapshot: PublicationSnapshot): {
  blockIds: Set<string>;
  slideIdsByBlock: Map<string, Set<string>>;
} {
  const blockIds = new Set<string>();
  const slideIdsByBlock = new Map<string, Set<string>>();
  for (const module of snapshot.modules) {
    for (const lesson of module.lessons) {
      for (const block of lesson.blocks) {
        blockIds.add(block.id);
        if (block.type === "slide_deck") {
          const set = new Set<string>();
          for (const slide of block.slides) set.add(slide.id);
          slideIdsByBlock.set(block.id, set);
        }
      }
    }
  }
  return { blockIds, slideIdsByBlock };
}

/** Resolve one canonical concept's anchors against the snapshot. An anchor whose
 *  blockId is unknown is DROPPED. A slideId that doesn't resolve DOWNGRADES to
 *  block level (slideId cleared) and flags the whole node's map row
 *  anchorDowngraded=true (R-13). Returns the resolved anchors + the downgrade flag. */
function resolveAnchors(
  anchors: LessonChunkAnchor[],
  index: { blockIds: Set<string>; slideIdsByBlock: Map<string, Set<string>> }
): { resolved: LessonChunkAnchor[]; downgraded: boolean } {
  const resolved: LessonChunkAnchor[] = [];
  let downgraded = false;
  const seen = new Set<string>();
  for (const a of anchors) {
    if (!index.blockIds.has(a.blockId)) continue; // unknown block → drop
    if (a.slideId) {
      const slides = index.slideIdsByBlock.get(a.blockId);
      if (slides && slides.has(a.slideId)) {
        const key = `${a.blockId}::${a.slideId}`;
        if (!seen.has(key)) {
          seen.add(key);
          resolved.push({ blockId: a.blockId, slideId: a.slideId });
        }
        continue;
      }
      // slideId didn't resolve → downgrade to block level.
      downgraded = true;
    }
    const key = `${a.blockId}::`;
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ blockId: a.blockId });
    }
  }
  return { resolved, downgraded };
}

/* ───────────────────────────── canonicalize step ────────────────────────── */

/**
 * Exact-title pre-merge → embed → cluster → per-cluster adjudication. Returns the
 * canonical concepts + accumulated flags. Model calls decrement the budget; when
 * the budget runs out mid-canonicalization the remaining clusters stay UNMERGED
 * (each member becomes its own canonical) — never a crash.
 */
async function canonicalize(
  deps: GraphExtractionDeps,
  courseId: string,
  authorId: string,
  runId: string,
  proposals: LessonProposal[],
  cfg: ExtractionConfig,
  budget: CallBudget,
  totals: UsageTotals
): Promise<{ canonicals: CanonicalConcept[]; flags: string[] }> {
  const flags: string[] = [];
  if (proposals.length === 0) return { canonicals: [], flags };

  // 1. Exact-title pre-merge (deterministic, no model). Group members by
  //    normalized title; the FIRST member is the survivor.
  const exactGroups = new Map<string, LessonProposal[]>();
  const groupOrder: string[] = [];
  for (const p of proposals) {
    const key = normalizeTitleKey(p.proposal.title);
    if (!exactGroups.has(key)) {
      exactGroups.set(key, []);
      groupOrder.push(key);
    }
    exactGroups.get(key)!.push(p);
  }

  // Pre-merged units: one per distinct normalized title.
  interface Unit {
    survivor: LessonProposal;
    members: LessonProposal[];
    embedKey: string;
  }
  const units: Unit[] = groupOrder.map((key) => {
    const members = exactGroups.get(key)!;
    return { survivor: members[0], members, embedKey: `${members[0].proposal.title}: ${members[0].proposal.description}` };
  });

  // A single unit ⇒ nothing to cluster/adjudicate.
  if (units.length === 1) {
    const u = units[0];
    return {
      canonicals: [foldConcept(u.survivor, u.members, u.survivor.proposal.title, [])],
      flags,
    };
  }

  // 2. ONE batched embed of every unit's title+": "+description.
  let vectors: number[][] = [];
  if (deps.model.embed && budget.remaining > 0) {
    budget.remaining -= 1;
    const t0 = Date.now();
    try {
      const res = await deps.model.embed({
        model: TUTOR_MODELS.embedding.model,
        inputs: units.map((u) => u.embedKey),
        timeoutMs: TUTOR_MODELS.embedding.timeoutMs,
      });
      vectors = res.vectors;
      await emitAndAccumulate(
        deps,
        {
          courseId,
          authorId,
          jobType: "embedding",
          model: TUTOR_MODELS.embedding.model,
          usage: { inputTokens: res.usage.inputTokens, cachedTokens: 0, outputTokens: 0 },
          latencyMs: Date.now() - t0,
          // Deterministic synthetic id — the embeddings API returns none.
          providerResponseId: `embed:${runId}:0`,
        },
        totals
      );
    } catch {
      flags.push("embed_failed");
      vectors = [];
    }
  }

  // Without vectors, every unit stands alone (no clustering possible).
  if (vectors.length !== units.length) {
    return {
      canonicals: units.map((u) => foldConcept(u.survivor, u.members, u.survivor.proposal.title, [])),
      flags,
    };
  }

  // 3. Cluster by cosine.
  const clusters = clusterByCosine(
    units.map((u, i) => ({ key: String(i), vector: vectors[i] })),
    cfg.canonSimThreshold
  );

  // 4. Per multi-member cluster, ONE adjudication call. Singletons pass through.
  const canonicals: CanonicalConcept[] = [];
  for (const cluster of clusters) {
    const memberUnits = cluster.map((k) => units[Number(k)]);
    if (memberUnits.length === 1) {
      const u = memberUnits[0];
      canonicals.push(foldConcept(u.survivor, u.members, u.survivor.proposal.title, []));
      continue;
    }

    // Budget-out ⇒ leave the cluster unmerged.
    if (budget.remaining <= 0) {
      for (const u of memberUnits) {
        canonicals.push(foldConcept(u.survivor, u.members, u.survivor.proposal.title, []));
      }
      continue;
    }
    budget.remaining -= 1;

    const memberList = memberUnits
      .map((u, i) => `${i}. ${u.survivor.proposal.title} — ${u.survivor.proposal.description}`)
      .join("\n");
    const t0 = Date.now();
    const verdict = await runStructuredCall(deps.model, {
      system: MERGE_SYSTEM_PROMPT,
      input: `CANDIDATE CONCEPTS (same cluster):\n${memberList}`,
      outputName: MERGE_RESPONSE_NAME,
      outputSchema: MergeAdjudicationSchema,
      model: TUTOR_MODELS.graph_extraction.model,
      effort: TUTOR_MODELS.graph_extraction.effort,
      timeoutMs: TUTOR_MODELS.graph_extraction.timeoutMs,
      maxRetries: TUTOR_MODELS.graph_extraction.maxRetries,
      maxOutputTokens: TUTOR_MODELS.graph_extraction.maxOutputTokens,
      signal: undefined,
    });
    await emitAndAccumulate(
      deps,
      {
        courseId,
        authorId,
        jobType: "graph_extraction",
        model: TUTOR_MODELS.graph_extraction.model,
        usage: {
          inputTokens: verdict.usage.inputTokens,
          cachedTokens: verdict.usage.cachedTokens,
          outputTokens: verdict.usage.outputTokens,
        },
        latencyMs: Date.now() - t0,
        // RunId-scoped synthetic id (retry-stable — see the proposal emit note);
        // the cluster key makes it unique across this run's merge calls.
        providerResponseId: `merge:${runId}:${cluster.join("-")}`,
      },
      totals
    );

    // Track which member indexes the model folded away; the rest stand alone.
    const foldedInto = new Set<number>();
    if (verdict.ok && verdict.data) {
      for (const group of verdict.data.groups) {
        const keepIdx = group.keepIndex;
        if (keepIdx < 0 || keepIdx >= memberUnits.length) continue;
        const survivorUnit = memberUnits[keepIdx];
        const foldedUnits: LessonProposal[] = [];
        for (const mi of group.mergeIndexes) {
          if (mi < 0 || mi >= memberUnits.length || mi === keepIdx) continue;
          foldedInto.add(mi);
          foldedUnits.push(...memberUnits[mi].members);
        }
        foldedInto.add(keepIdx);
        const allMembers = [...survivorUnit.members, ...foldedUnits];
        canonicals.push(
          foldConcept(survivorUnit.survivor, allMembers, group.canonicalTitle, group.aliases)
        );
      }
    }
    // Any member the model DECLINED to fold stands alone.
    for (let i = 0; i < memberUnits.length; i += 1) {
      if (foldedInto.has(i)) continue;
      const u = memberUnits[i];
      canonicals.push(foldConcept(u.survivor, u.members, u.survivor.proposal.title, []));
    }
  }

  return { canonicals, flags };
}

/* ───────────────────────────── edge step ────────────────────────────────── */

/** Infer edges over the canonical node list, then run the pure passes. Returns the
 *  surviving edges (index-addressed against `nodes`) + the dropped-edge log +
 *  flags. One model call (budget-gated). */
async function inferAndHardenEdges(
  deps: GraphExtractionDeps,
  courseId: string,
  authorId: string,
  runId: string,
  nodes: CanonicalConcept[],
  cfg: ExtractionConfig,
  budget: CallBudget,
  totals: UsageTotals
): Promise<{ edges: InferredEdge[]; droppedEdges: { reason: string; count: number }[]; flags: string[] }> {
  const flags: string[] = [];
  const dropLog: { reason: string; count: number }[] = [];
  if (nodes.length < 2 || budget.remaining <= 0) {
    return { edges: [], droppedEdges: dropLog, flags };
  }

  budget.remaining -= 1;
  const nodeList = nodes
    .map((n, i) => `${i}. ${n.title} — ${n.description}`)
    .join("\n");
  const t0 = Date.now();
  const verdict = await runStructuredCall(deps.model, {
    system: EDGE_SYSTEM_PROMPT,
    input: `CONCEPTS (index. title — description), in teaching order:\n${nodeList}`,
    outputName: EDGE_RESPONSE_NAME,
    outputSchema: EdgeInferenceSchema,
    model: TUTOR_MODELS.graph_extraction.model,
    effort: TUTOR_MODELS.graph_extraction.effort,
    timeoutMs: TUTOR_MODELS.graph_extraction.timeoutMs,
    maxRetries: TUTOR_MODELS.graph_extraction.maxRetries,
    maxOutputTokens: TUTOR_MODELS.graph_extraction.maxOutputTokens,
  });
  await emitAndAccumulate(
    deps,
    {
      courseId,
      authorId,
      jobType: "graph_extraction",
      model: TUTOR_MODELS.graph_extraction.model,
      usage: {
        inputTokens: verdict.usage.inputTokens,
        cachedTokens: verdict.usage.cachedTokens,
        outputTokens: verdict.usage.outputTokens,
      },
      latencyMs: Date.now() - t0,
      // RunId-scoped synthetic id (retry-stable — see the proposal emit note).
      providerResponseId: `edges:${runId}`,
    },
    totals
  );

  if (!verdict.ok || !verdict.data) {
    flags.push("edge_inference_failed");
    return { edges: [], droppedEdges: dropLog, flags };
  }

  // Clamp out-of-range indexes before the pure passes touch them.
  let edges = verdict.data.edges.filter(
    (e) => e.sourceIndex < nodes.length && e.targetIndex < nodes.length
  );

  const selfPass = dropSelfLoops(edges);
  if (selfPass.dropped.length) dropLog.push({ reason: "self_loop", count: selfPass.dropped.length });
  edges = selfPass.kept;

  const evPass = pruneEvidenceless(edges);
  if (evPass.dropped.length) dropLog.push({ reason: "evidenceless", count: evPass.dropped.length });
  edges = evPass.kept;

  const confPass = dropLowConfidence(edges, cfg.edgeMinConfidence);
  if (confPass.dropped.length) dropLog.push({ reason: "low_confidence", count: confPass.dropped.length });
  edges = confPass.kept;

  const cyclePass = breakCyclesDropWeakest(edges);
  if (cyclePass.dropped.length) dropLog.push({ reason: "cycle_break", count: cyclePass.dropped.length });
  edges = cyclePass.kept;

  const trPass = transitiveReduction(edges);
  if (trPass.dropped.length) dropLog.push({ reason: "transitive_reduction", count: trPass.dropped.length });
  edges = trPass.kept;

  return { edges, droppedEdges: dropLog, flags };
}

/* ─────────────────────────────── orchestrator ───────────────────────────── */

/**
 * Run the whole extraction. Wrapped so a thrown error settles into
 * {ok:false, checkpoint:<error>} — the Inngest wrapper decides retries.
 */
export async function runGraphExtraction(
  deps: GraphExtractionDeps,
  args: RunGraphExtractionArgs
): Promise<GraphExtractionResult> {
  const cfg = resolveExtractionConfig(deps.config);
  const totals: UsageTotals = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
  const budget: CallBudget = { remaining: cfg.maxCalls };
  const flags: string[] = [];

  const empty = (checkpoint: string | null, ok: boolean): GraphExtractionResult => ({
    ok,
    changeSetId: null,
    findingId: null,
    nodeCount: 0,
    edgeCount: 0,
    assumedPriorCount: 0,
    flags,
    droppedEdges: [],
    usage: totals,
    checkpoint,
  });

  try {
    // Resolve the course author (admin) — the acting principal for cost telemetry.
    const courseRow = await deps.supabase
      .from("courses")
      .select("author_id")
      .eq("id", args.courseId)
      .maybeSingle();
    if (courseRow.error) throw new Error(`load course: ${courseRow.error.message}`);
    if (!courseRow.data) return empty(`course ${args.courseId} not found`, false);
    const authorId = courseRow.data.author_id;

    // The published snapshot is the extraction SOURCE.
    const { snapshot, version } = deps.loadSnapshot
      ? await deps.loadSnapshot(args.publicationId)
      : await getCachedSnapshot(args.publicationId);
    const chunks = deriveLessonChunksWithCap(snapshot, cfg.chunkMaxChars);

    // Per-lesson proposal under the call budget. Exhaustion checkpoints the rest.
    const allProposals: LessonProposal[] = [];
    const processedLessonIds: string[] = [];
    const unprocessed: string[] = [];
    let checkpoint: string | null = null;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (budget.remaining <= 0) {
        // Budget out — record the rest as unprocessed and STOP proposing.
        unprocessed.push(...chunks.slice(i).map((c) => c.lessonId));
        break;
      }
      budget.remaining -= 1;
      const t0 = Date.now();
      const verdict = await runStructuredCall(deps.model, {
        system: PROPOSAL_SYSTEM_PROMPT,
        input: buildProposalInput(chunk),
        outputName: PROPOSAL_RESPONSE_NAME,
        outputSchema: ProposalBatchSchema,
        model: TUTOR_MODELS.graph_extraction.model,
        effort: TUTOR_MODELS.graph_extraction.effort,
        timeoutMs: TUTOR_MODELS.graph_extraction.timeoutMs,
        maxRetries: TUTOR_MODELS.graph_extraction.maxRetries,
        maxOutputTokens: TUTOR_MODELS.graph_extraction.maxOutputTokens,
      });
      await emitAndAccumulate(
        deps,
        {
          courseId: args.courseId,
          authorId,
          jobType: "graph_extraction",
          model: TUTOR_MODELS.graph_extraction.model,
          usage: {
            inputTokens: verdict.usage.inputTokens,
            cachedTokens: verdict.usage.cachedTokens,
            outputTokens: verdict.usage.outputTokens,
          },
          latencyMs: Date.now() - t0,
          // RunId-scoped synthetic id (like the embed) — NOT the provider's
          // responseId, which is NOT retry-stable (a retried call gets a fresh one,
          // so it would double-count cost on an Inngest step retry). This id is
          // stable across a retry of the SAME run+lesson ⇒ the emit no-ops (R: the
          // module header's "a step retry re-emits as a no-op").
          providerResponseId: `propose:${args.runId}:${chunk.lessonId}`,
        },
        totals
      );
      processedLessonIds.push(chunk.lessonId);
      if (verdict.ok && verdict.data) {
        for (const proposal of verdict.data.concepts) {
          allProposals.push({ lessonId: chunk.lessonId, proposal });
        }
      } else {
        flags.push(`propose_failed:${chunk.lessonId}`);
      }
    }

    if (unprocessed.length > 0) {
      checkpoint = `Model-call budget (${cfg.maxCalls}) exhausted — ${unprocessed.length} lesson(s) not processed: ${unprocessed.join(", ")}. Staged what was built.`;
      flags.push("budget_exhausted");
    }

    // Grain normalization (pure) over the processed lessons.
    const grain = normalizeGrain(
      allProposals,
      { grainMaxPerLesson: cfg.grainMaxPerLesson, grainCourseMax: cfg.grainCourseMax },
      processedLessonIds
    );
    flags.push(...grain.flags);

    // Canonicalize (exact → embed → cluster → adjudicate).
    const { canonicals, flags: canonFlags } = await canonicalize(
      deps,
      args.courseId,
      authorId,
      args.runId,
      grain.kept,
      cfg,
      budget,
      totals
    );
    flags.push(...canonFlags);

    // TAUGHT nodes only become concept_nodes. A PURE assumed-prior (isAssumedPrior
    // — foldConcept sets it iff EVERY folded member was a prior) is a node the
    // course leans on but never teaches: it is persisted ONLY as an
    // assumed_prior_node, NEVER also as a concept_node (persisting it as both would
    // double-count it + let edges/snapshot-map point at a phantom taught node).
    const taughtNodes = canonicals.filter((c) => !c.isAssumedPrior);

    // Resolve anchors against the snapshot (R-13). A node that ends up with ZERO
    // resolvable anchors keeps an empty anchor set (it's still a real concept).
    // stageNodes is 1:1 with taughtNodes (same order), so an edge index against
    // taughtNodes maps DIRECTLY to a stageNodes index.
    const anchorIndex = buildSnapshotAnchorIndex(snapshot);
    const stageNodes: StageNodeInput[] = [];
    const snapshotMap: StageSnapshotMapInput[] = [];
    taughtNodes.forEach((c, idx) => {
      const { resolved, downgraded } = resolveAnchors(c.anchors, anchorIndex);
      stageNodes.push({
        title: c.title,
        description: c.description,
        aliases: c.aliases,
        anchors: resolved.map((a) => ({
          // The R-13 anchor shape needs lessonId; resolve it from the block's lesson.
          lessonId: lessonIdForBlock(snapshot, a.blockId),
          blockId: a.blockId,
          ...(a.slideId ? { slideId: a.slideId } : {}),
        })).filter((a) => a.lessonId.length > 0),
        embedding: null,
      });
      snapshotMap.push({
        nodeIndex: idx,
        anchors: resolved.map((a) => ({
          lessonId: lessonIdForBlock(snapshot, a.blockId),
          blockId: a.blockId,
          ...(a.slideId ? { slideId: a.slideId } : {}),
        })).filter((a) => a.lessonId.length > 0),
        anchorDowngraded: downgraded,
      });
    });

    // Assumed priors: from isAssumedPrior canonicals, deduped by normalized title.
    const priorTitles = new Set<string>();
    const assumedPriors = canonicals
      .filter((c) => c.isAssumedPrior)
      .filter((c) => {
        const key = normalizeTitleKey(c.title);
        if (priorTitles.has(key)) return false;
        priorTitles.add(key);
        return true;
      })
      .map((c) => ({
        title: c.title,
        description: c.description,
        evidence: c.evidenceQuotes.map((q) => ({ quote: q })),
      }));

    // Edges are inferred over the TAUGHT nodes (assumed priors are not the course's
    // taught structure).
    const { edges, droppedEdges, flags: edgeFlags } = await inferAndHardenEdges(
      deps,
      args.courseId,
      authorId,
      args.runId,
      taughtNodes,
      cfg,
      budget,
      totals
    );
    flags.push(...edgeFlags);

    // Edge indexes are against `taughtNodes`, which IS `stageNodes` (1:1, same
    // order), so an index maps directly — but guard the range defensively.
    const stageEdges: StageEdgeInput[] = edges.flatMap((e) => {
      const src = e.sourceIndex < stageNodes.length ? e.sourceIndex : undefined;
      const tgt = e.targetIndex < stageNodes.length ? e.targetIndex : undefined;
      if (src === undefined || tgt === undefined) return [];
      const staged: StageEdgeInput = {
        sourceNodeIndex: src,
        targetNodeIndex: tgt,
        kind: e.kind,
        evidenceRefs: [{ quote: e.evidenceQuote, confidence: e.confidence }],
      };
      return [staged];
    });

    // Nothing to stage at all ⇒ still record a fate row so the run is auditable.
    const staged = await stageExtractionResult(deps.supabase, {
      courseId: args.courseId,
      authorId,
      runId: args.runId,
      publicationId: args.publicationId,
      version,
      nodes: stageNodes,
      edges: stageEdges,
      assumedPriors,
      snapshotMap,
      evidence: { flags, droppedEdges, checkpoint },
      nowIso: deps.nowIso,
    });

    return {
      ok: true,
      alreadyPending: staged.alreadyPending,
      changeSetId: staged.changeSetId,
      findingId: staged.findingId,
      nodeCount: staged.nodeCount,
      edgeCount: staged.edgeCount,
      assumedPriorCount: staged.assumedPriorCount,
      flags,
      droppedEdges,
      usage: totals,
      checkpoint,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return empty(message, false);
  }
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** The lessonId owning a given blockId in the snapshot (empty string if unknown —
 *  the caller filters those out). Pure. */
function lessonIdForBlock(snapshot: PublicationSnapshot, blockId: string): string {
  for (const module of snapshot.modules) {
    for (const lesson of module.lessons) {
      for (const block of lesson.blocks) {
        if (block.id === blockId) return lesson.id;
      }
    }
  }
  return "";
}
