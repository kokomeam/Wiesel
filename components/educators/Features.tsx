import { Reveal, Stagger, StaggerItem } from "./motion";
import { features } from "@/lib/marketing";

export function Features() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-orange-600">
          Everything in one place
        </p>
        <h2 className="mt-3 text-3xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-4xl">
          One platform, end to end
        </h2>
        <p className="mt-3 text-base text-stone-500">
          Replace the patchwork of tools with a single, AI-native studio.
        </p>
      </Reveal>

      <Stagger
        className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4"
        stagger={0.08}
      >
        {features.map((f) => (
          <StaggerItem key={f.title}>
            <div className="group h-full rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:-translate-y-1 hover:shadow-md">
              <span className="grid size-11 place-items-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100 transition-colors group-hover:bg-orange-100">
                <f.icon className="size-5" aria-hidden />
              </span>
              <h3 className="mt-5 text-base font-semibold text-stone-900">
                {f.title}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-stone-500">
                {f.body}
              </p>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
