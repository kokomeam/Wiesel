"use client";

/**
 * The create-campaign wizard (client): 4 steps — goal (blueprint preview) →
 * lead list (consent is a GATE, not a checkbox) → sender identity (mailing
 * address required) → brief + schedule. Submits one server action.
 */

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Loader2, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { BLUEPRINTS, CAMPAIGN_GOALS, type CampaignGoal } from "@/lib/marketing/blueprints";
import { createCampaignWizardAction, type WizardInput } from "../../campaignActions";

interface ListOption {
  id: string;
  name: string;
  totalLeads: number;
  eligibleLeads: number;
  consentConfirmed: boolean;
}

interface SenderOption {
  id: string;
  fromName: string;
  fromEmail: string;
}

const STEPS = ["Goal", "Lead list & consent", "Sender", "Brief & schedule"] as const;

const inputCls =
  "w-full rounded-xl border border-stone-300/80 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15";
const labelCls = "font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400";

export function CampaignWizard({
  courseId,
  courseTitle,
  lists,
  senders,
}: {
  courseId: string;
  courseTitle: string;
  lists: ListOption[];
  senders: SenderOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [goal, setGoal] = useState<CampaignGoal>("launch_course");
  const [name, setName] = useState(`Launch — ${courseTitle}`);
  const [length, setLength] = useState<number | null>(null);

  const [listId, setListId] = useState<string | null>(lists[0]?.id ?? null);
  const [newListName, setNewListName] = useState("");

  const [senderId, setSenderId] = useState<string | null>(senders[0]?.id ?? null);
  const [fromName, setFromName] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [businessName, setBusinessName] = useState("");

  const [audienceNotes, setAudienceNotes] = useState("");
  const [proofPoints, setProofPoints] = useState("");
  const [offerDetails, setOfferDetails] = useState("");
  const [thingsToAvoid, setThingsToAvoid] = useState("");
  const [offerDeadline, setOfferDeadline] = useState("");
  const [startHour, setStartHour] = useState(9);
  const [endHour, setEndHour] = useState(11);
  const [skipWeekends, setSkipWeekends] = useState(true);

  const blueprint = BLUEPRINTS[goal];

  const stepValid = useMemo(() => {
    if (step === 0) return name.trim().length > 0;
    if (step === 1) return !!listId || newListName.trim().length > 0;
    if (step === 2) return !!senderId || (fromName.trim() && fromEmail.trim() && mailingAddress.trim());
    if (step === 3) return goal !== "promote_discount" || !!offerDeadline;
    return true;
  }, [step, name, listId, newListName, senderId, fromName, fromEmail, mailingAddress, goal, offerDeadline]);

  function submit() {
    setError(null);
    const input: WizardInput = {
      name: name.trim(),
      goal,
      leadListId: listId,
      newListName: listId ? null : newListName.trim() || null,
      sender: senderId
        ? null
        : {
            fromName: fromName.trim(),
            fromEmail: fromEmail.trim(),
            replyTo: replyTo.trim() || null,
            mailingAddress: mailingAddress.trim(),
            businessName: businessName.trim() || null,
          },
      existingSenderId: senderId,
      brief: {
        audienceNotes: audienceNotes.trim() || null,
        proofPoints: proofPoints.trim() || null,
        offerDetails: offerDetails.trim() || null,
        thingsToAvoid: thingsToAvoid.trim() || null,
        freeform: null,
        language: null,
        offerDeadlineIso: offerDeadline ? new Date(offerDeadline).toISOString() : null,
      },
      schedule: { startHour, endHour, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", skipWeekends },
      sequenceLength: length,
    };
    startTransition(async () => {
      try {
        const { campaignId } = await createCampaignWizardAction(courseId, input);
        router.push(`/marketing/email/${campaignId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* step chips */}
      <div className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-[0.08em] ring-1 ring-inset",
              i < step && "bg-emerald-50 text-emerald-700 ring-emerald-100",
              i === step && "bg-brand-50 text-brand-700 ring-brand-200",
              i > step && "bg-white text-stone-400 ring-stone-200"
            )}
          >
            {i < step ? <Check className="size-3" /> : <span>{i + 1}</span>} {s}
          </span>
        ))}
      </div>

      <div className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <p className={labelCls}>Campaign name</p>
              <input className={cn(inputCls, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <p className={labelCls}>Goal</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CAMPAIGN_GOALS.map((g) => {
                  const bp = BLUEPRINTS[g];
                  return (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setGoal(g)}
                      className={cn(
                        "rounded-xl border p-3 text-left text-sm transition-colors",
                        goal === g ? "border-brand-300 bg-brand-50 text-brand-900" : "border-stone-200 bg-white text-stone-700 hover:border-stone-300"
                      )}
                    >
                      <span className="font-medium">{bp.label}</span>
                      <span className="mt-0.5 block text-xs text-stone-500">
                        {bp.defaultLength} emails (min {bp.minLength} · max {bp.maxLength})
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-4">
              <p className="text-sm font-semibold text-stone-900">What the AI will draft — “{blueprint.label}”</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-600">
                {blueprint.stages.slice(0, length ?? blueprint.defaultLength).map((s) => (
                  <li key={s.key}>
                    {s.name} <span className="text-xs text-stone-400">· day {s.dayOffset}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-stone-500">{blueprint.timingNote}</p>
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className={labelCls}>Emails:</span>
                {Array.from({ length: blueprint.maxLength - blueprint.minLength + 1 }, (_, i) => blueprint.minLength + i).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setLength(n)}
                    className={cn(
                      "size-7 rounded-full text-xs font-semibold ring-1 ring-inset",
                      (length ?? blueprint.defaultLength) === n ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-stone-500 ring-stone-200 hover:ring-stone-300"
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              Consent is a gate, not a checkbox — a list without confirmed consent can’t launch. Eligible = consented and not unsubscribed/bounced.
            </p>
            {lists.length > 0 && (
              <div className="space-y-2">
                {lists.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setListId(l.id)}
                    className={cn(
                      "flex w-full flex-wrap items-center gap-3 rounded-xl border p-3 text-left text-sm",
                      listId === l.id ? "border-brand-300 bg-brand-50" : "border-stone-200 bg-white hover:border-stone-300"
                    )}
                  >
                    <span className="font-medium text-stone-900">{l.name}</span>
                    <span className="text-xs text-stone-500">
                      {l.eligibleLeads}/{l.totalLeads} eligible
                    </span>
                    {l.consentConfirmed ? (
                      <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <ShieldCheck className="size-3.5" /> Consent confirmed
                      </span>
                    ) : (
                      <span className="ml-auto text-xs font-medium text-amber-700">Consent pending</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="rounded-xl border border-dashed border-stone-300 p-4">
              <p className={labelCls}>Or create a new (empty) list to import into later</p>
              <input
                className={cn(inputCls, "mt-2")}
                placeholder="e.g. Interest signups"
                value={newListName}
                onChange={(e) => {
                  setNewListName(e.target.value);
                  if (e.target.value) setListId(null);
                }}
              />
              <p className="mt-2 text-xs text-stone-500">Manual imports require the consent confirmation and double opt-in before anyone can be emailed.</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {senders.length > 0 && (
              <div className="space-y-2">
                {senders.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSenderId(s.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm",
                      senderId === s.id ? "border-brand-300 bg-brand-50" : "border-stone-200 bg-white hover:border-stone-300"
                    )}
                  >
                    <span className="font-medium text-stone-900">{s.fromName}</span>
                    <span className="text-xs text-stone-500">&lt;{s.fromEmail}&gt;</span>
                  </button>
                ))}
                <button type="button" onClick={() => setSenderId(null)} className={cn("text-sm font-medium", senderId === null ? "text-brand-700" : "text-stone-500 hover:text-stone-900")}>
                  + New sender identity
                </button>
              </div>
            )}
            {(senders.length === 0 || senderId === null) && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <p className={labelCls}>From name *</p>
                  <input className={cn(inputCls, "mt-1")} value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your name" />
                </div>
                <div>
                  <p className={labelCls}>From email *</p>
                  <input className={cn(inputCls, "mt-1")} value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="you@mail.wisesel.pro" />
                </div>
                <div>
                  <p className={labelCls}>Reply-to</p>
                  <input className={cn(inputCls, "mt-1")} value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="optional" />
                </div>
                <div>
                  <p className={labelCls}>Business name</p>
                  <input className={cn(inputCls, "mt-1")} value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="optional" />
                </div>
                <div className="sm:col-span-2">
                  <p className={labelCls}>Mailing address * — required in every marketing email footer</p>
                  <input
                    className={cn(inputCls, "mt-1")}
                    value={mailingAddress}
                    onChange={(e) => setMailingAddress(e.target.value)}
                    placeholder="A P.O. box or virtual business address is fine"
                  />
                </div>
              </div>
            )}
            <p className="text-xs text-stone-500">
              MVP sends go out on the platform’s verified domain; per-creator verified domains (SPF/DKIM/DMARC) come later with no flow change.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              The Campaign Brief grounds the copy in what only you know — optional but strongly encouraged. The AI cites what came from the course vs. your brief.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className={labelCls}>Audience notes — who they are, where they’re stuck</p>
                <textarea className={cn(inputCls, "mt-1 h-20 resize-none")} value={audienceNotes} onChange={(e) => setAudienceNotes(e.target.value)} />
              </div>
              <div>
                <p className={labelCls}>Credibility / proof points — results, testimonials, years teaching</p>
                <textarea className={cn(inputCls, "mt-1 h-20 resize-none")} value={proofPoints} onChange={(e) => setProofPoints(e.target.value)} />
              </div>
              <div>
                <p className={labelCls}>Offer details — price, date, what’s included</p>
                <textarea className={cn(inputCls, "mt-1 h-20 resize-none")} value={offerDetails} onChange={(e) => setOfferDetails(e.target.value)} />
              </div>
              <div>
                <p className={labelCls}>Things to avoid — “never promise financial returns”</p>
                <textarea className={cn(inputCls, "mt-1 h-20 resize-none")} value={thingsToAvoid} onChange={(e) => setThingsToAvoid(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <p className={labelCls}>{goal === "promote_discount" ? "Real offer deadline * (required for discounts)" : "Real offer deadline (optional)"}</p>
                <input type="datetime-local" className={cn(inputCls, "mt-1")} value={offerDeadline} onChange={(e) => setOfferDeadline(e.target.value)} />
              </div>
              <div>
                <p className={labelCls}>Send window (your timezone)</p>
                <div className="mt-1 flex items-center gap-2">
                  <input type="number" min={0} max={23} className={cn(inputCls, "w-20")} value={startHour} onChange={(e) => setStartHour(Number(e.target.value))} />
                  <span className="text-sm text-stone-500">to</span>
                  <input type="number" min={0} max={23} className={cn(inputCls, "w-20")} value={endHour} onChange={(e) => setEndHour(Number(e.target.value))} />
                </div>
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm text-stone-700">
                <input type="checkbox" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} className="size-4 rounded border-stone-300 text-brand-600" />
                Skip weekends
              </label>
            </div>
            {goal === "promote_discount" && !offerDeadline && (
              <p className="text-xs font-medium text-amber-700">
                The “Promote a discount” blueprint requires a real end date — deadline copy is anchored to it (fake scarcity is blocked).
              </p>
            )}
          </div>
        )}
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || pending}>
          <ChevronLeft className="size-4" /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!stepValid || pending}>
            Continue <ChevronRight className="size-4" />
          </Button>
        ) : (
          <Button onClick={submit} disabled={!stepValid || pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {pending ? "Drafting your sequence…" : "Create & draft sequence"}
          </Button>
        )}
      </div>
    </div>
  );
}
