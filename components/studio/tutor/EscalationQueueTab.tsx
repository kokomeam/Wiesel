import { LifeBuoy, ShieldAlert } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { createClient } from "@/lib/supabase/server";
import { loadEscalationQueue } from "@/lib/studio/escalationQueue";
import { ClusterCard } from "./ClusterCard";

/**
 * Escalations tab (TUTOR-1 Wave 6, P6.3). Server component — loads its OWN data
 * through the one author-gated definer RPC (loadEscalationQueue → tutor_escalation_
 * queue). The route shell wires `<EscalationQueueTab courseId=... />` only when
 * escalationsUiEnabled(); the frozen prop signature stays fixed.
 *
 * The queue shows the OPEN + REPLIED clusters as identity-free cards — each with the
 * implicated concept, the representative question, a COUNT of learners who asked
 * (NEVER a roster), the tutor's proposed answer, and Approve/Dismiss. The RPC
 * already sorts by member_count desc then updated_at desc (biggest, freshest first)
 * — the "count × recency" ordering — so we render in the order it returns.
 *
 * PRIVACY: no user_id ever reaches this component. loadEscalationQueue can only read
 * the identity-free escalation_cluster surface + the definer RPC; the identity-
 * bearing escalation_dossier is unreadable to every client role. A non-author (or a
 * missing course) yields an empty queue (the page already 404s the hard cases).
 *
 * No editor-store imports (the tutor route budget fence).
 */
export async function EscalationQueueTab({ courseId }: { courseId: string }) {
  const supabase = await createClient();
  const clusters = await loadEscalationQueue(supabase, courseId);

  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="flex items-center gap-2">
            <LifeBuoy className="size-4 text-brand-500" aria-hidden />
            Escalations
          </span>
        }
        subtitle="Questions your learners handed off to you, grouped by concept. Reply once — every learner who asked gets your answer in their tutor thread. You only ever see the count, never who asked."
      />

      {clusters.length > 0 ? (
        <ul className="space-y-3 p-card-pad" data-ai-component="escalation-queue">
          {clusters.map((cluster) => (
            <ClusterCard key={cluster.id} courseId={courseId} cluster={cluster} />
          ))}
        </ul>
      ) : (
        <div className="p-card-pad">
          <EmptyState
            icon={ShieldAlert}
            title="No escalations waiting"
            hint="When a learner hands a question off to you — and consents to share it — it shows up here, grouped with everyone else asking the same thing. Reply once and it reaches them all."
          />
        </div>
      )}
    </Card>
  );
}
