/**
 * Public landing page — /p/[slug]. Server-rendered; reads the PUBLISHED page via
 * RLS (published pages are world-readable, drafts are not), 404s otherwise. This
 * route is intentionally outside the (app) auth group, so it's public.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { landingPageFromRow } from "@/lib/marketing/persistence";
import { LandingRenderer } from "@/components/marketing-pages/LandingRenderer";
import type { HeroSection, LandingPage } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

const loadPublished = cache(async (slug: string): Promise<LandingPage | null> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("landing_page")
    .select("*")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  return data ? landingPageFromRow(data) : null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPublished(slug);
  if (!page) return { title: "Page not found" };
  const hero = page.sections.find((s): s is HeroSection => s.kind === "hero");
  return { title: page.title, description: hero?.subhead };
}

export default async function PublicLandingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await loadPublished(slug);
  if (!page) notFound();
  return <LandingRenderer page={page} />;
}
