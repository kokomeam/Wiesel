import { CountUp } from "./CountUp";
import { Stagger, StaggerItem } from "./motion";
import { stats } from "@/lib/marketing";

export function StatsBand() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-amber-500 to-orange-600">
      {/* subtle texture */}
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        aria-hidden
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)",
          backgroundSize: "26px 26px",
        }}
      />
      <div className="relative mx-auto max-w-6xl px-6 py-16">
        <Stagger
          className="grid grid-cols-2 gap-8 lg:grid-cols-4"
          stagger={0.1}
        >
          {stats.map((s) => (
            <StaggerItem key={s.label} className="text-center">
              <div className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
                <CountUp to={s.value} suffix={s.suffix} />
              </div>
              <p className="mt-2 text-sm font-medium text-white/90">{s.label}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
