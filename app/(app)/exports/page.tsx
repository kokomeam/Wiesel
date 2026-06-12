import {
  Presentation,
  BookOpen,
  Package,
  Download,
  FileText,
  Check,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { exportFormats, recentExports, slideThemes } from "@/lib/data";

const formatIcon: Record<string, typeof Presentation> = {
  presentation: Presentation,
  book: BookOpen,
  package: Package,
};

export default function ExportsPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Export & Delivery"
        description="Ship professional, client-side deliverables — slides, handbooks and LMS packages."
      />

      {/* Formats */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {exportFormats.map((f) => {
          const Icon = formatIcon[f.icon] ?? FileText;
          return (
            <Card key={f.id} className="flex flex-col p-5">
              <span
                className={`grid size-11 place-items-center rounded-xl bg-gradient-to-br ${f.accent} text-white shadow-sm`}
              >
                <Icon className="size-5" />
              </span>
              <h3 className="mt-4 text-[15px] font-semibold text-stone-900">
                {f.title}
              </h3>
              <p className="mt-1 flex-1 text-sm leading-relaxed text-stone-500">
                {f.body}
              </p>
              <Button variant="outline" size="sm" className="mt-4 w-full">
                <Download className="size-4" />
                Export
              </Button>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Theme picker */}
        <div className="lg:col-span-1">
          <Card className="h-full">
            <CardHeader
              title="Master Theme"
              subtitle="Applied to all exported slides"
            />
            <div className="space-y-4 p-5">
              <div className="grid grid-cols-2 gap-3">
                {slideThemes.map((theme, i) => (
                  <button
                    key={theme.id}
                    className={`group relative aspect-[4/3] overflow-hidden rounded-xl bg-gradient-to-br ${theme.swatch} p-3 text-left ring-2 ${
                      i === 1 ? "ring-brand-500" : "ring-transparent hover:ring-stone-200"
                    }`}
                  >
                    <span className="text-xs font-semibold text-white/90">
                      {theme.name}
                    </span>
                    {i === 1 && (
                      <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-white text-brand-600">
                        <Check className="size-3" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="space-y-2.5 rounded-xl bg-stone-50 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Font</span>
                  <span className="font-medium text-stone-800">Geist Sans</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Speaker notes</span>
                  <span className="font-medium text-emerald-600">Embedded</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-stone-500">Watermark</span>
                  <span className="font-medium text-stone-800">Off · Pro</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Recent exports */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Recent Exports"
              subtitle="Generated client-side in your browser"
            />
            <div className="divide-y divide-stone-100">
              {recentExports.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-stone-50/70"
                >
                  <span
                    className={`grid size-9 place-items-center rounded-lg ${
                      e.type === "PPTX"
                        ? "bg-orange-50 text-orange-600"
                        : "bg-rose-50 text-rose-600"
                    }`}
                  >
                    <FileText className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-stone-800">
                      {e.name}
                    </p>
                    <p className="text-xs text-stone-400">
                      {e.size} · {e.when}
                    </p>
                  </div>
                  <Badge tone="slate">{e.type}</Badge>
                  <button className="grid size-8 place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700">
                    <Download className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
