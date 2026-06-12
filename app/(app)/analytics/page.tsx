import {
  Sparkles,
  TrendingDown,
  Info,
  TrendingUp,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat } from "@/components/ui/Stat";
import { Card, CardHeader } from "@/components/ui/Card";
import { AreaChart } from "@/components/charts/AreaChart";
import { cn } from "@/lib/cn";
import {
  analyticsStats,
  dropoffSeries,
  analyticsInsights,
  feedbackThemes,
} from "@/lib/data";

const toneMap = {
  warning: {
    icon: TrendingDown,
    ring: "ring-amber-100",
    bg: "bg-amber-50",
    text: "text-amber-600",
    cta: "text-amber-700",
  },
  info: {
    icon: Info,
    ring: "ring-brand-100",
    bg: "bg-brand-50",
    text: "text-brand-600",
    cta: "text-brand-700",
  },
  positive: {
    icon: TrendingUp,
    ring: "ring-emerald-100",
    bg: "bg-emerald-50",
    text: "text-emerald-600",
    cta: "text-emerald-700",
  },
} as const;

const sentimentTone = {
  positive: "bg-emerald-400",
  negative: "bg-rose-400",
  neutral: "bg-stone-300",
} as const;

const weeks = dropoffSeries.map((_, i) => `W${i + 1}`);
const maxMentions = Math.max(...feedbackThemes.map((t) => t.mentions));

export default function AnalyticsPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Analytics & Success"
        description="An AI agent watches your learner data and tells you what to fix."
        actions={
          <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm font-medium text-stone-700 hover:bg-stone-50">
            USACO Silver Bootcamp
            <ChevronDown className="size-4 text-stone-400" />
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {analyticsStats.map((s) => (
          <Stat key={s.label} {...s} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Retention curve */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Learner Drop-off"
              subtitle="Active learners by week"
              action={
                <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600">
                  <TrendingDown className="size-3.5" />
                  -42% by Week 8
                </span>
              }
            />
            <div className="px-2 pb-2 pt-5">
              <AreaChart data={dropoffSeries} color="#e11d48" height={200} />
              <div className="mt-2 flex justify-between px-3">
                {weeks.map((w, i) => (
                  <span
                    key={w}
                    className={cn(
                      "text-[10px]",
                      i === 3 ? "font-semibold text-rose-500" : "text-stone-400"
                    )}
                  >
                    {w}
                  </span>
                ))}
              </div>
            </div>
            <div className="mx-5 mb-5 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50/60 p-3">
              <TrendingDown className="mt-0.5 size-4 shrink-0 text-rose-500" />
              <p className="text-xs text-rose-700">
                <span className="font-semibold">Steepest drop at Week 3</span> —
                retention falls from 86% to 58% at the homework. A supplemental
                review lesson could recover ~18% of learners.
              </p>
            </div>
          </Card>

          {/* Feedback themes */}
          <Card className="mt-6">
            <CardHeader
              title="Feedback Themes"
              subtitle="AI-summarized from 437 reviews"
            />
            <div className="space-y-3 p-5">
              {feedbackThemes.map((t) => (
                <div key={t.theme} className="flex items-center gap-3">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      sentimentTone[t.sentiment]
                    )}
                  />
                  <span className="w-44 shrink-0 text-sm text-stone-700">
                    {t.theme}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        t.sentiment === "negative"
                          ? "bg-rose-400"
                          : t.sentiment === "neutral"
                            ? "bg-stone-300"
                            : "bg-emerald-400"
                      )}
                      style={{ width: `${(t.mentions / maxMentions) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 shrink-0 text-right text-xs text-stone-400">
                    {t.mentions}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* AI insights */}
        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-4 text-brand-500" />
                  AI Insights
                </span>
              }
              subtitle="What to do next"
            />
            <div className="space-y-3 p-4">
              {analyticsInsights.map((insight) => {
                const t = toneMap[insight.tone];
                const Icon = t.icon;
                return (
                  <div
                    key={insight.id}
                    className="rounded-xl border border-stone-200/80 bg-white p-4"
                  >
                    <span
                      className={cn(
                        "grid size-8 place-items-center rounded-lg ring-1",
                        t.bg,
                        t.text,
                        t.ring
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-stone-900">
                      {insight.title}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-stone-500">
                      {insight.body}
                    </p>
                    <button
                      className={cn(
                        "mt-3 inline-flex items-center gap-1 text-xs font-semibold",
                        t.cta
                      )}
                    >
                      {insight.cta}
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
