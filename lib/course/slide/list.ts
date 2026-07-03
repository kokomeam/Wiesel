/**
 * Pure operations on the rich-list model (`SlideListContent`) — the testable
 * core of every list keyboard behaviour and the materialize/render bridge.
 *
 * FLAT model: nesting is the integer `level`, so indent/outdent is a level
 * change and rendering is a single pass. `text` stays the plain fallback
 * (invariant: equals concat(`runs`)). Everything here is pure; `newId` (crypto)
 * is only used when creating items — call from event handlers / materialize /
 * tests, never during render (the renderer uses `listFromElement`, which mints
 * DETERMINISTIC ids and is render-safe).
 */

import { newId } from "../factories";
import type {
  ListMarkerKind,
  SlideListContent,
  SlideListItem,
  TextRun,
} from "../types";

export const DEFAULT_MARKER: ListMarkerKind = "disc";
export const MAX_LIST_LEVEL = 5;
/** Logical px per indent level (renderer + materializer share this). */
export const LIST_INDENT_STEP = 34;

/** Any element that can carry a list: a bullet_list (legacy `items[]` fallback)
 *  or a text box (no `items` — a list created by toggling). */
type Listy = { id: string; items?: string[]; list?: SlideListContent };

/* ─────────────────────────── normalize / flatten ──────────────────────── */

/** RENDER-SAFE: the element's rich list, or a legacy `items[]` upgraded to a
 *  flat level-0 disc list with DETERMINISTIC ids (no crypto → no hydration
 *  mismatch). */
export function listFromElement(el: Listy): SlideListContent {
  if (el.list) return el.list;
  return {
    items: (el.items ?? []).map((text, i) => ({ id: `${el.id}::${i}`, text, level: 0 })),
    defaultMarkerKind: DEFAULT_MARKER,
  };
}

/** The plain-text fallback (the element's `items[]` invariant). */
export function flattenToItems(content: SlideListContent): string[] {
  return content.items.map((it) => it.text);
}

/** A fresh item (crypto id — event handlers / materialize / tests only). */
export function newListItem(text = "", level = 0, extra: Partial<SlideListItem> = {}): SlideListItem {
  return { id: newId("li"), text, level, ...extra };
}

/* ──────────────────────────── marker rendering ────────────────────────── */

const STATIC_GLYPH: Record<ListMarkerKind, string> = {
  disc: "•",
  circle: "○",
  square: "▪",
  dash: "—",
  none: "",
  number: "",
  alpha: "",
  roman: "",
};

export function effectiveMarkerKind(content: SlideListContent, item: SlideListItem): ListMarkerKind {
  return item.markerKind ?? content.levelStyles?.[item.level]?.markerKind ?? content.defaultMarkerKind;
}

function toAlpha(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    x--;
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26);
  }
  return s || "a";
}

const ROMAN: [number, string][] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];
function toRoman(n: number): string {
  let x = n;
  let s = "";
  for (const [v, sym] of ROMAN) while (x >= v) { s += sym; x -= v; }
  return s || "i";
}

/** The displayed marker glyph/label for every item (auto-numbers per contiguous
 *  same-level run; honours `markerText` overrides). */
export function computeMarkers(content: SlideListContent): string[] {
  const start = content.startNumber ?? 1;
  const counters: number[] = [];
  return content.items.map((item) => {
    counters.length = item.level + 1; // drop deeper counters (restart on descend)
    const kind = effectiveMarkerKind(content, item);
    const numbered = kind === "number" || kind === "alpha" || kind === "roman";
    if (numbered) counters[item.level] = (counters[item.level] ?? start - 1) + 1;
    if (item.markerText !== undefined) return item.markerText;
    if (numbered) {
      const n = counters[item.level];
      const label = kind === "number" ? String(n) : kind === "alpha" ? toAlpha(n) : toRoman(n);
      return `${label}.`;
    }
    return STATIC_GLYPH[kind];
  });
}

/* ───────────────────────────── editing result ─────────────────────────── */

export type ListCaret = "start" | "end" | number;
export interface ListEdit {
  content: SlideListContent;
  /** Item to focus after the edit, and where to place the caret. */
  focusId?: string;
  caret?: ListCaret;
}

function indexOf(content: SlideListContent, itemId: string): number {
  return content.items.findIndex((it) => it.id === itemId);
}
function replace(content: SlideListContent, items: SlideListItem[]): SlideListContent {
  return { ...content, items };
}

/* ───────────────────────────── structural ops ─────────────────────────── */

/** Split an item at `offset` into two same-level items (Enter). Splitting drops
 *  rich runs on both halves (plain text) — formatted-mid-split is a known cut. */
export function splitItem(content: SlideListContent, itemId: string, offset: number): ListEdit {
  const i = indexOf(content, itemId);
  if (i === -1) return { content };
  const item = content.items[i];
  const head = item.text.slice(0, offset);
  const tail = item.text.slice(offset);
  const first: SlideListItem = { ...item, text: head, runs: undefined };
  const next: SlideListItem = {
    id: newId("li"),
    text: tail,
    level: item.level,
    markerKind: item.markerKind,
    markerColor: item.markerColor,
    textColor: item.textColor,
  };
  const items = [...content.items.slice(0, i), first, next, ...content.items.slice(i + 1)];
  return { content: replace(content, items), focusId: next.id, caret: "start" };
}

/** Indent one level (Tab) — capped at prev-sibling level + 1 (can't indent the
 *  first item or jump levels), and at MAX_LIST_LEVEL. */
export function indentItem(content: SlideListContent, itemId: string): ListEdit {
  const i = indexOf(content, itemId);
  if (i <= 0) return { content, focusId: itemId, caret: "end" };
  const item = content.items[i];
  const maxLevel = Math.min(content.items[i - 1].level + 1, MAX_LIST_LEVEL);
  const level = Math.min(item.level + 1, maxLevel);
  if (level === item.level) return { content, focusId: itemId, caret: "end" };
  const items = content.items.map((it) => (it.id === itemId ? { ...it, level } : it));
  return { content: replace(content, items), focusId: itemId, caret: "end" };
}

/** Outdent one level (Shift+Tab / Enter|Backspace on an empty nested item). */
export function outdentItem(content: SlideListContent, itemId: string): ListEdit {
  const item = content.items.find((it) => it.id === itemId);
  if (!item || item.level === 0) return { content, focusId: itemId, caret: "end" };
  const items = content.items.map((it) => (it.id === itemId ? { ...it, level: it.level - 1 } : it));
  return { content: replace(content, items), focusId: itemId, caret: "end" };
}

/** Merge an item into the previous one (Backspace at item start). Focus lands at
 *  the join. First item → no-op. */
export function mergeWithPrev(content: SlideListContent, itemId: string): ListEdit {
  const i = indexOf(content, itemId);
  if (i <= 0) return { content, focusId: itemId, caret: "start" };
  const prev = content.items[i - 1];
  const cur = content.items[i];
  const joinAt = prev.text.length;
  const merged: SlideListItem = { ...prev, text: prev.text + cur.text, runs: undefined };
  const items = [...content.items.slice(0, i - 1), merged, ...content.items.slice(i + 1)];
  return { content: replace(content, items), focusId: prev.id, caret: joinAt };
}

/** Remove an item (Enter/Backspace on an empty level-0 item). Focuses the
 *  previous item's end, or the next item's start. */
export function removeItem(content: SlideListContent, itemId: string): ListEdit {
  const i = indexOf(content, itemId);
  if (i === -1) return { content };
  const items = [...content.items.slice(0, i), ...content.items.slice(i + 1)];
  const focus = items[i - 1] ?? items[i];
  return {
    content: replace(content, items),
    focusId: focus?.id,
    caret: items[i - 1] ? "end" : "start",
  };
}

export function addItemAfter(content: SlideListContent, itemId: string, text = ""): ListEdit {
  const i = indexOf(content, itemId);
  const item = content.items[i];
  const next = newListItem(text, item?.level ?? 0);
  const at = i === -1 ? content.items.length : i + 1;
  const items = [...content.items.slice(0, at), next, ...content.items.slice(at)];
  return { content: replace(content, items), focusId: next.id, caret: "end" };
}

/* ───────────────────────────── content setters ────────────────────────── */

/** Update one item's text (+ optional runs; invariant text === concat(runs)). */
export function setItemText(content: SlideListContent, itemId: string, text: string, runs?: TextRun[]): SlideListContent {
  const items = content.items.map((it) =>
    it.id === itemId ? { ...it, text, runs: runs && runs.length ? runs : undefined } : it
  );
  return replace(content, items);
}

export function setItemMarker(content: SlideListContent, itemId: string, kind: ListMarkerKind): SlideListContent {
  const items = content.items.map((it) => (it.id === itemId ? { ...it, markerKind: kind, markerText: undefined } : it));
  return replace(content, items);
}

/** Set the whole list's marker kind (toolbar "bullet"/"numbered" toggle); clears
 *  per-item overrides so the choice takes effect everywhere. */
export function setListMarker(content: SlideListContent, kind: ListMarkerKind): SlideListContent {
  return {
    ...content,
    defaultMarkerKind: kind,
    items: content.items.map((it) => ({ ...it, markerKind: undefined, markerText: undefined })),
  };
}

/** Shift every item's level by ±1 (toolbar indent/outdent of the whole list),
 *  clamped to [0, MAX_LIST_LEVEL]. Preserves relative nesting. */
export function shiftAllLevels(content: SlideListContent, delta: number): SlideListContent {
  return {
    ...content,
    items: content.items.map((it) => ({ ...it, level: Math.max(0, Math.min(it.level + delta, MAX_LIST_LEVEL)) })),
  };
}

/** Toggle one item's marker: if it already shows `kind`, turn it off (→ none);
 *  otherwise set it (the ⌘⇧8 / ⌘⇧7 behaviour within a list). */
export function toggleItemMarker(content: SlideListContent, itemId: string, kind: ListMarkerKind): SlideListContent {
  const item = content.items.find((it) => it.id === itemId);
  if (!item) return content;
  const next = effectiveMarkerKind(content, item) === kind ? "none" : kind;
  return setItemMarker(content, itemId, next);
}

/** True when every item is a plain (markerless) paragraph — a text box, really. */
export function listIsAllPlain(content: SlideListContent): boolean {
  return content.items.every((it) => effectiveMarkerKind(content, it) === "none");
}

/* ────────────────── text ⇄ list (lists inside a text box) ──────────────── */

/** Split flat runs at "\n" into per-line runs (preserves inline formatting when
 *  a text box becomes a list). */
function runsByLine(text: string, runs: TextRun[] | undefined): { text: string; runs?: TextRun[] }[] {
  const lines = text.split("\n");
  if (!runs || runs.length === 0) return lines.map((t) => ({ text: t }));
  const acc: TextRun[][] = lines.map(() => []);
  let li = 0;
  for (const run of runs) {
    let s = run.text;
    while (s.length > 0) {
      const nl = s.indexOf("\n");
      if (nl === -1) {
        if (s) acc[li].push({ text: s, marks: run.marks });
        s = "";
      } else {
        if (nl > 0) acc[li].push({ text: s.slice(0, nl), marks: run.marks });
        s = s.slice(nl + 1);
        li = Math.min(li + 1, lines.length - 1);
      }
    }
  }
  return lines.map((t, i) => ({ text: t, runs: acc[i].length ? acc[i] : undefined }));
}

/** Default paragraph gap (px) for a text-box list — tight, so plain lines flow
 *  like normal text and only marked lines read as a list. */
export const TEXT_LIST_SPACING = 4;

/** Convert a text element's `text`/`runs` into a list: every line becomes an
 *  item (preserving per-line runs); lines in `markLines` get `kind`, the rest
 *  stay plain (`none`). Used by ⌘⇧8 / ⌘⇧7 on a normal text box. */
export function textToList(text: string, runs: TextRun[] | undefined, markLines: Set<number>, kind: ListMarkerKind): SlideListContent {
  const lines = runsByLine(text, runs);
  const items: SlideListItem[] = lines.map((l, i) => ({
    id: newId("li"),
    text: l.text,
    runs: l.runs,
    level: 0,
    markerKind: markLines.has(i) ? kind : "none",
  }));
  if (items.length === 0) items.push(newListItem("", 0, { markerKind: kind }));
  return { items, defaultMarkerKind: kind, paragraphSpacing: TEXT_LIST_SPACING };
}

/** Collapse a list back into plain text + runs (every "\n"-joined line, with
 *  per-item runs concatenated). Used when the last marker is toggled off. */
export function listToText(content: SlideListContent): { text: string; runs?: TextRun[] } {
  const runs: TextRun[] = [];
  content.items.forEach((it, i) => {
    if (i > 0) runs.push({ text: "\n" });
    if (it.runs && it.runs.length) runs.push(...it.runs);
    else if (it.text) runs.push({ text: it.text });
  });
  const text = content.items.map((it) => it.text).join("\n");
  const hasMarks = runs.some((r) => r.marks);
  return hasMarks ? { text, runs } : { text };
}

/* ─────────────────────────── markdown shortcuts ───────────────────────── */

export interface MarkdownPrefix {
  kind: ListMarkerKind;
  markerText?: string;
  rest: string;
}

/** Detect a leading list shortcut on a line (only at the very start). Returns
 *  the marker intent + the remaining text, or null. */
export function detectMarkdownPrefix(text: string): MarkdownPrefix | null {
  let m = /^(\d+)([.)])\s+([\s\S]*)$/.exec(text);
  if (m) {
    const digits = m[1];
    const twoDigit = digits.length >= 2 && digits.startsWith("0");
    return { kind: "number", markerText: twoDigit ? digits : undefined, rest: m[3] };
  }
  m = /^(\d{2})\s+([\s\S]*)$/.exec(text);
  if (m) return { kind: "number", markerText: m[1], rest: m[2] };
  m = /^(?:—|--)\s+([\s\S]*)$/.exec(text);
  if (m) return { kind: "dash", rest: m[1] };
  m = /^-\s+([\s\S]*)$/.exec(text);
  if (m) return { kind: "dash", rest: m[1] };
  m = /^•\s+([\s\S]*)$/.exec(text);
  if (m) return { kind: "disc", rest: m[1] };
  m = /^(?:○|o)\s+([\s\S]*)$/.exec(text);
  if (m) return { kind: "circle", rest: m[1] };
  return null;
}

/** Apply a detected markdown prefix to an item (sets marker + strips the prefix). */
export function applyMarkdownPrefix(content: SlideListContent, itemId: string, p: MarkdownPrefix): SlideListContent {
  const items = content.items.map((it) =>
    it.id === itemId ? { ...it, text: p.rest, runs: undefined, markerKind: p.kind, markerText: p.markerText } : it
  );
  return replace(content, items);
}
