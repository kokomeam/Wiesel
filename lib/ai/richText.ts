/**
 * Rich text for the slide agent — the fix for the leaked-`**markdown**` bug.
 *
 * The agent expresses emphasis as STRUCTURED runs (`{ text, bold?, italic? }`),
 * not markdown in a plain string. We convert that to the studio's `TextRun[]`
 * model (which the renderer already draws as <strong>/<em>), maintaining the
 * invariant `concat(runs.text) === text`. As a belt-and-suspenders safety net,
 * any stray markdown a model still slips into a run's text (`**x**`, `*x*`,
 * `` `x` ``) is parsed into runs too — so a literal asterisk can never ship.
 *
 * Bullet-list items are plain strings in the renderer (per-item runs are a
 * known studio cut), so emphasis there is flattened to plain text with the
 * markers stripped — never leaked.
 */

import { z } from "zod";
import type { TextMarks, TextRun } from "@/lib/course/types";

/** One run of rich text the model may emit. */
export const RichRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().nullable(),
  italic: z.boolean().nullable(),
});
export type RichRun = z.infer<typeof RichRunSchema>;

/** A rich-text value = an ordered list of runs. */
export const RichTextSchema = z.array(RichRunSchema);
export type RichTextInput = RichRun[];

/** Split inline markdown in `text` into runs (the safety net). Balanced
 *  `**bold**` / `__bold__`, `*italic*` / `_italic_`, and `` `code` `` (kept as
 *  plain text). Anything else stays literal; orphan markers are stripped. */
function runsFromMarkdown(text: string): TextRun[] {
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g;
  const runs: TextRun[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**") || tok.startsWith("__")) {
      runs.push({ text: tok.slice(2, -2), marks: { bold: true } });
    } else if (tok.startsWith("`")) {
      runs.push({ text: tok.slice(1, -1) }); // inline code → plain (no code mark)
    } else {
      runs.push({ text: tok.slice(1, -1), marks: { italic: true } });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  // Strip any orphan emphasis markers left in plain runs so nothing leaks.
  return runs.map((r) =>
    r.marks ? r : { text: r.text.replace(/\*\*|__|(?<!\w)[*_]|[*_](?!\w)/g, "") }
  );
}

function mergeMarks(a: TextMarks | undefined, bold: boolean, italic: boolean): TextMarks | undefined {
  const marks: TextMarks = {};
  if (a?.bold || bold) marks.bold = true;
  if (a?.italic || italic) marks.italic = true;
  return marks.bold || marks.italic ? marks : undefined;
}

/**
 * Convert the agent's rich-text input into the element shape `{ text, runs? }`.
 * Returns `runs` only when there's actual formatting (a plain rewrite resets
 * styling, matching the studio's "text without runs clears runs" rule).
 */
export function richTextToElement(input: RichTextInput | null | undefined): {
  text: string;
  runs?: TextRun[];
} {
  const out: TextRun[] = [];
  for (const r of input ?? []) {
    for (const sub of runsFromMarkdown(r.text)) {
      const marks = mergeMarks(sub.marks, Boolean(r.bold), Boolean(r.italic));
      out.push(marks ? { text: sub.text, marks } : { text: sub.text });
    }
  }
  const text = out.map((r) => r.text).join("");
  return out.some((r) => r.marks) ? { text, runs: out } : { text };
}

/** Flatten rich text to a plain string with markdown markers stripped (for
 *  bullet items and any plain-string slot). */
export function richTextToPlain(input: RichTextInput | string | null | undefined): string {
  if (typeof input === "string") return runsFromMarkdown(input).map((r) => r.text).join("");
  return (input ?? []).map((r) => runsFromMarkdown(r.text).map((s) => s.text).join("")).join("");
}

/** True if a string still contains raw inline markdown emphasis markers. */
export function hasRawMarkdown(s: string): boolean {
  return /\*\*|__|(?<![\w*])\*(?!\s)|(?<![\w_])_(?!\s)/.test(s);
}
