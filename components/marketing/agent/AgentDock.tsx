"use client";

/**
 * The agent dock — the always-there way into the Marketing Agent. A floating
 * pill on every marketing page opens a right-hand slide-over with the SAME
 * AgentPanel the full-screen page and the campaign builder embed use.
 *
 * The panel stays MOUNTED while the dock is closed (translated off-screen,
 * inert) so the transcript survives open/close within a visit; the hub's
 * ask-bar seeds a message through agentDockStore and the panel auto-sends it.
 *
 * Hidden where a chat already owns the surface: the full-screen /marketing/agent
 * page and the campaign builder (which embeds its own panel).
 */

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Maximize2, Wand2, X } from "lucide-react";
import { AgentPanel } from "@/components/marketing/agent/AgentPanel";
import { useAgentDockStore } from "@/lib/marketing/agentDockStore";
import { cn } from "@/lib/cn";

export function AgentDock({ defaultCourseId }: { defaultCourseId: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { open, seed, openDock, closeDock, clearSeed } = useAgentDockStore();

  // Surfaces that already own a chat: full-screen agent + the campaign builder.
  const hidden =
    pathname === "/marketing/agent" ||
    (/^\/marketing\/email\/[^/]+$/.test(pathname) && !pathname.endsWith("/new"));
  if (hidden) return null;

  const courseId = params.get("course") ?? defaultCourseId;

  return (
    <>
      {/* the slide-over — always mounted so the transcript survives close */}
      <div
        className={cn(
          "fixed inset-y-4 right-4 z-50 flex w-[min(27.5rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-[#faf7f1] shadow-2xl shadow-stone-900/15 transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "pointer-events-none translate-x-[calc(100%+2rem)]"
        )}
        aria-hidden={!open}
        role="complementary"
        aria-label="Marketing Agent"
        data-testid="agent-dock"
      >
        <div className="flex items-center gap-2.5 border-b border-stone-200/80 bg-white/70 px-4 py-3">
          <span className="brand-gradient grid size-7 shrink-0 place-items-center rounded-lg text-white [font-family:var(--font-display)] text-base">
            *
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-stone-900">Marketing Agent</p>
            <p className="truncate text-[11px] text-stone-400">
              Reads your funnel · drafts revert · sends always ask you first
            </p>
          </div>
          <Link
            href={`/marketing/agent?course=${courseId}`}
            className="grid size-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-900/[0.06] hover:text-stone-700"
            title="Open full screen"
            onClick={closeDock}
          >
            <Maximize2 className="size-3.5" />
          </Link>
          <button
            type="button"
            onClick={closeDock}
            className="grid size-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-900/[0.06] hover:text-stone-700"
            aria-label="Close agent"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 px-3 pb-3">
          <AgentPanel courseId={courseId} seed={open ? seed : null} onSeedConsumed={clearSeed} />
        </div>
      </div>

      {/* the always-visible way in */}
      {!open ? (
        <button
          type="button"
          onClick={() => openDock()}
          className="brand-gradient fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full py-2.5 pl-4 pr-5 text-sm font-medium text-white shadow-lg shadow-brand-600/30 transition-transform hover:-translate-y-0.5"
          data-testid="agent-dock-fab"
        >
          <Wand2 className="size-4" /> Ask the agent
        </button>
      ) : null}
    </>
  );
}
