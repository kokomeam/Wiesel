/**
 * Split-view landing editor — agent chat (left) + the live draft preview (right).
 * The agent is scoped to this page; content/design edits go through the gate
 * (reversible → auto-apply to the draft, staged for review), and the panel calls
 * router.refresh() on each turn so the preview reflects edits immediately.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { landingPageFromRow } from "@/lib/marketing/persistence";
import { LandingRenderer } from "@/components/marketing-pages/LandingRenderer";
import { AgentPanel } from "@/components/marketing/agent/AgentPanel";

export const dynamic = "force-dynamic";

export default async function LandingEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from("landing_page").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const page = landingPageFromRow(data);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-white px-4 py-2.5 text-sm">
        <Link href="/marketing" className="inline-flex items-center gap-1.5 text-stone-500 hover:text-stone-700">
          <ArrowLeft className="size-4" /> Marketing
        </Link>
        <span className="font-medium text-stone-800">Editing “{page.title}”</span>
        <span className="text-stone-400">{page.status} · edits stage for review</span>
        <Link href={`/marketing/preview/${page.id}`} className="ml-auto text-brand-600 hover:underline">
          Full preview →
        </Link>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(340px,400px)_1fr]">
        <div className="flex min-h-0 flex-col border-r border-line p-4">
          <AgentPanel courseId={page.courseId} pageId={page.id} />
        </div>
        <div className="min-h-0 overflow-y-auto bg-stone-100/60 scrollbar-thin">
          <LandingRenderer page={page} preview />
        </div>
      </div>
    </div>
  );
}
