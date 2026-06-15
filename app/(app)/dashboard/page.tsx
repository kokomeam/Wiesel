import Link from "next/link";
import {
  Plus,
  ChevronRight,
  Users,
  Sparkles,
  TrendingUp,
  BarChart3,
  Megaphone,
  PenLine,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat } from "@/components/ui/Stat";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, statusTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AreaChart } from "@/components/charts/AreaChart";
import { createNewCourse } from "@/app/(app)/studio/actions";
import {
  courses,
  dashboardStats,
  revenueSeries,
  aiSuggestions,
  currentUser,
} from "@/lib/data";

const suggestionIcon: Record<string, typeof BarChart3> = {
  Analytics: BarChart3,
  Marketing: Megaphone,
  Content: PenLine,
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title={`Welcome back, ${currentUser.name.split(" ")[0]}`}
        description="Here's what's happening across your courses today."
        actions={
          <form action={createNewCourse}>
            <Button type="submit">
              <Plus className="size-4" />
              New Course
            </Button>
          </form>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {dashboardStats.map((s) => (
          <Stat key={s.label} {...s} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Courses */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title="Your Courses"
              subtitle="Pick up where you left off"
              action={
                <Link
                  href="/marketplace"
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  View all
                </Link>
              }
            />
            <div className="divide-y divide-stone-100">
              {courses.map((course) => (
                <Link
                  key={course.id}
                  href="/studio"
                  className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-stone-50/70"
                >
                  <div
                    className={`grid size-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${course.accent} text-sm font-bold text-white shadow-sm`}
                  >
                    {course.level.slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-stone-900">
                        {course.title}
                      </p>
                      <Badge tone={statusTone(course.status)} dot>
                        {course.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 flex items-center gap-3 text-xs text-stone-500">
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3.5" />
                        {course.learners.toLocaleString()} learners
                      </span>
                      <span>{course.lessons} lessons</span>
                      <span className="hidden sm:inline">
                        Updated {course.updated}
                      </span>
                    </p>
                  </div>
                  <div className="hidden w-32 shrink-0 sm:block">
                    <div className="flex items-center justify-between text-[11px] text-stone-400">
                      <span>Build</span>
                      <span>{course.progress}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-stone-100">
                      <div
                        className="h-full rounded-full brand-gradient"
                        style={{ width: `${course.progress}%` }}
                      />
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-stone-300" />
                </Link>
              ))}
            </div>
          </Card>

          {/* Revenue */}
          <Card>
            <CardHeader
              title="Revenue"
              subtitle="Last 10 months · all courses"
              action={
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                  <TrendingUp className="size-3.5" />
                  +8.2%
                </span>
              }
            />
            <div className="px-2 pb-2 pt-4">
              <AreaChart data={revenueSeries} height={170} />
            </div>
          </Card>
        </div>

        {/* AI suggestions */}
        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-4 text-brand-500" />
                  AI Suggestions
                </span>
              }
              subtitle="Generated from your latest data"
            />
            <div className="space-y-3 p-4">
              {aiSuggestions.map((s) => {
                const Icon = suggestionIcon[s.kind] ?? Sparkles;
                return (
                  <div
                    key={s.id}
                    className="rounded-xl border border-stone-200/80 bg-stone-50/40 p-3.5 transition-colors hover:border-brand-200 hover:bg-brand-50/30"
                  >
                    <div className="flex items-center gap-2">
                      <span className="grid size-7 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-stone-200">
                        <Icon className="size-3.5" />
                      </span>
                      <span className="text-xs font-medium text-stone-400">
                        {s.kind}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-stone-900">
                      {s.title}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-stone-500">
                      {s.body}
                    </p>
                    <button className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700">
                      {s.cta}
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
