"use client";

/**
 * "Put my existing contacts on a list" — the one-step audience builder the
 * Leads + Audience pages surface prominently. Landing-page signups and imports
 * all land as course-level contacts; this turns any slice of them (consent
 * state × funnel stage) into a mailable list, or adds them to an existing one.
 *
 * Counts are LIVE (computed client-side from the page's own contact rows), so
 * the button always says exactly what it will do ("Create list with 4
 * contacts"). Both actions run through the gate as reversible — they land in
 * the quiet activity log with a revert window; nothing is sent.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ListPlus, Loader2, Users } from "lucide-react";
import {
  addLeadsToListAction,
  buildAudienceListAction,
  type AudienceFilterInput,
} from "@/app/(app)/marketing/campaignActions";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export interface ListBuilderContact {
  consentStatus: string;
  status: string;
}

const CONSENT_OPTIONS: { value: AudienceFilterInput["consent"]; label: string }[] = [
  { value: "confirmed", label: "Consent-confirmed (mailable now)" },
  { value: "pending", label: "Awaiting opt-in" },
  { value: "any", label: "Everyone" },
];

const STAGE_OPTIONS: { value: AudienceFilterInput["status"]; label: string }[] = [
  { value: "all", label: "Every stage" },
  { value: "lead", label: "Leads" },
  { value: "subscribed", label: "Subscribed" },
  { value: "engaged", label: "Engaged" },
  { value: "enrolled", label: "Enrolled" },
];

const selectCls =
  "h-9 rounded-xl border border-stone-300/80 bg-white px-2.5 text-sm text-stone-800 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15";

export function ListBuilder({
  courseId,
  contacts,
  lists,
}: {
  courseId: string;
  contacts: ListBuilderContact[];
  lists: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [targetList, setTargetList] = useState(lists[0]?.id ?? "");
  const [consent, setConsent] = useState<AudienceFilterInput["consent"]>("confirmed");
  const [stage, setStage] = useState<AudienceFilterInput["status"]>("all");
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, startTransition] = useTransition();

  const matchCount = useMemo(
    () =>
      contacts.filter(
        (c) =>
          c.status !== "unsubscribed" &&
          c.status !== "bounced" &&
          (stage === "all" || c.status === stage) &&
          (consent === "any" || c.consentStatus === consent)
      ).length,
    [contacts, consent, stage]
  );

  const run = () =>
    startTransition(async () => {
      setResult(null);
      const filter: AudienceFilterInput = { consent, status: stage };
      const r =
        mode === "new"
          ? await buildAudienceListAction(courseId, name.trim() || "Mailing list", filter)
          : await addLeadsToListAction(courseId, targetList, filter);
      setResult({ text: r.message, error: !!r.error });
      if (!r.error && mode === "new") setName("");
      router.refresh();
    });

  const disabled = busy || matchCount === 0 || (mode === "existing" && !targetList);

  return (
    <section
      className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      data-testid="list-builder"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-brand-200">
          <Users className="size-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-stone-900">Turn your contacts into a mailing list</h3>
          <p className="text-xs text-stone-500">
            Landing-page signups and imports are already here — slice them into a list in one step. Nothing is sent.
          </p>
        </div>
        <div className="ml-auto flex rounded-full border border-stone-200 bg-white p-0.5 text-xs">
          {(["new", "existing"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded-full px-3 py-1 font-medium transition-colors",
                mode === m ? "bg-stone-900 text-white" : "text-stone-500 hover:text-stone-800"
              )}
            >
              {m === "new" ? "New list" : "Add to existing"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode === "new" ? (
          <input
            className="h-9 min-w-44 flex-1 rounded-xl border border-stone-300/80 bg-white px-3 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
            placeholder="List name — e.g. Launch mailing list"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <select className={cn(selectCls, "min-w-44 flex-1")} value={targetList} onChange={(e) => setTargetList(e.target.value)} aria-label="Target list">
            {lists.length === 0 ? <option value="">No lists yet</option> : null}
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <select className={selectCls} value={consent} onChange={(e) => setConsent(e.target.value as AudienceFilterInput["consent"])} aria-label="Consent filter">
          {CONSENT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select className={selectCls} value={stage} onChange={(e) => setStage(e.target.value as AudienceFilterInput["status"])} aria-label="Funnel stage filter">
          {STAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={run} disabled={disabled}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ListPlus className="size-3.5" />}
          {mode === "new" ? `Create list with ${matchCount}` : `Add ${matchCount} contact${matchCount === 1 ? "" : "s"}`}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-stone-400">
        {matchCount === 0
          ? "No contacts match this slice yet."
          : consent === "confirmed"
            ? "All matches completed double opt-in — this list is mailable immediately."
            : "Contacts awaiting opt-in can be added, but won't receive campaign emails until they confirm."}
        {mode === "existing" ? " Contacts already on the list are skipped." : ""}
      </p>
      {result ? (
        <p className={cn("mt-2 rounded-lg px-2.5 py-1.5 text-xs", result.error ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800")}>
          {result.text}
          {!result.error ? " You can revert this under Recent changes on the Marketing hub." : ""}
        </p>
      ) : null}
    </section>
  );
}
