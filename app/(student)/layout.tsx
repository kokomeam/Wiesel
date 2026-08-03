import { redirect } from "next/navigation";
import { StudentSidebar } from "@/components/shell/StudentSidebar";
import { getSessionUser } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/supabase/sessionProfile";

/**
 * Student portal shell (/home, /my-courses, /explore). Auth-gated like the
 * creator (app) group, but deliberately editor-free: no uiStore, no studio
 * actions, no ConfirmHost — the learner bundle stays light. The /learn/*
 * runtime keeps its own minimal public shell in app/(learn)/.
 */

function initialsFrom(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "U"
  );
}

export default async function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();

  // Belt-and-suspenders with the middleware guard.
  if (!user) redirect("/login?redirectTo=/home");

  const profile = await getSessionProfile();

  const name = profile?.displayName || user.email?.split("@")[0] || "Learner";
  const shellUser = {
    name,
    email: user.email ?? "",
    initials: initialsFrom(name),
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden md:flex-row">
      <StudentSidebar user={shellUser} />
      <main className="flex-1 overflow-y-auto scrollbar-thin">{children}</main>
    </div>
  );
}
