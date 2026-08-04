/**
 * TUTOR-1 Wave 4 (Contract 3) — the tutor GATING + mount layout. Wraps both the
 * course landing (`/learn/[slug]`) and every lesson (`/learn/[slug]/[lessonId]`)
 * so the tutor shell is available across the runtime for an enrolled learner.
 *
 * The gate is the ONE truth from the runtime service (`resolveTutorAccess`):
 * ONLY access.kind === 'ok' (an enrolled learner) mounts the client — an author
 * preview, a disabled course, an un-enrolled caller, or an anonymous visitor
 * renders the children alone (the tutor never mounts, so an author's session
 * produces ZERO tutor evidence — the Wave 2 trust boundary, AC-W4C.2).
 *
 * Everything is tolerant of a missing user / unresolved slug: TutorFrame is
 * harmless with an empty userId, and no access read happens until BOTH resolve.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getSessionUser } from "@/lib/supabase/server";
import { resolveLivePublicationMeta } from "@/lib/learn/publicationCache";
import { resolveTutorAccess } from "@/lib/tutor/runtime/service";
import { TutorFrame } from "@/components/learn/tutor/TutorFrame";
import { TutorMount } from "@/components/learn/tutor/TutorMount";

export default async function LearnCourseLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await createClient();

  // The session read and the narrow (snapshot-free) slug resolve are
  // independent — one wave. Both are tolerated null → children only.
  const [user, resolution] = await Promise.all([
    getSessionUser(),
    resolveLivePublicationMeta(supabase, slug).catch(() => ({ kind: "not_found" as const })),
  ]);

  const meta = resolution.kind === "found" ? resolution.meta : null;

  // Resolve tutor access ONLY when both the learner and the live publication
  // exist. Anything but 'ok' mounts no client. A gating read failure fails safe
  // (no mount) — the lesson page's own gating still governs content access.
  let showTutor = false;
  if (user && meta) {
    try {
      const access = await resolveTutorAccess(createAdminClient(), {
        userId: user.id,
        courseId: meta.course_id,
      });
      showTutor = access.kind === "ok";
    } catch {
      showTutor = false;
    }
  }

  return (
    <TutorFrame userId={user?.id ?? ""}>
      {children}
      {showTutor && user && meta ? (
        <TutorMount
          userId={user.id}
          courseId={meta.course_id}
          publicationId={meta.id}
          version={meta.version}
          slug={slug}
          escalationsUi={process.env.TUTOR_ESCALATIONS_UI === "true"}
        />
      ) : null}
    </TutorFrame>
  );
}
