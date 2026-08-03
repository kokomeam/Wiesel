/**
 * /settings — the creator identity page (rebuilt on REAL data 2026-07-11; the
 * old page rendered lib/data.ts mocks). Profile fields feed the instructor
 * card learners see on course landings + marketplace cards.
 *
 * select("*") on profiles deliberately tolerates the pre-migration DB:
 * headline/bio/role simply read as undefined until 20260708000000/20260711*
 * are applied, and the client components degrade with quiet notices.
 */

import { redirect } from "next/navigation";
import { AccountCard } from "@/components/settings/AccountCard";
import { ProfileSettings } from "@/components/settings/ProfileSettings";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) redirect("/login?redirectTo=/settings");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  // RAW value, no email-prefix fallback: profiles is world-readable, so a
  // derived fallback must never be silently persisted as the public name —
  // an empty field forces an explicit choice (zod min(1) blocks the save).
  const displayName = profile?.display_name?.trim() ?? "";
  const role = profile?.role === "learner" ? "learner" : "creator";

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <PageHeader
        eyebrow="Settings"
        title="Your creator profile"
        description="Learners see this on every course page and marketplace card — a real face and a clear headline sell courses."
      />

      <ProfileSettings
        userId={user.id}
        initial={{
          displayName,
          headline: profile?.headline ?? "",
          bio: profile?.bio ?? "",
          avatarUrl: profile?.avatar_url ?? null,
        }}
      />

      <AccountCard
        userId={user.id}
        email={user.email ?? ""}
        plan={profile?.plan ?? "hobbyist"}
        role={role}
      />
    </div>
  );
}
