/**
 * STRETCHING render checks — the converted structured layouts flow (grow to fit)
 * and never DROP/clip content. Run: `npx tsx scripts/verify-stretch.ts`
 *
 * Renders each flow-converted layout (non-interactive, server markup) with
 * deliberately HEAVY content and asserts:
 *   1. it renders without throwing (SSR-safe);
 *   2. ALL the heavy text appears in the output (no content dropped);
 *   3. the layout uses FLOW (display:flex column / grid auto rows) — not a fixed-
 *      height clip box — and no text container carries `overflow:hidden`.
 * Pixel-level "fits the 16:9 frame" is confirmed visually with the temporary
 * Playwright harness; this is the runnable, no-browser guard.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StructuredCtx } from "@/components/editor/slide/structured/common";
import { ComparisonColumnsLayout } from "@/components/editor/slide/structured/ComparisonColumnsLayout";
import { ComparisonMatrixLayout } from "@/components/editor/slide/structured/ComparisonMatrixLayout";
import { ConceptExampleLayout } from "@/components/editor/slide/structured/ConceptExampleLayout";
import { OutlineListLayout } from "@/components/editor/slide/structured/OutlineListLayout";
import { ProseLayout } from "@/components/editor/slide/structured/ProseLayout";
import type {
  ComparisonColumnsContent,
  ComparisonMatrixContent,
  ConceptExampleContent,
  OutlineListContent,
  ProseContent,
} from "@/lib/course/types";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n} ${d}`); }
};

const ctx: StructuredCtx = { blockId: "b", slideId: "s", interactive: false, accent: "#ea580c", ink: "#1c1917", body: "#44403c", muted: "#78716c" };
const t = (text: string) => ({ text });
/** A long, UNIQUE sentence so we can prove it rendered in full (not dropped). */
const heavy = (tag: string) =>
  `${tag} ${"a heavy clause that wraps across several lines and would have clipped a fixed-height box before stretching ".repeat(3)}END_${tag}`;

function renderOk(name: string, el: React.ReactElement): string {
  try {
    const html = renderToStaticMarkup(el);
    check(`${name}: renders (SSR-safe)`, html.length > 0);
    check(`${name}: uses FLOW layout (flex/grid), not a clip box`, /display:\s*flex|class="[^"]*flex|display:\s*grid/.test(html));
    return html;
  } catch (e) {
    check(`${name}: renders (SSR-safe)`, false, e instanceof Error ? e.message : String(e));
    return "";
  }
}
/** Assert each heavy marker's full text survived to the output (no clip-by-drop). */
function hasAll(name: string, html: string, markers: string[]) {
  const missing = markers.filter((m) => !html.includes(m));
  check(`${name}: all heavy content rendered in full (${markers.length} blocks)`, missing.length === 0, `missing: ${missing.join(", ")}`);
}

function main() {
  // ── prose: a very long body + many points
  {
    const content: ProseContent = {
      eyebrow: t("Intuition"),
      title: t("A title that is also fairly long to test the header wrap"),
      body: t(heavy("BODY")),
      points: [t(heavy("P1")), t(heavy("P2")), t(heavy("P3")), t(heavy("P4")), t(heavy("P5"))],
    };
    const html = renderOk("prose", createElement(ProseLayout, { content, ctx }));
    hasAll("prose", html, ["END_BODY", "END_P1", "END_P3", "END_P5"]);
    check("prose: no overflow:hidden clip on the frame", !/overflow:\s*hidden/.test(html));
  }

  // ── concept_example: a long definition + a long worked example (the worst clipper)
  {
    const content: ConceptExampleContent = {
      concept: { badge: "Rule", title: t("A reasonably long concept title here"), titleStyle: "serif", definition: t(heavy("DEF")) },
      example: {
        badge: "Worked Example",
        title: t("A worked example with a long title too"),
        body: { kind: "steps", steps: [
          { heading: t("Step one heading is long"), body: t(heavy("S1")) },
          { heading: t("Step two heading is long"), body: t(heavy("S2")) },
          { heading: t("Step three heading is long"), body: t(heavy("S3")) },
          { heading: t("Step four heading is long"), body: t(heavy("S4")) },
        ] },
      },
      footnote: t(heavy("FN")),
    };
    const html = renderOk("concept_example", createElement(ConceptExampleLayout, { content, ctx }));
    hasAll("concept_example", html, ["END_DEF", "END_S1", "END_S4", "END_FN"]);
    check("concept_example: no overflow:hidden clip on its text columns", !/overflow:\s*hidden/.test(html));
  }

  // ── comparison_columns: 3 options, 4 long points each
  {
    const opt = (name: string, k: string): ComparisonColumnsContent["options"][number] => ({
      name: t(name), icon: "lightbulb",
      points: [1, 2, 3, 4].map((j) => ({ label: t(`Point ${j} of ${name}`), detail: t(heavy(`${k}${j}`)) })),
    });
    const content: ComparisonColumnsContent = {
      eyebrow: t("Compare"), title: t("Comparing three approaches in depth"), subtitle: t("A longer framing line under the title to push the body down"),
      presentation: "cards",
      options: [opt("Local state", "A"), opt("Global store", "B"), opt("Server state", "C")],
      footer: { kind: "summary", text: t(heavy("FOOT")) },
    };
    const html = renderOk("comparison_columns", createElement(ComparisonColumnsLayout, { content, ctx }));
    hasAll("comparison_columns", html, ["END_A1", "END_B4", "END_C3", "END_FOOT"]);
  }

  // ── comparison_matrix: 3 options × 4 dimensions, long cells
  {
    const content: ComparisonMatrixContent = {
      eyebrow: t("Compare"), title: t("A spec matrix with long cells"),
      options: [{ name: t("SQL") }, { name: t("Document") }, { name: t("Key-value") }],
      dimensions: [1, 2, 3, 4].map((r) => ({
        label: t(`Dimension ${r} with a long label`),
        cells: [t(""), t(""), t("")].map((_, c) => ({ detail: t(heavy(`C${r}${c}`)) })),
      })),
      footer: { kind: "similarities", points: [t(heavy("SIM1")), t(heavy("SIM2"))] },
    };
    const html = renderOk("comparison_matrix", createElement(ComparisonMatrixLayout, { content, ctx }));
    hasAll("comparison_matrix", html, ["END_C10", "END_C42", "END_SIM1"]);
    check("comparison_matrix: grid rows are content-sized (auto), not fixed fractions", /repeat\(\d+,\s*auto\)/.test(html));
  }

  // ── outline_list: 5 items, each with sub-points, all long
  {
    const content: OutlineListContent = {
      title: t("By the end of this module you will be able to do all of these"),
      items: [1, 2, 3, 4, 5].map((i) => ({
        text: t(heavy(`IT${i}`)),
        subItems: [t(heavy(`SUB${i}a`)), t(heavy(`SUB${i}b`))],
      })),
    };
    const html = renderOk("outline_list", createElement(OutlineListLayout, { content, ctx }));
    hasAll("outline_list", html, ["END_IT1", "END_IT5", "END_SUB3a"]);
    check("outline_list: items flow in a column (no fixed per-row clip)", !/overflow:\s*hidden/.test(html));
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
