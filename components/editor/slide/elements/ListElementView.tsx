"use client";

/**
 * Rich list element (`bullet_list`) — renderer + Google-Slides-style editor.
 *
 * Display (`ListContent`) is pure + SSR-safe (used on the stage, in thumbnails,
 * and by the height measurer). The editor opens per-item contenteditable rows on
 * double-click and maps keys to the PURE ops in lib/course/slide/list.ts:
 *   Enter      split (empty nested → outdent · empty level-0 → remove)
 *   Tab        indent · Shift+Tab outdent
 *   Backspace  at item start: empty → outdent/remove · else merge w/ prev
 *   Shift+Enter soft line break (browser <br> → "\n", rendered pre-wrap)
 *   "- "/"1. "/"— "/"○ "… at the start of an empty item → set marker
 * Each structural op commits the whole list via ONE patch (one undo) and bumps a
 * revision so rows remount from the fresh model; plain typing never remounts, so
 * the caret is stable.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commitElementTextPatches } from "@/lib/course/commands";
import { SLIDE_H } from "@/lib/course/slide/geometry";
import {
  LIST_INDENT_STEP,
  applyMarkdownPrefix,
  computeMarkers,
  detectMarkdownPrefix,
  effectiveMarkerKind,
  flattenToItems,
  indentItem,
  listFromElement,
  mergeWithPrev,
  outdentItem,
  setItemMarker,
  setItemText,
  splitItem,
  toggleItemMarker,
  type ListEdit,
} from "@/lib/course/slide/list";
import { resolveElementStyle, verticalAlignCss } from "@/lib/course/slide/styleResolver";
import { findTheme } from "@/lib/course/slide/themes";
import { useEditorStore } from "@/lib/course/store";
import type { SlideElement, SlideListContent, SlideListItem, TextRun } from "@/lib/course/types";
import { plainTextToHtml, runsToHtml, serializeRuns, setActiveRichEditor } from "./richText";

/** Elements that render/edit through the list path: a bullet_list, or a text
 *  box that has had a list toggled inside it. */
type ListEl = Extract<SlideElement, { type: "bullet_list" | "text" }>;

/* ─────────────────────────── shared row geometry ──────────────────────── */

function runStyle(run: TextRun): CSSProperties | undefined {
  const m = run.marks;
  if (!m) return undefined;
  return {
    ...(m.bold !== undefined && { fontWeight: m.bold ? 700 : 400 }),
    ...(m.italic !== undefined && { fontStyle: m.italic ? "italic" : "normal" }),
    ...(m.underline !== undefined && { textDecoration: m.underline ? "underline" : "none" }),
    ...(m.color && { color: m.color }),
  };
}

interface RowStyle {
  marginTop: number;
  indent: number;
  marker: string;
  markerColor: string;
  markerStyle: CSSProperties;
  textColor: string;
  fontSize: number;
  lineHeight: number;
}

function rowStyles(content: SlideListContent, themeId: string, baseColor: string, baseFontSize: number, baseLineHeight: number): RowStyle[] {
  const accent = findTheme(themeId).accentColor;
  const markers = computeMarkers(content);
  return content.items.map((item, i) => {
    const ls = content.levelStyles?.[item.level];
    const kind = effectiveMarkerKind(content, item);
    const numbered = kind === "number" || kind === "alpha" || kind === "roman" || item.markerText !== undefined;
    const prev = content.items[i - 1];
    const marginTop =
      i === 0
        ? 0
        : content.paragraphSpacing !== undefined
          ? content.paragraphSpacing
          : item.level > prev.level
            ? 4
            : item.level === 0
              ? 12
              : 7;
    const fontSize = ls?.fontSize ?? baseFontSize;
    return {
      marginTop,
      indent: item.level * LIST_INDENT_STEP + (ls?.indent ?? 0),
      marker: markers[i],
      markerColor: item.markerColor ?? ls?.markerColor ?? content.markerColor ?? accent,
      markerStyle: {
        fontFamily: numbered ? "var(--font-geist-mono), ui-monospace, monospace" : undefined,
        fontWeight: item.markerText !== undefined ? 700 : numbered ? 600 : 400,
        minWidth: numbered ? `${Math.round(fontSize * 1.7)}px` : `${Math.round(fontSize * 0.9)}px`,
      },
      textColor: item.textColor ?? ls?.textColor ?? content.textColor ?? baseColor,
      fontSize,
      lineHeight: ls?.lineHeight ?? baseLineHeight,
    };
  });
}

/** PURE display (SSR-safe — no hooks). The measurer renders this too. */
export function ListContent({ el, themeId }: { el: ListEl; themeId: string }) {
  const content = listFromElement(el);
  const css = resolveElementStyle(el, themeId);
  const baseColor = (css.color as string) ?? "#000";
  const baseFontSize = (css.fontSize as number) ?? 22;
  const baseLineHeight = (css.lineHeight as number) ?? 1.45;
  const styles = rowStyles(content, themeId, baseColor, baseFontSize, baseLineHeight);

  return (
    <ul style={{ display: "block", fontFamily: css.fontFamily as string }}>
      {content.items.map((item, i) => {
        const r = styles[i];
        return (
          <li key={item.id} style={{ display: "flex", gap: "0.5em", marginTop: r.marginTop, marginLeft: r.indent, fontSize: r.fontSize, lineHeight: r.lineHeight, alignItems: "baseline" }}>
            {r.marker !== "" && (
              <span aria-hidden style={{ flex: "0 0 auto", color: r.markerColor, ...r.markerStyle }}>
                {r.marker}
              </span>
            )}
            <span style={{ minWidth: 0, flex: 1, color: r.textColor, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word" }}>
              {item.runs && item.runs.length > 0
                ? item.runs.map((run, k) => (
                    <span key={k} style={runStyle(run)}>
                      {run.text}
                    </span>
                  ))
                : item.text || "​"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ──────────────────────────────── editor ──────────────────────────────── */

/** Hand-off signal: when a plain text box is toggled INTO a list (from
 *  TextLikeElement), it remounts as a ListElement — this keeps the edit session
 *  alive so the user doesn't have to double-click again. */
let autoEditId: string | null = null;
export function requestListAutoEdit(id: string): void {
  autoEditId = id;
}

function itemHtml(item: SlideListItem): string {
  return item.runs && item.runs.length > 0 ? runsToHtml(item.runs) : plainTextToHtml(item.text);
}

/** Caret offset (char index) of the collapsed selection within `node`. */
function caretOffset(node: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(node);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

function setCaret(node: HTMLElement, caret: "start" | "end" | number): void {
  node.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (caret === "start") {
    range.setStart(node, 0);
  } else if (caret === "end" || caret >= (node.textContent?.length ?? 0)) {
    range.selectNodeContents(node);
    range.collapse(false);
  } else {
    // walk text nodes to the char offset
    let remaining = caret;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let placed = false;
    let t = walker.nextNode() as Text | null;
    while (t) {
      if (remaining <= t.data.length) {
        range.setStart(t, remaining);
        placed = true;
        break;
      }
      remaining -= t.data.length;
      t = walker.nextNode() as Text | null;
    }
    if (!placed) {
      range.selectNodeContents(node);
      range.collapse(false);
    }
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function ListItemRow({
  item,
  rowStyle,
  onKey,
  onCommitText,
  registerRef,
}: {
  item: SlideListItem;
  rowStyle: RowStyle;
  onKey: (e: React.KeyboardEvent<HTMLDivElement>, node: HTMLElement, item: SlideListItem) => void;
  onCommitText: (item: SlideListItem, node: HTMLElement) => void;
  registerRef: (id: string, node: HTMLElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [html] = useState(() => itemHtml(item));

  useEffect(() => {
    const node = ref.current;
    registerRef(item.id, node);
    return () => registerRef(item.id, null);
  }, [item.id, registerRef]);

  return (
    <li style={{ display: "flex", gap: "0.5em", marginTop: rowStyle.marginTop, marginLeft: rowStyle.indent, fontSize: rowStyle.fontSize, lineHeight: rowStyle.lineHeight, alignItems: "baseline" }}>
      {rowStyle.marker !== "" && (
        <span aria-hidden style={{ flex: "0 0 auto", color: rowStyle.markerColor, ...rowStyle.markerStyle }}>
          {rowStyle.marker}
        </span>
      )}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        data-ai-tool="edit-list-item"
        dangerouslySetInnerHTML={{ __html: html }}
        onFocus={() => {
          const node = ref.current;
          if (node) setActiveRichEditor({ exec: (c, v) => { node.focus(); document.execCommand(c, false, v); } });
        }}
        onKeyDown={(e) => ref.current && onKey(e, ref.current, item)}
        onBlur={() => { if (ref.current) onCommitText(item, ref.current); setActiveRichEditor(null); }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ minWidth: 0, flex: 1, color: rowStyle.textColor, whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: "break-word", outline: "none" }}
      />
    </li>
  );
}

export function ListElement({
  el,
  blockId,
  slideId,
  themeId,
  editable,
  soleSelected,
}: {
  el: ListEl;
  blockId: string;
  slideId: string;
  themeId: string;
  editable: boolean;
  soleSelected: boolean;
}) {
  const applyMany = useEditorStore((s) => s.applyMany);
  // Auto-enter edit mode when this element was JUST toggled into a list from a
  // plain text box (consume the one-shot signal in the initializer).
  const [editing, setEditing] = useState(() => {
    if (autoEditId === el.id) {
      autoEditId = null;
      return true;
    }
    return false;
  });
  const [prevSole, setPrevSole] = useState(soleSelected);
  const [rev, setRev] = useState(0);
  const refs = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<{ id: string; caret: "start" | "end" | number } | null>(null);
  const autoFocused = useRef(false);

  // Exit edit mode when this element is no longer the sole selection (adjust
  // state DURING render — avoids a setState-in-effect cascade).
  if (prevSole !== soleSelected) {
    setPrevSole(soleSelected);
    if (!soleSelected) setEditing(false);
  }

  // After a structural op (rev bump), focus the target item + place the caret;
  // on the first auto-edit mount, focus the first item.
  useEffect(() => {
    const pf = pendingFocus.current;
    if (pf) {
      pendingFocus.current = null;
      const node = refs.current.get(pf.id);
      if (node) setCaret(node, pf.caret);
      return;
    }
    if (editing && !autoFocused.current) {
      autoFocused.current = true;
      const first = listFromElement(el).items[0];
      const node = first ? refs.current.get(first.id) : null;
      if (node) setCaret(node, "end");
    }
  }, [rev, editing, el]);

  const css = resolveElementStyle(el, themeId);
  const baseColor = (css.color as string) ?? "#000";
  const baseFontSize = (css.fontSize as number) ?? 22;
  const baseLineHeight = (css.lineHeight as number) ?? 1.45;

  if (!editing) {
    return (
      <div
        style={{ width: "100%", height: "100%", overflow: "hidden", ...css, ...verticalAlignCss(el.style) }}
        onDoubleClick={(e) => {
          if (!editable || !soleSelected) return;
          e.stopPropagation();
          const content = listFromElement(el);
          pendingFocus.current = { id: content.items[0]?.id ?? "", caret: "end" };
          setEditing(true);
        }}
      >
        <ListContent el={el} themeId={themeId} />
      </div>
    );
  }

  const content = listFromElement(el);
  const styles = rowStyles(content, themeId, baseColor, baseFontSize, baseLineHeight);

  function registerRef(id: string, node: HTMLElement | null) {
    if (node) refs.current.set(id, node);
    else refs.current.delete(id);
  }

  /** Capture the live DOM text of one item into the content before an op. */
  function withLiveText(c: SlideListContent, item: SlideListItem, node: HTMLElement): SlideListContent {
    const { text, runs } = serializeRuns(node);
    return setItemText(c, item.id, text, runs);
  }

  /** Measure the list's content height at the element's width (off-canvas), for
   *  grow-on-edit. Self-contained (no measureTextLike import → no cycle). */
  function measureHeight(next: SlideListContent): number {
    const probe = { ...el, list: next, items: flattenToItems(next) } as ListEl;
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
    host.innerHTML = renderToStaticMarkup(
      <div style={{ ...css, width: el.width, height: "auto", overflow: "visible" }}>
        <ListContent el={probe} themeId={themeId} />
      </div>
    );
    document.body.appendChild(host);
    try {
      const box = host.firstElementChild;
      return box instanceof HTMLElement ? Math.min(Math.ceil(box.offsetHeight), SLIDE_H - el.y) : el.height;
    } finally {
      host.remove();
    }
  }

  /** One undoable patch: content + grow-only resize. bullet_list keeps its
   *  `items[]` fallback; a text box keeps `text` (the reducer derives it). */
  function listPatches(next: SlideListContent) {
    const updates = el.type === "bullet_list" ? { list: next, items: flattenToItems(next) } : { list: next };
    return commitElementTextPatches(blockId, slideId, el, updates, measureHeight(next));
  }

  function commit(next: SlideListContent, focus?: { id: string; caret: "start" | "end" | number }) {
    if (focus) pendingFocus.current = focus;
    applyMany(listPatches(next), "human");
    setRev((r) => r + 1);
  }

  function commitEdit(edit: ListEdit) {
    commit(edit.content, edit.focusId ? { id: edit.focusId, caret: edit.caret ?? "end" } : undefined);
  }

  function onCommitText(item: SlideListItem, node: HTMLElement) {
    const { text, runs } = serializeRuns(node);
    const cur = content.items.find((it) => it.id === item.id);
    if (!cur) return;
    const changed = text !== cur.text || JSON.stringify(runs) !== JSON.stringify(cur.runs ?? []);
    if (!changed) return;
    // Text-only commit (no rev bump → no remount; the box grows to fit).
    applyMany(listPatches(setItemText(content, item.id, text, runs)), "human");
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>, node: HTMLElement, item: SlideListItem) {
    const offset = caretOffset(node);
    const live = serializeRuns(node).text;
    const atStart = offset === 0;
    const isEmpty = live.trim().length === 0;
    const marked = effectiveMarkerKind(content, item) !== "none";

    // ⌘/Ctrl+Shift+8 bullets · ⌘/Ctrl+Shift+7 numbered — toggle THIS line's marker.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === "Digit8" || e.code === "Digit7")) {
      e.preventDefault();
      const c = withLiveText(content, item, node);
      commit(toggleItemMarker(c, item.id, e.code === "Digit8" ? "disc" : "number"), { id: item.id, caret: offset });
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const c = withLiveText(content, item, node);
      // Empty bullet → drop the marker (becomes a plain line), like Google Slides.
      if (isEmpty && marked) commit(setItemMarker(c, item.id, "none"), { id: item.id, caret: "start" });
      else commitEdit(splitItem(c, item.id, offset));
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const c = withLiveText(content, item, node);
      commitEdit(e.shiftKey ? outdentItem(c, item.id) : indentItem(c, item.id));
      return;
    }
    if (e.key === "Backspace" && atStart) {
      e.preventDefault();
      const c = withLiveText(content, item, node);
      if (isEmpty && marked) commit(setItemMarker(c, item.id, "none"), { id: item.id, caret: "start" });
      else if (isEmpty && item.level > 0) commitEdit(outdentItem(c, item.id));
      else commitEdit(mergeWithPrev(c, item.id));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      node.blur();
      setEditing(false);
      return;
    }
    // Shift+Enter: let the browser insert a <br> (serialized to "\n").
  }

  function onInput(item: SlideListItem, node: HTMLElement) {
    const { text } = serializeRuns(node);
    const p = detectMarkdownPrefix(text);
    if (p && p.rest === "") {
      commit(applyMarkdownPrefix(content, item.id, p), { id: item.id, caret: "end" });
    }
  }

  return (
    <ul
      style={{ display: "block", width: "100%", height: "100%", overflow: "visible", fontFamily: css.fontFamily as string, outline: "1px solid rgba(167,139,250,0.6)", outlineOffset: 2 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {content.items.map((item, i) => (
        <ListItemRow
          key={`${item.id}-${rev}`}
          item={item}
          rowStyle={styles[i]}
          onKey={(e, node, it) => {
            onKey(e, node, it);
            // markdown detection on space
            if (e.key === " ") setTimeout(() => onInput(it, node), 0);
          }}
          onCommitText={onCommitText}
          registerRef={registerRef}
        />
      ))}
    </ul>
  );
}

