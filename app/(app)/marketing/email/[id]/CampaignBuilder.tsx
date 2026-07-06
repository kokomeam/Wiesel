"use client";

/**
 * The campaign builder client — step cards (edit · regenerate · variants ·
 * approve · delete), follow-up rules, compliance panel, launch checklist +
 * gate, brief + voice editing, and the embedded Marketing Assistant. Every
 * button routes a gated server action; nothing mutates outside the tool seam.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { EmailBody } from "@/lib/marketing/types";
import { AgentPanel } from "@/components/marketing/agent/AgentPanel";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import type { PendingActionPayload } from "../../actions";
import {
  approveCampaignAction,
  approveStepAction,
  attachLeadListAction,
  attachSenderAction,
  cancelCampaignRequestAction,
  createSenderAction,
  deleteStepAction,
  generateVariantsAction,
  pauseCampaignAction,
  processDueSendsAction,
  regenerateStepAction,
  requestLaunchAction,
  resumeCampaignAction,
  runComplianceAction,
  sendTestEmailAction,
  updateBriefAction,
  updateStepAction,
  updateVoiceProfileAction,
} from "../../campaignActions";

/* ─────────────────────────────── types ─────────────────────────────── */

interface Touch {
  id: string;
  position: number;
  stageName: string | null;
  subject: string;
  previewText: string | null;
  body: EmailBody;
  delaySeconds: number | null;
  approvalStatus: "draft" | "pending_review" | "approved";
  aiRationale: string | null;
  personalizationVariables: string[];
  qualityScore: { score: number; failedCriteria: string[]; passedCriteria: string[] } | null;
}

interface ComplianceReport {
  findings?: { key: string; label: string; severity: "blocking" | "warning"; detail: string }[];
  quality?: { touchId: string; stageName: string | null; score: number; failedCriteria: string[] }[];
  reviewedAt?: string;
}

export interface BuilderProps {
  campaign: {
    id: string;
    courseId: string;
    name: string;
    status: string;
    complianceStatus: string;
    complianceReport: ComplianceReport;
    goalLabel: string;
    brief: Record<string, string | undefined>;
    sendWindow: { startHour: number; endHour: number; timezone: string; skipWeekends: boolean } | null;
    autoPauseReason: { metric: string; value: number; threshold: number } | null;
  };
  courseTitle: string;
  analysis: { audience: string | null; outcomes: string[]; proofPoints: string | null };
  sequence: { id: string; status: string; touches: Touch[] } | null;
  rules: { id: string; name: string; trigger: string; delayDays: number; status: string }[];
  sender: { fromName: string; fromEmail: string; mailingAddress: string } | null;
  senders: { id: string; fromName: string; fromEmail: string; mailingAddress: string }[];
  list: { name: string; totalLeads: number; eligibleLeads: number; consentConfirmed: boolean } | null;
  lists: { id: string; name: string; totalLeads: number; eligibleLeads: number; awaitingConsentRequest: number }[];
  attachedListId: string | null;
  delivery: { queued: number; sent: number; skipped: number; failed: number; cancelled: number; nextDueAt: string | null } | null;
  /** Server-computed send-window truth (never derived client-side — no clock in render). */
  sendWindowInfo: { description: string; openNow: boolean; nextOpenAt: string | null; heldNow: boolean };
  checklist: { items: { key: string; label: string; ok: boolean; detail: string }[]; canLaunch: boolean };
  pendingApprovals: PendingActionPayload[];
  voiceRules: string[];
  creatorEmail: string;
}

const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose" | "brand"> = {
  draft: "slate",
  generated: "sky",
  in_review: "amber",
  approved: "green",
  active: "brand",
  paused: "sky",
  completed: "green",
  cancelled: "rose",
  failed: "rose",
};

const labelCls = "font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400";
const inputCls =
  "w-full rounded-xl border border-stone-300/80 bg-white px-3 py-2 text-sm text-stone-800 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15";

function bodyToText(body: EmailBody): string {
  return body.blocks
    .map((b) => (b.kind === "paragraph" || b.kind === "heading" ? b.text : b.kind === "bullets" ? b.items.map((i) => `• ${i}`).join("\n") : `[${b.label}](${b.href})`))
    .join("\n\n");
}

/* ─────────────────────────── step card ─────────────────────────── */

function StepCard({
  campaignId,
  sequenceId,
  touch,
  launched,
  creatorEmail,
}: {
  campaignId: string;
  sequenceId: string;
  touch: Touch;
  launched: boolean;
  creatorEmail: string;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(touch.subject);
  const [preview, setPreview] = useState(touch.previewText ?? "");
  const [bodyText, setBodyText] = useState(bodyToText(touch.body));
  const [variants, setVariants] = useState<string[] | null>(null);
  const [testSent, setTestSent] = useState<string | null>(null);
  const [testPending, setTestPending] = useState<PendingActionPayload | null>(null);

  const dayOffset = touch.delaySeconds !== null ? Math.round(touch.delaySeconds / 86400) : null;
  const approved = touch.approvalStatus === "approved";

  function saveEdit() {
    // Preserve buttons; replace text blocks from the edited plain text.
    const buttons = touch.body.blocks.filter((b) => b.kind === "button");
    const paragraphs = bodyText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) =>
        p.startsWith("•")
          ? { kind: "bullets" as const, items: p.split("\n").map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean) }
          : { kind: "paragraph" as const, text: p }
      );
    startTransition(async () => {
      await updateStepAction(campaignId, {
        sequenceId,
        touchId: touch.id,
        subject,
        previewText: preview || null,
        body: { blocks: [...paragraphs, ...buttons] },
        delaySeconds: touch.delaySeconds,
      });
      setEditing(false);
    });
  }

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        approved ? "border-stone-200/80" : "border-amber-200 ring-1 ring-amber-100"
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-3">
        <span className="rounded-md border border-brand-100 bg-brand-50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-brand-700">
          {touch.position + 1} · {touch.stageName ?? "Step"}
        </span>
        {dayOffset !== null && (
          <span className="rounded-md border border-dashed border-stone-200 px-2 py-0.5 font-mono text-[10px] text-stone-500">
            {dayOffset === 0 ? "on launch" : `+${dayOffset} day${dayOffset === 1 ? "" : "s"}`}
          </span>
        )}
        {touch.qualityScore && (
          <span
            className={cn(
              "rounded-md px-2 py-0.5 font-mono text-[10px]",
              touch.qualityScore.score >= 80 ? "bg-emerald-50 text-emerald-700" : touch.qualityScore.score >= 60 ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"
            )}
            title={touch.qualityScore.failedCriteria.join("\n") || "All rubric criteria pass"}
          >
            quality {touch.qualityScore.score}
          </span>
        )}
        <span className="ml-auto" />
        {approved ? (
          <Badge tone="green" dot>
            Approved
          </Badge>
        ) : (
          <Badge tone="amber" dot>
            Pending review
          </Badge>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} className="grid size-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-100">
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      <div className="px-4 py-3">
        {editing ? (
          <div className="space-y-2">
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} />
            <input className={inputCls} value={preview} onChange={(e) => setPreview(e.target.value)} placeholder="Preview text (40–90 chars)" />
            <textarea className={cn(inputCls, "h-40")} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveEdit} disabled={pending}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-stone-400">Editing an approved step returns it (and the campaign) to review.</p>
          </div>
        ) : (
          <>
            <p className="font-medium text-stone-900">{touch.subject}</p>
            {touch.previewText && <p className="mt-0.5 text-xs text-stone-500">{touch.previewText}</p>}
            {open && (
              <div className="mt-3 space-y-3 border-t border-dashed border-stone-200 pt-3">
                <pre className="whitespace-pre-wrap font-sans text-sm text-stone-700">{bodyToText(touch.body)}</pre>
                {touch.aiRationale && (
                  <p className="text-xs text-stone-500">
                    <span className={labelCls}>Rationale · </span>
                    {touch.aiRationale}
                  </p>
                )}
                {touch.personalizationVariables.length > 0 && (
                  <p className="text-xs text-stone-500">
                    <span className={labelCls}>Personalization · </span>
                    {touch.personalizationVariables.join(", ")}
                  </p>
                )}
                {touch.qualityScore && touch.qualityScore.failedCriteria.length > 0 && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <p className="font-semibold">Quality rubric (advisory):</p>
                    <ul className="mt-1 list-disc pl-4">
                      {touch.qualityScore.failedCriteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {variants && (
                  <div className="rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-700">
                    <p className="font-semibold">Variants (pick one manually — no A/B experiments):</p>
                    <ul className="mt-1 list-disc pl-4">
                      {variants.map((v) => (
                        <li key={v}>{v}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {!editing && (
        <div className="flex flex-wrap gap-1.5 border-t border-stone-100 bg-stone-50/50 px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(() => regenerateStepAction(campaignId, sequenceId, touch.id))}>
            <RefreshCw className={cn("size-3.5", pending && "animate-spin")} /> Regenerate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setVariants(await generateVariantsAction(campaignId, sequenceId, touch.id, "subject"));
                setOpen(true);
              })
            }
          >
            <Sparkles className="size-3.5" /> Variants
          </Button>
          {!launched && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(() => deleteStepAction(campaignId, sequenceId, touch.id))}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
          {creatorEmail && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setTestSent(null);
                  setTestPending(null);
                  try {
                    const r = await sendTestEmailAction(campaignId, creatorEmail, touch.subject, touch.body);
                    if (r.status === "executed") setTestSent(r.message);
                    else if (r.pending) setTestPending(r.pending);
                    else setTestSent(r.message);
                  } catch (e) {
                    setTestSent(e instanceof Error ? e.message : String(e));
                  }
                })
              }
            >
              <Send className="size-3.5" /> Send test
            </Button>
          )}
          <span className="ml-auto" />
          <Button
            size="sm"
            variant={approved ? "ghost" : "outline"}
            disabled={pending}
            onClick={() => startTransition(() => approveStepAction(campaignId, sequenceId, touch.id, !approved))}
          >
            {approved ? (
              <>
                <X className="size-3.5" /> Un-approve
              </>
            ) : (
              <>
                <Check className="size-3.5" /> Approve
              </>
            )}
          </Button>
        </div>
      )}
      {testSent && <p className="border-t border-stone-100 bg-stone-50/50 px-4 py-2 text-xs text-stone-500">{testSent}</p>}
      {testPending && (
        <div className="border-t border-stone-100 p-3">
          <ApprovalCard
            pending={testPending}
            compact
            onResolved={() => setTestPending(null)}
            onResult={(r) => setTestSent(r.message)}
          />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── guided setup pieces ─────────────────────── */

/** The five-stop map of the whole flow — always visible, so a creator never
 *  has to guess what comes next or where a missing piece lives. */
function Stepper({ steps }: { steps: { label: string; done: boolean; hint: string }[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-2xl border border-stone-200/80 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              s.done ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-600"
            )}
            title={s.hint}
          >
            {s.done ? <Check className="size-3.5" /> : <span className="grid size-4 place-items-center rounded-full bg-stone-200 text-[10px]">{i + 1}</span>}
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="px-0.5 text-stone-300">→</span>}
        </li>
      ))}
    </ol>
  );
}

function AudienceCard({
  campaignId,
  list,
  lists,
  attachedListId,
}: {
  campaignId: string;
  list: BuilderProps["list"];
  lists: BuilderProps["lists"];
  attachedListId: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string>(attachedListId ?? lists[0]?.id ?? "");

  return (
    <div className={cn("rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]", list ? "border-stone-200/80" : "border-amber-200 ring-1 ring-amber-100")}>
      <p className={labelCls}>1 · Audience (who receives this)</p>
      {list ? (
        <div className="mt-2 text-sm text-stone-800">
          <p className="font-medium">{list.name}</p>
          <p className="text-xs text-stone-500">
            <span className="text-emerald-700">{list.eligibleLeads} eligible</span> of {list.totalLeads}
            {list.eligibleLeads === 0 && (
              <span className="text-amber-700"> — contacts must confirm consent before they can be emailed</span>
            )}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-800">No list attached yet — pick one below, or import contacts first.</p>
      )}
      <div className="mt-3 space-y-2">
        {lists.length > 0 && (
          <div className="flex gap-2">
            <select className={cn(inputCls, "flex-1 text-xs")} value={selected} onChange={(e) => setSelected(e.target.value)}>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.eligibleLeads}/{l.totalLeads} eligible)
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !selected || selected === attachedListId}
              onClick={() => startTransition(() => attachLeadListAction(campaignId, selected))}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : "Attach"}
            </Button>
          </div>
        )}
        <Link href="/marketing/leads" className="inline-block text-xs font-medium text-brand-700 hover:text-brand-800">
          Import contacts / manage consent →
        </Link>
      </div>
    </div>
  );
}

function SenderCard({
  campaignId,
  sender,
  senders,
  creatorEmail,
}: {
  campaignId: string;
  sender: BuilderProps["sender"];
  senders: BuilderProps["senders"];
  creatorEmail: string;
}) {
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ fromName: "", fromEmail: creatorEmail, mailingAddress: "" });
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={cn("rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]", sender ? "border-stone-200/80" : "border-amber-200 ring-1 ring-amber-100")}>
      <p className={labelCls}>2 · Sender (who it&apos;s from)</p>
      {sender ? (
        <div className="mt-2 text-sm text-stone-800">
          <p className="font-medium">
            {sender.fromName} <span className="font-normal text-stone-500">&lt;{sender.fromEmail}&gt;</span>
          </p>
          <p className="text-xs text-stone-500">{sender.mailingAddress}</p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-800">Every marketing email legally needs a sender name + mailing address.</p>
      )}
      <div className="mt-3 space-y-2">
        {senders.length > 0 && !creating && (
          <div className="flex flex-col gap-1.5">
            {senders.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => startTransition(() => attachSenderAction(campaignId, s.id))}
              >
                Use {s.fromName} &lt;{s.fromEmail}&gt;
              </Button>
            ))}
          </div>
        )}
        {creating ? (
          <div className="space-y-2">
            <input className={cn(inputCls, "text-xs")} placeholder="From name (e.g. Henry from WiseSel)" value={form.fromName} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} />
            <div>
              <input className={cn(inputCls, "text-xs")} placeholder="Your email (replies land here)" value={form.fromEmail} onChange={(e) => setForm((f) => ({ ...f, fromEmail: e.target.value }))} />
              <p className="mt-1 text-[11px] leading-relaxed text-stone-400">
                Replies go to this address. The actual From address is always the platform&apos;s verified sending domain — this can be any inbox you own.
              </p>
            </div>
            <div>
              <input
                className={cn(inputCls, "text-xs")}
                placeholder="Postal address — e.g. 123 Main St, Portland, OR 97201"
                value={form.mailingAddress}
                onChange={(e) => setForm((f) => ({ ...f, mailingAddress: e.target.value }))}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-stone-400">
                A physical mailing address is legally required in every marketing email&apos;s footer (CAN-SPAM). A business address or PO box works — it doesn&apos;t have to be your home.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !form.fromName.trim() || !form.fromEmail.includes("@") || !form.mailingAddress.trim()}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    try {
                      await createSenderAction(campaignId, {
                        fromName: form.fromName.trim(),
                        fromEmail: form.fromEmail.trim(),
                        replyTo: null,
                        mailingAddress: form.mailingAddress.trim(),
                        businessName: null,
                      });
                      setCreating(false);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  })
                }
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Save sender
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
            {error && <p className="text-xs text-red-700">{error}</p>}
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            + New sender identity
          </Button>
        )}
      </div>
    </div>
  );
}

function DeliveryCard({
  campaignId,
  campaignStatus,
  delivery,
  windowInfo,
}: {
  campaignId: string;
  campaignStatus: string;
  delivery: NonNullable<BuilderProps["delivery"]>;
  windowInfo: BuilderProps["sendWindowInfo"];
}) {
  const [pending, startTransition] = useTransition();
  const [lastRun, setLastRun] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <p className={labelCls}>Delivery</p>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Queued", delivery.queued],
            ["Sent", delivery.sent],
            ["Failed", delivery.failed],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-xl bg-stone-50 px-2 py-2">
            <p className="text-lg font-semibold text-stone-900">{n}</p>
            <p className="text-[10px] uppercase tracking-wide text-stone-400">{label}</p>
          </div>
        ))}
      </div>
      {campaignStatus === "paused" ? (
        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600" data-testid="delivery-paused">
          <strong className="text-stone-800">Campaign paused</strong> — the {delivery.queued} queued email
          {delivery.queued === 1 ? " is" : "s are"} held, not deleted. Nothing sends until you Resume (top of the page).
        </div>
      ) : campaignStatus === "cancelled" ? (
        <div className="mt-2 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600">
          <strong className="text-stone-800">Campaign cancelled</strong> — all remaining sends were permanently stopped.
        </div>
      ) : windowInfo.heldNow ? (
        <div className="mt-2 rounded-xl border border-amber-200/80 bg-amber-50/60 px-3 py-2 text-xs text-amber-900" data-testid="delivery-held">
          {delivery.queued} queued email{delivery.queued === 1 ? "" : "s"} {delivery.queued === 1 ? "is" : "are"} due
          but <strong>held until your send window opens</strong> ({windowInfo.description}).
          {windowInfo.nextOpenAt && <> Next opening: {new Date(windowInfo.nextOpenAt).toLocaleString()} your time.</>}{" "}
          Nothing is lost — they go out on the first delivery run inside the window.
        </div>
      ) : delivery.nextDueAt ? (
        <p className="mt-2 text-xs text-stone-500">
          Next send due {new Date(delivery.nextDueAt).toLocaleString()} — it goes out inside the send window ({windowInfo.description}).
        </p>
      ) : null}
      {windowInfo.openNow && delivery.queued > 0 && campaignStatus !== "paused" && campaignStatus !== "cancelled" && (
        <p className="mt-2 text-xs text-emerald-700">The send window is open now — process due sends below or wait for the scheduler.</p>
      )}
      {delivery.queued > 0 && campaignStatus !== "paused" && campaignStatus !== "cancelled" && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3 w-full"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setLastRun(null);
              try {
                const r = await processDueSendsAction(campaignId);
                setLastRun(
                  r.processed === 0
                    ? "Nothing due yet — sends wait for their scheduled time."
                    : `${r.sent} sent${r.heldByWindow ? ` · ${r.heldByWindow} held for the send window` : ""}${r.heldByRamp ? ` · ${r.heldByRamp} held by the daily ramp` : ""}.`
                );
              } catch (e) {
                setLastRun(e instanceof Error ? e.message : String(e));
              }
            })
          }
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Process due sends now
        </Button>
      )}
      {lastRun && <p className="mt-2 text-xs text-stone-500">{lastRun}</p>}
    </div>
  );
}

/* ───────────────────────── the builder ───────────────────────── */

export function CampaignBuilder(props: BuilderProps) {
  const { campaign, sequence, checklist, pendingApprovals } = props;
  const [pending, startTransition] = useTransition();
  const [briefOpen, setBriefOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [approvalOutcome, setApprovalOutcome] = useState<{ text: string; error: boolean } | null>(null);
  /** Approval cards created THIS session by a request button (launch/cancel) —
   *  rendered immediately in place, deduped against the server-loaded list. */
  const [localPending, setLocalPending] = useState<PendingActionPayload[]>([]);
  const [brief, setBrief] = useState({
    audienceNotes: campaign.brief.audienceNotes ?? "",
    proofPoints: campaign.brief.proofPoints ?? "",
    offerDetails: campaign.brief.offerDetails ?? "",
    thingsToAvoid: campaign.brief.thingsToAvoid ?? "",
  });
  const [voiceText, setVoiceText] = useState(props.voiceRules.join("\n"));

  const launched = ["active", "sending", "paused", "completed", "cancelled"].includes(campaign.status);
  const approvedSteps = sequence?.touches.filter((t) => t.approvalStatus === "approved").length ?? 0;
  const totalSteps = sequence?.touches.length ?? 0;
  const report = campaign.complianceReport;
  const blocking = (report.findings ?? []).filter((f) => f.severity === "blocking");
  const warnings = (report.findings ?? []).filter((f) => f.severity === "warning");
  const serverIds = new Set(pendingApprovals.map((a) => a.actionId));
  const allPending = [...pendingApprovals, ...localPending.filter((a) => !serverIds.has(a.actionId))];
  const launchRequested = allPending.some((a) => a.toolName === "launch_campaign");

  const checkOk = (key: string) => checklist.items.find((i) => i.key === key)?.ok ?? false;
  const steps = [
    { label: "Audience", done: checkOk("lead_list"), hint: "Attach a lead list with at least one consent-confirmed contact." },
    { label: "Sender", done: checkOk("sender_identity"), hint: "Set who the emails come from (name, email, mailing address)." },
    { label: "Review emails", done: checkOk("steps_approved"), hint: "Read and approve every email step below." },
    { label: "Compliance", done: !!report.reviewedAt && blocking.length === 0, hint: "Run the compliance review (right column)." },
    { label: "Launch", done: launched && campaign.status !== "cancelled", hint: "Launch pauses once for your explicit approval, then sends run on schedule." },
  ];

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.7rem] font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">{campaign.name}</h1>
          <p className="mt-0.5 text-sm text-stone-500">
            {props.courseTitle} · {campaign.goalLabel}
          </p>
        </div>
        <Badge tone={STATUS_TONE[campaign.status] ?? "slate"} dot>
          {campaign.status.replace("_", " ")}
        </Badge>
        {campaign.status === "active" && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => pauseCampaignAction(campaign.id))}>
            <Pause className="size-3.5" /> Pause
          </Button>
        )}
        {campaign.status === "paused" && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => resumeCampaignAction(campaign.id))}>
            <Play className="size-3.5" /> Resume
          </Button>
        )}
        {launched && campaign.status !== "cancelled" && campaign.status !== "completed" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await cancelCampaignRequestAction(campaign.id);
                if (r.pending) setLocalPending((cur) => [...cur, r.pending!]);
                else setApprovalOutcome({ text: r.message, error: false });
              })
            }
          >
            <X className="size-3.5" /> Cancel…
          </Button>
        )}
      </div>

      <Stepper steps={steps} />

      {campaign.autoPauseReason && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">Auto-paused by a guardrail</p>
            <p>
              {campaign.autoPauseReason.metric.replace(/_/g, " ")} hit {(campaign.autoPauseReason.value * 100).toFixed(1)}% (threshold{" "}
              {(campaign.autoPauseReason.threshold * 100).toFixed(1)}%). Review the list, then Resume.
            </p>
          </div>
        </div>
      )}

      {/* pending irreversible approvals for THIS campaign — the ONE card */}
      {allPending.map((a) => (
        <ApprovalCard
          key={a.actionId}
          pending={a}
          onResult={(r) => setApprovalOutcome({ text: r.message, error: !!r.error })}
        />
      ))}
      {approvalOutcome && (
        <p
          className={
            approvalOutcome.error
              ? "rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-900"
              : "rounded-xl bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800"
          }
        >
          {approvalOutcome.error ? "Failed (the approval is still pending — fix the cause and approve again): " : ""}
          {approvalOutcome.text}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        {/* ── LEFT: setup ── */}
        <div className="space-y-4">
          <AudienceCard campaignId={campaign.id} list={props.list} lists={props.lists} attachedListId={props.attachedListId} />
          <SenderCard campaignId={campaign.id} sender={props.sender} senders={props.senders} creatorEmail={props.creatorEmail} />

          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <p className={labelCls}>Send window</p>
            <p className="mt-1 text-sm text-stone-800">
              {campaign.sendWindow
                ? `${campaign.sendWindow.startHour}:00–${campaign.sendWindow.endHour}:00 ${campaign.sendWindow.timezone}${campaign.sendWindow.skipWeekends ? " · weekdays" : ""}`
                : "9:00–11:00 weekdays (default)"}
            </p>
            <p className="mt-1 text-[11px] text-stone-400">Emails only go out inside this window — outside it they queue, they don&apos;t fail.</p>
          </div>

          {/* course analysis — reference material, tucked away */}
          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <button type="button" className="flex w-full items-center justify-between" onClick={() => setAnalysisOpen((o) => !o)}>
              <p className={labelCls}>Course analysis</p>
              <ChevronDown className={cn("size-4 text-stone-400 transition-transform", analysisOpen && "rotate-180")} />
            </button>
            {analysisOpen && (
              <div className="mt-2 space-y-2 text-xs text-stone-600">
                {props.analysis.audience && (
                  <p>
                    <b className="text-stone-800">Audience:</b> {props.analysis.audience}
                  </p>
                )}
                {props.analysis.outcomes[0] && (
                  <p>
                    <b className="text-stone-800">Outcome:</b> {props.analysis.outcomes[0]}
                  </p>
                )}
                {props.analysis.proofPoints ? (
                  <p>
                    <b className="text-stone-800">Credibility:</b> {props.analysis.proofPoints}
                  </p>
                ) : (
                  <p className="text-amber-700">No proof points yet — add them to the brief for stronger copy.</p>
                )}
              </div>
            )}
          </div>

          {/* brief */}
          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <button type="button" className="flex w-full items-center justify-between" onClick={() => setBriefOpen((o) => !o)}>
              <p className={labelCls}>Campaign brief</p>
              <ChevronDown className={cn("size-4 text-stone-400 transition-transform", briefOpen && "rotate-180")} />
            </button>
            {briefOpen && (
              <div className="mt-3 space-y-2">
                {(
                  [
                    ["audienceNotes", "Audience notes"],
                    ["proofPoints", "Proof points"],
                    ["offerDetails", "Offer details"],
                    ["thingsToAvoid", "Things to avoid"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <p className={labelCls}>{label}</p>
                    <textarea
                      className={cn(inputCls, "mt-1 h-16 resize-none text-xs")}
                      value={brief[key]}
                      onChange={(e) => setBrief((b) => ({ ...b, [key]: e.target.value }))}
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    startTransition(() =>
                      updateBriefAction(campaign.id, {
                        audienceNotes: brief.audienceNotes || null,
                        proofPoints: brief.proofPoints || null,
                        offerDetails: brief.offerDetails || null,
                        thingsToAvoid: brief.thingsToAvoid || null,
                        freeform: null,
                        language: null,
                        offerDeadlineIso: null,
                      })
                    )
                  }
                >
                  Save brief
                </Button>
              </div>
            )}
          </div>

          {/* voice */}
          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <button type="button" className="flex w-full items-center justify-between" onClick={() => setVoiceOpen((o) => !o)}>
              <p className={labelCls}>Voice · {props.voiceRules[0]?.toLowerCase().replace(/\.$/, "") ?? "default"}</p>
              <ChevronDown className={cn("size-4 text-stone-400 transition-transform", voiceOpen && "rotate-180")} />
            </button>
            {voiceOpen && (
              <div className="mt-3 space-y-2">
                <textarea className={cn(inputCls, "h-32 text-xs")} value={voiceText} onChange={(e) => setVoiceText(e.target.value)} />
                <p className="text-[11px] text-stone-400">One rule per line. Applies to every campaign; the AI also learns from what you accept vs. reject.</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    startTransition(() =>
                      updateVoiceProfileAction(
                        campaign.courseId,
                        voiceText.split("\n").map((l) => l.trim()).filter(Boolean)
                      )
                    )
                  }
                >
                  Save voice
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── CENTER: sequence + rules ── */}
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-stone-900">Email sequence</p>
            <span className="text-xs text-stone-500">
              {approvedSteps}/{totalSteps} approved
            </span>
          </div>
          {sequence ? (
            <div className="space-y-3">
              {sequence.touches.map((t) => (
                <StepCard key={t.id} campaignId={campaign.id} sequenceId={sequence.id} touch={t} launched={launched} creatorEmail={props.creatorEmail} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-8 text-center text-sm text-stone-500">
              No sequence yet — ask the assistant to draft one.
            </div>
          )}

          {props.rules.length > 0 && (
            <div className="rounded-2xl border border-stone-200/80 bg-white p-4 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
              <p className={labelCls}>Follow-up rules (approved with the campaign)</p>
              <ul className="mt-2 space-y-1.5 text-stone-700">
                {props.rules.map((r) => (
                  <li key={r.id}>
                    ↳ <b>{r.trigger.replace(/_/g, " ")}</b> → {r.name} (+{r.delayDays}d)
                    {(r.trigger === "opened_not_clicked" || r.trigger === "not_opened") && (
                      <span className="text-xs text-stone-400"> · open-based, approximate (mail-privacy prefetching)</span>
                    )}
                  </li>
                ))}
                <li className="text-stone-500">✕ stop on unsubscribe · bounce · enroll</li>
              </ul>
            </div>
          )}
        </div>

        {/* ── RIGHT: delivery + compliance + launch + assistant ── */}
        <div className="space-y-4">
          {launched && props.delivery && (
            <DeliveryCard campaignId={campaign.id} campaignStatus={campaign.status} delivery={props.delivery} windowInfo={props.sendWindowInfo} />
          )}

          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <div className="mb-2 flex items-center justify-between">
              <p className={labelCls}>Compliance & trust</p>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => startTransition(() => runComplianceAction(campaign.id))}>
                <RefreshCw className={cn("size-3.5", pending && "animate-spin")} /> Run review
              </Button>
            </div>
            {report.reviewedAt ? (
              <div className="space-y-1.5 text-xs">
                {blocking.map((f) => (
                  <p key={f.key} className="flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-red-900">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <b>{f.label}</b> — {f.detail}
                    </span>
                  </p>
                ))}
                {warnings.map((f) => (
                  <p key={f.key} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-amber-900">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <b>{f.label}</b> — {f.detail}
                    </span>
                  </p>
                ))}
                {blocking.length === 0 && warnings.length === 0 && (
                  <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-emerald-800">
                    <ShieldCheck className="size-3.5" /> All checks pass — nothing blocking, nothing flagged.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-stone-500">Not reviewed yet — run the review before launch.</p>
            )}
          </div>

          <div className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <p className={labelCls}>Launch checklist</p>
            <ul className="mt-2 space-y-1.5 text-xs">
              {checklist.items.map((i) => (
                <li key={i.key} className={cn("flex items-start gap-1.5", i.ok ? "text-stone-600" : "text-amber-800")}>
                  {i.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <X className="mt-0.5 size-3.5 shrink-0 text-amber-600" />}
                  <span>
                    {i.label}
                    <span className="block text-[11px] text-stone-400">{i.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-col gap-2">
              {!launched && campaign.status !== "approved" && (
                <Button size="sm" variant="outline" disabled={pending || approvedSteps !== totalSteps || totalSteps === 0} onClick={() => startTransition(() => approveCampaignAction(campaign.id))}>
                  <Check className="size-3.5" /> Approve campaign content
                </Button>
              )}
              {!launched && (
                <Button
                  size="sm"
                  disabled={pending || !checklist.canLaunch || launchRequested}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await requestLaunchAction(campaign.id);
                      if (r.pending) setLocalPending((cur) => [...cur, r.pending!]);
                      else setApprovalOutcome({ text: r.message, error: false });
                    })
                  }
                >
                  <Rocket className="size-3.5" /> {launchRequested ? "Launch awaiting your approval above" : "Launch campaign…"}
                </Button>
              )}
              {!launched && <p className="text-[11px] text-stone-400">Launching is irreversible — one card, your explicit approval, then sends begin automatically on your schedule. It can never auto-approve.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <div className="border-b border-stone-100 px-4 py-3">
              <p className={labelCls}>Marketing Assistant</p>
            </div>
            <div className="h-[420px] p-3">
              <AgentPanel courseId={campaign.courseId} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
