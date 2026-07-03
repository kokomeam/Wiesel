"use client";

/**
 * Renders text, heading, callout, and bullet_list elements.
 *
 * Editing:
 *  - text/heading/callout double-click into a CONTENTEDITABLE overlay with
 *    character-level formatting (runs model; B/I/U/color apply to the live
 *    selection via the toolbar or ⌘B/⌘I/⌘U). Commit on blur serializes the
 *    DOM back to runs — ONE undo step for text + formatting + auto-grow.
 *  - bullet_list keeps the plain one-item-per-line textarea (per-item runs
 *    are a known cut).
 *
 * Auto-grow is grow-only (user policy: the box reformats, text never
 * shrinks): a hidden twin measures plain drafts; the rich overlay grows on
 * its own scrollHeight.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { commitElementTextPatches } from "@/lib/course/commands";
import { SLIDE_H } from "@/lib/course/slide/geometry";
import { textToList } from "@/lib/course/slide/list";
import { resolveElementStyle, verticalAlignCss } from "@/lib/course/slide/styleResolver";
import { findTheme } from "@/lib/course/slide/themes";
import { useEditorStore } from "@/lib/course/store";
import type { CalloutVariant, ListMarkerKind, SlideElement, TextRun } from "@/lib/course/types";
import { requestListAutoEdit } from "./ListElementView";
import {
  plainTextToHtml,
  runsToHtml,
  serializeRuns,
  setActiveRichEditor,
} from "./richText";

export type TextLike = Extract<
  SlideElement,
  { type: "text" | "heading" | "callout" | "bullet_list" }
>;

type RichTextLike = Extract<SlideElement, { type: "text" | "heading" | "callout" }>;

const calloutColors: Record<CalloutVariant, { bg: string; border: string; label: string }> = {
  info: { bg: "#eff6ff", border: "#3b82f6", label: "Info" },
  tip: { bg: "#ecfdf5", border: "#10b981", label: "Tip" },
  warning: { bg: "#fffbeb", border: "#f59e0b", label: "Warning" },
  definition: { bg: "#f5f3ff", border: "#7c3aed", label: "Definition" },
  important: { bg: "#fff1f2", border: "#f43f5e", label: "Important" },
};

export function textLikeValue(el: TextLike): string {
  return el.type === "bullet_list" ? el.items.join("\n") : el.text;
}

/** The element's effective box CSS (shared by display, editor, measurer). */
export function textLikeBoxStyle(el: TextLike, themeId: string): CSSProperties {
  const css = resolveElementStyle(el, themeId);
  const calloutTone = el.type === "callout" ? calloutColors[el.variant] : null;
  return {
    ...css,
    ...verticalAlignCss(el.style),
    width: "100%",
    height: "100%",
    overflow: "hidden",
    ...(calloutTone && {
      backgroundColor: el.style.backgroundColor ?? calloutTone.bg,
      borderLeft: `4px solid ${el.style.borderColor ?? calloutTone.border}`,
      borderRadius: el.style.borderRadius ?? 14,
      padding: el.style.padding ?? 18,
    }),
  };
}

function runStyle(run: TextRun): CSSProperties | undefined {
  const m = run.marks;
  if (!m) return undefined;
  return {
    // tri-state: false explicitly REMOVES the element-level weight/slant
    ...(m.bold !== undefined && { fontWeight: m.bold ? 700 : 400 }),
    ...(m.italic !== undefined && { fontStyle: m.italic ? "italic" : "normal" }),
    ...(m.underline !== undefined && {
      textDecoration: m.underline ? "underline" : "none",
    }),
    ...(m.color && { color: m.color }),
  };
}

/**
 * The display markup, extracted so the auto-grow measurer renders the EXACT
 * same thing (callout label row, bullet gaps/markers, rich runs) as the
 * canvas. `value` overrides the stored content (plain drafts during
 * editing); without it, rich runs render with their marks.
 */
export function TextLikeContent({
  el,
  themeId,
  value,
}: {
  el: TextLike;
  themeId: string;
  value?: string;
}) {
  const calloutTone = el.type === "callout" ? calloutColors[el.variant] : null;
  const runs =
    value === undefined && el.type !== "bullet_list" ? el.runs : undefined;
  const v = value ?? textLikeValue(el);
  const items =
    el.type === "bullet_list"
      ? v.split("\n").filter((line) => line.trim().length > 0)
      : [];
  return (
    <>
      {calloutTone && (
        <p
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            color: calloutTone.border,
            marginBottom: 6,
          }}
        >
          {calloutTone.label}
        </p>
      )}
      {el.type === "bullet_list" ? (
        <ul style={{ display: "flex", flexDirection: "column", gap: "0.45em" }}>
          {items.map((item, i) => (
            <li key={i} style={{ display: "flex", gap: "0.55em", alignItems: "baseline" }}>
              <span
                aria-hidden
                style={{
                  width: "0.32em",
                  height: "0.32em",
                  minWidth: "0.32em",
                  borderRadius: "50%",
                  backgroundColor: findTheme(themeId).accentColor,
                  transform: "translateY(-0.08em)",
                }}
              />
              <span style={{ minWidth: 0 }}>{item}</span>
            </li>
          ))}
        </ul>
      ) : runs && runs.length > 0 ? (
        <span style={{ whiteSpace: "pre-wrap" }}>
          {runs.map((run, i) => (
            <span key={i} style={runStyle(run)}>
              {run.text}
            </span>
          ))}
        </span>
      ) : (
        <span style={{ whiteSpace: "pre-wrap" }}>
          {v || <span style={{ opacity: 0.35 }}>Double-click to edit</span>}
        </span>
      )}
    </>
  );
}

/** Which line indices the current selection covers within `node` (collapsed
 *  cursor → its single line). Used to bullet only the selected paragraph(s). */
function selectionLineRange(node: HTMLElement, text: string): Set<number> {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (const ln of lines) {
    starts.push(acc);
    acc += ln.length + 1;
  }
  let startOff = 0;
  let endOff = text.length;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    const a = r.cloneRange();
    a.selectNodeContents(node);
    a.setEnd(r.startContainer, r.startOffset);
    startOff = a.toString().length;
    const b = r.cloneRange();
    b.selectNodeContents(node);
    b.setEnd(r.endContainer, r.endOffset);
    endOff = b.toString().length;
  }
  const set = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const ls = starts[i];
    const le = ls + lines[i].length;
    if (startOff <= le && endOff >= ls) set.add(i);
  }
  if (set.size === 0) set.add(0);
  return set;
}

export function TextLikeElement({
  el,
  blockId,
  slideId,
  themeId,
  editable,
  soleSelected = true,
}: {
  el: TextLike;
  blockId: string;
  slideId: string;
  themeId: string;
  editable: boolean;
  /** Text editing only opens when this element is the sole selection —
   *  double-click on a grouped/multi-selected member enters the group. */
  soleSelected?: boolean;
}) {
  const applyMany = useEditorStore((s) => s.applyMany);
  const isBullets = el.type === "bullet_list";

  /* ── plain textarea path (bullet lists) ── */
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  /* ── rich contenteditable path (text / heading / callout) ──
     state holds the session's INITIAL html (null = not editing) so render
     never reads a ref */
  const [richHtml, setRichHtml] = useState<string | null>(null);
  const richOpen = richHtml !== null;
  const richRef = useRef<HTMLDivElement>(null);

  const editing = draft !== null;
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  // Auto-grow (textarea path): measure the hidden twin per keystroke and
  // grow the overlay live. Direct DOM write — transient, committed on blur.
  useLayoutEffect(() => {
    if (!editing) return;
    const m = measureRef.current;
    const ta = taRef.current;
    if (!m || !ta) return;
    const measured = Math.ceil(m.offsetHeight);
    ta.style.height =
      measured > el.height ? `${Math.min(measured, SLIDE_H - el.y)}px` : "100%";
  }, [editing, draft, el.height, el.y]);

  // Rich session: focus, caret at end, register as the toolbar's target.
  useEffect(() => {
    if (!richOpen) return;
    const node = richRef.current;
    if (!node) return;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const grow = () => {
      const measured = Math.ceil(node.scrollHeight);
      node.style.height =
        measured > node.clientHeight ? `${measured}px` : node.style.height;
    };
    setActiveRichEditor({
      exec: (command, value) => {
        node.focus();
        document.execCommand(command, false, value);
        grow();
      },
    });
    return () => setActiveRichEditor(null);
  }, [richOpen]);

  const isCallout = el.type === "callout";
  const value = textLikeValue(el);
  const boxStyle = textLikeBoxStyle(el, themeId);

  function commitBullets() {
    if (!cancelled.current && draft !== null && draft !== value) {
      applyMany(
        commitElementTextPatches(
          blockId,
          slideId,
          el,
          { items: draft.split("\n").filter((line) => line.trim().length > 0) },
          measureRef.current?.offsetHeight
        ),
        "human"
      );
    }
    setDraft(null);
  }

  function commitRich() {
    const node = richRef.current;
    if (!cancelled.current && node && el.type !== "bullet_list") {
      const { text, runs } = serializeRuns(node);
      const rich = el as RichTextLike;
      const changed =
        text !== rich.text ||
        JSON.stringify(runs) !== JSON.stringify(rich.runs ?? []);
      if (changed) {
        const hasMarks = runs.some((r) => r.marks);
        applyMany(
          commitElementTextPatches(
            blockId,
            slideId,
            el,
            hasMarks ? { runs } : { text },
            Math.ceil(node.scrollHeight)
          ),
          "human"
        );
      }
    }
    setRichHtml(null);
  }

  /** ⌘/Ctrl+Shift+8 / +7: toggle the selected line(s) of a plain TEXT box into a
   *  bullet / numbered list. Converts the box to the list model (it remounts as a
   *  ListElement, which keeps editing alive via requestListAutoEdit). */
  function toggleListInText(kind: ListMarkerKind) {
    const node = richRef.current;
    if (!node || el.type !== "text") return;
    cancelled.current = true; // suppress commitRich on the blur that follows
    const { text, runs } = serializeRuns(node);
    const content = textToList(text, runs, selectionLineRange(node, text), kind);
    requestListAutoEdit(el.id);
    applyMany(commitElementTextPatches(blockId, slideId, el, { list: content }), "human");
  }

  function openEditor(e: React.MouseEvent) {
    if (!editable || !soleSelected) return;
    e.stopPropagation();
    cancelled.current = false;
    if (isBullets) {
      setDraft(value);
      return;
    }
    const rich = el as RichTextLike;
    setRichHtml(
      rich.runs && rich.runs.length > 0
        ? runsToHtml(rich.runs)
        : plainTextToHtml(rich.text)
    );
  }

  if (editing && isBullets) {
    return (
      <>
        <textarea
          ref={taRef}
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitBullets}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Edit bullet list"
          style={{
            ...boxStyle,
            display: "block",
            resize: "none",
            outline: "2px solid #a78bfa",
            outlineOffset: -2,
            background: "rgba(255,255,255,0.6)",
          }}
          className="m-0 border-0"
        />
        {/* hidden twin: same markup + box style, height auto, for measuring */}
        <div
          ref={measureRef}
          aria-hidden
          style={{
            ...boxStyle,
            position: "absolute",
            left: 0,
            top: 0,
            height: "auto",
            visibility: "hidden",
            pointerEvents: "none",
          }}
        >
          <TextLikeContent el={el} themeId={themeId} value={draft ?? ""} />
        </div>
      </>
    );
  }

  if (richOpen && !isBullets) {
    return (
      <div
        ref={richRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={`Edit ${el.type.replace("_", " ")}`}
        dangerouslySetInnerHTML={{ __html: richHtml ?? "" }}
        onBlur={commitRich}
        onInput={() => {
          const node = richRef.current;
          if (!node) return;
          const measured = Math.ceil(node.scrollHeight);
          if (measured > el.height) {
            node.style.height = `${Math.min(measured, SLIDE_H - el.y)}px`;
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const mod = e.metaKey || e.ctrlKey;
          if (mod && (e.key === "b" || e.key === "B")) {
            e.preventDefault();
            document.execCommand("bold");
          } else if (mod && (e.key === "i" || e.key === "I")) {
            e.preventDefault();
            document.execCommand("italic");
          } else if (mod && (e.key === "u" || e.key === "U")) {
            e.preventDefault();
            document.execCommand("underline");
          } else if (mod && e.shiftKey && el.type === "text" && (e.code === "Digit8" || e.code === "Digit7")) {
            e.preventDefault();
            toggleListInText(e.code === "Digit8" ? "disc" : "number");
          } else if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          ...boxStyle,
          display: "block", // flex (vertical-align) breaks inline editing
          whiteSpace: "pre-wrap",
          outline: "2px solid #a78bfa",
          outlineOffset: -2,
          background: isCallout ? boxStyle.backgroundColor : "rgba(255,255,255,0.6)",
        }}
      />
    );
  }

  return (
    <div style={boxStyle} onDoubleClick={openEditor}>
      <TextLikeContent el={el} themeId={themeId} />
    </div>
  );
}
