"use client";

/**
 * Staged concept-graph review panel (TUTOR-1 Wave 5, P5.2 · step 6 · AC-W5G.2). The
 * RAIL CONSUMER: when the console bundle carries a pending concept_graph change-set,
 * this surface shows each staged node with its classification + the EvidenceCard
 * that justifies it, lets the creator EDIT a staged node before accepting (a
 * versioned edit on the live staged row), then Accept (activates the set) or Reject
 * (atomically restores byte-for-byte, all-or-nothing).
 *
 * The frozen bundle exposes `pendingChangeSetId` + `evidenceByNode` (node_id → the
 * evidence jsonb stamped on that node's change-set item). The staged nodes ARE the
 * nodes that carry evidence — we render those, deriving a presentation
 * classification from the node's own fields (created_by / creator_edited / status),
 * because the accept path has already made the rows live (the rail stages
 * optimistically; Accept resolves, Reject reverts). EvidenceCard renders verbatim.
 *
 * No editor-store imports. EvidenceCard is the pure client component (allowed).
 */

import { useState, useTransition } from "react";
import { CheckCircle2, XCircle, Pencil, GitPullRequestArrow } from "lucide-react";
import { EvidenceCard, parseEvidence } from "@/components/editor/agent/EvidenceCard";
import { Button } from "@/components/ui/Button";
import { IconTile } from "@/components/ui/IconTile";
import { toolAttrs } from "@/lib/course/aiAttributes";
import {
  acceptGraphChangeSetAction,
  rejectGraphChangeSetAction,
  renameNodeAction,
} from "@/app/(app)/studio/[courseId]/tutor/graphActions";
import type { ConceptNodeRow } from "@/lib/studio/graphConsole";

/* --------------------------- classification ------------------------------ */

export type StagedClassification = "matched" | "added" | "removed" | "split" | "merged";

/** Derive a presentation classification for a staged node from its row fields. Pure
 *  + exported for the verify script. The reconciler stamps the true classification
 *  into the item payload; the bundle surfaces evidence, so we present a best-effort
 *  label from the node's lifecycle:
 *    - status 'retired'      → removed (a node the reconcile retired)
 *    - status 'merged_into'  → merged
 *    - created_by 'creator'  → split (creator-authored children of a split fan-out)
 *    - creator_edited true   → matched (a matched node whose content changed)
 *    - otherwise             → added (a freshly extracted concept). */
export function classifyStagedNode(node: Pick<ConceptNodeRow, "status" | "created_by" | "creator_edited">): StagedClassification {
  if (node.status === "retired") return "removed";
  if (node.status === "merged_into") return "merged";
  if (node.created_by === "creator") return "split";
  if (node.creator_edited) return "matched";
  return "added";
}

const CLASSIFICATION_TONE: Record<StagedClassification, string> = {
  matched: "bg-stone-100 text-stone-600 ring-1 ring-inset ring-stone-200/70",
  added: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/70",
  removed: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200/70",
  split: "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200/70",
  merged: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200/70",
};

/* ------------------------------ props ------------------------------------ */

export interface GraphReviewPanelProps {
  courseId: string;
  changeSetId: string;
  nodes: ConceptNodeRow[];
  evidenceByNode: Record<string, unknown>;
}

/* ------------------------------ panel ------------------------------------ */

export function GraphReviewPanel({ courseId, changeSetId, nodes, evidenceByNode }: GraphReviewPanelProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The staged nodes are those carrying evidence in this pending set.
  const stagedIds = new Set(Object.keys(evidenceByNode));
  const staged = nodes.filter((n) => stagedIds.has(n.id));

  const accept = () => {
    startTransition(async () => {
      const res = await acceptGraphChangeSetAction(courseId, changeSetId);
      if (!res.ok) setError(res.error);
    });
  };
  const reject = () => {
    startTransition(async () => {
      const res = await rejectGraphChangeSetAction(courseId, changeSetId);
      if (!res.ok) setError(res.error);
    });
  };

  return (
    <section
      aria-label="Staged concept-graph changes"
      className="rounded-2xl border border-brand-200 bg-brand-50/40 p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      data-ai-component="tutor-graph-review"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <IconTile icon={GitPullRequestArrow} tone="gradient" />
          <div>
            <h3 className="font-display text-title font-medium tracking-tight text-stone-900">
              Review staged graph changes
            </h3>
            <p className="text-xs text-stone-600">
              {staged.length} concept{staged.length === 1 ? "" : "s"} proposed. Edit before you accept — Accept activates them, Reject restores everything exactly.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={accept}
            disabled={pending}
            {...toolAttrs({ tool: "tutor-graph-accept", action: "acceptGraphChangeSet", targetType: "change_set", label: "Accept staged graph changes" })}
          >
            <CheckCircle2 className="size-3.5" aria-hidden /> Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={reject}
            disabled={pending}
            {...toolAttrs({ tool: "tutor-graph-reject", action: "rejectGraphChangeSet", targetType: "change_set", label: "Reject staged graph changes" })}
          >
            <XCircle className="size-3.5" aria-hidden /> Reject
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <ul className="space-y-2">
        {staged.map((node) => (
          <StagedItem
            key={node.id}
            courseId={courseId}
            node={node}
            evidence={evidenceByNode[node.id]}
          />
        ))}
      </ul>
    </section>
  );
}

/* --------------------------- staged item --------------------------------- */

function StagedItem({ courseId, node, evidence }: { courseId: string; node: ConceptNodeRow; evidence: unknown }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const [version, setVersion] = useState(node.version);
  const [notice, setNotice] = useState<string | null>(null);

  const classification = classifyStagedNode(node);
  const parsed = parseEvidence(evidence);

  const commit = () => {
    const trimmed = title.trim();
    if (trimmed === node.title || trimmed.length < 1) {
      setEditing(false);
      setTitle(node.title);
      return;
    }
    startTransition(async () => {
      const res = await renameNodeAction(courseId, node.id, trimmed, version);
      if (res.ok) {
        setVersion(res.version);
        setEditing(false);
        setNotice(null);
      } else if ("conflict" in res) {
        setNotice(res.message);
      } else {
        setNotice(res.error);
      }
    });
  };

  return (
    <li className="rounded-xl border border-stone-200/80 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${CLASSIFICATION_TONE[classification]}`}>
          {classification}
        </span>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setTitle(node.title);
                setEditing(false);
              }
            }}
            maxLength={200}
            className="flex-1 rounded-lg border border-stone-300 px-2 py-0.5 text-sm focus:border-brand-500 focus:outline-none"
            aria-label="Staged concept title"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group inline-flex flex-1 items-center gap-1.5 text-left text-sm font-medium text-stone-900"
            {...toolAttrs({ tool: "tutor-staged-rename", action: "renameNode", targetType: "concept_node", label: "Edit staged concept before accepting" })}
          >
            {title}
            <Pencil className="size-3 shrink-0 text-stone-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          </button>
        )}
      </div>
      {node.description ? (
        <p className="mt-1 text-xs text-stone-600">{node.description}</p>
      ) : null}
      {notice ? (
        <p role="alert" className="mt-1.5 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {notice}
        </p>
      ) : null}
      {parsed ? (
        <div className="mt-2">
          <EvidenceCard evidence={parsed} compact />
        </div>
      ) : null}
      {pending ? <span className="sr-only">Saving…</span> : null}
    </li>
  );
}
