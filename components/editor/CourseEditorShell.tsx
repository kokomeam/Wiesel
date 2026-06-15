"use client";

/**
 * Editor root: compact header + three columns (outline / workspace /
 * inspector), each side panel collapsible to a labeled rail. Focus mode
 * collapses everything for a canvas-dominant view; global shortcuts and the
 * shared image dialog mount here.
 */

import { useEffect } from "react";
import { Eye, Focus, Minimize2, Redo2, Rocket, RotateCcw, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { aiAttrs, toolAttrs } from "@/lib/course/aiAttributes";
import { updateTextPatch } from "@/lib/course/commands";
import { computeCreationFlow } from "@/lib/course/creationFlow";
import { registerLintTextMeasurer } from "@/lib/course/lint";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import { AICommandBar } from "./AICommandBar";
import { CollapsedRail } from "./CollapsedRail";
import { CourseOutlineSidebar } from "./CourseOutlineSidebar";
import { CreationFlowBar } from "./CreationFlowBar";
import { EditableName } from "./EditableName";
import { ModulePage } from "./ModulePage";
import { PlanPage } from "./plan/PlanPage";
import { PublishPanel } from "./plan/PublishPanel";
import { InspectorPanel } from "./InspectorPanel";
import { LessonWorkspace } from "./LessonWorkspace";
import { CanvasContextMenu } from "./slide/CanvasContextMenu";
import { isTextLike, measuredContentHeight } from "./slide/elements/measureTextLike";
import { GlobalImageDialog } from "./slide/ImageUploadDialog";
import { useEditorShortcuts } from "./useEditorShortcuts";

function initials(title: string): string {
  return (
    title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "C"
  );
}

/** Live autosave state, replacing the old static "Updated" date. */
function SaveIndicator({ status }: { status: "idle" | "saving" | "saved" | "error" }) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1 text-stone-400">
        <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
        Saving…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1 text-rose-500">
        <span className="size-1.5 rounded-full bg-rose-500" />
        Couldn’t save — retrying
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-stone-400">
      <span className="size-1.5 rounded-full bg-emerald-400" />
      {status === "idle" ? "Saved to your account" : "All changes saved"}
    </span>
  );
}

export function CourseEditorShell() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const undoCount = useEditorStore((s) => s.undoStack.length);
  const redoCount = useEditorStore((s) => s.redoStack.length);
  const editCount = useEditorStore((s) => s.patchLog.length);
  const saveStatus = useEditorStore((s) => s.saveStatus);

  const flow = computeCreationFlow(doc);

  const collapsed = useUIStore((s) => s.collapsed);
  const focusMode = useUIStore((s) => s.focusMode);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const enterFocusMode = useUIStore((s) => s.enterFocusMode);
  const exitFocusMode = useUIStore((s) => s.exitFocusMode);
  const resetLayout = useUIStore((s) => s.resetLayout);
  const activeStep = useUIStore((s) => s.activeStep);
  const setActiveStep = useUIStore((s) => s.setActiveStep);

  // Default landing: a brand-new (contentless) course opens on Plan; a course
  // that already has content opens on Create. Explicit stepper clicks override.
  const courseIsEmpty = doc.modules.every((m) =>
    m.lessons.every((l) => l.blocks.length === 0)
  );
  const effectiveStep = activeStep ?? (courseIsEmpty ? "plan" : "create");
  const showFlowBar = !(effectiveStep === "create" && focusMode);

  useEditorShortcuts();

  // Lint's TEXT_CLIPPED check needs DOM measurement — register the real
  // measurer once the editor is on screen (lint itself stays UI-free).
  useEffect(() => {
    registerLintTextMeasurer((el, themeId) =>
      isTextLike(el) ? measuredContentHeight(el, themeId) : null
    );
  }, []);

  return (
    <div
      {...aiAttrs({
        component: "course-editor",
        type: "course",
        id: doc.id,
        purpose: doc.description,
        label: `Course editor: ${doc.title}`,
      })}
      className="flex h-full flex-col"
    >
      {/* Header strip */}
      <div className="flex items-center gap-4 border-b border-stone-200 bg-white px-6 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg brand-gradient text-[11px] font-bold text-white">
            {initials(doc.title)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="min-w-0 max-w-72">
                <EditableName
                  value={doc.title}
                  aria-label="Course title"
                  placeholder="Course title"
                  onCommit={(v) =>
                    apply(updateTextPatch({ kind: "course", field: "title" }, v), "human")
                  }
                  className="text-sm font-semibold text-stone-900"
                />
              </div>
              <Badge tone="amber" dot>
                Draft
              </Badge>
            </div>
            <p className="flex items-center gap-1.5 truncate text-xs text-stone-400">
              {doc.level && <span className="capitalize">{doc.level} ·</span>}
              <SaveIndicator status={saveStatus} />
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {editCount > 0 && (
            <span className="hidden text-xs text-stone-400 sm:block">
              {editCount} edit{editCount === 1 ? "" : "s"}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={undo} disabled={undoCount === 0}>
            <Undo2 className="size-3.5" />
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={redo}
            disabled={redoCount === 0}
            aria-label="Redo"
            className="px-2"
          >
            <Redo2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={focusMode ? exitFocusMode : enterFocusMode}
            className="px-2"
            title={focusMode ? "Exit focus mode" : "Focus mode — hide side panels"}
            {...toolAttrs({
              tool: "toggle-focus-mode",
              action: "TOGGLE_FOCUS_MODE",
              targetType: "panel",
              label: focusMode ? "Exit focus mode" : "Enter focus mode",
            })}
          >
            <Focus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetLayout}
            className="px-2"
            title="Reset panel layout"
            {...toolAttrs({
              tool: "reset-layout",
              action: "RESET_LAYOUT",
              targetType: "panel",
              label: "Reset the panel layout to defaults",
            })}
          >
            <RotateCcw className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm">
            <Eye className="size-3.5" />
            Preview
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!flow.readyToPublish}
            title={
              flow.readyToPublish
                ? "Publish your course"
                : "Add a course title and at least one lesson with content to publish"
            }
          >
            <Rocket className="size-3.5" />
            Publish
          </Button>
        </div>
      </div>

      {showFlowBar && (
        <CreationFlowBar
          flow={flow}
          activeStep={effectiveStep}
          onStepClick={setActiveStep}
        />
      )}

      {/* Create = the three-column curriculum editor; Plan & Publish swap in. */}
      {effectiveStep === "plan" ? (
        <PlanPage />
      ) : effectiveStep === "publish" ? (
        <PublishPanel />
      ) : (
      <div className="flex min-h-0 flex-1">
        <div className="hidden md:flex">
          {collapsed.outline ? (
            <CollapsedRail
              label="Outline"
              side="left"
              onExpand={() => togglePanel("outline")}
            />
          ) : (
            <CourseOutlineSidebar />
          )}
        </div>

        <div className="relative flex min-w-0 flex-1 flex-col">
          {selection.kind === "module" ? (
            <ModulePage moduleId={selection.id} />
          ) : (
            <LessonWorkspace />
          )}
          <AICommandBar />
          {focusMode && (
            <button
              type="button"
              {...toolAttrs({
                tool: "exit-focus-mode",
                action: "TOGGLE_FOCUS_MODE",
                targetType: "panel",
                label: "Exit focus mode and restore panels",
              })}
              onClick={exitFocusMode}
              className="absolute right-4 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-stone-200/80 bg-white/95 px-3 py-1.5 text-xs font-medium text-stone-600 shadow-[0_4px_14px_rgba(16,24,40,0.1)] backdrop-blur transition-colors hover:text-stone-900"
            >
              <Minimize2 className="size-3.5" />
              Exit focus
            </button>
          )}
        </div>

        <div className="hidden xl:flex">
          {collapsed.inspector ? (
            <CollapsedRail
              label="Inspector"
              side="right"
              onExpand={() => togglePanel("inspector")}
            />
          ) : (
            <InspectorPanel />
          )}
        </div>
      </div>
      )}

      <GlobalImageDialog />
      <CanvasContextMenu />
    </div>
  );
}
