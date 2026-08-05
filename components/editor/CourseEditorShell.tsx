"use client";

/**
 * Editor root: compact header + three columns (outline / workspace /
 * inspector), each side panel collapsible to a labeled rail. Focus mode
 * collapses everything for a canvas-dominant view; global shortcuts and the
 * shared image dialog mount here.
 */

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  BarChart3,
  Eye,
  Focus,
  GraduationCap,
  Loader2,
  Minimize2,
  Redo2,
  Rocket,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { aiAttrs, toolAttrs } from "@/lib/course/aiAttributes";
import { updateTextPatch } from "@/lib/course/commands";
import { computeCreationFlow } from "@/lib/course/creationFlow";
import { registerLintTextMeasurer } from "@/lib/course/lint";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";
import { useUIStore } from "@/lib/editor/uiStore";
import { AICommandBar } from "./AICommandBar";
import { AgentConfirmHost } from "./agent/AgentConfirmHost";
import { AgentFlashToast } from "./agent/AgentFlashToast";
import { CollapsedRail } from "./CollapsedRail";
import { CourseOutlineSidebar } from "./CourseOutlineSidebar";
import { CoursePage } from "./CoursePage";
import { CreationFlowBar } from "./CreationFlowBar";
import { EditableName } from "./EditableName";
import { ModulePage } from "./ModulePage";
import { PlanPage } from "./plan/PlanPage";
import { InspectorPanel } from "./InspectorPanel";
import { LessonWorkspace } from "./LessonWorkspace";
import { CanvasContextMenu } from "./slide/CanvasContextMenu";
import { isTextLike, measuredContentHeight } from "./slide/elements/measureTextLike";
import { useEditorShortcuts } from "./useEditorShortcuts";

/* ── Modal/panel-gated subsystems load on demand (PERF-1 D — studio split). ──
 * Each is a separate chunk the main studio bundle never pays for:
 *  - PublishPanel: whole publish pipeline (preflight/hash/snapshot/diff) —
 *    only when the Publish step opens.
 *  - AgentPanel: the docked chat (pulls comms DraftList/MessageComposer) —
 *    gated below on "has ever been open" so a collapse never unmounts a
 *    loaded panel (transcript + in-flight stream survive re-opens).
 *  - GlobalImageDialog: only when an image-upload request opens it.
 *  - AgentPlanHost: the plan-review modal — the ONLY framer-motion importer
 *    on the studio route; loads on the first pending plan. Its always-on
 *    companion (AgentFlashToast) is framer-free and mounted statically here.
 * The shell itself renders behind StudioLoader's effect gate (never in SSR
 * HTML), so no `ssr:` option is needed. */
const PublishPanel = dynamic(
  () => import("./plan/PublishPanel").then((m) => m.PublishPanel),
  {
    loading: () => (
      <div className="flex flex-1 items-center justify-center py-24">
        <Loader2 className="size-5 animate-spin text-stone-400" aria-label="Loading the publish step" />
      </div>
    ),
  }
);
const AgentPanel = dynamic(() => import("./agent/AgentPanel").then((m) => m.AgentPanel), {
  // Rail-shaped placeholder so the layout doesn't jump on first open.
  loading: () => (
    <aside
      aria-label="AI Content Agent"
      className="flex w-[360px] shrink-0 items-center justify-center border-l border-stone-200 bg-white"
    >
      <Loader2 className="size-5 animate-spin text-stone-300" aria-label="Loading the agent panel" />
    </aside>
  ),
});
const GlobalImageDialog = dynamic(
  () => import("./slide/ImageUploadDialog").then((m) => m.GlobalImageDialog),
  {
    loading: () => (
      <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-6" role="presentation">
        <Loader2 className="size-5 animate-spin text-white" aria-label="Loading the image picker" />
      </div>
    ),
  }
);
const AgentPlanHost = dynamic(() => import("./agent/AgentPlanHost").then((m) => m.AgentPlanHost));

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
  const courseId = useEditorStore((s) => s.courseId);
  const openFindings = useAgentStore((s) => s.openFindings);
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
  const imageDialogOpen = useUIStore((s) => s.imageDialog !== null);
  const hasPendingOutline = useAgentStore((s) => s.pendingOutline !== null);

  // "Has ever been opened" latches (render-phase derived state, the repo's
  // standard pattern) for the lazy subsystems. The agent panel keys off the
  // uiStore collapse state itself, so EVERY open path — rail click, focus-mode
  // exit, layout reset, a keyboard shortcut — triggers the first chunk load;
  // once loaded it stays mounted (hidden while collapsed) so the transcript
  // and any in-flight run survive collapse/expand. The plan host stays mounted
  // after the first plan so reopen + exit animations keep working.
  const agentPanelOpen = !collapsed.agentPanel;
  const [agentPanelLoaded, setAgentPanelLoaded] = useState(agentPanelOpen);
  if (agentPanelOpen && !agentPanelLoaded) setAgentPanelLoaded(true);
  const [planHostLoaded, setPlanHostLoaded] = useState(hasPendingOutline);
  if (hasPendingOutline && !planHostLoaded) setPlanHostLoaded(true);
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
              {openFindings > 0 && (
                <span
                  title={`${openFindings} issue${openFindings === 1 ? "" : "s"} flagged by learner data — open the AI panel to review`}
                  className="cursor-default"
                >
                  <Badge tone="rose" dot>
                    {openFindings} finding{openFindings === 1 ? "" : "s"}
                  </Badge>
                </span>
              )}
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
          {courseId ? (
            <Link
              href={`/studio/${courseId}/analytics`}
              title="Learner analytics for this course"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50"
              {...toolAttrs({
                tool: "open-analytics",
                action: "OPEN_ANALYTICS",
                targetType: "panel",
                label: "Open learner analytics for this course",
              })}
            >
              <BarChart3 className="size-3.5 text-stone-400" />
              Analytics
            </Link>
          ) : null}
          {courseId ? (
            <Link
              href={`/studio/${courseId}/tutor`}
              title="AI tutor for this course"
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50"
              {...toolAttrs({
                tool: "open-tutor",
                action: "OPEN_TUTOR",
                targetType: "panel",
                label: "Open the AI tutor console for this course",
              })}
            >
              <GraduationCap className="size-3.5 text-stone-400" />
              Tutor
            </Link>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!flow.readyToPublish}
            title={
              flow.readyToPublish
                ? "Review and publish your course"
                : "Add a course title and at least one lesson with content to publish"
            }
            onClick={() => setActiveStep("publish")}
            {...toolAttrs({
              tool: "open-publish",
              action: "OPEN_PUBLISH_STEP",
              targetType: "panel",
              label: "Open the publish step",
            })}
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
          ) : selection.kind === "course" ? (
            <CoursePage />
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

        <div className="hidden lg:flex">
          {collapsed.agentPanel && (
            <CollapsedRail
              label="AI Agent"
              side="right"
              onExpand={() => togglePanel("agentPanel")}
            />
          )}
          {agentPanelLoaded && (
            <div className={collapsed.agentPanel ? "hidden" : "flex min-h-0"}>
              <AgentPanel />
            </div>
          )}
        </div>
      </div>
      )}

      {imageDialogOpen && <GlobalImageDialog />}
      <CanvasContextMenu />
      <AgentConfirmHost />
      {planHostLoaded && <AgentPlanHost />}
      {/* Always mounted (framer-free) — rollback toasts must surface even
          before the lazy plan host ever loads. */}
      <AgentFlashToast />
    </div>
  );
}
