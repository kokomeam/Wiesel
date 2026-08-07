"use client";

/**
 * Markdown-lite for assistant chat bubbles — a tiny, dependency-free renderer:
 * paragraphs, **bold**, *italic*, `inline code`, - / 1. lists, ### headings,
 * and ```fenced code blocks```. Builds React nodes directly (NO
 * dangerouslySetInnerHTML). The PARSER is a pure exported function
 * (`parseMarkdownBlocks`) so `scripts/verify-agent-ux.ts` can test it without
 * React; the component just maps segments to elements.
 *
 * Deliberately forgiving: unclosed fences swallow the rest as code, unmatched
 * markers render as plain text, and pathological input never throws — the text
 * streams token-by-token, so half-typed markup is the COMMON case.
 */

import { memo, useMemo } from "react";
import { cn } from "@/lib/cn";

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type MarkdownBlock =
  | { type: "paragraph"; inline: MarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] }
  | { type: "code"; lang: string | null; text: string };

/** `code` first (verbatim wins), then **bold**, then *italic*. No nesting —
 *  this is chat copy, not a document engine. */
const INLINE_TOKEN = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g;

/** Parse one line/segment of text into inline segments (pure). */
export function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) out.push({ type: "text", text: text.slice(lastIndex, idx) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ type: "code", text: tok.slice(1, -1) });
    else if (tok.startsWith("**")) out.push({ type: "bold", text: tok.slice(2, -2) });
    else out.push({ type: "italic", text: tok.slice(1, -1) });
    lastIndex = idx + tok.length;
  }
  if (lastIndex < text.length) out.push({ type: "text", text: text.slice(lastIndex) });
  return out;
}

/** Parse markdown-lite into typed blocks (pure — testable without React). */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  if (typeof text !== "string" || !text) return blocks;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // ``` fenced code (optional language tag). An unterminated fence takes the
    // rest of the text — mid-stream, that's exactly what you want to see.
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1] || null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (harmless past the end)
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        inline: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    // - / * bullets and 1. / 1) ordered items; consecutive same-kind lines
    // collect into one list. (Marker requires a following space, so "*italic*"
    // is never mistaken for a bullet.)
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = ul ? null : line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      const items: MarkdownInline[][] = [];
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          : lines[i].match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/** The character offset AFTER the last blank line that sits outside any ```
 *  fence (pure). Everything before it parses to blocks that can NEVER change as
 *  more text streams in: a blank line terminates paragraphs and list runs, and
 *  fences only swallow blank lines while open — so a streaming bubble can cache
 *  the prefix parse and re-parse only the open tail (PERF-1 D5, A5 §2.2's O(n²)
 *  whole-string re-parse per delta). The final line is skipped when
 *  unterminated — the next delta could still extend it. */
export function stableMarkdownPrefixEnd(text: string): number {
  if (typeof text !== "string" || !text) return 0;
  const lines = text.split("\n");
  const last = lines.length - 1; // the final segment is unterminated
  let fenceOpen = false;
  let boundary = 0;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only `-prefixed lines can toggle fence state (the parser's fence regexes
    // are ^-anchored) — cheap guard so ordinary lines skip both regex tests.
    if (line.charCodeAt(0) === 96 /* ` */) {
      if (fenceOpen) {
        if (/^```\s*$/.test(line)) fenceOpen = false;
      } else if (/^```\S*\s*$/.test(line)) {
        fenceOpen = true;
      }
    } else if (!fenceOpen && !line.trim() && i < last) {
      boundary = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  return boundary;
}

function InlineRun({ segments }: { segments: MarkdownInline[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case "bold":
            return (
              <strong key={i} className="font-semibold text-stone-800">
                {seg.text}
              </strong>
            );
          case "italic":
            return <em key={i}>{seg.text}</em>;
          case "code":
            return (
              <code key={i} className="rounded bg-stone-200/60 px-1 py-px font-mono text-meta">
                {seg.text}
              </code>
            );
          default:
            return <span key={i}>{seg.text}</span>;
        }
      })}
    </>
  );
}

const MarkdownBlocks = memo(function MarkdownBlocks({
  blocks,
  spacedFirst,
}: {
  blocks: MarkdownBlock[];
  spacedFirst: boolean;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        const spaced = spacedFirst || i > 0;
        switch (b.type) {
          case "heading":
            return (
              <p key={i} className={cn("text-secondary font-semibold text-stone-800", spaced && "mt-2.5")}>
                <InlineRun segments={b.inline} />
              </p>
            );
          case "list":
            return b.ordered ? (
              <ol key={i} className={cn("list-decimal space-y-1 pl-4", spaced && "mt-1.5")}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineRun segments={item} />
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={i} className={cn("list-disc space-y-1 pl-4", spaced && "mt-1.5")}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineRun segments={item} />
                  </li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre
                key={i}
                className={cn(
                  "overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 font-mono text-meta leading-relaxed text-stone-700",
                  spaced && "mt-2"
                )}
              >
                <code>{b.text}</code>
              </pre>
            );
          default:
            return (
              <p key={i} className={cn("whitespace-pre-wrap", spaced && "mt-2")}>
                <InlineRun segments={b.inline} />
              </p>
            );
        }
      })}
    </>
  );
});

/** Assistant-bubble markdown (user bubbles stay plain text). While streaming,
 *  only the OPEN tail (after the last stable boundary) re-parses per flush; the
 *  settled prefix parses once — string deps compare by VALUE, so the growing
 *  text still memo-hits an unchanged `prefix`, and the stable block-array
 *  identity lets MarkdownBlocks skip re-rendering the prefix entirely. */
export function Markdown({ text }: { text: string }) {
  const prefixEnd = useMemo(() => stableMarkdownPrefixEnd(text), [text]);
  const prefix = text.slice(0, prefixEnd);
  const tail = text.slice(prefixEnd);
  const prefixBlocks = useMemo(() => parseMarkdownBlocks(prefix), [prefix]);
  const tailBlocks = useMemo(() => parseMarkdownBlocks(tail), [tail]);
  return (
    <>
      <MarkdownBlocks blocks={prefixBlocks} spacedFirst={false} />
      <MarkdownBlocks blocks={tailBlocks} spacedFirst={prefixBlocks.length > 0} />
    </>
  );
}
