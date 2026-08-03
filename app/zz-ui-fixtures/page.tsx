"use client";

/**
 * Dev fixtures route — renders every ui/ primitive in every state from the
 * SAME fixture list the verify:ui snapshots pin (components/ui/fixtures.tsx).
 * The lightweight stand-in for Storybook this repo deliberately doesn't have.
 */

import { UI_FIXTURES } from "@/components/ui/fixtures";

export default function UiFixturesPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <h1 className="font-display text-display font-light text-stone-900">UI fixtures</h1>
      <p className="text-secondary text-stone-500">
        Every primitive, every state — the verify:ui snapshot suite renders exactly this list.
      </p>
      <div className="space-y-4">
        {UI_FIXTURES.map((f) => (
          <section key={f.name} data-fixture={f.name} className="space-y-1.5">
            <p className="font-mono text-meta uppercase tracking-eyebrow text-stone-400">{f.name}</p>
            <div className="rounded-panel border border-dashed border-stone-200 bg-white p-4">{f.node}</div>
          </section>
        ))}
      </div>
    </main>
  );
}
