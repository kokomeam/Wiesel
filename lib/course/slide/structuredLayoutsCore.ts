/**
 * Structured-layout CORE registry — ids, display metadata, AI hints, seeds,
 * capacity, and length limits. Deliberately ZOD-FREE (PERF-1 D1): the render
 * path (SlideView / StructuredSlide / the layout components) and factories.ts
 * reach layout metadata through THIS module, so viewing a slide never drags
 * the zod content schemas into the bundle. The strict schemas + the AI input
 * union live in ./structuredLayouts.ts (the SCHEMA registry), which re-exports
 * everything here — existing imports keep working unchanged.
 */

import { findDiagramTemplate } from "../diagram/catalog";
import type { DiagramContent } from "../diagram/types";
import type {
  IllustrationContent,
  ImageReferenceContent,
  ImageSupportingContent,
  RichText,
  SlideTemplate,
  StructuredLayoutId,
} from "../types";

/* ── Length budget (plain-text chars / line counts). Tuned to the card geometry;
      these are COMMITTED limits, not advice. ── */
export const LIMITS = {
  eyebrow: 24,
  title: 48,
  subtitle: 90,
  term: 26,
  definition: 170,
  heading: 32,
  body: 120,
  metricLabel: 22,
  metricValue: 10,
  metricDelta: 22,
  codeLines: 20,
  // ── section_break
  sbNumber: 4,
  sbLabel: 24,
  sbTitle: 40,
  sbSubtitle: 90,
  // ── concept_example
  ceBadge: 16,
  ceTitle: 40,
  ceDefinition: 140,
  ceExampleBadge: 20,
  ceExampleTitle: 48,
  ceParagraph: 160,
  ceStepHeading: 40,
  ceStepBody: 120,
  ceFootnote: 90,
  // ── outline_list
  olTitle: 80,
  olItem: 80,
  olSubItem: 70,
  // ── prose (a substantive teaching text slide — body cap is GENEROUS on purpose)
  proseEyebrow: 24,
  proseTitle: 60,
  proseBody: 700,
  prosePoint: 120,
  // ── illustration (a generated/uploaded image slide)
  illTitle: 60,
  illAlt: 320,
  illCaption: 180,
  illPoint: 120,
  // ── image_reference / image_supporting (the two generated-image layouts)
  imgTitle: 56,
  imgLead: 160,
  annLabel: 28,
  annDesc: 84,
  cardTitle: 28,
  cardBody: 92,
  imgBullet: 120,
  // ── comparison (shared header + columnar + matrix). Caps lean GENEROUS/soft:
  //    tight caps cause reshape churn; the renderer reflows, it doesn't clip.
  cmpEyebrow: 24,
  cmpTitle: 56,
  cmpSubtitle: 120,
  cmpOptionName: 30,
  cmpPointLabel: 48,
  cmpPointDetail: 130,
  cmpDimLabel: 30,
  cmpCellDetail: 100,
  cmpCellExample: 90,
  cmpSummary: 170,
  cmpSimilarity: 72,
} as const;

/** Everything a layout is EXCEPT its strict content schema (which lives in
 *  structuredLayouts.ts and joins this via `STRUCTURED_LAYOUTS`). */
export interface StructuredLayoutMeta {
  id: StructuredLayoutId;
  name: string;
  description: string;
  ai: { bestFor: string[]; avoidWhen: string[] };
  /** Example content for the manual picker / seeding. */
  seed: () => SlideTemplate;
  /** Text capacity — how many key points this layout holds before content-first
   *  planning SPILLS to a continuation slide (drives `layoutPointCapacity` →
   *  `splitOverflowingSpecs`). Absent ⇒ the global default. `slots` documents the
   *  per-slot caps for the planner; `captionOptional` notes whether a caption slot
   *  exists. */
  capacity?: {
    maxPoints: number;
    captionOptional?: boolean;
    slots?: Record<string, { max: number; charsPerLine?: number }>;
  };
}

const t = (text: string): RichText => ({ text });

export const STRUCTURED_LAYOUT_META: StructuredLayoutMeta[] = [
  {
    id: "process_steps",
    name: "Process / steps",
    description: "A repeatable process as 3–5 numbered step cards in a row with arrows.",
    ai: {
      bestFor: ["a sequence", "a workflow", "how it works", "numbered steps"],
      avoidWhen: ["non-sequential content", "a single idea", "raw data"],
    },
    seed: () => ({
      layoutId: "process_steps",
      content: {
        eyebrow: t("Process overview"),
        title: t("Our four-step process"),
        subtitle: t("A simple, repeatable way to go from concept to outcome."),
        steps: [
          { sticker: "lightbulb", heading: t("Define the goal"), body: t("Align on the outcome and key priorities.") },
          { sticker: "document", heading: t("Map the plan"), body: t("Sequence the approach before you start.") },
          { sticker: "gear", heading: t("Execute"), body: t("Do the work with focus and precision.") },
          { sticker: "bar-chart", heading: t("Review & refine"), body: t("Measure results and improve continuously.") },
        ],
      },
    }),
  },
  {
    id: "key_concept",
    name: "Key concept / definition",
    description: "A big term + definition on the left, with supporting icon points on the right.",
    ai: {
      bestFor: ["defining a term", "a key concept", "vocabulary", "a principle + examples"],
      avoidWhen: ["multiple unrelated concepts", "a process", "raw data"],
    },
    seed: () => ({
      layoutId: "key_concept",
      content: {
        variant: "sans",
        spine: false,
        eyebrow: t("Core concept"),
        term: t("Opportunity cost"),
        definition: t("The value of the next best alternative you give up when you make a choice."),
        items: [
          { sticker: "signpost", heading: t("Every choice is a tradeoff"), body: t("Resources are limited, so choosing one option means giving up another.") },
          { sticker: "user-star", heading: t("The next best alternative"), body: t("It's measured by the value of the best option you didn't choose.") },
          { sticker: "bar-chart", heading: t("Better decisions"), body: t("Understanding it helps you choose options that create the most value.") },
        ],
      },
    }),
  },
  {
    id: "metrics_overview",
    name: "Metrics overview",
    description: "2–4 headline stat cards, each with a value and an up/down change.",
    ai: {
      bestFor: ["key numbers", "results at a glance", "KPIs", "before/after metrics"],
      avoidWhen: ["a time-series chart (deferred)", "prose", "a single idea"],
    },
    seed: () => ({
      layoutId: "metrics_overview",
      content: {
        eyebrow: t("Summary overview"),
        title: t("Performance at a glance"),
        metrics: [
          { sticker: "trending-up", label: t("New signups"), value: t("12,345"), delta: { direction: "up", text: t("8.6% vs last period"), sentiment: "positive" } },
          { sticker: "target", label: t("Conversion"), value: t("67.8%"), delta: { direction: "up", text: t("5.2% vs last period"), sentiment: "positive" } },
          { sticker: "users", label: t("Active users"), value: t("1,234"), delta: { direction: "down", text: t("3.1% vs last period"), sentiment: "negative" } },
        ],
      },
    }),
  },
  {
    id: "code_walkthrough_steps",
    name: "Code walkthrough",
    description: "A highlighted code block beside 2–4 numbered explanations.",
    ai: {
      bestFor: ["explaining code", "an implementation", "a function step by step"],
      avoidWhen: ["concept intros", "no code", "more than ~20 lines of code"],
    },
    seed: () => ({
      layoutId: "code_walkthrough_steps",
      content: {
        eyebrow: t("Code walkthrough"),
        title: t("A simple function, step by step"),
        code: {
          language: "python",
          code: 'def total_price(items, tax_rate=0.07):\n    subtotal = 0\n    for item in items:\n        subtotal += item["price"] * item["qty"]\n    tax = subtotal * tax_rate\n    return round(subtotal + tax, 2)',
        },
        steps: [
          { sticker: "document", heading: t("Define the function"), body: t("Line 1: accepts a list of items and an optional tax rate.") },
          { sticker: "gear", heading: t("Sum the subtotal"), body: t("Lines 3–4: iterate items and add price × quantity.") },
          { sticker: "coins", heading: t("Add tax and return"), body: t("Lines 5–6: apply the tax and return the rounded total.") },
        ],
      },
    }),
  },
  {
    id: "section_break",
    name: "Section break",
    description: "A chapter/section transition: a numbered kicker, a big two-tone title, and a one-line framing.",
    ai: {
      bestFor: ["opening a new module/section", "a chapter divider", "a transition slide"],
      avoidWhen: ["mid-lesson content", "a slide that teaches something"],
    },
    seed: () => ({
      layoutId: "section_break",
      content: {
        number: "02",
        label: t("Foundations"),
        title: t("Core Principles"),
        subtitle: t("An introduction to the key ideas that guide everything we build."),
        titleStyle: "serif",
        variant: "standard",
      },
    }),
  },
  {
    id: "concept_example",
    name: "Concept → example",
    description: "An abstract rule/definition on the left paired with a worked example (prose or numbered steps) on the right.",
    ai: {
      bestFor: ["pairing a rule/definition with a concrete worked example", "concept then application"],
      avoidWhen: ["a pure definition with no example (use key_concept)", "a standalone process"],
    },
    seed: () => ({
      layoutId: "concept_example",
      content: {
        concept: {
          badge: "Rule",
          title: t("Supply and demand"),
          titleStyle: "serif",
          definition: t("Price settles where the quantity buyers want equals the quantity sellers offer."),
        },
        example: {
          badge: "Worked Example",
          title: t("Pricing a new product"),
          body: {
            kind: "steps",
            steps: [
              { heading: t("Estimate demand"), body: t("Survey how many units sell at each candidate price.") },
              { heading: t("Estimate supply"), body: t("Work out how many you can make at each price.") },
              { heading: t("Find the balance"), body: t("The price where the two meet is the market price.") },
            ],
          },
        },
        footnote: t("In practice, taxes and shortages shift these curves."),
      },
    }),
  },
  {
    id: "outline_list",
    name: "Outline / objectives",
    description: "A titled nested list — lesson objectives or a module table of contents, with optional sub-points.",
    ai: {
      bestFor: ["lesson objectives", "a module table of contents", "a learning agenda"],
      avoidWhen: ["a sequence/procedure (use process_steps)", "raw data"],
    },
    seed: () => ({
      layoutId: "outline_list",
      content: {
        title: t("By the end of this module…"),
        items: [
          { text: t("Explain what a market price is"), subItems: [t("Define supply and demand"), t("Read a simple price chart")] },
          { text: t("Calculate a market equilibrium") },
          { text: t("Predict how a shock moves prices"), subItems: [t("Tax, subsidy, and shortage cases")] },
        ],
      },
    }),
  },
  {
    id: "prose",
    name: "Explainer (prose)",
    description: "A title + a real explanatory paragraph (and optional key points) — a deliberate plain teaching slide, not a tip stack.",
    ai: {
      bestFor: ["explaining an idea in full sentences", "intuition / motivation prose", "background a learner must read"],
      avoidWhen: ["a process (use process_steps)", "a term + supports (use key_concept)", "a list of objectives (use outline_list)"],
    },
    seed: () => ({
      layoutId: "prose",
      content: {
        eyebrow: t("Intuition"),
        title: t("Why greedy works here"),
        body: t("A greedy algorithm builds the answer one safe choice at a time. At each step it adds the cheapest option that can't break a later solution — for a minimum spanning tree, the cheapest edge that doesn't form a cycle. Because every such choice is provably part of some optimal tree, repeating it never paints us into a corner, so the locally cheapest move adds up to the globally cheapest tree."),
        points: [
          t("Make the cheapest choice that stays valid."),
          t("A 'safe' edge never closes a cycle."),
          t("Local optima compose into the global optimum here."),
        ],
      },
    }),
  },
  {
    id: "comparison_columns",
    name: "Comparison · columns",
    description:
      "Contrast 2–3 options as side-by-side columns (cards or bare badges), each a name + a few points; optional takeaway / shared-traits footer.",
    ai: {
      bestFor: ["comparing 2–3 options", "pros and cons side by side", "this vs that", "approach A vs approach B"],
      avoidWhen: ["many shared dimensions (use comparison_matrix)", "a single option", "a sequence (use process_steps)"],
    },
    seed: () => ({
      layoutId: "comparison_columns",
      content: {
        eyebrow: t("Compare"),
        title: t("Two ways to manage state"),
        subtitle: t("When to reach for each approach."),
        presentation: "cards",
        options: [
          {
            name: t("Local state"),
            icon: "lightbulb",
            points: [
              { label: t("Lives in one component"), detail: t("Simple to reason about and quick to add.") },
              { label: t("No extra libraries"), detail: t("Built into the framework.") },
              { label: t("Hard to share widely"), detail: t("Passing it deep gets unwieldy.") },
            ],
          },
          {
            name: t("Global store"),
            icon: "users",
            points: [
              { label: t("Shared across the app"), detail: t("Any component can read or update it.") },
              { label: t("Predictable updates"), detail: t("One place to trace every change.") },
              { label: t("More setup"), detail: t("Boilerplate and a learning curve.") },
            ],
          },
        ],
        footer: { kind: "summary", text: t("Start local; reach for a global store only when state is truly shared.") },
      },
    }),
  },
  {
    id: "comparison_matrix",
    name: "Comparison · matrix",
    description:
      "Contrast 2–3 options across shared dimensions as a matrix (options = columns, dimensions = rows); optional takeaway / shared-traits footer.",
    ai: {
      bestFor: ["comparing options across several shared dimensions", "a feature / spec matrix", "tradeoffs across criteria"],
      avoidWhen: ["only one or two attributes per option (use comparison_columns)", "a single option", "raw time-series data"],
    },
    seed: () => ({
      layoutId: "comparison_matrix",
      content: {
        eyebrow: t("Compare"),
        title: t("Choosing a database"),
        options: [
          { name: t("SQL"), icon: "document" },
          { name: t("Document"), icon: "search" },
          { name: t("Key-value"), icon: "gear" },
        ],
        dimensions: [
          {
            label: t("Data shape"),
            icon: "signpost",
            cells: [
              { detail: t("Rigid tables + relations") },
              { detail: t("Flexible JSON documents") },
              { detail: t("Simple key → value pairs") },
            ],
          },
          {
            label: t("Best for"),
            icon: "target",
            cells: [
              { detail: t("Complex queries"), example: t("e.g. reporting") },
              { detail: t("Evolving schemas"), example: t("e.g. catalogs") },
              { detail: t("Fast lookups"), example: t("e.g. caching") },
            ],
          },
          {
            label: t("Scaling"),
            icon: "trending-up",
            cells: [
              { detail: t("Vertical, then sharding") },
              { detail: t("Horizontal by design") },
              { detail: t("Horizontal, very fast") },
            ],
          },
        ],
        footer: {
          kind: "similarities",
          points: [t("All persist data durably"), t("All offer managed cloud options")],
        },
      },
    }),
  },
  {
    id: "diagram",
    name: "Diagram / graph",
    description:
      "A programmatic teaching VISUAL the renderer draws as crisp SVG — a supply & demand / price-control graph, or a coordinate plot (a function, distribution, or regression). Accurate by construction; pick a diagram.kind (or an add_diagram templateId). Any OTHER visual is a generated image (image_reference / image_supporting).",
    ai: {
      bestFor: [
        "a supply & demand / price-control graph",
        "a function, distribution, or regression plot (coordinate_plot)",
      ],
      avoidWhen: [
        "any other diagram type — use a generated image (image_reference/image_supporting)",
        "a decorative picture",
        "content a text/table/code slide conveys more accurately",
      ],
    },
    seed: (): SlideTemplate => ({
      layoutId: "diagram",
      content: {
        title: t("Market equilibrium"),
        caption: t("Price settles where the upward-sloping supply curve meets the downward-sloping demand curve — the equilibrium point E."),
        spec: {
          role: "graph",
          pedagogicalPurpose: "Show how the equilibrium price and quantity arise where supply meets demand.",
          altText:
            "A supply and demand graph with an upward-sloping supply curve and a downward-sloping demand curve intersecting at equilibrium point E, with dashed guides to P* on the price axis and Q* on the quantity axis.",
          requiredElements: ["upward-sloping supply curve", "downward-sloping demand curve", "labeled price/quantity axes", "equilibrium point"],
          placement: "center",
          source: "programmatic",
          mustBeAccurate: true,
          reason: "Supply and demand is conventionally taught with intersecting curves and a labeled equilibrium.",
        },
        diagram: findDiagramTemplate("supply_demand_equilibrium")!.seed(),
      } satisfies DiagramContent,
    }),
  },
  {
    id: "illustration",
    name: "Illustration (image)",
    description:
      "An educational IMAGE — generated by the AI (add_image) or uploaded — with required alt text, an optional title, caption, and supporting points. For a concept a picture conveys better than text when NO diagram type fits (a historical scene, a biological structure, a real-world analogy). Never for accuracy-critical figures — those are programmatic diagrams.",
    ai: {
      bestFor: ["a concept image", "a historical / real-world scene", "a biological or physical structure", "an evocative analogy picture"],
      avoidWhen: ["anything accuracy-critical (use a diagram)", "a chart / graph / labeled figure", "decorative-only filler", "content text conveys precisely"],
    },
    seed: (): SlideTemplate => ({
      layoutId: "illustration",
      content: {
        imageUrl: "",
        alt: "An educational illustration relevant to the lesson.",
        title: t("Illustration"),
        caption: t("A short caption explaining what the image shows and why it matters."),
        source: "upload",
      } satisfies IllustrationContent,
    }),
  },
  {
    id: "image_reference",
    name: "Image · reference (hero)",
    description:
      "A large landscape teaching image as the subject, with annotation points referencing details in it and numbered concept cards below. The image is generated by add_image; you fill the title, annotations, and cards.",
    ai: {
      bestFor: ["the image IS the subject", "a labeled figure/diagram a learner studies", "an overview a picture anchors"],
      avoidWhen: ["anything accuracy-critical (use a diagram)", "a pure text point (use prose)", "authored by add_image — NOT the batch tool"],
    },
    capacity: {
      maxPoints: 7,
      captionOptional: false,
      slots: { annotations: { max: 4, charsPerLine: LIMITS.annDesc }, cards: { max: 3, charsPerLine: LIMITS.cardBody } },
    },
    seed: (): SlideTemplate => ({
      layoutId: "image_reference",
      content: {
        imageUrl: "",
        alt: "An educational illustration relevant to the lesson.",
        eyebrow: t("Concept overview"),
        title: t("Understanding the big picture"),
        annotations: [
          { label: t("Key focus"), description: t("Highlights the central idea of the concept.") },
          { label: t("Core elements"), description: t("Points to the essential components.") },
          { label: t("Important patterns"), description: t("Shows trends and relationships at a glance.") },
        ],
        cards: [
          { title: t("Understand the foundations"), description: t("Build a solid understanding of the key concepts and how they connect.") },
          { title: t("See how it works"), description: t("Explore the relationships and processes that drive outcomes.") },
          { title: t("Apply the insight"), description: t("Use the understanding to make better decisions.") },
        ],
        source: "upload",
      } satisfies ImageReferenceContent,
    }),
  },
  {
    id: "image_supporting",
    name: "Image · supporting",
    description:
      "Teaching text on the left (lead + bullets) beside a square supporting image on the right, with an optional caption. The image is generated by add_image; you fill the title, lead, bullets, and caption.",
    ai: {
      bestFor: ["an image that AIDS understanding", "a concept where fine image detail doesn't matter", "text-led teaching with a supporting picture"],
      avoidWhen: ["the image is the subject (use image_reference)", "anything accuracy-critical (use a diagram)", "authored by add_image — NOT the batch tool"],
    },
    capacity: {
      maxPoints: 4,
      captionOptional: true,
      slots: { bullets: { max: 4, charsPerLine: LIMITS.imgBullet } },
    },
    seed: (): SlideTemplate => ({
      layoutId: "image_supporting",
      content: {
        imageUrl: "",
        alt: "An educational illustration relevant to the lesson.",
        eyebrow: t("Lesson 1"),
        title: t("Why context matters"),
        lead: t("Understanding the surrounding context helps us make sense of information and avoid misinterpretation."),
        bullets: [
          t("Shows how context shapes meaning."),
          t("Highlights the factors that influence interpretation."),
          t("Illustrates surface understanding vs deeper insight."),
        ],
        caption: t("Context shapes how we interpret information and informs better decisions."),
        source: "upload",
      } satisfies ImageSupportingContent,
    }),
  },
];

export const STRUCTURED_LAYOUT_IDS = STRUCTURED_LAYOUT_META.map((l) => l.id) as [
  StructuredLayoutId,
  ...StructuredLayoutId[],
];

/** The single repeating-item slot of the FLAT structured layouts, with its count
 *  bounds — drives the inspector's generic add/remove/reorder controls. Layouts
 *  with bespoke structure (section_break, concept_example, outline_list) are
 *  absent here and edited by their own inspector panels. */
export const ITEM_BOUNDS: Partial<
  Record<
    StructuredLayoutId,
    { key: string; min: number; max: number; blank: () => Record<string, unknown> }
  >
> = {
  process_steps: { key: "steps", min: 3, max: 5, blank: () => ({ sticker: "lightbulb", heading: { text: "New step" }, body: { text: "" } }) },
  key_concept: { key: "items", min: 2, max: 4, blank: () => ({ sticker: "lightbulb", heading: { text: "New point" }, body: { text: "" } }) },
  metrics_overview: { key: "metrics", min: 2, max: 4, blank: () => ({ sticker: "bar-chart", label: { text: "Metric" }, value: { text: "0" } }) },
  code_walkthrough_steps: { key: "steps", min: 2, max: 4, blank: () => ({ sticker: "lightbulb", heading: { text: "New step" }, body: { text: "" } }) },
};

export function findStructuredLayoutMeta(id: string): StructuredLayoutMeta | undefined {
  return STRUCTURED_LAYOUT_META.find((l) => l.id === id);
}

/** Global default key-point capacity (the fallback for layouts without explicit
 *  `capacity`). Mirrors AI_MAX_POINTS_PER_SLIDE in lib/ai/outline.ts. */
export const DEFAULT_LAYOUT_POINT_CAPACITY = Math.max(3, Number(process.env.AI_MAX_POINTS_PER_SLIDE) || 6);

/** How many key points a layout holds before content-first planning spills to a
 *  continuation slide. Reads the registry's `capacity.maxPoints`, else the default. */
export function layoutPointCapacity(layoutId: string): number {
  return findStructuredLayoutMeta(layoutId)?.capacity?.maxPoints ?? DEFAULT_LAYOUT_POINT_CAPACITY;
}

/** Layout ids the PLANNER may choose — every structured layout EXCEPT the legacy
 *  `illustration` (retired from the AI surface; kept only for back-compat
 *  rendering). The two image_* layouts ARE included. */
export const PLANNABLE_LAYOUT_IDS = STRUCTURED_LAYOUT_IDS.filter((id) => id !== "illustration") as [
  StructuredLayoutId,
  ...StructuredLayoutId[],
];

export function isStructuredLayoutId(id: string): id is StructuredLayoutId {
  return STRUCTURED_LAYOUT_META.some((l) => l.id === id);
}

/** Compact AI catalog: id + when-to-use + slot summary. EXCLUDES the retired
 *  `illustration` layout so neither the planner nor GENERATE ever offers it. */
export function structuredLayoutCatalog() {
  return STRUCTURED_LAYOUT_META.filter((l) => l.id !== "illustration").map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    bestFor: l.ai.bestFor,
    avoidWhen: l.ai.avoidWhen,
  }));
}
