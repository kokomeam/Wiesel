/**
 * DiagramView — turns a typed `DiagramSpec` into crisp SVG. Pure (no hooks/store),
 * so it renders identically on the server, in thumbnails, and on the live canvas,
 * and is export-ready. Dispatches on `diagram.kind` to a per-kind renderer; each
 * renderer lays out within a padded inner box using the shared geometry maths
 * (lib/course/diagram/geometry.ts) so the picture is deterministic and accurate.
 */

import type { ReactNode } from "react";
import {
  layoutFlow,
  layoutGraph,
  layoutTree,
  linearScale,
  niceStep,
  supplyDemandEquilibrium,
  ticks as axisTicks,
} from "@/lib/course/diagram/geometry";
import type {
  ArrayDiagram,
  BarChartDiagram,
  CoordinatePlotDiagram,
  DiagramSpec,
  FlowchartDiagram,
  GraphDiagram,
  NumberLineDiagram,
  SupplyDemandDiagram,
  TreeDiagram,
  VennDiagram,
} from "@/lib/course/diagram/types";
import { alpha, AXIS, Axes, type Box, DiagramDefs, type DiagramPalette, GRID, Label } from "./svg";

const SERIES_COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"];

function approxTextW(text: string, size: number): number {
  return text.length * size * 0.56;
}

export function DiagramView({
  diagram,
  width,
  height,
  palette,
  uid,
}: {
  diagram: DiagramSpec;
  width: number;
  height: number;
  palette: DiagramPalette;
  uid: string;
}) {
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", overflow: "visible" }}
    >
      <DiagramDefs uid={uid} accent={palette.accent} />
      {renderDiagram(diagram, width, height, palette, uid)}
    </svg>
  );
}

function renderDiagram(d: DiagramSpec, w: number, h: number, p: DiagramPalette, uid: string): ReactNode {
  switch (d.kind) {
    case "supply_demand":
      return <SupplyDemand d={d} w={w} h={h} p={p} uid={uid} />;
    case "coordinate_plot":
      return <CoordinatePlot d={d} w={w} h={h} p={p} uid={uid} />;
    case "bar_chart":
      return <BarChart d={d} w={w} h={h} p={p} uid={uid} />;
    case "array_diagram":
      return <ArrayView d={d} w={w} h={h} p={p} />;
    case "tree_diagram":
      return <TreeView d={d} w={w} h={h} p={p} />;
    case "graph_diagram":
      return <GraphView d={d} w={w} h={h} p={p} uid={uid} />;
    case "flowchart":
      return <FlowchartView d={d} w={w} h={h} p={p} uid={uid} />;
    case "number_line":
      return <NumberLineView d={d} w={w} h={h} p={p} uid={uid} />;
    case "venn":
      return <VennView d={d} w={w} h={h} p={p} />;
  }
}

/* ────────────────────────────── Supply / demand ───────────────────────── */

function SupplyDemand({ d, w, h, p, uid }: { d: SupplyDemandDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const box: Box = { x: 70, y: 20, w: w - 110, h: h - 80 };
  const px = (qx: number) => box.x + qx * box.w;
  const py = (pr: number) => box.y + (1 - pr) * box.h; // price up
  const eq = supplyDemandEquilibrium(d.supply, d.demand);
  const sColor = p.accent;
  const dColor = "#0ea5e9";

  // Intervention quantities at the regulated price.
  let intervention: ReactNode = null;
  if (d.intervention) {
    const lvl = d.intervention.level;
    const qs = (lvl - d.supply.leftY) / (d.supply.rightY - d.supply.leftY || 1);
    const qd = (lvl - d.demand.leftY) / (d.demand.rightY - d.demand.leftY || 1);
    const qsC = Math.max(0, Math.min(1, qs));
    const qdC = Math.max(0, Math.min(1, qd));
    const lo = Math.min(qsC, qdC);
    const hi = Math.max(qsC, qdC);
    const isCeiling = d.intervention.kind === "price_ceiling";
    const gapLabel = isCeiling ? "Shortage" : "Surplus";
    intervention = (
      <g>
        <line x1={box.x} y1={py(lvl)} x2={px(1)} y2={py(lvl)} stroke="#dc2626" strokeWidth={2.2} strokeDasharray="2 0" />
        <Label x={px(1) + 4} y={py(lvl)} anchor="start" size={14} color="#dc2626" weight={600}>
          {d.intervention.label ?? (isCeiling ? "Ceiling" : "Floor")}
        </Label>
        {/* bracket on the x-axis between Qs and Qd */}
        <line x1={px(lo)} y1={box.y + box.h} x2={px(hi)} y2={box.y + box.h} stroke="#dc2626" strokeWidth={3} />
        <line x1={px(lo)} y1={py(lvl)} x2={px(lo)} y2={box.y + box.h} stroke="#dc2626" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
        <line x1={px(hi)} y1={py(lvl)} x2={px(hi)} y2={box.y + box.h} stroke="#dc2626" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
        <Label x={px((lo + hi) / 2)} y={box.y + box.h + 20} size={13.5} color="#dc2626" weight={600}>{gapLabel}</Label>
      </g>
    );
  }

  return (
    <g>
      <Axes box={box} uid={uid} xLabel={d.xLabel ?? "Quantity"} yLabel={d.yLabel ?? "Price"} palette={p} />
      {/* dashed guides to the equilibrium */}
      <line x1={box.x} y1={py(eq.y)} x2={px(eq.x)} y2={py(eq.y)} stroke={GRID} strokeWidth={1.4} strokeDasharray="5 4" />
      <line x1={px(eq.x)} y1={box.y + box.h} x2={px(eq.x)} y2={py(eq.y)} stroke={GRID} strokeWidth={1.4} strokeDasharray="5 4" />
      {/* supply + demand */}
      <line x1={px(0)} y1={py(d.supply.leftY)} x2={px(1)} y2={py(d.supply.rightY)} stroke={sColor} strokeWidth={3} />
      <line x1={px(0)} y1={py(d.demand.leftY)} x2={px(1)} y2={py(d.demand.rightY)} stroke={dColor} strokeWidth={3} />
      <Label x={px(0.96)} y={py(d.supply.rightY) - 14} anchor="end" size={15} color={sColor} weight={600}>Supply</Label>
      <Label x={px(0.96)} y={py(d.demand.rightY) - 14} anchor="end" size={15} color={dColor} weight={600}>Demand</Label>
      {intervention}
      {/* equilibrium point + labels */}
      <circle cx={px(eq.x)} cy={py(eq.y)} r={6} fill={p.ink} />
      <Label x={px(eq.x) + 12} y={py(eq.y) - 12} anchor="start" size={16} color={p.ink} weight={700}>{d.equilibriumLabel ?? "E"}</Label>
      <Label x={box.x - 14} y={py(eq.y)} anchor="end" size={14} color={p.body} weight={600}>{d.priceLabel ?? "P*"}</Label>
      <Label x={px(eq.x)} y={box.y + box.h + 20} size={14} color={p.body} weight={600}>{d.quantityLabel ?? "Q*"}</Label>
    </g>
  );
}

/* ─────────────────────────────── Coordinate plot ──────────────────────── */

function CoordinatePlot({ d, w, h, p, uid }: { d: CoordinatePlotDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const box: Box = { x: 78, y: 20, w: w - 120, h: h - 96 };
  const sx = linearScale([d.xRange.min, d.xRange.max], [box.x, box.x + box.w]);
  const sy = linearScale([d.yRange.min, d.yRange.max], [box.y + box.h, box.y]);
  const xStep = niceStep(d.xRange.max - d.xRange.min);
  const yStep = niceStep(d.yRange.max - d.yRange.min);
  const xt = axisTicks(d.xRange.min, d.xRange.max, xStep);
  const yt = axisTicks(d.yRange.min, d.yRange.max, yStep);
  const color = (i: number, c?: string) => c ?? (i === 0 ? p.accent : SERIES_COLORS[i % SERIES_COLORS.length]);

  return (
    <g>
      {/* gridlines */}
      {xt.map((t, i) => (
        <line key={`gx${i}`} x1={sx(t)} y1={box.y} x2={sx(t)} y2={box.y + box.h} stroke={GRID} strokeWidth={1} />
      ))}
      {yt.map((t, i) => (
        <line key={`gy${i}`} x1={box.x} y1={sy(t)} x2={box.x + box.w} y2={sy(t)} stroke={GRID} strokeWidth={1} />
      ))}
      <Axes box={box} uid={uid} xLabel={d.xLabel} yLabel={d.yLabel} palette={p} />
      {/* tick labels */}
      {xt.map((t, i) => (
        <Label key={`tx${i}`} x={sx(t)} y={box.y + box.h + 18} size={12.5} color={p.muted}>{fmt(t)}</Label>
      ))}
      {yt.map((t, i) => (
        <Label key={`ty${i}`} x={box.x - 10} y={sy(t)} anchor="end" size={12.5} color={p.muted}>{fmt(t)}</Label>
      ))}
      {/* shaded region under a series */}
      {d.shaded && d.series[d.shaded.seriesIndex] && (
        <ShadedRegion shaded={d.shaded} series={d.series[d.shaded.seriesIndex]} sx={sx} sy={sy} box={box} fill={alpha(color(d.shaded.seriesIndex, d.series[d.shaded.seriesIndex].color), 0.16)} label={p.body} />
      )}
      {/* series */}
      {d.series.map((s, i) => {
        const c = color(i, s.color);
        const pts = s.points.map((pt) => `${sx(pt.x)},${sy(pt.y)}`).join(" ");
        return (
          <g key={`s${i}`}>
            {s.style === "scatter"
              ? s.points.map((pt, j) => <circle key={j} cx={sx(pt.x)} cy={sy(pt.y)} r={4.5} fill={c} />)
              : <polyline points={pts} fill="none" stroke={c} strokeWidth={2.6} strokeDasharray={s.style === "dashed" ? "7 5" : undefined} strokeLinejoin="round" />}
          </g>
        );
      })}
      {/* markers */}
      {d.markers?.map((m, i) => (
        <g key={`m${i}`}>
          <circle cx={sx(m.x)} cy={sy(m.y)} r={5} fill={p.ink} />
          <Label x={sx(m.x) + 10} y={sy(m.y) - 10} anchor="start" size={14} color={p.ink} weight={600}>{m.label}</Label>
        </g>
      ))}
      {/* legend */}
      {d.series.length > 1 && (
        <g>
          {d.series.map((s, i) => (
            <g key={`l${i}`} transform={`translate(${box.x + i * 150}, ${box.y + box.h + 42})`}>
              <rect width={16} height={4} y={5} rx={2} fill={color(i, s.color)} />
              <Label x={22} y={8} anchor="start" size={13} color={p.body}>{s.label}</Label>
            </g>
          ))}
        </g>
      )}
    </g>
  );
}

function ShadedRegion({
  shaded,
  series,
  sx,
  sy,
  box,
  fill,
  label,
}: {
  shaded: NonNullable<CoordinatePlotDiagram["shaded"]>;
  series: CoordinatePlotDiagram["series"][number];
  sx: (v: number) => number;
  sy: (v: number) => number;
  box: Box;
  fill: string;
  label: string;
}) {
  const pts = series.points.filter((pt) => pt.x >= shaded.fromX && pt.x <= shaded.toX);
  if (pts.length < 2) return null;
  const baseline = box.y + box.h;
  const path =
    `M ${sx(pts[0].x)},${baseline} ` +
    pts.map((pt) => `L ${sx(pt.x)},${sy(pt.y)}`).join(" ") +
    ` L ${sx(pts[pts.length - 1].x)},${baseline} Z`;
  const midX = (sx(shaded.fromX) + sx(shaded.toX)) / 2;
  return (
    <g>
      <path d={path} fill={fill} />
      {shaded.label && <Label x={midX} y={baseline - 28} size={14} color={label} weight={600}>{shaded.label}</Label>}
    </g>
  );
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 1 ? 2 : 1);
}

/* ────────────────────────────────── Bar chart ─────────────────────────── */

function BarChart({ d, w, h, p, uid }: { d: BarChartDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const box: Box = { x: 70, y: 20, w: w - 110, h: h - 84 };
  const max = d.maxValue ?? Math.max(1, ...d.bars.map((b) => b.value)) * 1.12;
  const n = d.bars.length;
  const slot = box.w / n;
  const barW = Math.min(slot * 0.6, 96);
  const sy = linearScale([0, max], [box.y + box.h, box.y]);
  const yStep = niceStep(max);
  const yt = axisTicks(0, max, yStep);
  return (
    <g>
      {yt.map((t, i) => (
        <line key={i} x1={box.x} y1={sy(t)} x2={box.x + box.w} y2={sy(t)} stroke={GRID} strokeWidth={1} />
      ))}
      {yt.map((t, i) => (
        <Label key={`t${i}`} x={box.x - 10} y={sy(t)} anchor="end" size={12.5} color={p.muted}>{fmt(t)}</Label>
      ))}
      <Axes box={box} uid={uid} xLabel={d.xLabel} yLabel={d.yLabel} palette={p} />
      {d.bars.map((b, i) => {
        const cx = box.x + slot * (i + 0.5);
        const top = sy(Math.max(0, b.value));
        const barH = box.y + box.h - top;
        return (
          <g key={i}>
            <rect x={cx - barW / 2} y={top} width={barW} height={Math.max(0, barH)} rx={6} fill={b.color ?? (i === 0 ? p.accent : SERIES_COLORS[i % SERIES_COLORS.length])} />
            <Label x={cx} y={top - 12} size={14} color={p.ink} weight={600}>{fmt(b.value)}</Label>
            <Label x={cx} y={box.y + box.h + 20} size={13} color={p.body}>{b.label}</Label>
          </g>
        );
      })}
    </g>
  );
}

/* ────────────────────────────────── Array ─────────────────────────────── */

function ArrayView({ d, w, h, p }: { d: ArrayDiagram; w: number; h: number; p: DiagramPalette }) {
  const n = d.values.length;
  const cellW = Math.min((w - 80) / n, 96);
  const cellH = Math.min(cellW, 84);
  const totalW = cellW * n;
  const x0 = (w - totalW) / 2;
  const showIdx = d.showIndices !== false;
  const hasPointers = !!d.pointers?.length;
  const y0 = h / 2 - cellH / 2 + (hasPointers ? 14 : 0);
  const markByIndex = new Map<number, ArrayDiagram["marks"] extends (infer M)[] | undefined ? M : never>();
  d.marks?.forEach((m) => markByIndex.set(m.index, m));

  const cellFill = (i: number): string => {
    const m = d.marks?.find((mm) => mm.index === i);
    if (m?.kind === "found") return alpha("#10b981", 0.22);
    if (m?.kind === "target") return alpha(p.accent, 0.22);
    if (m?.kind === "eliminated") return "rgba(120,113,108,0.1)";
    if (d.window && i >= d.window.from && i <= d.window.to) return alpha(p.accent, 0.12);
    return "#ffffff";
  };
  const cellStroke = (i: number): string => {
    const m = d.marks?.find((mm) => mm.index === i);
    if (m?.kind === "visited" || m?.kind === "found") return p.accent;
    if (m?.kind === "eliminated") return "rgba(120,113,108,0.3)";
    return "rgba(68,48,28,0.28)";
  };
  const cellTextColor = (i: number): string => {
    const m = d.marks?.find((mm) => mm.index === i);
    return m?.kind === "eliminated" ? p.muted : p.ink;
  };

  // group pointers by index so multiple at one cell stack
  const pByIndex = new Map<number, ArrayDiagram["pointers"]>();
  d.pointers?.forEach((ptr) => {
    const arr = pByIndex.get(ptr.index) ?? [];
    arr.push(ptr);
    pByIndex.set(ptr.index, arr as ArrayDiagram["pointers"]);
  });

  return (
    <g>
      {d.window && (
        <Label x={x0 + (d.window.from + (d.window.to - d.window.from + 1) / 2) * cellW} y={y0 + cellH + (showIdx ? 44 : 26)} size={14} color={p.accent} weight={600}>
          {d.window.label ?? ""}
        </Label>
      )}
      {d.values.map((v, i) => {
        const cx = x0 + i * cellW;
        const m = d.marks?.find((mm) => mm.index === i);
        return (
          <g key={i}>
            <rect x={cx} y={y0} width={cellW - 4} height={cellH} rx={8} fill={cellFill(i)} stroke={cellStroke(i)} strokeWidth={m?.kind === "visited" || m?.kind === "found" ? 2.6 : 1.4} />
            <Label x={cx + (cellW - 4) / 2} y={y0 + cellH / 2} size={22} color={cellTextColor(i)} weight={600} mono>{v}</Label>
            {showIdx && <Label x={cx + (cellW - 4) / 2} y={y0 + cellH + 16} size={12.5} color={p.muted} mono>{i}</Label>}
          </g>
        );
      })}
      {/* pointers above the cells */}
      {[...pByIndex.entries()].map(([idx, ptrs]) => {
        const cx = x0 + idx * cellW + (cellW - 4) / 2;
        return (
          <g key={`p${idx}`}>
            {(ptrs ?? []).map((ptr, j) => (
              <Label key={j} x={cx} y={y0 - 14 - j * 18} size={14} color={ptr.color ?? p.accent} weight={700}>
                {ptr.label}
              </Label>
            ))}
            <path d={`M ${cx} ${y0 - 8} l -5 -8 l 10 0 z`} fill={(ptrs?.[0]?.color) ?? p.accent} />
          </g>
        );
      })}
    </g>
  );
}

/* ────────────────────────────────── Tree ──────────────────────────────── */

function TreeView({ d, w, h, p }: { d: TreeDiagram; w: number; h: number; p: DiagramPalette }) {
  const laid = layoutTree(d.root);
  const pad = 56;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const X = (nx: number) => pad + nx * innerW;
  const Y = (ny: number) => pad + ny * innerH;
  const pos = new Map(laid.nodes.map((n) => [n.id, n]));
  // traversal badge numbers, matched by label in order
  const badge = new Map<string, number>();
  if (d.highlightOrder) {
    const used = new Set<string>();
    d.highlightOrder.forEach((lbl, i) => {
      const node = laid.nodes.find((n) => n.label === lbl && !used.has(n.id));
      if (node) {
        used.add(node.id);
        badge.set(node.id, i + 1);
      }
    });
  }
  const r = Math.min(26, innerW / (laid.nodes.length + 1));
  return (
    <g>
      {laid.edges.map((e, i) => {
        const a = pos.get(e.from)!;
        const b = pos.get(e.to)!;
        return <line key={i} x1={X(a.x)} y1={Y(a.y)} x2={X(b.x)} y2={Y(b.y)} stroke="rgba(68,48,28,0.32)" strokeWidth={1.6} />;
      })}
      {laid.nodes.map((n) => {
        const cx = X(n.x);
        const cy = Y(n.y);
        const rw = Math.max(r * 2, approxTextW(n.label, 16) + 18);
        return (
          <g key={n.id}>
            <rect x={cx - rw / 2} y={cy - 20} width={rw} height={40} rx={20} fill={n.highlight ? alpha(p.accent, 0.16) : "#ffffff"} stroke={n.highlight ? p.accent : "rgba(68,48,28,0.3)"} strokeWidth={n.highlight ? 2.4 : 1.5} />
            <Label x={cx} y={cy} size={16} color={p.ink} weight={600} mono>{n.label}</Label>
            {badge.has(n.id) && (
              <g>
                <circle cx={cx + rw / 2 - 2} cy={cy - 20} r={11} fill={p.accent} />
                <Label x={cx + rw / 2 - 2} y={cy - 20} size={12} color="#ffffff" weight={700}>{badge.get(n.id)}</Label>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

/* ────────────────────────────────── Graph ─────────────────────────────── */

function GraphView({ d, w, h, p, uid }: { d: GraphDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const pos = layoutGraph(d.nodes);
  const pad = 56;
  const X = (nx: number) => pad + nx * (w - pad * 2);
  const Y = (ny: number) => pad + ny * (h - pad * 2);
  const R = 26;
  const onPath = new Set<string>();
  if (d.highlightPath) {
    for (let i = 0; i + 1 < d.highlightPath.length; i++) onPath.add(`${d.highlightPath[i]}->${d.highlightPath[i + 1]}`);
  }
  const pathNodes = new Set(d.highlightPath ?? []);
  return (
    <g>
      {d.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const ax = X(a.x), ay = Y(a.y), bx = X(b.x), by = Y(b.y);
        const ang = Math.atan2(by - ay, bx - ax);
        const sx = ax + Math.cos(ang) * R, sy = ay + Math.sin(ang) * R;
        const ex = bx - Math.cos(ang) * (R + (d.directed ? 4 : 0)), ey = by - Math.sin(ang) * (R + (d.directed ? 4 : 0));
        const hot = e.highlight || onPath.has(`${e.from}->${e.to}`) || (!d.directed && onPath.has(`${e.to}->${e.from}`));
        const mx = (sx + ex) / 2, my = (sy + ey) / 2;
        const wLabel = e.label ?? (e.weight !== undefined ? String(e.weight) : "");
        return (
          <g key={i}>
            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={hot ? p.accent : "rgba(68,48,28,0.4)"} strokeWidth={hot ? 3 : 1.8} markerEnd={d.directed ? `url(#${uid}-${hot ? "arrow-accent" : "arrow"})` : undefined} />
            {wLabel && (
              <g>
                <rect x={mx - approxTextW(wLabel, 14) / 2 - 5} y={my - 11} width={approxTextW(wLabel, 14) + 10} height={20} rx={5} fill="#ffffff" stroke={GRID} />
                <Label x={mx} y={my} size={14} color={hot ? p.accent : p.body} weight={600}>{wLabel}</Label>
              </g>
            )}
          </g>
        );
      })}
      {d.nodes.map((n) => {
        const pt = pos.get(n.id)!;
        const cx = X(pt.x), cy = Y(pt.y);
        const hot = pathNodes.has(n.id);
        return (
          <g key={n.id}>
            <circle cx={cx} cy={cy} r={R} fill={hot ? alpha(p.accent, 0.16) : "#ffffff"} stroke={hot ? p.accent : "rgba(68,48,28,0.4)"} strokeWidth={hot ? 2.8 : 1.8} />
            <Label x={cx} y={cy} size={16} color={p.ink} weight={600}>{n.label ?? n.id}</Label>
          </g>
        );
      })}
    </g>
  );
}

/* ──────────────────────────────── Flowchart ───────────────────────────── */

function FlowchartView({ d, w, h, p, uid }: { d: FlowchartDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const laid = layoutFlow(d.nodes, d.edges);
  const padX = 40;
  const padY = 36;
  const X = (nx: number) => padX + nx * (w - padX * 2);
  const Y = (ny: number) => padY + ny * (h - padY * 2);
  const nodeH = 46;
  const pos = new Map(laid.nodes.map((n) => [n.id, n]));
  const nodeW = (label: string, kind: string) => {
    const base = approxTextW(label, 15) + (kind === "decision" ? 56 : 40);
    return Math.max(110, Math.min(base, (w - padX * 2) / Math.max(1, laid.rows > 1 ? 2 : 1) - 20, 240));
  };
  return (
    <g>
      {d.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const ax = X(a.x), ay = Y(a.y), bx = X(b.x), by = Y(b.y);
        const ang = Math.atan2(by - ay, bx - ax);
        // stop just outside the target box
        const ex = bx - Math.cos(ang) * (nodeH / 2 + 8);
        const ey = by - Math.sin(ang) * (nodeH / 2 + 8);
        const mx = (ax + ex) / 2, my = (ay + ey) / 2;
        return (
          <g key={i}>
            <line x1={ax} y1={ay} x2={ex} y2={ey} stroke="rgba(68,48,28,0.45)" strokeWidth={1.8} markerEnd={`url(#${uid}-arrow)`} />
            {e.label && (
              <g>
                <rect x={mx - approxTextW(e.label, 13) / 2 - 5} y={my - 10} width={approxTextW(e.label, 13) + 10} height={19} rx={5} fill="#ffffff" stroke={GRID} />
                <Label x={mx} y={my} size={13} color={p.body} weight={600}>{e.label}</Label>
              </g>
            )}
          </g>
        );
      })}
      {laid.nodes.map((n) => {
        const cx = X(n.x), cy = Y(n.y);
        const nw = nodeW(n.label, n.kind);
        const accentNode = n.kind === "start" || n.kind === "end";
        const fill = accentNode ? alpha(p.accent, 0.14) : "#ffffff";
        const stroke = accentNode ? p.accent : "rgba(68,48,28,0.32)";
        let shape: ReactNode;
        if (n.kind === "decision") {
          shape = <polygon points={`${cx},${cy - nodeH / 2 - 4} ${cx + nw / 2},${cy} ${cx},${cy + nodeH / 2 + 4} ${cx - nw / 2},${cy}`} fill={alpha(p.accent, 0.08)} stroke={p.accent} strokeWidth={1.6} />;
        } else if (n.kind === "io") {
          shape = <polygon points={`${cx - nw / 2 + 14},${cy - nodeH / 2} ${cx + nw / 2},${cy - nodeH / 2} ${cx + nw / 2 - 14},${cy + nodeH / 2} ${cx - nw / 2},${cy + nodeH / 2}`} fill={fill} stroke={stroke} strokeWidth={1.6} />;
        } else {
          shape = <rect x={cx - nw / 2} y={cy - nodeH / 2} width={nw} height={nodeH} rx={accentNode ? nodeH / 2 : 10} fill={fill} stroke={stroke} strokeWidth={1.6} />;
        }
        return (
          <g key={n.id}>
            {shape}
            <Label x={cx} y={cy} size={15} color={p.ink} weight={accentNode ? 700 : 500}>{n.label}</Label>
          </g>
        );
      })}
    </g>
  );
}

/* ──────────────────────────────── Number line ─────────────────────────── */

function NumberLineView({ d, w, h, p, uid }: { d: NumberLineDiagram; w: number; h: number; p: DiagramPalette; uid: string }) {
  const pad = 60;
  const y = h / 2;
  const sx = linearScale([d.min, d.max], [pad, w - pad]);
  const step = d.step && d.step > 0 ? d.step : niceStep(d.max - d.min);
  const tk = axisTicks(d.min, d.max, step);
  return (
    <g>
      <line x1={pad - 10} y1={y} x2={w - pad + 10} y2={y} stroke={AXIS} strokeWidth={2} markerEnd={`url(#${uid}-arrow)`} markerStart={`url(#${uid}-arrow)`} />
      {tk.map((t, i) => (
        <g key={i}>
          <line x1={sx(t)} y1={y - 6} x2={sx(t)} y2={y + 6} stroke={AXIS} strokeWidth={1.4} />
          <Label x={sx(t)} y={y + 26} size={13} color={p.muted} mono>{fmt(t)}</Label>
        </g>
      ))}
      {d.intervals?.map((iv, i) => {
        const x1 = sx(iv.from), x2 = sx(iv.to);
        return (
          <g key={`iv${i}`}>
            <line x1={x1} y1={y - 16} x2={x2} y2={y - 16} stroke={p.accent} strokeWidth={4} />
            <circle cx={x1} cy={y - 16} r={6} fill={iv.closedLeft ? p.accent : "#ffffff"} stroke={p.accent} strokeWidth={2} />
            <circle cx={x2} cy={y - 16} r={6} fill={iv.closedRight ? p.accent : "#ffffff"} stroke={p.accent} strokeWidth={2} />
            {iv.label && <Label x={(x1 + x2) / 2} y={y - 32} size={14} color={p.accent} weight={600}>{iv.label}</Label>}
          </g>
        );
      })}
      {d.points?.map((pt, i) => (
        <g key={`pt${i}`}>
          <circle cx={sx(pt.value)} cy={y} r={6} fill={pt.color ?? p.ink} />
          {pt.label && <Label x={sx(pt.value)} y={y - 18} size={14} color={pt.color ?? p.ink} weight={600}>{pt.label}</Label>}
        </g>
      ))}
    </g>
  );
}

/* ──────────────────────────────────── Venn ────────────────────────────── */

function VennView({ d, w, h, p }: { d: VennDiagram; w: number; h: number; p: DiagramPalette }) {
  const r = Math.min(h * 0.42, w * 0.3);
  const cy = h / 2 + 8;
  const overlap = r * 0.75;
  const cxA = w / 2 - overlap / 2;
  const cxB = w / 2 + overlap / 2;
  const cA = "#0ea5e9";
  return (
    <g>
      <circle cx={cxA} cy={cy} r={r} fill={alpha(cA, 0.16)} stroke={cA} strokeWidth={2} />
      <circle cx={cxB} cy={cy} r={r} fill={alpha(p.accent, 0.16)} stroke={p.accent} strokeWidth={2} />
      <Label x={cxA - r * 0.5} y={cy - r - 12} size={18} color={cA} weight={700}>{d.aLabel}</Label>
      <Label x={cxB + r * 0.5} y={cy - r - 12} size={18} color={p.accent} weight={700}>{d.bLabel}</Label>
      {d.aOnly && <WrapText x={cxA - r * 0.55} y={cy} text={d.aOnly} color={p.body} maxChars={14} />}
      {d.bOnly && <WrapText x={cxB + r * 0.55} y={cy} text={d.bOnly} color={p.body} maxChars={14} />}
      {d.both && <WrapText x={w / 2} y={cy} text={d.both} color={p.ink} maxChars={12} weight={600} />}
    </g>
  );
}

/** Crude word-wrap for the Venn region labels (no DOM measurement available). */
function WrapText({ x, y, text, color, maxChars, weight = 400 }: { x: number; y: number; text: string; color: string; maxChars: number; weight?: number }) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if ((cur + " " + word).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) lines.push(cur);
  const start = y - ((lines.length - 1) * 18) / 2;
  return (
    <g>
      {lines.map((ln, i) => (
        <Label key={i} x={x} y={start + i * 18} size={14} color={color} weight={weight}>{ln}</Label>
      ))}
    </g>
  );
}
