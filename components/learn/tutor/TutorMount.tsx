"use client";

/**
 * TUTOR-1 Wave 4 — the tutor SHELL. This is the EAGER client entry the learn
 * layout mounts for an enrolled learner ('ok' access only). It stays tiny (the
 * ≤5 KB budget line) by owning ONLY: store rehydration, the ambient course
 * envelope, the ?tutor=/?seed= deep-link consumption, the collapsed edge tab,
 * and the open panel FRAME. The heavy conversation body is next/dynamic
 * (ssr:false) so its weight loads only when the panel is opened.
 *
 * z-stack (Contract 6): the edge tab + panel + overlay scrim are all z-50 —
 * above the learn header (z-40), below the course-nav mobile drawer (z-[60]).
 * Overlay mode < lg (fixed inset-y right + scrim); docked ≥ lg (fixed right,
 * TutorFrame reflows the content).
 */

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { useTutorStore, hydrateTutorStore } from "@/lib/learn/tutorStore";
import { useMediaQuery } from "@/lib/ui/useMediaQuery";

const TutorBody = dynamic(() => import("./TutorBody").then((m) => m.TutorBody), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center px-4 py-6 text-sm text-stone-400">
      Loading…
    </div>
  ),
});

export function TutorMount({
  userId,
  courseId,
  publicationId,
  version,
  slug,
  escalationsUi,
}: {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  escalationsUi: boolean;
}) {
  const slice = useTutorStore((s) => s.byUser[userId]);
  const open = slice?.open ?? false;
  const width = slice?.width ?? 384;
  const suggestionDot = useTutorStore((s) => s.suggestionDot);
  const setUserSlice = useTutorStore((s) => s.setUserSlice);
  const setAmbient = useTutorStore((s) => s.setAmbient);
  const seedComposer = useTutorStore((s) => s.seedComposer);
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const tabRef = useRef<HTMLButtonElement | null>(null);
  const searchParams = useSearchParams();

  // (a) rehydrate the persisted slice once (skipHydration — never at SSR).
  useEffect(() => {
    hydrateTutorStore();
  }, []);

  // (b) publish the course envelope on mount (the lesson view fills the rest).
  useEffect(() => {
    setAmbient({ courseId, publicationId, version });
  }, [setAmbient, courseId, publicationId, version]);

  // (c) consume ?tutor=open + ?seed= ONCE on mount (a deep link from /home or a
  //     review nudge). A ref guards against a re-run re-opening after a close.
  const consumedDeepLink = useRef(false);
  useEffect(() => {
    if (consumedDeepLink.current) return;
    consumedDeepLink.current = true;
    if (searchParams.get("tutor") === "open") setUserSlice(userId, { open: true });
    const seed = searchParams.get("seed");
    if (seed) seedComposer(seed);
  }, [searchParams, setUserSlice, seedComposer, userId]);

  function openPanel() {
    setUserSlice(userId, { open: true });
  }
  function closePanel() {
    setUserSlice(userId, { open: false });
    // Return focus to the edge tab (it re-renders when open flips to false).
    requestAnimationFrame(() => tabRef.current?.focus());
  }

  const panel =
    isDesktop ? (
      <aside
        aria-label="Course tutor"
        className="fixed right-0 top-14 bottom-0 z-50 flex flex-col border-l border-stone-200/80 bg-white shadow-[-8px_0_24px_rgba(68,48,28,0.06)]"
        style={{ width }}
      >
        <TutorBody
          userId={userId}
          courseId={courseId}
          publicationId={publicationId}
          version={version}
          slug={slug}
          escalationsUi={escalationsUi}
          onClose={closePanel}
        />
      </aside>
    ) : (
      <>
        <div
          className="fixed inset-0 z-50 bg-stone-900/30 backdrop-blur-[1px]"
          onClick={closePanel}
          aria-hidden
        />
        <aside
          aria-label="Course tutor"
          className="fixed inset-y-0 right-0 z-50 flex w-[min(92vw,420px)] flex-col border-l border-stone-200/80 bg-white shadow-[-8px_0_24px_rgba(68,48,28,0.12)]"
        >
          <TutorBody
            userId={userId}
            courseId={courseId}
            publicationId={publicationId}
            version={version}
            slug={slug}
            escalationsUi={escalationsUi}
            onClose={closePanel}
          />
        </aside>
      </>
    );

  return (
    <>
      {!open ? (
        <button
          ref={tabRef}
          type="button"
          onClick={openPanel}
          aria-label="Open tutor"
          data-ai-tool="tutor-open"
          className="fixed right-0 top-1/2 z-50 -translate-y-1/2 rounded-l-full border border-r-0 border-stone-200/80 bg-white px-3 py-4 text-stone-600 shadow-[-4px_0_14px_rgba(68,48,28,0.08)] transition-colors hover:text-brand-700"
        >
          <span className="relative grid place-items-center">
            <MessageCircle className="size-5" aria-hidden />
            {suggestionDot ? (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 size-2.5 rounded-full bg-amber-500 ring-2 ring-white"
              />
            ) : null}
          </span>
        </button>
      ) : (
        panel
      )}
    </>
  );
}

export default TutorMount;
