/**
 * /api/marketing/social-voice-profile
 *   GET — the creator's social voice profile (derives + persists on first use)
 *   PUT — creator edit: persists with source='creator_edited' (regeneration
 *         over edits then requires an explicit confirm)
 */

import { NextResponse } from "next/server";
import { ensureSocialVoiceProfile } from "@/lib/marketing/social/generate";
import { emitSocialEvent } from "@/lib/marketing/social/events";
import { upsertSocialVoiceProfile } from "@/lib/marketing/social/repository";
import { SocialVoiceProfileSchema } from "@/lib/marketing/social/schemas";
import { socialErrorResponse, socialRouteAuth } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const record = await ensureSocialVoiceProfile(auth.deps);
    return NextResponse.json({ voiceProfile: record });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  let body: { profile?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SocialVoiceProfileSchema.safeParse(body.profile);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid profile: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 }
    );
  }
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const record = await upsertSocialVoiceProfile(
      auth.ctx.supabase,
      auth.ownerId,
      parsed.data,
      "creator_edited"
    );
    await emitSocialEvent(auth.ctx.supabase, auth.ctx.courseId, "social_voice_profile_edited", {
      version: record.version,
    });
    return NextResponse.json({ voiceProfile: record });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
