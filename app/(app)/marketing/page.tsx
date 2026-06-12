import {
  LayoutTemplate,
  Mail,
  Share2,
  Sparkles,
  ArrowRight,
  Check,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { marketingTools, emailSequence, socialPosts } from "@/lib/data";

const toolIcon: Record<string, typeof LayoutTemplate> = {
  layout: LayoutTemplate,
  mail: Mail,
  share: Share2,
};

export default function MarketingPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Marketing Assistant"
        description="Creating the course is half the battle — let AI help you sell it."
        actions={
          <Button>
            <Sparkles className="size-4" />
            Generate Kit
          </Button>
        }
      />

      {/* Tools */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {marketingTools.map((tool) => {
          const Icon = toolIcon[tool.icon] ?? LayoutTemplate;
          return (
            <Card
              key={tool.id}
              className="group cursor-pointer p-5 transition-all hover:border-brand-200 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                  <Icon className="size-5" />
                </span>
                <Badge tone="green" dot>
                  {tool.status}
                </Badge>
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-stone-900">
                {tool.title}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-stone-500">
                {tool.body}
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-600 group-hover:gap-2 transition-all">
                Open tool
                <ArrowRight className="size-4" />
              </span>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Landing page preview */}
        <div className="lg:col-span-3">
          <Card className="overflow-hidden">
            <CardHeader
              title="Landing Page Preview"
              subtitle="Auto-generated from your syllabus"
              action={
                <Button variant="outline" size="sm">
                  Edit
                </Button>
              }
            />
            <div className="p-6">
              <div className="rounded-xl border border-stone-200 bg-gradient-to-b from-brand-50/60 to-white p-8">
                <Badge tone="brand">USACO Silver · 10 weeks</Badge>
                <h2 className="mt-4 max-w-md text-3xl font-bold tracking-tight text-stone-900">
                  Crack USACO Silver in 10 focused weeks.
                </h2>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-stone-600">
                  A structured, problem-first bootcamp that takes you from Bronze
                  habits to Silver-level algorithmic thinking — with 48 lessons and
                  graded practice.
                </p>
                <div className="mt-5 flex items-center gap-3">
                  <Button>Enroll for $129</Button>
                  <Button variant="outline">Preview free lesson</Button>
                </div>
                <div className="mt-6 grid grid-cols-3 gap-3">
                  {["48 lessons", "Graded homework", "Lifetime access"].map((f) => (
                    <div
                      key={f}
                      className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-medium text-stone-600 ring-1 ring-stone-200"
                    >
                      <Check className="size-3.5 text-emerald-500" />
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Email + social */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="size-4 text-brand-500" />
                  Launch Email Sequence
                </span>
              }
              subtitle="4-touch campaign"
            />
            <div className="divide-y divide-stone-100">
              {emailSequence.map((e) => (
                <div key={e.day} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-12 shrink-0 text-xs font-semibold text-brand-600">
                    {e.day}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-stone-700">
                    {e.subject}
                  </span>
                  <span className="shrink-0 text-xs text-stone-400">
                    {e.open} open
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Share2 className="size-4 text-brand-500" />
                  Social Media Kit
                </span>
              }
              subtitle="Golden nuggets from your content"
            />
            <div className="space-y-3 p-4">
              {socialPosts.map((p) => (
                <div
                  key={p.channel}
                  className="rounded-xl border border-stone-200/80 bg-stone-50/40 p-3.5"
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                    {p.channel}
                  </span>
                  <p className="mt-1.5 text-sm leading-relaxed text-stone-700">
                    {p.body}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
