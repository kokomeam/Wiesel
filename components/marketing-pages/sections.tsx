/**
 * Landing-page section renderers — the RENDERER owns all layout & decoration.
 *
 * Each component receives a typed slot section + the resolved design tokens
 * (color/type/density/buttons) and, for some sections, a layout `variant`. The
 * AI fills only the text slots and picks from typed enums (tokens + variant); it
 * never emits CSS or markup. Visual variety lives entirely here.
 */

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type {
  CurriculumSection,
  FaqSection,
  HeroSection,
  InstructorSection,
  OutcomesSection,
  PricingCtaSection,
  SocialProofSection,
} from "@/lib/marketing/types";
import type { Design } from "./design";

const CTA_HREF = "#get-started";

function Cta({ label, design, className }: { label: string; design: Design; className?: string }) {
  return (
    <a
      href={CTA_HREF}
      className={cn(
        "inline-flex h-11 items-center justify-center px-7 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-95",
        design.accentGrad,
        design.btnRadius,
        className
      )}
    >
      {label}
    </a>
  );
}

export function HeroBlock({ s, design }: { s: HeroSection; design: Design }) {
  const variant = s.variant ?? "centered";
  const eyebrow = s.eyebrow ? (
    <p className={cn("font-mono text-[11px] uppercase tracking-[0.18em]", design.accentText)}>{s.eyebrow}</p>
  ) : null;

  if (variant === "split") {
    return (
      <section className={cn("border-b border-line bg-gradient-to-br", design.heroBg)}>
        <div className="mx-auto grid max-w-5xl items-center gap-10 px-6 py-20 md:grid-cols-2">
          <div>
            {eyebrow}
            <h1 className={cn("mt-4 text-balance text-4xl leading-[1.05] tracking-tight text-stone-900 sm:text-5xl", design.headingFont)}>
              {s.headline}
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-stone-600">{s.subhead}</p>
            <div className="mt-8">
              <Cta label={s.ctaLabel} design={design} />
            </div>
          </div>
          <div className="aspect-[4/3] rounded-2xl border border-stone-200/60 bg-white/50 shadow-sm" aria-hidden />
        </div>
      </section>
    );
  }

  if (variant === "minimal") {
    return (
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 py-16">
          {eyebrow}
          <h1 className={cn("mt-3 text-3xl leading-tight tracking-tight text-stone-900 sm:text-4xl", design.headingFont)}>
            {s.headline}
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-stone-600">{s.subhead}</p>
          <div className="mt-6">
            <Cta label={s.ctaLabel} design={design} />
          </div>
        </div>
      </section>
    );
  }

  // centered (default)
  return (
    <section className={cn("border-b border-line bg-gradient-to-br", design.heroBg)}>
      <div className="mx-auto max-w-4xl px-6 py-20 text-center">
        {eyebrow}
        <h1 className={cn("mt-4 text-balance text-4xl leading-[1.05] tracking-tight text-stone-900 sm:text-5xl", design.headingFont)}>
          {s.headline}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-stone-600">{s.subhead}</p>
        <div className="mt-8">
          <Cta label={s.ctaLabel} design={design} />
        </div>
      </div>
    </section>
  );
}

function SectionShell({ heading, design, children }: { heading: string; design: Design; children: React.ReactNode }) {
  return (
    <section className={cn("mx-auto max-w-4xl px-6", design.sectionPad)}>
      <h2 className={cn("text-2xl tracking-tight text-stone-900 sm:text-3xl", design.headingFont)}>{heading}</h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}

export function OutcomesBlock({ s, design }: { s: OutcomesSection; design: Design }) {
  const list = s.variant === "list";
  return (
    <SectionShell heading={s.heading} design={design}>
      <ul className={cn("gap-4", list ? "flex flex-col" : "grid sm:grid-cols-2")}>
        {s.items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 text-[15px] leading-relaxed text-stone-700">
            <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-50 ring-1 ring-emerald-200", design.check)}>
              <Check className="size-3.5" />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

export function CurriculumBlock({ s, design }: { s: CurriculumSection; design: Design }) {
  return (
    <SectionShell heading={s.heading} design={design}>
      <ol className="divide-y divide-stone-100 overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        {s.modules.map((m, i) => (
          <li key={i} className="flex items-center gap-4 px-5 py-4">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-stone-50 font-mono text-xs ring-1 ring-stone-200", design.accentText)}>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 text-[15px] font-medium text-stone-800">{m.title}</span>
            <span className="shrink-0 text-xs text-stone-400">
              {m.lessonCount} {m.lessonCount === 1 ? "lesson" : "lessons"}
            </span>
          </li>
        ))}
      </ol>
    </SectionShell>
  );
}

export function InstructorBlock({ s, design }: { s: InstructorSection; design: Design }) {
  return (
    <SectionShell heading={s.heading} design={design}>
      <div className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <p className="text-[15px] font-semibold text-stone-900">{s.name}</p>
        <p className="mt-2 text-[15px] leading-relaxed text-stone-600">{s.bio}</p>
      </div>
    </SectionShell>
  );
}

export function SocialProofBlock({ s, design }: { s: SocialProofSection; design: Design }) {
  return (
    <section className={cn("mx-auto max-w-4xl px-6", design.sectionPad)}>
      <figure className="rounded-2xl border border-stone-200/80 bg-white p-8 text-center shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <blockquote className={cn("text-pretty text-xl leading-snug text-stone-800", design.headingFont)}>“{s.quote}”</blockquote>
        <figcaption className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">{s.attribution}</figcaption>
      </figure>
    </section>
  );
}

export function PricingCtaBlock({ s, design }: { s: PricingCtaSection; design: Design }) {
  return (
    <section className={cn("mx-auto max-w-4xl px-6", design.sectionPad)}>
      <div className="rounded-2xl border border-stone-200/80 bg-white p-8 text-center shadow-[0_2px_12px_rgba(68,48,28,0.08)]">
        <h2 className={cn("text-2xl tracking-tight text-stone-900 sm:text-3xl", design.headingFont)}>{s.heading}</h2>
        <p className={cn("mt-3 text-4xl", design.headingFont, design.accentText)}>{s.priceLabel}</p>
        <ul className="mx-auto mt-6 grid max-w-md gap-2.5 text-left">
          {s.points.map((p, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-stone-700">
              <Check className={cn("mt-0.5 size-4 shrink-0", design.check)} />
              {p}
            </li>
          ))}
        </ul>
        <div className="mt-7">
          <Cta label={s.ctaLabel} design={design} />
        </div>
      </div>
    </section>
  );
}

export function FaqBlock({ s, design }: { s: FaqSection; design: Design }) {
  return (
    <SectionShell heading={s.heading} design={design}>
      <dl className="space-y-5">
        {s.items.map((item, i) => (
          <div key={i} className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <dt className="text-[15px] font-semibold text-stone-900">{item.q}</dt>
            <dd className="mt-1.5 text-[15px] leading-relaxed text-stone-600">{item.a}</dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  );
}
