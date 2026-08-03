import { Reveal } from "./motion";

const wordmarks = [
  "Olympiad Academy",
  "CodePrep",
  "ScholarHub",
  "ByteCamp",
  "MathWorks Edu",
  "PrepLab",
];

export function TrustStrip() {
  return (
    <section className="border-y border-stone-200/60 bg-white/40">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <Reveal>
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.24em] text-stone-400">
            Trusted by educators &amp; teams at
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {wordmarks.map((w) => (
              <span
                key={w}
                className="cursor-default text-sm font-semibold tracking-tight text-stone-400 transition-colors hover:text-stone-600"
              >
                {w}
              </span>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
