import type { Metadata } from "next";
import { displayFont } from "@/components/intro/fonts";
import { FinalSeat } from "@/components/intro/FinalSeat";
import { IntroBento } from "@/components/intro/IntroBento";
import { IntroFooter } from "@/components/intro/IntroFooter";
import { IntroHero } from "@/components/intro/IntroHero";
import { IntroNav } from "@/components/intro/IntroNav";
import { NumbersBand } from "@/components/intro/NumbersBand";
import { TopicMarquee } from "@/components/intro/TopicMarquee";
import { TwoSides } from "@/components/intro/TwoSides";

export const metadata: Metadata = {
  title: "WiseSel — Both sides of the classroom",
  description:
    "The course studio built for both sides of the desk: educators craft courses like products, learners actually finish them. The educator deep-dive lives at /educators.",
};

/**
 * The dual-audience product introduction. The original educator-focused
 * landing page is preserved in full at /educators and linked from the hero,
 * the educator card, the nav, and the closing footnote.
 */
export default function IntroPage() {
  return (
    <div className={`${displayFont.variable} min-h-screen bg-[#FAF7F1]`}>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-orange-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <IntroNav />
      <main id="content">
        <IntroHero />
        <TopicMarquee />
        <TwoSides />
        <IntroBento />
        <NumbersBand />
        <FinalSeat />
      </main>
      <IntroFooter />
    </div>
  );
}
