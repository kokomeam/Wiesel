/**
 * Sequence detail — reads every email in a sequence exactly as it will send
 * (renderEmailHtml, the same renderer the real Resend path uses), with its
 * schedule + send counts, and the recipients (who's enrolled + which touch
 * they're up to).
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Clock, Wand2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import { loadEmailSequence, loadSequenceRecipients, loadSequencesOverview } from "@/lib/marketing/persistence";
import { renderEmailHtml } from "@/lib/marketing/email/render";

export const dynamic = "force-dynamic";

function fmtSchedule(d: number | null, trigger: string | null): string {
  const s = d ?? 0;
  const delay = s === 0 ? "" : s % 86400 === 0 ? `+${s / 86400}d` : s % 3600 === 0 ? `+${s / 3600}h` : `+${Math.round(s / 60)}m`;
  if (trigger) return `on ${trigger}${delay ? ` ${delay}` : ""}`;
  return s === 0 ? "on signup" : delay;
}

export default async function SequenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const seq = await loadEmailSequence(supabase, id);
  if (!seq) notFound();

  const overview = (await loadSequencesOverview(supabase, seq.campaignId)).find((s) => s.id === id);
  const recipients = await loadSequenceRecipients(supabase, id);
  const countFor = (touchId: string) => overview?.touches.find((t) => t.id === touchId);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <div>
        <Link href="/marketing/sequences" className="mb-3 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700">
          <ArrowLeft className="size-4" /> Email & sequences
        </Link>
        <PageHeader
          title={seq.name}
          description={`${seq.kind === "time_launch" ? "Timed launch" : "Event-triggered"} · ${seq.status} · ${recipients.length} enrolled`}
          actions={
            <Link
              href={`/marketing/agent?course=${seq.courseId}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-300/80 bg-white px-4 text-sm font-medium text-stone-700 hover:border-stone-400 hover:bg-stone-50"
            >
              <Wand2 className="size-4" /> Edit with AI
            </Link>
          }
        />
      </div>

      {/* Emails */}
      <section className="space-y-5">
        {seq.touches.map((t, i) => {
          const counts = countFor(t.id);
          const html = renderEmailHtml(t.body, { unsubscribeUrl: "#" });
          return (
            <div key={t.id} className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 bg-stone-50/60 px-5 py-3 text-sm">
                <span className="grid size-6 place-items-center rounded-full bg-brand-50 font-mono text-xs text-brand-700 ring-1 ring-brand-100">
                  {i + 1}
                </span>
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-brand-700">
                  <Clock className="size-3" /> {fmtSchedule(t.delaySeconds, t.triggerEvent)}
                </span>
                <span className="font-medium text-stone-900">{t.subject}</span>
                <span className="flex-1" />
                {counts ? (
                  <span className="text-xs text-stone-400">
                    {counts.sent} sent{counts.queued ? ` · ${counts.queued} queued` : ""}
                  </span>
                ) : null}
              </div>
              {t.previewText ? (
                <div className="border-b border-stone-100 px-5 py-2 text-xs italic text-stone-400">Preview: {t.previewText}</div>
              ) : null}
              {/* Rendered exactly as it will send */}
              <div className="bg-stone-100/50 p-4">
                <div className="mx-auto max-w-xl rounded-lg bg-white shadow-sm" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </div>
          );
        })}
      </section>

      {/* Recipients */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">Recipients · who&apos;s on which email</h2>
        {recipients.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-8 text-center text-sm text-stone-500">
            No one enrolled yet. Activate the sequence (with subscribers on the list) to enroll them.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                  <th className="px-4 py-2.5 font-medium">Subscriber</th>
                  <th className="px-4 py-2.5 font-medium">Lifecycle</th>
                  <th className="px-4 py-2.5 font-medium">Up to</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((r, i) => (
                  <tr key={i} className="border-b border-stone-50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-stone-800">{r.name ?? "—"}</div>
                      <div className="text-xs text-stone-400">{r.email}</div>
                    </td>
                    <td className="px-4 py-3"><Badge tone="slate">{r.status}</Badge></td>
                    <td className="px-4 py-3 text-xs text-stone-500">
                      {r.enrollmentStatus === "completed"
                        ? "finished"
                        : r.enrollmentStatus === "cancelled"
                          ? "stopped"
                          : `email ${Math.min(r.currentPosition + 1, seq.touches.length)} of ${seq.touches.length}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
