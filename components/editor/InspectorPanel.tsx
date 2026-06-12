"use client";

/**
 * Right column: human-first inspector with Design / Content / AI / Metadata
 * tabs (default Design — AI metadata is there when you want it, never in the
 * way). Collapsible to a slim rail; state lives in the uiStore.
 */

import { PanelRightClose } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { updateTextPatch } from "@/lib/course/commands";
import { resolveSelection } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore, type InspectorTab } from "@/lib/editor/uiStore";
import { AIActionMenu } from "./AIActionMenu";
import { InlineText } from "./InlineText";
import { ContentTab } from "./inspector/ContentTab";
import { DesignTab } from "./inspector/DesignTab";
import { MetadataTab } from "./inspector/MetadataTab";

const TABS: { key: InspectorTab; label: string }[] = [
  { key: "design", label: "Design" },
  { key: "content", label: "Content" },
  { key: "ai", label: "AI" },
  { key: "metadata", label: "Meta" },
];

export function InspectorPanel() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);
  const tab = useUIStore((s) => s.inspectorTab);
  const setTab = useUIStore((s) => s.setInspectorTab);
  const togglePanel = useUIStore((s) => s.togglePanel);

  const resolved = resolveSelection(doc, selection);

  function commitTitle(value: string) {
    if (selection.kind === "course")
      apply(updateTextPatch({ kind: "course", field: "title" }, value), "human");
    else if (selection.kind === "module")
      apply(updateTextPatch({ kind: "module", id: selection.id, field: "title" }, value), "human");
    else if (selection.kind === "lesson")
      apply(updateTextPatch({ kind: "lesson", id: selection.id, field: "title" }, value), "human");
    else if (selection.kind === "block")
      apply({ action: "UPDATE_BLOCK_TITLE", blockId: selection.id, title: value }, "human");
    else if (selection.kind === "slide")
      apply(
        updateTextPatch(
          { kind: "slide", blockId: selection.blockId, slideId: selection.id, field: "title" },
          value
        ),
        "human"
      );
  }

  const titleEditable = selection.kind !== "element";

  return (
    <aside
      aria-label="Inspector"
      data-ai-component="inspector-panel"
      className="flex w-80 shrink-0 flex-col border-l border-stone-200 bg-white"
    >
      {resolved ? (
        <>
          <div className="border-b border-stone-100 px-5 pb-3 pt-4">
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="brand">{resolved.typeName.replace(/_/g, " ")}</Badge>
              <button
                type="button"
                {...toolAttrs({
                  tool: "collapse-inspector",
                  action: "TOGGLE_PANEL",
                  targetType: "panel",
                  label: "Collapse the inspector panel",
                })}
                onClick={() => togglePanel("inspector")}
                className="ml-auto grid size-6 place-items-center rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                <PanelRightClose className="size-3.5" />
              </button>
            </div>
            {titleEditable ? (
              <InlineText
                value={resolved.title}
                aria-label={`${resolved.typeName} title`}
                placeholder="Untitled"
                onCommit={commitTitle}
                className="text-sm font-semibold text-stone-900"
              />
            ) : (
              <p className="text-sm font-semibold capitalize text-stone-900">
                {resolved.title}
              </p>
            )}

            <div
              role="tablist"
              aria-label="Inspector sections"
              className="mt-3 flex gap-0.5 rounded-lg bg-stone-100/80 p-0.5"
            >
              {TABS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  {...toolAttrs({
                    tool: `inspector-tab-${key}`,
                    action: "SET_INSPECTOR_TAB",
                    targetType: "panel",
                    label: `Show inspector ${label} tab`,
                  })}
                  onClick={() => setTab(key)}
                  className={cn(
                    "flex-1 rounded-md py-1 text-xs font-medium transition-colors",
                    tab === key
                      ? "bg-white text-stone-900 shadow-sm"
                      : "text-stone-500 hover:text-stone-800"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
            {tab === "design" && (
              <DesignTab selection={selection} node={resolved.node} />
            )}
            {tab === "content" && (
              <ContentTab
                selection={selection}
                node={resolved.node}
                typeName={resolved.typeName}
              />
            )}
            {tab === "ai" && <AIActionMenu />}
            {tab === "metadata" && <MetadataTab resolved={resolved} />}
          </div>
        </>
      ) : (
        <div className="px-5 py-6 text-xs text-stone-400">Nothing selected.</div>
      )}
    </aside>
  );
}
