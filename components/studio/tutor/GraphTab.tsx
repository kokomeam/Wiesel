import { Waypoints, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { createClient } from "@/lib/supabase/server";
import { loadGraphConsole } from "@/lib/studio/graphConsole";
import { GraphWorkspace } from "./graph/GraphCanvas";
import { GraphReviewPanel } from "./graph/GraphReviewPanel";
import { AssumedPriorsPanel } from "./graph/AssumedPriorsPanel";

/**
 * Concept graph tab (TUTOR-1 Wave 5, P5.2 · step 7). Server component — loads its
 * OWN data through the one author-gated definer RPC (loadGraphConsole →
 * tutor_graph_console). The route shell already wired `<GraphTab courseId=... />`;
 * the frozen prop signature stays fixed.
 *
 * Layout:
 *   - null bundle  → an author-only notice (the RPC returned null: not the author
 *     or the course is gone; the page above 404s for the hard cases, this is the
 *     graceful fallback).
 *   - a pending change-set → the GraphReviewPanel PROMINENTLY at the top (the rail
 *     consumer: classification + evidence + edit-before-accept + Accept/Reject).
 *   - no nodes → an EmptyState routing the creator to the Enablement tab.
 *   - otherwise → the GraphWorkspace (canvas + overlays + node list + detail drawer)
 *     and the AssumedPriorsPanel below it.
 *
 * No editor-store imports (the tutor route budget fence).
 */
export async function GraphTab({ courseId }: { courseId: string }) {
  const supabase = await createClient();
  const bundle = await loadGraphConsole(supabase, courseId);

  if (!bundle) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Concept graph unavailable"
        hint="We couldn't load this course's concept graph. Only the course author can view it — check you're signed in as the owner."
      />
    );
  }

  const hasNodes = bundle.nodes.length > 0;

  return (
    <div className="space-y-5">
      {bundle.pendingChangeSetId ? (
        <GraphReviewPanel
          courseId={courseId}
          changeSetId={bundle.pendingChangeSetId}
          nodes={bundle.nodes}
          evidenceByNode={bundle.evidenceByNode}
        />
      ) : null}

      {hasNodes ? (
        <GraphWorkspace
          courseId={courseId}
          nodes={bundle.nodes}
          edges={bundle.edges}
          mastery={bundle.mastery}
          confusion={bundle.confusion}
          evidenceByNode={bundle.evidenceByNode}
        />
      ) : (
        <EmptyState
          icon={Waypoints}
          title="No concept graph yet"
          hint="Build the concept graph from the Enablement tab — once it's extracted and accepted, it appears here to review, edit, and inspect against learner mastery."
        />
      )}

      {bundle.assumedPriors.length > 0 ? (
        <AssumedPriorsPanel courseId={courseId} assumedPriors={bundle.assumedPriors} />
      ) : null}
    </div>
  );
}
