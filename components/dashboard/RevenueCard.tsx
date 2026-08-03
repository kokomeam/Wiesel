import { Card } from "@/components/ui/Card";

/**
 * Deliberately slim + honest: there is no payments data anywhere in the
 * product yet (Stripe is a roadmap milestone), so this renders an em-dash —
 * never a fake chart or mock numbers.
 */
export function RevenueCard() {
  return (
    <Card className="p-5">
      <p className="font-mono text-[11px] uppercase tracking-wider text-brand-700">
        Revenue
      </p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-300">—</p>
      <p className="mt-1 text-xs leading-relaxed text-stone-400">
        Arrives with payments — Stripe integration is on the roadmap.
      </p>
    </Card>
  );
}
