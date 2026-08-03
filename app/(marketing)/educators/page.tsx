import type { Metadata } from "next";
import { displayFont } from "@/components/intro/fonts";
import { MarketingNav } from "@/components/educators/MarketingNav";
import { Hero } from "@/components/educators/Hero";
import { TrustStrip } from "@/components/educators/TrustStrip";
import { DualPath } from "@/components/educators/DualPath";
import { HowItWorks } from "@/components/educators/HowItWorks";
import { Features } from "@/components/educators/Features";
import { StatsBand } from "@/components/educators/StatsBand";
import { MarketplacePeek } from "@/components/educators/MarketplacePeek";
import { FinalCTA } from "@/components/educators/FinalCTA";
import { MarketingFooter } from "@/components/educators/MarketingFooter";

export const metadata: Metadata = {
  title: "WiseSel for Educators — The AI Course Studio",
  description:
    "The deep-dive tour for educators: turn expertise into engaging, monetizable courses — from curriculum to marketing to analytics.",
};

/**
 * The educator deep-dive: the original landing page's structure and elements
 * (rotating-word hero, flowing background lines, self-assembling product
 * demo, full section lineup), re-skinned to the warm paper + orange identity
 * of the new introduction at "/".
 */
export default function EducatorsPage() {
  return (
    <div className={`${displayFont.variable} min-h-screen bg-[#FAF7F1]`}>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-orange-600 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      <MarketingNav />
      <main id="content">
        <Hero />
        <TrustStrip />
        <DualPath />
        <HowItWorks />
        <Features />
        <StatsBand />
        <MarketplacePeek />
        <FinalCTA />
      </main>
      <MarketingFooter />
    </div>
  );
}
