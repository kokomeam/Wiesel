"use client";

/**
 * The concept-graph viewport (TUTOR-1 Wave 5, P5.2 · step 2). A pure re-implementation
 * of the SlideStage recipe (see w5-maps §svgStack) that does NOT import SlideStage,
 * lib/course/store, lib/course/patches, lib/editor/uiStore, or lib/editor/dragStore
 * (the ~590 KB editor leak the tutor route's budget must avoid). It builds ONLY on:
 *   - lib/tutor/graph/layout.ts  (the pure layered-DAG layout),
 *   - lib/tutor/graph/editorStore.ts  (our own standalone store),
 *   - components/editor/slide/diagram/svg.tsx  (PURE Label / DiagramDefs / AXIS —
 *     zero store deps), with a per-instance marker uid.
 *
 * The recipe:
 *   - ResizeObserver measures the container → fitScale (null until the first observe,
 *     so SSR + first paint render nothing → no hydration mismatch);
 *   - scale = fitScale * zoom (zoom clamped 0.5..3 in the store);
 *   - center-stable scroll on zoom change via useLayoutEffect (paint-blocking);
 *   - pointer math reads innerRef.getBoundingClientRect() / scale (the scaled body
 *     rect, never the container which becomes a scroll viewport once zoomed).
 *
 * Positions are layout-derived (normalized 0..1 → the logical GRAPH_W×GRAPH_H space).
 * Dragging a node PANS/SELECTS — coordinates are never stored (there are none). The
 * KEYBOARD-OPERABLE equivalent is a focusable node list: arrow keys move the selection,
 * Enter opens the drawer (the accessible mirror of canvas mouse nav — AC a11y).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { ZoomIn, ZoomOut, Maximize, Search } from "lucide-react";
import { Label, DiagramDefs, AXIS, alpha } from "@/components/editor/slide/diagram/svg";
import {
  layoutConceptGraph,
  type LayoutNodeInput,
  type LayoutEdgeInput,
} from "@/lib/tutor/graph/layout";
import {
  useGraphEditorStore,
  createFrameCoalescer,
  type GraphDragFrame,
} from "@/lib/tutor/graph/editorStore";
import { OverlayToggles } from "./OverlayToggles";
import { NodeDetailDrawer } from "./NodeDetailDrawer";
import { mergeNodesAction } from "@/app/(app)/studio/[courseId]/tutor/graphActions";
import type { ConceptNodeRow, ConceptEdgeRow, MasteryOverlay, ConfusionOverlay } from "@/lib/studio/graphConsole";

/* ------------------------------ geometry --------------------------------- */

// Logical drawing space (mirrors SlideStage's fixed logical canvas — the stage
// transform-scales it). Wide + tall so a layered DAG has breathing room.
const GRAPH_W = 1280;
const GRAPH_H = 720;
const MARGIN_X = 120;
const MARGIN_Y = 90;
const NODE_W = 176;
const NODE_H = 56;

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Map a node's normalized layout position to a logical top-left corner (the
 *  rect is centered on the layout point). */
function nodeRect(pos: { x: number; y: number }): { x: number; y: number } {
  const cx = MARGIN_X + pos.x * (GRAPH_W - 2 * MARGIN_X);
  const cy = MARGIN_Y + pos.y * (GRAPH_H - 2 * MARGIN_Y);
  return { x: cx - NODE_W / 2, y: cy - NODE_H / 2 };
}

function nodeCenter(pos: { x: number; y: number }): { x: number; y: number } {
  return {
    x: MARGIN_X + pos.x * (GRAPH_W - 2 * MARGIN_X),
    y: MARGIN_Y + pos.y * (GRAPH_H - 2 * MARGIN_Y),
  };
}

/** Mastery shading tone for a node (cohort-floored; suppressed → neutral). Green
 *  when strong, amber→rose as average decayed p falls. Returns a fill color. */
export function masteryFill(overlay: MasteryOverlay | undefined, show: boolean): string {
  if (!show || !overlay || overlay.suppressed || overlay.avg_decayed_p === null) {
    return "#ffffff";
  }
  const p = overlay.avg_decayed_p;
  if (p >= 0.75) return alpha("#16a34a", 0.14);
  if (p >= 0.5) return alpha("#f59e0b", 0.16);
  return alpha("#e11d48", 0.14);
}

/** Confusion ring for a node's anchor block (cohort-floored). Returns a stroke
 *  color when the block is confusing enough, else null. */
export function confusionStroke(overlay: ConfusionOverlay | undefined, show: boolean): string | null {
  if (!show || !overlay || overlay.suppressed || overlay.confusing_pct === null) return null;
  if (overlay.confusing_pct >= 0.4) return "#e11d48";
  if (overlay.confusing_pct >= 0.25) return "#f59e0b";
  return null;
}

/* ----------------------------- fit scale --------------------------------- */

/** ResizeObserver fit-scale (SSR-safe: null until the first observe). */
function useFitScale(ref: React.RefObject<HTMLDivElement | null>): number | null {
  const [fit, setFit] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setFit(w / GRAPH_W);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fit;
}

/* ------------------------------- props ----------------------------------- */

export interface GraphCanvasProps {
  courseId: string;
  nodes: ConceptNodeRow[];
  edges: ConceptEdgeRow[];
  mastery: MasteryOverlay[];
  confusion: ConfusionOverlay[];
  showMastery: boolean;
  showConfusion: boolean;
}

/* ------------------------------- canvas ---------------------------------- */

export function GraphCanvas({
  courseId,
  nodes,
  edges,
  mastery,
  confusion,
  showMastery,
  showConfusion,
}: GraphCanvasProps) {
  void courseId; // reserved for future deep-link affordances on the canvas itself.
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const selection = useGraphEditorStore((s) => s.selection);
  const zoom = useGraphEditorStore((s) => s.zoom);
  const searchFocus = useGraphEditorStore((s) => s.searchFocus);
  const selectNode = useGraphEditorStore((s) => s.selectNode);
  const setDragFrame = useGraphEditorStore((s) => s.setDragFrame);

  const fitScale = useFitScale(containerRef);
  const scale = fitScale === null ? null : fitScale * zoom;

  // Only ACTIVE nodes are laid out (retired/merged nodes drop off the canvas).
  const activeNodes = useMemo(() => nodes.filter((n) => n.status === "active"), [nodes]);
  const uid = useMemo(() => `tutor-graph`, []);

  const layout = useMemo(() => {
    const layoutNodes: LayoutNodeInput[] = activeNodes.map((n) => ({ id: n.id }));
    const layoutEdges: LayoutEdgeInput[] = edges.map((e) => ({
      source: e.source_node_id,
      target: e.target_node_id,
      kind: e.kind,
    }));
    return layoutConceptGraph(layoutNodes, layoutEdges);
  }, [activeNodes, edges]);

  const masteryById = useMemo(() => {
    const m = new Map<string, MasteryOverlay>();
    for (const o of mastery) m.set(o.node_id, o);
    return m;
  }, [mastery]);

  // Confusion is keyed by block id; map it to a node via the node's first anchor
  // block (R-13 anchors are [{lessonId, blockId, slideId?}]).
  const confusionByBlock = useMemo(() => {
    const c = new Map<string, ConfusionOverlay>();
    for (const o of confusion) c.set(o.block_id, o);
    return c;
  }, [confusion]);

  const firstAnchorBlock = useCallback((n: ConceptNodeRow): string | null => {
    const anchors = (n.anchors ?? []) as Array<{ blockId?: string }>;
    const a = anchors[0];
    return a && typeof a.blockId === "string" ? a.blockId : null;
  }, []);

  // Center-stable zoom: keep the visual center fixed when the scale changes.
  const prevScale = useRef<number | null>(null);
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c || scale === null) return;
    const prev = prevScale.current;
    prevScale.current = scale;
    if (prev === null || prev === scale) return;
    const ratio = scale / prev;
    c.scrollLeft = (c.scrollLeft + c.clientWidth / 2) * ratio - c.clientWidth / 2;
    c.scrollTop = (c.scrollTop + c.clientHeight / 2) * ratio - c.clientHeight / 2;
  }, [scale]);

  // Pointer → logical coordinate (the scaled body rect, per the recipe).
  const toLogical = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const rect = innerRef.current?.getBoundingClientRect();
      if (!rect || scale === null) return null;
      return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
    },
    [scale]
  );

  // Transient drag frame, coalesced to one store write per animation frame.
  const coalescer = useRef(createFrameCoalescer<GraphDragFrame | null>(setDragFrame));
  useEffect(() => {
    const c = coalescer.current;
    return () => c.cancel();
  }, []);

  const dragging = useRef<string | null>(null);
  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.stopPropagation();
      selectNode(nodeId);
      dragging.current = nodeId;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [selectNode]
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const p = toLogical(e.clientX, e.clientY);
      if (p) coalescer.current.push({ nodeId: dragging.current, x: p.x, y: p.y });
    },
    [toLogical]
  );
  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = null;
    // Drop: positions are layout-derived, so we persist NOTHING — just clear the
    // live frame (flush lands any pending frame first so the highlight settles).
    coalescer.current.flush();
    coalescer.current.push(null);
  }, []);

  // Filter highlight for search (matches node title, case-insensitive substring).
  const q = searchFocus.trim().toLowerCase();
  const matches = useCallback(
    (n: ConceptNodeRow) => q.length === 0 || n.title.toLowerCase().includes(q),
    [q]
  );

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
      {/* The scroll viewport + scaled stage. */}
      <div
        ref={containerRef}
        className="relative h-[520px] overflow-auto rounded-2xl border border-stone-200/80 bg-[#fbfaf7]"
        data-ai-component="tutor-graph-canvas"
        role="group"
        aria-label="Concept graph canvas"
      >
        {scale === null ? (
          // Pre-measure: render an invisible spacer so the observer fires (mirrors
          // SlideStage's "invisible until first measure").
          <div style={{ width: GRAPH_W, height: GRAPH_H }} aria-hidden />
        ) : (
          <div
            ref={innerRef}
            data-stage-body
            className="relative origin-top-left"
            style={{ width: GRAPH_W * scale, height: GRAPH_H * scale }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `scale(${scale})`, width: GRAPH_W, height: GRAPH_H }}
            >
              <svg
                width={GRAPH_W}
                height={GRAPH_H}
                viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
                style={{ display: "block", overflow: "visible" }}
              >
                <DiagramDefs uid={uid} accent="#ea580c" />
                {/* Edges (prerequisite solid, part_of/related dashed). */}
                {edges.map((edge) => {
                  const sp = layout.positions.get(edge.source_node_id);
                  const tp = layout.positions.get(edge.target_node_id);
                  if (!sp || !tp) return null;
                  const s = nodeCenter(sp);
                  const t = nodeCenter(tp);
                  const isPrereq = edge.kind === "prerequisite";
                  return (
                    <line
                      key={edge.id}
                      x1={s.x}
                      y1={s.y + NODE_H / 2}
                      x2={t.x}
                      y2={t.y - NODE_H / 2}
                      stroke={isPrereq ? AXIS : "rgba(120,113,108,0.6)"}
                      strokeWidth={selection.kind === "edge" && selection.id === edge.id ? 3 : 1.6}
                      strokeDasharray={isPrereq ? undefined : "5 4"}
                      markerEnd={`url(#${uid}-arrow${isPrereq ? "" : "-muted"})`}
                    />
                  );
                })}
                {/* Nodes. */}
                {activeNodes.map((n) => {
                  const pos = layout.positions.get(n.id);
                  if (!pos) return null;
                  const r = nodeRect(pos);
                  const isSel = selection.kind === "node" && selection.id === n.id;
                  const dim = q.length > 0 && !matches(n);
                  const fill = masteryFill(masteryById.get(n.id), showMastery);
                  const anchorBlock = firstAnchorBlock(n);
                  const confStroke = anchorBlock
                    ? confusionStroke(confusionByBlock.get(anchorBlock), showConfusion)
                    : null;
                  const stroke = isSel ? "#ea580c" : confStroke ?? "#d6d3d1";
                  return (
                    <g
                      key={n.id}
                      style={{ cursor: "pointer", opacity: dim ? 0.35 : 1, transition: `opacity 150ms ${EASE}` }}
                      onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    >
                      <rect
                        x={r.x}
                        y={r.y}
                        width={NODE_W}
                        height={NODE_H}
                        rx={12}
                        fill={fill === "#ffffff" ? "#ffffff" : fill}
                        stroke={stroke}
                        strokeWidth={isSel ? 2.5 : confStroke ? 2 : 1.4}
                      />
                      <Label
                        x={r.x + NODE_W / 2}
                        y={r.y + NODE_H / 2}
                        size={15}
                        weight={600}
                        color="#44403c"
                      >
                        {n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}
                      </Label>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Keyboard-operable equivalent: a focusable node list (arrow keys move the
          selection, Enter opens the drawer). This IS the accessible mirror of the
          canvas mouse navigation. */}
      <NodeList
        nodes={activeNodes}
        selectedId={selection.kind === "node" ? selection.id : null}
        onSelect={selectNode}
      />
    </div>
  );
}

/* ------------------------------ node list -------------------------------- */

/** The a11y equivalent to the canvas: a listbox of active nodes. Arrow keys move
 *  the roving selection; Enter/Space select (which opens the detail drawer). */
function NodeList({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: ConceptNodeRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const sorted = useMemo(
    () => [...nodes].sort((a, b) => a.title.localeCompare(b.title)),
    [nodes]
  );
  const activeIndex = Math.max(0, sorted.findIndex((n) => n.id === selectedId));

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (sorted.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = (activeIndex + delta + sorted.length) % sorted.length;
        onSelect(sorted[next].id);
      }
    },
    [activeIndex, sorted, onSelect]
  );

  return (
    <div
      role="listbox"
      aria-label="Concepts (keyboard-navigable)"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="max-h-[520px] overflow-auto rounded-2xl border border-stone-200/80 bg-white p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      {sorted.length === 0 ? (
        <p className="px-2 py-3 text-xs text-stone-500">No active concepts.</p>
      ) : (
        sorted.map((n, i) => {
          const isSel = n.id === selectedId;
          return (
            <div
              key={n.id}
              role="option"
              aria-selected={isSel}
              tabIndex={i === activeIndex ? 0 : -1}
              onClick={() => onSelect(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(n.id);
                }
              }}
              className={
                "cursor-pointer truncate rounded-lg px-2.5 py-1.5 text-[13px] transition-colors " +
                (isSel ? "bg-brand-50 font-medium text-brand-800" : "text-stone-700 hover:bg-stone-50")
              }
            >
              {n.title}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ----------------------------- deep links -------------------------------- */

/**
 * The teaching-slide deep-link builder (R-13 block-level fallback). Points the
 * creator at the exact block in the studio editor. slideId is intentionally NOT
 * appended — the studio DeepLinkFocus resolves block-level; per R-13 a missing/
 * downgraded slide anchor degrades to the block. Pure + exported for the verify
 * script.
 */
export function buildTeachingDeepLink(courseId: string, lessonId: string, blockId?: string): string {
  const base = `/studio?course=${courseId}&lesson=${lessonId}`;
  return blockId ? `${base}&block=${blockId}` : base;
}

/* ---------------------------- workspace ---------------------------------- */

export interface GraphWorkspaceProps {
  courseId: string;
  nodes: ConceptNodeRow[];
  edges: ConceptEdgeRow[];
  mastery: MasteryOverlay[];
  confusion: ConfusionOverlay[];
  evidenceByNode: Record<string, unknown>;
}

/**
 * The client orchestrator that ties the canvas, overlay toggles, and detail drawer
 * together (the selection lives in the standalone editor store; the overlay toggles
 * are pure view state; merge routes through mergeNodesAction with the survivor the
 * creator names). This is the ONE client boundary GraphTab (server) renders. It
 * imports NOTHING from lib/course/store, lib/course/patches, lib/editor/uiStore,
 * lib/editor/dragStore, or SlideStage.
 */
export function GraphWorkspace({ courseId, nodes, edges, mastery, confusion, evidenceByNode }: GraphWorkspaceProps) {
  const [showMastery, setShowMastery] = useState(true);
  const [showConfusion, setShowConfusion] = useState(true);
  const [mergePending, startMerge] = useTransition();
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);

  const selection = useGraphEditorStore((s) => s.selection);
  const clearSelection = useGraphEditorStore((s) => s.clearSelection);
  const searchFocus = useGraphEditorStore((s) => s.searchFocus);
  const setSearchFocus = useGraphEditorStore((s) => s.setSearchFocus);
  const zoomIn = useGraphEditorStore((s) => s.zoomIn);
  const zoomOut = useGraphEditorStore((s) => s.zoomOut);
  const resetZoom = useGraphEditorStore((s) => s.resetZoom);
  const zoom = useGraphEditorStore((s) => s.zoom);

  const activeNodes = useMemo(() => nodes.filter((n) => n.status === "active"), [nodes]);
  const masteryById = useMemo(() => {
    const m = new Map<string, MasteryOverlay>();
    for (const o of mastery) m.set(o.node_id, o);
    return m;
  }, [mastery]);
  const confusionByBlock = useMemo(() => {
    const c = new Map<string, ConfusionOverlay>();
    for (const o of confusion) c.set(o.block_id, o);
    return c;
  }, [confusion]);

  const selectedNode =
    selection.kind === "node" ? activeNodes.find((n) => n.id === selection.id) ?? null : null;

  // Confusion for the selected node = its first anchor block's overlay.
  const selectedConfusion = (() => {
    if (!selectedNode) return undefined;
    const anchors = (selectedNode.anchors ?? []) as Array<{ blockId?: string }>;
    const block = anchors[0]?.blockId;
    return block ? confusionByBlock.get(block) : undefined;
  })();

  const mergeTargets = useMemo(
    () =>
      selectedNode
        ? activeNodes.filter((n) => n.id !== selectedNode.id).map((n) => ({ id: n.id, title: n.title }))
        : [],
    [activeNodes, selectedNode]
  );

  // THIS node's outgoing prerequisite edges (source === selected), titled for the edge editor.
  const outgoingEdges = useMemo(() => {
    if (!selectedNode) return [];
    const titleById = new Map(activeNodes.map((n) => [n.id, n.title]));
    return edges
      .filter((e) => e.source_node_id === selectedNode.id)
      .map((e) => ({
        id: e.id,
        targetNodeId: e.target_node_id,
        targetTitle: titleById.get(e.target_node_id) ?? "(unknown)",
        kind: e.kind,
        creatorLocked: e.creator_locked,
        version: e.version,
      }));
  }, [selectedNode, edges, activeNodes]);

  const doMerge = useCallback(
    (survivorNodeId: string, absorbedNodeId: string) => {
      startMerge(async () => {
        const res = await mergeNodesAction(courseId, survivorNodeId, [absorbedNodeId]);
        if (res.ok) {
          clearSelection();
          setMergeNotice(null);
        } else {
          setMergeNotice(res.error);
        }
      });
    },
    [courseId, clearSelection]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OverlayToggles
          showMastery={showMastery}
          showConfusion={showConfusion}
          onToggleMastery={setShowMastery}
          onToggleConfusion={setShowConfusion}
        />
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-stone-400" aria-hidden />
            <input
              type="search"
              value={searchFocus}
              onChange={(e) => setSearchFocus(e.target.value)}
              placeholder="Find a concept…"
              aria-label="Search concepts"
              className="h-8 w-44 rounded-full border border-stone-300 pl-8 pr-3 text-xs focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1 rounded-full border border-stone-300 bg-white px-1">
            <button type="button" onClick={zoomOut} aria-label="Zoom out" className="rounded-full p-1.5 text-stone-500 hover:bg-stone-100">
              <ZoomOut className="size-3.5" aria-hidden />
            </button>
            <span className="min-w-9 text-center text-[11px] tabular-nums text-stone-500">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={zoomIn} aria-label="Zoom in" className="rounded-full p-1.5 text-stone-500 hover:bg-stone-100">
              <ZoomIn className="size-3.5" aria-hidden />
            </button>
            <button type="button" onClick={resetZoom} aria-label="Reset zoom" className="rounded-full p-1.5 text-stone-500 hover:bg-stone-100">
              <Maximize className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {mergeNotice ? (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {mergeNotice}
        </p>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
        <GraphCanvas
          courseId={courseId}
          nodes={nodes}
          edges={edges}
          mastery={mastery}
          confusion={confusion}
          showMastery={showMastery}
          showConfusion={showConfusion}
        />
        {selectedNode ? (
          <NodeDetailDrawer
            courseId={courseId}
            node={selectedNode}
            mastery={masteryById.get(selectedNode.id)}
            confusion={selectedConfusion}
            evidence={evidenceByNode[selectedNode.id]}
            mergeTargets={mergeTargets}
            outgoingEdges={outgoingEdges}
            onClose={clearSelection}
            onMerge={doMerge}
          />
        ) : (
          <aside className="hidden rounded-2xl border border-dashed border-stone-200 p-6 text-center text-sm text-stone-600 xl:block">
            {mergePending ? "Merging…" : "Select a concept to see its details, mastery, and evidence."}
          </aside>
        )}
      </div>
    </div>
  );
}
