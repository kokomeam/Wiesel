/**
 * Marketing area layout — every /marketing/* page gets the floating Agent
 * dock (the always-visible way into the Marketing Agent; hidden on surfaces
 * that already own a chat). The dock needs a course to scope the agent to;
 * pages that carry ?course= override this server-resolved default.
 */

import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import { AgentDock } from "@/components/marketing/agent/AgentDock";
import { DockClearance } from "@/components/marketing/agent/DockClearance";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const course = user ? await selectCourseForAuthor(supabase, user.id) : null;

  return (
    <>
      <Suspense fallback={children}>
        <DockClearance>{children}</DockClearance>
      </Suspense>
      {course ? (
        <Suspense fallback={null}>
          <AgentDock defaultCourseId={course.id} />
        </Suspense>
      ) : null}
    </>
  );
}
