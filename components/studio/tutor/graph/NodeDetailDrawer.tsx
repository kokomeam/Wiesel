"use client";

/**
 * The selected-node detail drawer (TUTOR-1 Wave 5, P5.2 · step 3). Shows the
 * concept's title/description (inline-editable, optimistic with conflict handling),
 * its teaching-slide deep links (R-13 block-level fallback), the cohort-floored
 * mastery + confusion signals (suppressed → "not enough learners yet", NO number),
 * the EvidenceCard (parseEvidence over bundle.evidenceByNode[nodeId] → null hides),
 * and retire/merge/split affordances.
 *
 * Fence: no lib/course/store, lib/course/patches, lib/editor/uiStore, lib/editor/
 * dragStore, or SlideStage imports. EvidenceCard is a pure client component from
 * components/editor/agent (allowed — it is NOT the editor store).
 */

import { useState, useTransition } from "react";
import { Pencil, ExternalLink, Archive, GitMerge, Split, X } from "lucide-react";
import { EvidenceCard, parseEvidence } from "@/components/editor/agent/EvidenceCard";
import { Button } from "@/components/ui/Button";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { useRouter } from "next/navigation";
import {
  renameNodeAction,
  editNodeDescriptionAction,
  retireNodeAction,
  splitNodeAction,
  addEdgeAction,
  removeEdgeAction,
  lockEdgeAction,
} from "@/app/(app)/studio/[courseId]/tutor/graphActions";
import { buildTeachingDeepLink } from "./GraphCanvas";
import type { ConceptNodeRow, MasteryOverlay, ConfusionOverlay } from "@/lib/studio/graphConsole";

/* ----------------------------- props ------------------------------------- */

export interface NodeDetailDrawerProps {
  courseId: string;
  node: ConceptNodeRow;
  mastery: MasteryOverlay | undefined;
  confusion: ConfusionOverlay | undefined;
  evidence: unknown;
  /** other active node titles+ids for the merge / add-prerequisite target picker. */
  mergeTargets: Array<{ id: string; title: string }>;
  /** THIS node's outgoing prerequisite edges (source === node), for the edge editor. */
  outgoingEdges: Array<{ id: string; targetNodeId: string; targetTitle: string; kind: "prerequisite" | "part_of" | "related"; creatorLocked: boolean; version: number }>;
  onClose: () => void;
  /** the drawer requests a merge (opens the confirm with THIS node as absorbed);
   *  the parent owns mergeNodesAction (it needs the survivor rule). */
  onMerge: (survivorNodeId: string, absorbedNodeId: string) => void;
}

type Anchor = { lessonId?: string; blockId?: string; slideId?: string | null };

/* ----------------------------- suppression -------------------------------- */

/** The render decision for a cohort-floored overlay: show the number, or suppress
 *  it with "not enough learners yet" (NEVER a count). Pure + exported for the
 *  verify script. */
export function overlayDisplay(
  overlay: { suppressed: boolean; value: number | null } | undefined
): { show: false } | { show: true; value: number } {
  if (!overlay || overlay.suppressed || overlay.value === null) return { show: false };
  return { show: true, value: overlay.value };
}

const SUPPRESSED_COPY = "Not enough learners yet";

/* ------------------------------ drawer ----------------------------------- */

export function NodeDetailDrawer({
  courseId,
  node,
  mastery,
  confusion,
  evidence,
  mergeTargets,
  outgoingEdges,
  onClose,
  onMerge,
}: NodeDetailDrawerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  // Local optimistic mirrors (reset when the selected node identity/version changes).
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [version, setVersion] = useState(node.version);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [showSplit, setShowSplit] = useState(false);

  const nodeKey = `${node.id}:${node.version}`;
  const [prevKey, setPrevKey] = useState(nodeKey);
  if (prevKey !== nodeKey) {
    // Derived reset (React 19: setState-during-render, not a ref write in render) —
    // a fresh node or a server-bumped version re-seeds the optimistic mirrors.
    setPrevKey(nodeKey);
    setTitle(node.title);
    setDescription(node.description);
    setVersion(node.version);
    setEditingTitle(false);
    setEditingDesc(false);
    setNotice(null);
  }

  const parsedEvidence = parseEvidence(evidence);
  const anchors = (node.anchors ?? []) as Anchor[];

  const masteryView = overlayDisplay(
    mastery ? { suppressed: mastery.suppressed, value: mastery.avg_decayed_p } : undefined
  );
  const confusionView = overlayDisplay(
    confusion ? { suppressed: confusion.suppressed, value: confusion.confusing_pct } : undefined
  );

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed === node.title || trimmed.length < 1) {
      setEditingTitle(false);
      setTitle(node.title);
      return;
    }
    startTransition(async () => {
      const res = await renameNodeAction(courseId, node.id, trimmed, version);
      if (res.ok) {
        setVersion(res.version);
        setEditingTitle(false);
        setNotice(null);
      } else if ("conflict" in res) {
        setNotice(res.message);
      } else {
        setNotice(res.error);
      }
    });
  };

  const commitDescription = () => {
    if (description === node.description) {
      setEditingDesc(false);
      return;
    }
    startTransition(async () => {
      const res = await editNodeDescriptionAction(courseId, node.id, description, version);
      if (res.ok) {
        setVersion(res.version);
        setEditingDesc(false);
        setNotice(null);
      } else if ("conflict" in res) {
        setNotice(res.message);
      } else {
        setNotice(res.error);
      }
    });
  };

  const retire = () => {
    startTransition(async () => {
      const res = await retireNodeAction(courseId, node.id, version);
      if (res.ok) {
        onClose();
      } else if ("conflict" in res) {
        setNotice(res.message);
      } else {
        setNotice(res.error);
      }
    });
  };

  /* ── prerequisite edges (add / lock / remove) ── */
  const [edgeTarget, setEdgeTarget] = useState("");
  // Nodes not already a prerequisite of THIS node (and not itself).
  const edgeCandidates = mergeTargets.filter(
    (t) => !outgoingEdges.some((e) => e.targetNodeId === t.id)
  );
  const edgeErr = (r: { message?: string; error?: string }) => r.message ?? r.error ?? "Edit failed.";
  const addEdge = () => {
    if (!edgeTarget) return;
    startTransition(async () => {
      const res = await addEdgeAction(courseId, node.id, edgeTarget, "prerequisite");
      if (res.ok) {
        setEdgeTarget("");
        setNotice("Prerequisite added.");
        router.refresh();
      } else {
        setNotice(edgeErr(res)); // cycle → the specific "…would create a cycle" path message
      }
    });
  };
  const toggleLock = (e: NodeDetailDrawerProps["outgoingEdges"][number]) => {
    startTransition(async () => {
      const res = await lockEdgeAction(courseId, e.id, node.id, e.targetNodeId, e.kind, !e.creatorLocked, e.version);
      if (res.ok) {
        setNotice(e.creatorLocked ? "Edge unlocked." : "Edge locked.");
        router.refresh();
      } else {
        setNotice(edgeErr(res));
      }
    });
  };
  const removeEdge = (edgeId: string) => {
    startTransition(async () => {
      const res = await removeEdgeAction(courseId, edgeId);
      if (res.ok) {
        setNotice("Prerequisite removed.");
        router.refresh();
      } else {
        setNotice(res.error);
      }
    });
  };

  return (
    <aside
      className="flex w-full flex-col gap-4 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      aria-label={`Concept details: ${node.title}`}
      data-ai-component="tutor-node-drawer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitle(node.title);
                  setEditingTitle(false);
                }
              }}
              maxLength={200}
              className="w-full rounded-lg border border-stone-300 px-2 py-1 text-base font-medium focus:border-brand-500 focus:outline-none"
              aria-label="Concept title"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="group inline-flex items-center gap-1.5 text-left text-base font-medium text-stone-900"
              {...toolAttrs({ tool: "tutor-node-rename", action: "renameNode", targetType: "concept_node", label: "Rename concept" })}
            >
              {title}
              <Pencil className="size-3.5 shrink-0 text-stone-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </button>
          )}
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-stone-400">
            {node.created_by === "creator" ? "Creator-authored" : node.created_by === "reconciliation" ? "Reconciliation" : "Extracted"}
            {node.creator_edited ? " · edited" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close concept details"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {notice ? (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {notice}
        </p>
      ) : null}

      {/* Description (inline-editable). */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-stone-500">Description</span>
          {!editingDesc ? (
            <button
              type="button"
              onClick={() => setEditingDesc(true)}
              className="text-xs text-brand-700 hover:underline"
              {...toolAttrs({ tool: "tutor-node-describe", action: "editNodeDescription", targetType: "concept_node", label: "Edit description" })}
            >
              Edit
            </button>
          ) : null}
        </div>
        {editingDesc ? (
          <textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            maxLength={2000}
            rows={4}
            className="w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            aria-label="Concept description"
          />
        ) : (
          <p className="text-sm leading-relaxed text-stone-700">
            {description || <span className="text-stone-400">No description.</span>}
          </p>
        )}
      </div>

      {/* Cohort-floored signals. */}
      <div className="grid grid-cols-2 gap-2">
        <Signal
          label="Mastery"
          body={
            masteryView.show ? (
              <span className="tabular-nums">{Math.round(masteryView.value * 100)}%</span>
            ) : (
              <span className="text-stone-400">{SUPPRESSED_COPY}</span>
            )
          }
        />
        <Signal
          label="Confusion"
          body={
            confusionView.show ? (
              <span className="tabular-nums">{Math.round(confusionView.value * 100)}%</span>
            ) : (
              <span className="text-stone-400">{SUPPRESSED_COPY}</span>
            )
          }
        />
      </div>

      {/* Prerequisites (outgoing edges): add / lock / remove. The DAG cycle gate
       *  lives in the RPC — a cycle-creating add surfaces the specific path here. */}
      <div data-ai-component="tutor-node-edges">
        <span className="text-xs font-medium text-stone-500">Prerequisites (this concept requires)</span>
        {outgoingEdges.length > 0 ? (
          <ul className="mt-1.5 flex flex-col gap-1">
            {outgoingEdges.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 rounded-lg border border-stone-200/80 px-2.5 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-stone-800">{e.targetTitle}</span>
                <button
                  type="button"
                  onClick={() => toggleLock(e)}
                  disabled={pending}
                  className="shrink-0 text-[11px] text-stone-500 hover:text-stone-800"
                  {...toolAttrs({ tool: "tutor-edge-lock", action: "lockEdge", targetType: "concept_edge", label: e.creatorLocked ? "Unlock edge" : "Lock edge" })}
                >
                  {e.creatorLocked ? "🔒 locked" : "unlocked"}
                </button>
                <button
                  type="button"
                  onClick={() => removeEdge(e.id)}
                  disabled={pending}
                  className="shrink-0 text-[11px] text-rose-600 hover:text-rose-800"
                  {...toolAttrs({ tool: "tutor-edge-remove", action: "removeEdge", targetType: "concept_edge", label: "Remove prerequisite" })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-stone-500">No prerequisites yet.</p>
        )}
        {edgeCandidates.length > 0 ? (
          <div className="mt-2 flex items-center gap-2">
            <select
              value={edgeTarget}
              onChange={(ev) => setEdgeTarget(ev.target.value)}
              aria-label="Add a prerequisite concept"
              className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
            >
              <option value="">Add a prerequisite…</option>
              {edgeCandidates.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
            <Button
              type="button"
              variant="secondary"
              onClick={addEdge}
              disabled={pending || !edgeTarget}
              {...toolAttrs({ tool: "tutor-edge-add", action: "addEdge", targetType: "concept_edge", label: "Add prerequisite" })}
            >
              Add
            </Button>
          </div>
        ) : null}
      </div>

      {/* Evidence (hidden when parseEvidence → null). */}
      {parsedEvidence ? <EvidenceCard evidence={parsedEvidence} compact /> : null}

      {/* Teaching-slide deep links (R-13 block-level fallback). */}
      {anchors.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium text-stone-500">Taught in</p>
          <ul className="space-y-1">
            {anchors.slice(0, 6).map((a, i) =>
              a.lessonId ? (
                <li key={`${a.lessonId}:${a.blockId ?? i}`}>
                  <a
                    href={buildTeachingDeepLink(courseId, a.lessonId, a.blockId)}
                    className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    Open teaching slide
                  </a>
                </li>
              ) : null
            )}
          </ul>
        </div>
      ) : null}

      {/* Split panel. */}
      {showSplit ? (
        <SplitPanel
          courseId={courseId}
          node={node}
          version={version}
          onDone={onClose}
          onCancel={() => setShowSplit(false)}
          onNotice={setNotice}
        />
      ) : null}

      {/* Affordances. */}
      <div className="flex flex-wrap gap-2 border-t border-stone-100 pt-3">
        <Button variant="outline" size="sm" onClick={retire} disabled={pending}>
          <Archive className="size-3.5" aria-hidden /> Retire
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowSplit((s) => !s)} disabled={pending}>
          <Split className="size-3.5" aria-hidden /> Split
        </Button>
        {mergeTargets.length > 0 ? (
          <MergeMenu node={node} targets={mergeTargets} onMerge={onMerge} disabled={pending} />
        ) : null}
      </div>
    </aside>
  );
}

/* ------------------------------ sub-parts -------------------------------- */

function Signal({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-200/70 bg-stone-50/60 px-2.5 py-2">
      <p className="text-[11px] uppercase tracking-wide text-stone-400">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-stone-800">{body}</p>
    </div>
  );
}

/** Merge picker: THIS node is absorbed into a chosen survivor (the parent owns the
 *  survivor rule — here the creator names the survivor explicitly). */
function MergeMenu({
  node,
  targets,
  onMerge,
  disabled,
}: {
  node: ConceptNodeRow;
  targets: Array<{ id: string; title: string }>;
  onMerge: (survivorNodeId: string, absorbedNodeId: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <GitMerge className="size-3.5" aria-hidden /> Merge into…
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 z-10 mt-1 max-h-56 w-56 overflow-auto rounded-xl border border-stone-200 bg-white p-1 shadow-lg"
        >
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onMerge(t.id, node.id);
              }}
              className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-50"
            >
              {t.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Split editor: collect ≥2 child titles, fan the parent out into them. */
function SplitPanel({
  courseId,
  node,
  version,
  onDone,
  onCancel,
  onNotice,
}: {
  courseId: string;
  node: ConceptNodeRow;
  version: number;
  onDone: () => void;
  onCancel: () => void;
  onNotice: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [raw, setRaw] = useState("");

  const submit = () => {
    const titles = raw
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (titles.length < 2) {
      onNotice("A split needs at least two child titles (one per line).");
      return;
    }
    startTransition(async () => {
      const res = await splitNodeAction(courseId, node.id, titles, version);
      if (res.ok) onDone();
      else onNotice(res.error);
    });
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
      <p className="mb-1.5 text-xs font-medium text-stone-600">Split into children (one title per line)</p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={3}
        placeholder={"Sub-concept A\nSub-concept B"}
        className="w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
        aria-label="Child concept titles"
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          Split concept
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
