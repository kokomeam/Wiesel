"use client";

/**
 * THE approval card — the single surface an irreversible action is approved
 * from, wherever it appears (agent chat, hub inbox, campaign builder, leads
 * page). Full preview INLINE, exactly three actions:
 *
 *   Approve & {effect}  — one click, the real effect runs, no nested confirm
 *   Edit                — inline form over the tool's editableParams; the
 *                         preview re-renders truthfully before approving
 *   Reject              — one click; optional note (for agent-requested
 *                         actions) flows into the agent's resumed observation
 *
 * Pending cards carry the visual weight (rose ring); once resolved the card
 * collapses to a quiet one-line log entry so the loud state is always ONLY
 * the thing that still needs the creator.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, ShieldAlert, X } from "lucide-react";
import {
  approvePendingAction,
  denyPendingAction,
  editPendingAction,
  type ActionResult,
  type PendingActionPayload,
} from "@/app/(app)/marketing/actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const AUDIENCE_VALUES = ["all", "lead", "subscribed", "engaged", "enrolled"] as const;

function prettyKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

export interface ApprovalCardProps {
  pending: PendingActionPayload;
  /** Denser paddings for the chat column. */
  compact?: boolean;
  /** Surface the ActionResult (e.g. the hub's toast). */
  onResult?: (r: ActionResult) => void;
  onResolved?: (decision: "approved" | "denied") => void;
}

interface ChecklistItem {
  label?: string;
  ok?: boolean;
}

/** Renders the known preview fields inline; unknown primitive fields fall back
 *  to a quiet key/value list so nothing the tool surfaced is hidden. */
function PreviewBlock({ preview }: { preview: Record<string, unknown> }) {
  const known = new Set([
    "subject",
    "to",
    "audience",
    "segment",
    "bodyPreview",
    "checklist",
    "touchSubjects",
    "url",
    "name",
    "count",
    "effectLabel",
    "kind",
    "touches",
    "title",
    "slug",
    "sectionCount",
  ]);
  const rest = Object.entries(preview).filter(
    ([k, v]) => !known.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
  );
  const to = preview.to;
  const checklist = Array.isArray(preview.checklist) ? (preview.checklist as ChecklistItem[]) : null;
  const touchSubjects = Array.isArray(preview.touchSubjects) ? (preview.touchSubjects as string[]) : null;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-3 text-xs text-stone-600">
      {typeof preview.subject === "string" ? (
        <p className="font-medium text-stone-900">Subject: {preview.subject}</p>
      ) : null}
      {typeof to === "string" ? <p>To: {to}</p> : null}
      {Array.isArray(to) ? (
        <p>
          To: {(to as string[]).slice(0, 5).join(", ")}
          {(to as string[]).length > 5 ? ` +${(to as string[]).length - 5} more` : ""}
        </p>
      ) : null}
      {typeof preview.audience === "number" ? (
        <p>
          Audience: <span className="font-medium text-stone-900">{preview.audience}</span>
          {typeof preview.segment === "string" ? ` · segment: ${preview.segment}` : ""}
        </p>
      ) : null}
      {typeof preview.count === "number" ? <p>Contacts: {preview.count}</p> : null}
      {typeof preview.url === "string" ? <p>URL: {preview.url}</p> : null}
      {typeof preview.bodyPreview === "string" && preview.bodyPreview ? (
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-stone-50 p-2 font-sans text-[11px] leading-relaxed text-stone-600">
          {preview.bodyPreview}
        </pre>
      ) : null}
      {touchSubjects && touchSubjects.length > 0 ? (
        <div className="mt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">First emails</p>
          <ul className="mt-1 space-y-0.5">
            {touchSubjects.map((s, i) => (
              <li key={i}>· {s}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {checklist ? (
        <ul className="mt-2 space-y-0.5">
          {checklist.map((item, i) => (
            <li key={i} className={cn("flex items-center gap-1.5", item.ok ? "text-emerald-700" : "text-rose-600")}>
              {item.ok ? <Check className="size-3" /> : <X className="size-3" />}
              {item.label ?? ""}
            </li>
          ))}
        </ul>
      ) : null}
      {rest.length > 0 ? (
        <dl className="mt-2 space-y-0.5">
          {rest.map(([k, v]) => (
            <div key={k} className="flex gap-1.5">
              <dt className="text-stone-400">{k}:</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function ApprovalCard({ pending: initial, compact, onResult, onResolved }: ApprovalCardProps) {
  const router = useRouter();
  const [pending, setPending] = useState(initial);
  const [resolved, setResolved] = useState<"approved" | "denied" | null>(null);
  const [resolvedMessage, setResolvedMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, startTransition] = useTransition();

  const preview = pending.preview ?? {};
  const effectLabel = typeof preview.effectLabel === "string" ? preview.effectLabel : "run it";
  const editable = (pending.editableParams ?? []).filter((p) => p !== "body");

  if (resolved) {
    return (
      <div className="flex items-start gap-2 py-1.5 text-xs text-stone-500">
        {resolved === "approved" ? (
          <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
        ) : (
          <X className="mt-0.5 size-3.5 shrink-0 text-stone-400" />
        )}
        <span>
          <span className="font-medium text-stone-600">{resolved === "approved" ? "Approved" : "Rejected"}</span>
          {" — "}
          {resolvedMessage ?? pending.summary}
        </span>
      </div>
    );
  }

  const approve = () =>
    startTransition(async () => {
      const r = await approvePendingAction(pending.actionId);
      onResult?.(r);
      if (!r.error) {
        setResolved("approved");
        setResolvedMessage(r.message);
        onResolved?.("approved");
      }
      router.refresh();
    });

  const reject = () =>
    startTransition(async () => {
      const r = await denyPendingAction(pending.actionId, note.trim() || undefined);
      onResult?.(r);
      if (!r.error) {
        setResolved("denied");
        setResolvedMessage(r.message);
        onResolved?.("denied");
      }
      router.refresh();
    });

  const saveEdit = () =>
    startTransition(async () => {
      const patch: Record<string, unknown> = {};
      for (const key of editable) {
        if (!(key in draft)) continue;
        patch[key] = key === "status" && draft[key] === "all" ? "all" : draft[key];
      }
      const r = await editPendingAction(pending.actionId, patch);
      onResult?.(r);
      if (!r.error && r.pending) {
        setPending(r.pending);
        setEditing(false);
        setDraft({});
      }
    });

  return (
    <div
      className={cn(
        "rounded-2xl border border-rose-200 bg-rose-50/60 shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        compact ? "p-3" : "p-4"
      )}
      data-testid="approval-card"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-rose-500" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="rose">{prettyKind(pending.toolName)}</Badge>
              {pending.requestedBy === "agent" ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">agent</span>
              ) : null}
            </div>
            <p className="mt-1.5 text-sm text-stone-800">{pending.summary}</p>
          </div>

          <PreviewBlock preview={preview} />

          {editing ? (
            <div className="space-y-2 rounded-xl border border-stone-200 bg-white p-3">
              {editable.map((key) =>
                key === "status" ? (
                  <label key={key} className="block text-xs text-stone-600">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">audience</span>
                    <select
                      className="mt-1 block w-full rounded-lg border border-stone-300/80 bg-white px-2 py-1.5 text-sm"
                      value={draft[key] ?? String((pending.preview?.segment as string) ?? "all")}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    >
                      {AUDIENCE_VALUES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label key={key} className="block text-xs text-stone-600">
                    <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">{key}</span>
                    <input
                      className="mt-1 block w-full rounded-lg border border-stone-300/80 bg-white px-2 py-1.5 text-sm"
                      defaultValue={String(preview[key] ?? "")}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  </label>
                )
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={saveEdit} disabled={busy}>
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save & re-preview
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {pending.requestedBy === "agent" ? (
            <input
              className="block w-full rounded-lg border border-stone-200 bg-white/70 px-2 py-1.5 text-xs text-stone-600 placeholder:text-stone-400"
              placeholder="Note to the agent (optional — sent with a rejection)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={approve} disabled={busy || editing}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Approve & {effectLabel}
            </Button>
            {editable.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setEditing((e) => !e)} disabled={busy}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={reject} disabled={busy || editing}>
              <X className="size-3.5" /> Reject
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
