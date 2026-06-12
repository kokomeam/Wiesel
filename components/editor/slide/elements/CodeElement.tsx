"use client";

/**
 * Code block element: dark well, mono, double-click to edit (own draft —
 * the light textarea overlay would fight the dark background).
 */

import { useEffect, useRef, useState } from "react";
import { updateElementPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { SlideElement } from "@/lib/course/types";

type CodeEl = Extract<SlideElement, { type: "code_block" }>;

export function CodeElement({
  el,
  blockId,
  slideId,
  editable,
}: {
  el: CodeEl;
  blockId: string;
  slideId: string;
  editable: boolean;
}) {
  const apply = useEditorStore((s) => s.apply);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const editing = draft !== null;
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  const fontSize = el.style.fontSize ?? 18;
  const radius = el.style.borderRadius ?? 14;
  const bg = el.style.backgroundColor ?? "#18181b";

  const shell: React.CSSProperties = {
    width: "100%",
    height: "100%",
    backgroundColor: bg,
    borderRadius: radius,
    padding: el.style.padding ?? 20,
    fontSize,
    lineHeight: el.style.lineHeight ?? 1.55,
    color: el.style.color ?? "#e4e4e7",
    overflow: "hidden",
    opacity: el.style.opacity,
  };

  if (editing) {
    return (
      <textarea
        ref={taRef}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!cancelled.current && draft !== el.code) {
            apply(updateElementPatch(blockId, slideId, el.id, { code: draft }), "human");
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Edit code"
        style={{ ...shell, resize: "none", outline: "2px solid #a78bfa", outlineOffset: -2 }}
        className="m-0 block border-0 font-mono"
      />
    );
  }

  return (
    <div
      style={shell}
      className="relative font-mono"
      onDoubleClick={(e) => {
        if (!editable) return;
        e.stopPropagation();
        cancelled.current = false;
        setDraft(el.code);
      }}
    >
      <span
        className="absolute right-3 top-2 text-[10px] uppercase tracking-wide"
        style={{ color: "#71717a" }}
      >
        {el.language}
      </span>
      <pre className="overflow-hidden whitespace-pre-wrap">{el.code}</pre>
    </div>
  );
}
