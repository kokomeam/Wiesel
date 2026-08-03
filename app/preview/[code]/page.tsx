/**
 * /preview/{code} — the shareable CLIP PREVIEW (M-D). Code possession is the
 * capability (the creator shares the link to review a rendered clip before
 * posting it); unknown codes 404 indistinguishably.
 *
 * ANSWER-KEY INVARIANT (re-asserted for this public surface, PRD §10): this
 * page reads ONLY short_link → posting_kit → social_post → clip_render_job →
 * a signed clip-media URL. It never touches quiz_answer_keys, blocks,
 * publications, or any course-content table — a clip preview can never leak
 * assessment material (verify-clips greps this file's table surface).
 *
 * The video URL is a 1-hour SIGNED url over the PRIVATE clip-media bucket
 * (the admin client mints it AFTER the code resolves — the learner-media
 * precedent: privileged read only behind the capability gate).
 */

import { notFound } from "next/navigation";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { WiseSelLogo } from "@/components/brand/WiseSelLogo";

export const dynamic = "force-dynamic";

export default async function ClipPreviewPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  if (!isAdminConfigured() || !/^[a-z2-9]{4,12}$/.test(code)) notFound();
  const admin = createAdminClient();

  const { data: link } = await admin
    .from("short_link")
    .select("id, course_id")
    .eq("code", code)
    .maybeSingle();
  if (!link) notFound();

  const { data: kit } = await admin
    .from("posting_kit")
    .select("id, caption, disclosure_line, post_id")
    .eq("short_link_id", link.id)
    .maybeSingle();
  if (!kit) notFound();

  const { data: post } = await admin
    .from("social_post")
    .select("id, video_path, body, ai_metadata")
    .eq("id", kit.post_id)
    .maybeSingle();
  if (!post?.video_path) notFound();

  const { data: signed } = await admin.storage
    .from("clip-media")
    .createSignedUrl(post.video_path, 3600);
  if (!signed?.signedUrl) notFound();

  const hook = ((post.ai_metadata as Record<string, unknown> | null)?.hookText as string) ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center gap-6 px-6 py-10">
      <WiseSelLogo variant="horizontal" className="h-7 w-auto" />
      <div className="w-full overflow-hidden rounded-2xl border border-stone-200 bg-stone-950 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        {/* A preview surface, not a learner player — native controls are right here. */}
        <video src={signed.signedUrl} controls playsInline className="aspect-[9/16] w-full" />
      </div>
      {hook && (
        <p className="w-full text-center text-lg font-medium text-stone-900">{hook}</p>
      )}
      <div className="w-full rounded-2xl border border-stone-200/80 bg-white p-4 text-sm text-stone-600">
        <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-stone-400">
          Caption preview
        </p>
        <p className="whitespace-pre-wrap">{kit.caption}</p>
        <p className="mt-2 text-stone-400">{kit.disclosure_line}</p>
      </div>
      <p className="text-xs text-stone-400">
        Preview only — this clip hasn&apos;t been posted anywhere. The creator posts it manually.
      </p>
    </main>
  );
}
