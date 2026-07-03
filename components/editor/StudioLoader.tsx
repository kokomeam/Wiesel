"use client";

/**
 * Bridges the server-loaded course into the client editor store. Hydration
 * runs in an effect (post React-hydration) so SSR and the first client render
 * both show the skeleton — no mismatch — then the real editor mounts.
 * Autosave is wired here, alongside the editor it guards.
 */

import { useEffect, useRef } from "react";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";
import { useChangeSetRealtime } from "@/lib/editor/useChangeSetRealtime";
import { useVisualJobs } from "@/lib/editor/useVisualJobs";
import { useCoursePersistence } from "@/lib/editor/coursePersistence";
import type { CourseDocument } from "@/lib/course/types";
import { CourseEditorShell } from "./CourseEditorShell";
import { SaveStatusIndicator } from "./SaveStatusIndicator";

function StudioSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="h-[53px] border-b border-stone-200 bg-white" />
      <div className="flex flex-1">
        <div className="w-72 animate-pulse border-r border-stone-200 bg-white/60" />
        <div className="grid flex-1 place-items-center bg-stone-50/40">
          <WiseSelLogo
            variant="mark"
            className="h-12 w-auto animate-pulse opacity-60"
          />
        </div>
        <div className="w-80 animate-pulse border-l border-stone-200 bg-white/60" />
      </div>
    </div>
  );
}

function EditorWithAutosave({ ownerId }: { ownerId: string }) {
  useCoursePersistence(ownerId);
  return (
    <>
      <CourseEditorShell />
      <SaveStatusIndicator ownerId={ownerId} />
    </>
  );
}

/**
 * Analytics deep-link focus (?lesson= / ?block= on the studio URL): opens the
 * lesson, selects the block, and scrolls it into view. Mounts only AFTER the
 * store is hydrated (StudioLoader gates on courseId), runs once per page load,
 * and validates ids against the doc so a stale link degrades to a no-op.
 */
function DeepLinkFocus({
  lessonId,
  blockId,
}: {
  lessonId: string;
  blockId: string | null;
}) {
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const state = useEditorStore.getState();
    const lesson = state.doc.modules
      .flatMap((m) => m.lessons)
      .find((l) => l.id === lessonId);
    if (!lesson) return;
    state.openLesson(lessonId);
    if (!blockId || !lesson.blocks.some((b) => b.id === blockId)) return;
    state.select({ kind: "block", id: blockId, lessonId });
    // The workspace renders on the next frames; poll briefly for the node.
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(
        `[data-ai-component="lesson-block"][data-ai-id="${blockId}"]`
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (tries++ < 60) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }, [lessonId, blockId]);
  return null;
}

export function StudioLoader({
  initialDoc,
  courseId,
  ownerId,
  pendingBlocks = [],
  pendingNodes = [],
  focusLessonId = null,
  focusBlockId = null,
  openFindingsCount = 0,
}: {
  initialDoc: CourseDocument;
  courseId: string;
  ownerId: string;
  /** Blocks with a pending agent change-set (server-loaded) — drives the
   *  editor highlight; `evidence` present on maintenance proposals. Re-supplied
   *  on every router.refresh. */
  pendingBlocks?: { blockId: string; changeSetId: string; evidence?: unknown }[];
  /** Modules/lessons with a pending STRUCTURAL change — drives the outline-sidebar
   *  highlight + the AgentPanel Structure group. Re-supplied on router.refresh. */
  pendingNodes?: { nodeId: string; nodeType: "module" | "lesson"; changeSetId: string; op: string }[];
  /** Analytics deep-link (?lesson= / ?block=): focus this node after hydration. */
  focusLessonId?: string | null;
  focusBlockId?: string | null;
  /** Open threshold findings (maintenance agent) — header badge + panel chip. */
  openFindingsCount?: number;
}) {
  const hydrate = useEditorStore((s) => s.hydrate);
  // Gate on the STORE's courseId (not local state): SSR and the first client
  // render both read the placeholder (null) → skeleton, no hydration mismatch;
  // the effect then installs the loaded course and the editor mounts. Also
  // re-gates when navigating between courses.
  const activeCourseId = useEditorStore((s) => s.courseId);
  // Live render: stream staged blocks into the editor as the agent builds them.
  useChangeSetRealtime(courseId);
  // Drive client-side image generation for any PENDING image slides (off the agent's
  // critical path — they fill in once the run is idle).
  useVisualJobs();

  useEffect(() => {
    hydrate(initialDoc, courseId);
  }, [hydrate, initialDoc, courseId]);

  // Reconcile the agent highlight with the DB's pending change-sets (authoritative
  // after a full reload; corrects the optimistic stream tracking after refresh).
  const pendingKey = JSON.stringify({ pendingBlocks, pendingNodes, openFindingsCount });
  useEffect(() => {
    // Blocks FIRST (it rebuilds changeSets), then nodes (augments with structural
    // counts) — so neither hydration clobbers the other's per-set counts.
    useAgentStore.getState().hydratePending(pendingBlocks);
    useAgentStore.getState().hydratePendingNodes(pendingNodes);
    useAgentStore.getState().setOpenFindings(openFindingsCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  if (activeCourseId !== courseId) return <StudioSkeleton />;
  return (
    <>
      {focusLessonId ? (
        <DeepLinkFocus lessonId={focusLessonId} blockId={focusBlockId} />
      ) : null}
      <EditorWithAutosave ownerId={ownerId} />
    </>
  );
}
