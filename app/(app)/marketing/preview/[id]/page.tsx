/**
 * Authed DRAFT preview — /marketing/preview/[id]. Renders a landing page (any
 * status) with the same renderer in preview mode, so the creator can see a draft
 * before publishing (public /p/[slug] 404s for drafts via RLS). Author-scoped:
 * the (app) layout requires auth and RLS only returns the author's own rows.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { landingPageFromRow } from "@/lib/marketing/persistence";
import { LandingRenderer } from "@/components/marketing-pages/LandingRenderer";

export const dynamic = "force-dynamic";

export default async function LandingPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("landing_page").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const page = landingPageFromRow(data);

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-amber-200 bg-amber-50/90 px-4 py-2.5 text-sm backdrop-blur">
        <Link href="/marketing" className="inline-flex items-center gap-1.5 text-amber-800 hover:text-amber-900">
          <ArrowLeft className="size-4" /> Marketing
        </Link>
        <span className="font-medium text-amber-900">Draft preview</span>
        <span className="text-amber-700">
          “{page.title}” · {page.status} · not public until published
        </span>
        {page.status === "published" ? (
          <Link href={`/p/${page.slug}`} target="_blank" className="ml-auto font-medium text-brand-700 hover:underline">
            View live →
          </Link>
        ) : null}
      </div>
      <LandingRenderer page={page} preview />
    </div>
  );
}
