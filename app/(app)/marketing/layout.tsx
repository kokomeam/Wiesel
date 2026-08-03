/**
 * Marketing area layout — every /marketing/* page gets the floating Agent
 * dock (the always-visible way into the Marketing Agent; hidden on surfaces
 * that already own a chat). The dock needs a course to scope the agent to;
 * pages that carry ?course= override this server-resolved default.
 */

import { Suspense } from "react";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { selectCourseForAuthorCached } from "@/lib/marketing/persistence";
import { AgentDock } from "@/components/marketing/agent/AgentDock";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const user = await getSessionUser();
  // PERF-1 C1: react cache()d — the hub page resolves the same default
  // course, so layout + page share ONE query per request.
  const course = user ? await selectCourseForAuthorCached(supabase, user.id, null) : null;

  return (
    <>
      {children}
      {course ? (
        <Suspense fallback={null}>
          <AgentDock defaultCourseId={course.id} />
        </Suspense>
      ) : null}
    </>
  );
}
