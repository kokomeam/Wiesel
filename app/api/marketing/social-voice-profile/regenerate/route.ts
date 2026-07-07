/**
 * POST /api/marketing/social-voice-profile/regenerate — re-derive from the
 * creator's courses (+ optional pasted sample posts). A creator-edited
 * profile requires confirm:true (409 otherwise) so regeneration never
 * silently clobbers hand-tuned rules.
 */

import { NextResponse } from "next/server";
import { emitSocialEvent } from "@/lib/marketing/social/events";
import {
  loadSocialVoiceProfile,
  upsertSocialVoiceProfile,
} from "@/lib/marketing/social/repository";
import { collectVoiceDerivationInput, deriveVoiceProfile } from "@/lib/marketing/social/voice";
import { socialErrorResponse, socialRouteAuth } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { confirm?: boolean; samples?: string[] };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const existing = await loadSocialVoiceProfile(auth.ctx.supabase);
    if (existing?.source === "creator_edited" && !body.confirm) {
      return NextResponse.json(
        {
          error: "You've hand-edited this profile — regenerating will overwrite your edits.",
          code: "needs_confirm",
        },
        { status: 409 }
      );
    }
    const samples = (body.samples ?? existing?.profile.sampleExcerpts ?? []).slice(0, 3);
    const input = await collectVoiceDerivationInput(auth.ctx.supabase, auth.ownerId, samples);
    const { profile, via } = await deriveVoiceProfile(auth.ctx.model, input);
    const record = await upsertSocialVoiceProfile(auth.ctx.supabase, auth.ownerId, profile, "derived");
    await emitSocialEvent(auth.ctx.supabase, auth.ctx.courseId, "social_voice_profile_derived", {
      via,
      version: record.version,
      regenerated: true,
    });
    return NextResponse.json({ voiceProfile: record });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
