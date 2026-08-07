/**
 * TUTOR-1 Amendment A3 Wave 4 — the THREE new tutor tools (renderStructure ·
 * checkUnderstanding · sequenceTask) + the pure sequenceTask scorer.
 *
 * They live here (not tools.ts) so the Wave-3 five-tool file stays the frozen
 * reference and the A3 additions are one reviewable unit; `TUTOR_TOOLS` in
 * tools.ts imports and mounts them, and toolTiers.ts / TUTOR_TOOL_NAMES carry
 * their (mandatory, compile-enforced) rows.
 *
 * ── THE THREE, BY CLASS (the frozen Wave-4 contract) ─────────────────────────
 *  • renderStructure  — Class P (presentational; NOT in CLASS_A_TOOL_NAMES). The
 *    model emits a compact per-kind structure as tool ARGS — the DATA is the
 *    args, no internal model call. The tool maps the A3 `kind` onto a
 *    lib/course/diagram spec, gates it with `validateDiagram`, and DROPS-AND-
 *    FLAGS an invalid one ({ structure: null, error }, log tutor_structure_
 *    dropped) — it NEVER throws / fails the turn (A3-24). Executes on ANY turn
 *    including a question turn (A3-12).
 *  • checkUnderstanding — Class A (gated). The Zod `.superRefine` ENFORCES
 *    A3-13: any option with `correct === false` and a null/empty misconceptionId
 *    FAILS parse. Mints a cardId; `initiation` is stamped by the loop's sink
 *    (see below).
 *  • sequenceTask — Class A (gated). The `.superRefine` validates `correctOrder`
 *    is a permutation of the item ids. Mints a cardId; `initiation` stamped by
 *    the sink.
 *
 * ── WHERE `initiation` IS STAMPED (a documented decision) ────────────────────
 * The tool's `execute` does NOT receive the turn initiation cleanly (TutorToolCtx
 * is snapshot/course scoped, not per-turn-initiation aware, and threading a new
 * required field through every tool would touch the frozen Wave-3 surface). So —
 * exactly as the contract permits and recommends ("cleaner — the sink knows the
 * ctx") — the tool mints the card with `initiation` left as a PLACEHOLDER, and
 * the LOOP's `collectToolOutputs` sink stamps the real per-turn initiation onto
 * every assessment card before it surfaces. The card that reaches the wire always
 * carries the turn's real initiation. renderStructure carries no initiation.
 *
 * The `conceptSlug` on an assessment card is the concept node uuid (Ruling R-1 —
 * concepts have no slug; the model echoes node ids reliably via L2 id tags).
 */

import { z } from "zod";

import { validateDiagram } from "@/lib/course/diagram/validate";
import type {
  CoordinatePlotDiagram,
  DiagramSpec,
  GraphDiagram,
  NumberLineDiagram,
  TreeDiagram,
  TreeNode,
} from "@/lib/course/diagram/types";
import type { TutorTool, TutorToolResult } from "./tools";

/* ─────────────────────────── the card wire shapes ───────────────────────── */

/** Class P — presentational; MAY appear on a question turn (A3-12). The built,
 *  VALIDATED diagram ships (storage-schema shape); `diagram` is null only on the
 *  drop-and-flag path (the tool then also carries `error`). */
export interface RenderStructureCard {
  kind: "tree" | "graph" | "timeline" | "axes";
  title: string | null;
  caption: string | null;
  diagram: DiagramSpec | null;
}

/** How an assessment card was initiated — the loop's sink stamps the real value
 *  from the turn ctx; the tool mints the placeholder. */
export type AssessmentInitiation = "practice_request" | "invitation_accepted";

/** Class A — a checkUnderstanding item. `options` (3–4) each name whether they're
 *  correct; every wrong option MUST carry a misconceptionId (A3-13, schema-
 *  enforced). The answer key ships (formative, client-graded — the practiceItems
 *  precedent). */
export interface CheckUnderstandingCard {
  cardId: string;
  toolName: "checkUnderstanding";
  conceptSlug: string;
  initiation: AssessmentInitiation;
  stem: string;
  options: {
    id: string;
    text: string;
    correct: boolean;
    misconceptionId: string | null;
    feedback: string;
  }[];
  collectConfidence: boolean;
}

/** Class A — a sequenceTask item. `items` (≥3) + `correctOrder` (a permutation of
 *  the item ids, schema-enforced). The client scores locally with
 *  `partialCreditRule`. */
export interface SequenceTaskCard {
  cardId: string;
  toolName: "sequenceTask";
  conceptSlug: string;
  initiation: AssessmentInitiation;
  prompt: string;
  items: { id: string; text: string }[];
  correctOrder: string[];
  partialCreditRule: "exact" | "adjacent-pairs";
}

export type AssessmentCard = CheckUnderstandingCard | SequenceTaskCard;

/* ─────────────────────── renderStructure — Class P ───────────────────────── */

/** A fixed-depth tree node for the compact arg schema (matches the diagram model's
 *  TreeNode; the renderer auto-positions, so no coordinates are needed). The
 *  strict JSON schema converter can't emit a recursive `$ref`, so the arg tree is
 *  bounded to 3 levels — deep enough for a teaching tree, shallow enough to inline.
 *  Deeper structure degrades gracefully (the tool clamps to what it received). */
const RS_TreeLeaf = z.object({
  label: z.string().min(1).max(60),
  highlight: z.boolean().nullish(),
});
const RS_TreeMid = z.object({
  label: z.string().min(1).max(60),
  highlight: z.boolean().nullish(),
  children: z.array(RS_TreeLeaf).max(6).nullish(),
});
const RS_TreeRoot = z.object({
  label: z.string().min(1).max(60),
  highlight: z.boolean().nullish(),
  children: z.array(RS_TreeMid).max(6).nullish(),
});

const RS_TreeBody = z.object({
  root: RS_TreeRoot,
});

const RS_GraphBody = z.object({
  directed: z.boolean().nullish(),
  weighted: z.boolean().nullish(),
  nodes: z
    .array(z.object({ id: z.string().min(1).max(40), label: z.string().max(60).nullish() }))
    .min(1)
    .max(20),
  edges: z
    .array(
      z.object({
        from: z.string().min(1).max(40),
        to: z.string().min(1).max(40),
        weight: z.number().nullish(),
        label: z.string().max(40).nullish(),
      })
    )
    .max(40),
  highlightPath: z.array(z.string().max(40)).max(20).nullish(),
});

const RS_TimelineBody = z.object({
  /** Ordered labeled points. Each `at` is the position on a 1-D line; when the
   *  model omits them the tool assigns 0,1,2,… so a categorical sequence still
   *  renders (a true categorical timeline renderer is a documented [FWD]). */
  points: z
    .array(z.object({ label: z.string().min(1).max(60), at: z.number().nullish() }))
    .min(1)
    .max(20),
});

const RS_AxesBody = z.object({
  xLabel: z.string().min(1).max(28),
  yLabel: z.string().min(1).max(28),
  xRange: z.object({ min: z.number(), max: z.number() }),
  yRange: z.object({ min: z.number(), max: z.number() }),
  series: z
    .array(
      z.object({
        label: z.string().min(1).max(28),
        points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().max(24).nullish() })).min(1).max(60),
        style: z.enum(["line", "scatter", "dashed"]).nullish(),
      })
    )
    .min(1)
    .max(4),
  markers: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().min(1).max(24) })).max(6).nullish(),
});

/**
 * The params are a FLAT top-level object (NOT a discriminated union): the
 * OpenAI function-calling API requires the tool's `parameters` JSON Schema to be
 * `type: "object"`, and a top-level `z.discriminatedUnion` converts to `anyOf`
 * with no top-level type — the live API rejects it ("got type: None"; caught by
 * the Wave-4 live smoke, invisible to the mock). `kind` selects the branch; the
 * model fills the matching body object and leaves the others null. A missing or
 * mismatched body drops-and-flags in the tool (A3-24), never throws.
 */
const RenderStructureParams = z.object({
  kind: z.enum(["tree", "graph", "timeline", "axes"]),
  title: z.string().max(120).nullish(),
  caption: z.string().max(320).nullish(),
  tree: RS_TreeBody.nullish(),
  graph: RS_GraphBody.nullish(),
  timeline: RS_TimelineBody.nullish(),
  axes: RS_AxesBody.nullish(),
});
type RenderStructureArgs = z.infer<typeof RenderStructureParams>;

/** Map the A3 arg tree onto the diagram model's TreeNode (drop nullish flags). */
function toTreeNode(n: {
  label: string;
  highlight?: boolean | null;
  children?: Array<{ label: string; highlight?: boolean | null; children?: Array<{ label: string; highlight?: boolean | null }> | null }> | null;
}): TreeNode {
  const node: TreeNode = { label: n.label };
  if (n.highlight) node.highlight = true;
  const kids = n.children ?? undefined;
  if (kids && kids.length > 0) node.children = kids.map((c) => toTreeNode(c));
  return node;
}

/** Build a lib/course/diagram spec from the A3 args (the kind mapping the
 *  contract fixes: tree→tree_diagram · graph→graph_diagram · axes→coordinate_plot
 *  · timeline→number_line). Reads the body object matching `kind`; returns null
 *  when that body is absent (the model set `kind` but omitted the body) — the
 *  caller drop-and-flags. Pure — no diagram validation here (the caller gates). */
function buildDiagramSpec(args: RenderStructureArgs): DiagramSpec | null {
  switch (args.kind) {
    case "tree": {
      if (!args.tree) return null;
      const spec: TreeDiagram = { kind: "tree_diagram", root: toTreeNode(args.tree.root) };
      return spec;
    }
    case "graph": {
      if (!args.graph) return null;
      const g = args.graph;
      const spec: GraphDiagram = {
        kind: "graph_diagram",
        directed: g.directed ?? undefined,
        weighted: g.weighted ?? undefined,
        nodes: g.nodes.map((n) => ({ id: n.id, label: n.label ?? undefined })),
        edges: g.edges.map((e) => ({
          from: e.from,
          to: e.to,
          weight: e.weight ?? undefined,
          label: e.label ?? undefined,
        })),
        highlightPath: g.highlightPath ?? undefined,
      };
      return spec;
    }
    case "timeline": {
      if (!args.timeline) return null;
      // number_line carries an ordered labeled sequence. Assign positions when the
      // model omits them (0,1,2,…), and derive min/max from the points so the line
      // spans exactly the sequence.
      const points = args.timeline.points.map((p, i) => ({ value: p.at ?? i, label: p.label }));
      const values = points.map((p) => p.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const spec: NumberLineDiagram = {
        kind: "number_line",
        // A degenerate single-point / all-equal sequence still needs min<max to
        // validate; nudge max up by 1 so the line has extent.
        min,
        max: max > min ? max : min + 1,
        points,
      };
      return spec;
    }
    case "axes": {
      if (!args.axes) return null;
      const a = args.axes;
      const spec: CoordinatePlotDiagram = {
        kind: "coordinate_plot",
        xLabel: a.xLabel,
        yLabel: a.yLabel,
        xRange: a.xRange,
        yRange: a.yRange,
        series: a.series.map((s) => ({
          label: s.label,
          points: s.points.map((p) => ({ x: p.x, y: p.y, label: p.label ?? undefined })),
          style: s.style ?? undefined,
        })),
        markers: a.markers ? a.markers.map((m) => ({ x: m.x, y: m.y, label: m.label })) : undefined,
      };
      return spec;
    }
  }
}

const renderStructure: TutorTool<RenderStructureArgs> = {
  name: "renderStructure",
  description:
    "Render a teaching STRUCTURE as a real diagram instead of ASCII: a `tree` (hierarchy / recursion), a `graph` (network / dependencies), a `timeline` (ordered labeled sequence), or `axes` (a labeled coordinate plot). Emit the structure as arguments — the data IS the diagram. Use this for any tree/graph/timeline/axes; describe other structure in prose.",
  params: RenderStructureParams,
  async execute(args): Promise<TutorToolResult> {
    const spec = buildDiagramSpec(args);
    const errs = spec === null ? [`missing ${args.kind} body`] : validateDiagram(spec);
    if (spec === null || errs.length > 0) {
      // A3-24 discipline: drop-and-flag, NEVER throw / fail the turn.
      console.log(
        JSON.stringify({
          tag: "tutor_structure_dropped",
          kind: args.kind,
          reason: errs.slice(0, 3).join("; ").slice(0, 200),
        })
      );
      const card: RenderStructureCard = {
        kind: args.kind,
        title: args.title ?? null,
        caption: args.caption ?? null,
        diagram: null,
      };
      return {
        summary: `Could not render the ${args.kind} structure (invalid: ${errs[0]}). Describe it in prose instead.`,
        data: { structure: card, error: errs[0] },
      };
    }
    const card: RenderStructureCard = {
      kind: args.kind,
      title: args.title ?? null,
      caption: args.caption ?? null,
      diagram: spec,
    };
    return {
      summary: `Rendered a ${args.kind} structure for the learner.`,
      data: { structure: card },
    };
  },
};

/* ─────────────────────── checkUnderstanding — Class A ────────────────────── */

const CheckUnderstandingOption = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(320),
  correct: z.boolean(),
  /** Every WRONG option must name the misconception it represents (A3-13). A
   *  correct option carries null. */
  misconceptionId: z.string().max(80).nullish(),
  feedback: z.string().min(1).max(320),
});

const CheckUnderstandingParams = z
  .object({
    conceptSlug: z.string().min(1).describe("The concept node id (uuid) this checks (R-1)."),
    stem: z.string().min(1).max(600).describe("The question stem."),
    options: z.array(CheckUnderstandingOption).min(3).max(4),
    collectConfidence: z.boolean().nullish(),
  })
  .superRefine((val, ctx) => {
    // A3-13: any WRONG option with a null/empty misconceptionId FAILS parse.
    val.options.forEach((o, i) => {
      if (o.correct === false) {
        const m = o.misconceptionId?.trim();
        if (!m) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["options", i, "misconceptionId"],
            message:
              "Every wrong option MUST name the misconception it represents (a non-empty misconceptionId).",
          });
        }
      }
    });
    // At least one option must be correct (a check with no key is unusable).
    if (!val.options.some((o) => o.correct === true)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "At least one option must be correct.",
      });
    }
  });
type CheckUnderstandingArgs = z.infer<typeof CheckUnderstandingParams>;

const checkUnderstanding: TutorTool<CheckUnderstandingArgs> = {
  name: "checkUnderstanding",
  description:
    "Author a single retrieval check (3–4 options) for a concept the learner just worked. EVERY wrong option MUST name the misconception it represents (its misconceptionId) — this is how a miss teaches. The feedback names the reasoning, never 'the answer is X'. Offer this instead of bare practice when you want to probe understanding.",
  params: CheckUnderstandingParams,
  async execute(args): Promise<TutorToolResult> {
    const card: CheckUnderstandingCard = {
      cardId: crypto.randomUUID(),
      toolName: "checkUnderstanding",
      conceptSlug: args.conceptSlug,
      // Placeholder — the loop's sink stamps the real per-turn initiation.
      initiation: "practice_request",
      stem: args.stem,
      options: args.options.map((o) => ({
        id: o.id,
        text: o.text,
        correct: o.correct,
        misconceptionId: o.correct ? null : o.misconceptionId?.trim() || null,
        feedback: o.feedback,
      })),
      collectConfidence: args.collectConfidence ?? false,
    };
    return {
      summary: `Authored an understanding check (${card.options.length} options) for the concept.`,
      data: { assessment: card },
    };
  },
};

/* ───────────────────────────── sequenceTask — Class A ────────────────────── */

const SequenceTaskParams = z
  .object({
    conceptSlug: z.string().min(1).describe("The concept node id (uuid) this checks (R-1)."),
    prompt: z.string().min(1).max(600).describe("What to order and by what criterion."),
    items: z
      .array(z.object({ id: z.string().min(1).max(40), text: z.string().min(1).max(200) }))
      .min(3)
      .max(8),
    correctOrder: z.array(z.string().min(1).max(40)).min(3).max(8),
    partialCreditRule: z.enum(["exact", "adjacent-pairs"]).nullish(),
  })
  .superRefine((val, ctx) => {
    // correctOrder MUST be a permutation of the item ids.
    const itemIds = val.items.map((it) => it.id);
    const itemSet = new Set(itemIds);
    if (itemSet.size !== itemIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Item ids must be unique." });
    }
    const orderSet = new Set(val.correctOrder);
    const isPermutation =
      val.correctOrder.length === itemIds.length &&
      orderSet.size === val.correctOrder.length &&
      val.correctOrder.every((id) => itemSet.has(id));
    if (!isPermutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctOrder"],
        message: "correctOrder must be a permutation of the item ids (each item exactly once).",
      });
    }
  });
type SequenceTaskArgs = z.infer<typeof SequenceTaskParams>;

const sequenceTask: TutorTool<SequenceTaskArgs> = {
  name: "sequenceTask",
  description:
    "Author an ordering task (≥3 items) for order-carrying content — steps of an algorithm, a chronology, a dependency chain. Provide the correct order; the learner drags the items and is scored locally. Use `adjacent-pairs` partial credit when being CLOSE is meaningful, `exact` when only the full order counts.",
  params: SequenceTaskParams,
  async execute(args): Promise<TutorToolResult> {
    const card: SequenceTaskCard = {
      cardId: crypto.randomUUID(),
      toolName: "sequenceTask",
      conceptSlug: args.conceptSlug,
      // Placeholder — the loop's sink stamps the real per-turn initiation.
      initiation: "practice_request",
      prompt: args.prompt,
      items: args.items.map((it) => ({ id: it.id, text: it.text })),
      correctOrder: [...args.correctOrder],
      partialCreditRule: args.partialCreditRule ?? "exact",
    };
    return {
      summary: `Authored a sequencing task (${card.items.length} items).`,
      data: { assessment: card },
    };
  },
};

/* ─────────────────────────── the pure scorer (A3-15) ─────────────────────── */

/** The outcome a completed assessment records — the tool-evidence contract. */
export type SequenceOutcome = "demonstrated" | "partial" | "not_demonstrated";

/**
 * PURE. Score a submitted ordering against the correct order. The SAME rule the
 * client grades with (formative) — exported so it is unit-tested (A3-15) and both
 * sides agree.
 *
 *  • `exact`          — every position right ⇒ demonstrated; else not_demonstrated
 *                       (no partial for exact).
 *  • `adjacent-pairs` — proportion of the SUBMISSION's adjacent pairs that are
 *                       in the correct RELATIVE order (the earlier element ranks
 *                       before the later in `correctOrder`): ≥ 0.99 ⇒
 *                       demonstrated · > 0 ⇒ partial · else not_demonstrated.
 *                       This is the standard forgiving metric — a single
 *                       misplaced element leaves most relative orders intact, so
 *                       it earns partial credit (directive §3.3), NOT a total
 *                       failure. ⚠ This MUST match the client twin
 *                       `scoreSequenceCard` (lib/learn/tutorClientTypes.ts) — the
 *                       client is the authoritative grader; a divergent
 *                       adjacency-based metric here (the pre-consolidation bug)
 *                       disagreed with it on middle transpositions like a,c,b,d.
 *
 * A submission that isn't a permutation of the correct order (missing/extra/
 * duplicate ids) scores not_demonstrated — a malformed answer is never a pass.
 * (The client UI can only ever submit a permutation of the presented items;
 * this guard is defensive.)
 */
export function scoreSequence(
  correctOrder: readonly string[],
  submitted: readonly string[],
  rule: "exact" | "adjacent-pairs"
): SequenceOutcome {
  // Guard: the submission must be a permutation of the correct order.
  if (submitted.length !== correctOrder.length) return "not_demonstrated";
  const correctSet = new Set(correctOrder);
  const submittedSet = new Set(submitted);
  if (submittedSet.size !== submitted.length) return "not_demonstrated"; // duplicates
  for (const id of submitted) if (!correctSet.has(id)) return "not_demonstrated"; // extra
  if (correctSet.size !== submittedSet.size) return "not_demonstrated"; // missing

  const allRight = submitted.every((id, i) => id === correctOrder[i]);

  if (rule === "exact") {
    return allRight ? "demonstrated" : "not_demonstrated";
  }

  // adjacent-pairs (relative-order metric — matches the client twin): the
  // fraction of the SUBMISSION's adjacent pairs whose elements are in the
  // correct relative order (rank[a] < rank[b] in correctOrder).
  const totalPairs = submitted.length - 1;
  if (totalPairs < 1) return allRight ? "demonstrated" : "not_demonstrated";
  const rank = new Map<string, number>();
  correctOrder.forEach((id, i) => rank.set(id, i));
  let ordered = 0;
  for (let i = 0; i + 1 < submitted.length; i += 1) {
    const a = rank.get(submitted[i]);
    const b = rank.get(submitted[i + 1]);
    if (a !== undefined && b !== undefined && a < b) ordered += 1;
  }
  const proportion = ordered / totalPairs;
  if (proportion >= 0.99) return "demonstrated";
  if (proportion > 0) return "partial";
  return "not_demonstrated";
}

/* ─────────────────────────────── the registry ───────────────────────────── */

/** The three A3 Wave-4 tools, keyed by name — imported into TUTOR_TOOLS. */
export const A3_WAVE4_TOOLS = {
  renderStructure: renderStructure as TutorTool,
  checkUnderstanding: checkUnderstanding as TutorTool,
  sequenceTask: sequenceTask as TutorTool,
};
