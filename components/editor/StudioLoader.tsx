"use client";

/**
 * Bridges the server-loaded course into the client editor store. Hydration
 * runs in an effect (post React-hydration) so SSR and the first client render
 * both show the skeleton — no mismatch — then the real editor mounts.
 * Autosave is wired here, alongside the editor it guards.
 */

import { useEffect } from "react";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";
import { useCoursePersistence } from "@/lib/editor/coursePersistence";
import type { CourseDocument } from "@/lib/course/types";
import { CourseEditorShell } from "./CourseEditorShell";
import { SaveStatusIndicator } from "./SaveStatusIndicator";

function StudioSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="h-[53px] border-b border-stone-200 bg-white" />
      <div className="flex flex-1 animate-pulse">
        <div className="w-72 border-r border-stone-200 bg-white/60" />
        <div className="flex-1 bg-stone-50/40" />
        <div className="w-80 border-l border-stone-200 bg-white/60" />
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

export function StudioLoader({
  initialDoc,
  courseId,
  ownerId,
  pendingBlocks = [],
}: {
  initialDoc: CourseDocument;
  courseId: string;
  ownerId: string;
  /** Blocks with a pending agent change-set (server-loaded) — drives the
   *  editor highlight. Re-supplied on every router.refresh. */
  pendingBlocks?: { blockId: string; changeSetId: string }[];
}) {
  const hydrate = useEditorStore((s) => s.hydrate);
  // Gate on the STORE's courseId (not local state): SSR and the first client
  // render both read the placeholder (null) → skeleton, no hydration mismatch;
  // the effect then installs the loaded course and the editor mounts. Also
  // re-gates when navigating between courses.
  const activeCourseId = useEditorStore((s) => s.courseId);

  useEffect(() => {
    hydrate(initialDoc, courseId);
  }, [hydrate, initialDoc, courseId]);

  // Reconcile the agent highlight with the DB's pending change-sets (authoritative
  // after a full reload; corrects the optimistic stream tracking after refresh).
  const pendingKey = JSON.stringify(pendingBlocks);
  useEffect(() => {
    useAgentStore.getState().hydratePending(pendingBlocks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  if (activeCourseId !== courseId) return <StudioSkeleton />;
  return <EditorWithAutosave ownerId={ownerId} />;
}
