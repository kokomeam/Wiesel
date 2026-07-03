/**
 * GET /api/learn/deck/[id] — learner-scoped imported-deck pages.
 *
 * The editor's /api/deck-imports/[id] is owner-only, so enrolled learners get
 * their signed page URLs here instead. Access chain (all must hold):
 *   1. signed in,
 *   2. enrolled in (or author of) the deck's course,
 *   3. the deck is actually part of that course's LIVE publication — a deck
 *      that only exists in the draft is NOT served to students.
 * URLs are short-lived signed URLs; the viewer refetches when they expire.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLearnerAccess } from "@/lib/learn/access";
import { LearnError } from "@/lib/learn/errors";
import { getLivePublicationByCourse, parsePublicationSnapshot } from "@/lib/learn/resolve";
import { learnErrorResponse, requireUser } from "@/lib/learn/routeHelpers";
import { getDeckImportView } from "@/lib/course/imports/deckImportService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { supabase, user } = auth;
  const { id } = await params;

  try {
    const admin = createAdminClient();
    const view = await getDeckImportView(admin, id);
    if (!view) throw new LearnError("not_found", "Deck not found.");

    const access = await getLearnerAccess(supabase, user.id, view.courseId);
    if (!access) throw new LearnError("not_enrolled", "Enroll to view this deck.");

    if (access.role === "student") {
      const publication = await getLivePublicationByCourse(supabase, view.courseId);
      if (!publication) throw new LearnError("not_found", "This course isn't published.");
      const snapshot = parsePublicationSnapshot(publication);
      const inSnapshot = snapshot.modules.some((m) =>
        m.lessons.some((l) =>
          l.blocks.some((b) => b.type === "imported_deck" && b.deckImportId === id)
        )
      );
      if (!inSnapshot) throw new LearnError("not_found", "Deck not found.");
    }

    return NextResponse.json({ deck: view });
  } catch (error) {
    return learnErrorResponse(error);
  }
}
