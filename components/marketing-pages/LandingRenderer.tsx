/**
 * Landing page renderer — maps a published page's typed sections to their
 * renderer-owned blocks, in document order. The lead-capture section is rendered
 * with the interactive client form; everything else is pure server markup. A
 * pageview beacon fires once on load.
 */

import type { LandingPage } from "@/lib/marketing/types";
import { resolveDesign } from "./design";
import { LeadCaptureForm } from "./LeadCaptureForm";
import { PageViewBeacon } from "./PageViewBeacon";
import {
  CurriculumBlock,
  FaqBlock,
  HeroBlock,
  InstructorBlock,
  OutcomesBlock,
  PricingCtaBlock,
  SocialProofBlock,
} from "./sections";

export function LandingRenderer({ page, preview = false }: { page: LandingPage; preview?: boolean }) {
  const design = resolveDesign(page.theme);
  return (
    <div className="min-h-screen bg-canvas text-stone-900">
      {/* No analytics beacon in preview — drafts aren't public traffic. */}
      {preview ? null : <PageViewBeacon slug={page.slug} />}
      <main>
        {page.sections.map((s) => {
          switch (s.kind) {
            case "hero":
              return <HeroBlock key={s.id} s={s} design={design} />;
            case "outcomes":
              return <OutcomesBlock key={s.id} s={s} design={design} />;
            case "curriculum":
              return <CurriculumBlock key={s.id} s={s} design={design} />;
            case "instructor":
              return <InstructorBlock key={s.id} s={s} design={design} />;
            case "social_proof":
              return <SocialProofBlock key={s.id} s={s} design={design} />;
            case "pricing_cta":
              return <PricingCtaBlock key={s.id} s={s} design={design} />;
            case "lead_capture":
              return <LeadCaptureForm key={s.id} section={s} slug={page.slug} preview={preview} />;
            case "faq":
              return <FaqBlock key={s.id} s={s} design={design} />;
            default:
              return null;
          }
        })}
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-8 text-xs text-stone-400">
          <span>{page.title}</span>
          <span className="[font-family:var(--font-display)] text-sm text-stone-500">WiseSel</span>
        </div>
      </footer>
    </div>
  );
}
