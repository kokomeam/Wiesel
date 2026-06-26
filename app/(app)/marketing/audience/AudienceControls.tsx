"use client";

/**
 * Dev/test controls for the funnel: seed a lead and advance the scheduler so you
 * can watch subscribers move through the lifecycle on the mock provider.
 */

import { useState, useTransition } from "react";
import { FlaskConical, Loader2, Play, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { seedSubscriberAction, tickSchedulerAction } from "./actions";

export function AudienceControls({ courseId }: { courseId: string }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const run = (fn: () => Promise<{ message: string }>) =>
    start(async () => setMsg((await fn()).message));

  return (
    <div className="rounded-2xl border border-dashed border-stone-300 bg-stone-50/60 p-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
        <FlaskConical className="size-3.5" /> Test controls (mock provider — no real email)
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => run(() => seedSubscriberAction(courseId))} disabled={busy}>
          <UserPlus className="size-3.5" /> Seed test lead
        </Button>
        <Button size="sm" variant="outline" onClick={() => run(() => tickSchedulerAction(courseId, 1))} disabled={busy}>
          <Play className="size-3.5" /> Run scheduler (+1 day)
        </Button>
        <Button size="sm" variant="outline" onClick={() => run(() => tickSchedulerAction(courseId, 7))} disabled={busy}>
          <Play className="size-3.5" /> +7 days
        </Button>
        {busy ? <Loader2 className="size-4 animate-spin text-stone-400" /> : null}
        {msg ? <span className="text-xs text-stone-500">{msg}</span> : null}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-stone-400">
        Seed a lead, then activate a sequence in the hub and advance the scheduler — each tick delivers the
        sends due by then and moves people lead → subscribed → engaged. Refresh shows their new position.
      </p>
    </div>
  );
}
