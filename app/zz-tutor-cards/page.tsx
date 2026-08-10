"use client";

/**
 * TUTOR-1 A3 Wave 6 — dev fixtures route for the five A3 interactive tutor cards
 * (+ the A3-4 escape-hatch gate and the A3-18 malformed-item fallback). Mirrors
 * app/zz-ui-fixtures/page.tsx: renders the same fixture list the automated a11y +
 * keyboard suite (scripts/verify-tutor-cards-browser.ts) drives, each in a
 * `data-fixture={name}` section, so what the suite pins is what a human eyeballs.
 *
 * Public (like the other zz- routes): NOT in the middleware PROTECTED regex, so
 * no auth is needed to open it. The cards' evidence POSTs are fire-and-forget and
 * swallow every error, so the surface is fully exercisable without a session.
 */

import { CARD_FIXTURES } from "@/components/learn/tutor/cardFixtures";

export default function TutorCardFixturesPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="font-display text-display font-light text-stone-900">Tutor card fixtures</h1>
      <p className="text-secondary text-stone-600">
        The five A3 interactive cards in a deterministic state, plus the A3-4 escape-hatch gate and
        the A3-18 malformed-item fallback — the automated a11y + keyboard suite renders exactly this list.
      </p>
      <div className="space-y-4">
        {CARD_FIXTURES.map((f) => (
          <section key={f.name} data-fixture={f.name} className="space-y-1.5">
            <p className="font-mono text-meta uppercase tracking-eyebrow text-stone-600">{f.name}</p>
            <div className="rounded-panel border border-dashed border-stone-200 bg-white p-4">{f.node}</div>
          </section>
        ))}
      </div>
    </main>
  );
}
