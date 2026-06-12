"use client";

/**
 * Rich-text plumbing for the contenteditable overlay (no editor deps):
 *
 *  - runsToHtml / serializeRuns convert between the document's TextRun[]
 *    model and the editable's DOM. Serialization normalizes whatever the
 *    browser produces (b/strong/i/em/u, font-weight styles, <font color>,
 *    div/br line breaks) back into flat runs with merged neighbors, so the
 *    stored model stays canonical regardless of execCommand quirks.
 *  - A tiny active-editor registry lets the toolbar route Bold/Italic/
 *    Underline/color to the LIVE SELECTION while a text edit session is
 *    open (instead of restyling the whole element).
 */

import type { TextMarks, TextRun } from "@/lib/course/types";

/* ───────────────────────── active editor registry ─────────────────────── */

export interface RichEditHandle {
  /** Apply a formatting command to the current selection. */
  exec: (command: "bold" | "italic" | "underline" | "foreColor", value?: string) => void;
}

let active: RichEditHandle | null = null;
export function setActiveRichEditor(handle: RichEditHandle | null): void {
  active = handle;
}
export function getActiveRichEditor(): RichEditHandle | null {
  return active;
}

/* ─────────────────────────── runs → editable DOM ──────────────────────── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markStyle(marks: TextMarks | undefined): string {
  if (!marks) return "";
  const css: string[] = [];
  // tri-state: true forces on, false forces OFF (un-bolding a selection
  // inside a semibold heading), undefined inherits the element style
  if (marks.bold !== undefined) css.push(`font-weight:${marks.bold ? 700 : 400}`);
  if (marks.italic !== undefined) css.push(`font-style:${marks.italic ? "italic" : "normal"}`);
  if (marks.underline !== undefined)
    css.push(`text-decoration:${marks.underline ? "underline" : "none"}`);
  if (marks.color) css.push(`color:${marks.color}`);
  return css.join(";");
}

export function runsToHtml(runs: TextRun[]): string {
  return runs
    .map((run) => {
      const style = markStyle(run.marks);
      const text = escapeHtml(run.text).replace(/\n/g, "<br>");
      return style ? `<span style="${style}">${text}</span>` : text;
    })
    .join("");
}

export function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/* ─────────────────────────── editable DOM → runs ──────────────────────── */

function rgbToHex(color: string): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return color;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function sameMarks(a: TextMarks | undefined, b: TextMarks | undefined): boolean {
  return (
    (a?.bold ?? null) === (b?.bold ?? null) &&
    (a?.italic ?? null) === (b?.italic ?? null) &&
    (a?.underline ?? null) === (b?.underline ?? null) &&
    (a?.color ?? null) === (b?.color ?? null)
  );
}

function pruneMarks(m: TextMarks): TextMarks | undefined {
  const out: TextMarks = {};
  if (m.bold !== undefined) out.bold = m.bold;
  if (m.italic !== undefined) out.italic = m.italic;
  if (m.underline !== undefined) out.underline = m.underline;
  if (m.color) out.color = m.color;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function serializeRuns(root: HTMLElement): { text: string; runs: TextRun[] } {
  const out: TextRun[] = [];
  const push = (text: string, marks: TextMarks) => {
    if (!text) return;
    const pruned = pruneMarks(marks);
    const last = out[out.length - 1];
    if (last && sameMarks(last.marks, pruned)) last.text += text;
    else out.push(pruned ? { text, marks: pruned } : { text });
  };

  const walk = (node: Node, marks: TextMarks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      push((node as Text).data, marks);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      push("\n", marks);
      return;
    }
    const m: TextMarks = { ...marks };
    if (tag === "B" || tag === "STRONG") m.bold = true;
    if (tag === "I" || tag === "EM") m.italic = true;
    if (tag === "U") m.underline = true;
    if (tag === "FONT") {
      const c = node.getAttribute("color");
      if (c) m.color = rgbToHex(c);
    }
    const st = node.style;
    if (st.fontWeight) {
      const w = st.fontWeight;
      m.bold = w === "bold" || Number(w) >= 600;
    }
    if (st.fontStyle) m.italic = st.fontStyle === "italic";
    if (st.textDecoration || st.textDecorationLine) {
      m.underline = (st.textDecoration + st.textDecorationLine).includes("underline");
    }
    if (st.color) m.color = rgbToHex(st.color);

    // block elements (div/p from Enter presses) start a new line
    const isBlock = tag === "DIV" || tag === "P";
    if (isBlock && out.length > 0 && !out[out.length - 1].text.endsWith("\n")) {
      push("\n", marks);
    }
    node.childNodes.forEach((child) => walk(child, m));
  };

  root.childNodes.forEach((child) => walk(child, {}));
  // drop a single trailing newline (contenteditable often appends one)
  const last = out[out.length - 1];
  if (last && last.text.endsWith("\n")) {
    last.text = last.text.replace(/\n$/, "");
    if (!last.text) out.pop();
  }
  return { text: out.map((r) => r.text).join(""), runs: out };
}
