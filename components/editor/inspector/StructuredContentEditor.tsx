"use client";

/**
 * Inspector editor for a renderer-owned structured slide: STRUCTURE only (add /
 * remove / reorder items, pick stickers, layout-specific switches like
 * key-concept variant, concept→example body kind, section-break variant, and
 * the renderer-owned `decor` flair level). Text is edited directly on the slide.
 * Every change goes through UPDATE_TEMPLATE_CONTENT (re-validated by the
 * reducer). Dispatches per layout: the four flat layouts share one generic item
 * editor; section_break / concept_example / outline_list have bespoke panels.
 */

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { updateTemplateContentPatch } from "@/lib/course/commands";
import { STICKER_REGISTRY } from "@/lib/course/slide/stickers";
import { ITEM_BOUNDS, findStructuredLayout } from "@/lib/course/slide/structuredLayouts";
import { useEditorStore } from "@/lib/course/store";
import type {
  ComparisonColumnsContent,
  ComparisonFooter,
  ComparisonMatrixContent,
  ConceptExampleContent,
  OutlineListContent,
  ProseContent,
  SectionBreakContent,
  Slide,
} from "@/lib/course/types";
import { Field, PillGroup } from "./DesignTab";

type AnyItem = Record<string, unknown>;
type Path = (string | number)[];

function richText(v: unknown): string {
  return typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string"
    ? (v as { text: string }).text
    : "";
}

/** Hook: a setter that commits a value at a content path. */
function useSet(blockId: string, slideId: string) {
  const apply = useEditorStore((s) => s.apply);
  return (path: Path, value: unknown) =>
    apply(updateTemplateContentPatch(blockId, slideId, path, value), "human");
}

/* ───────────────────────────── Shared bits ─────────────────────────────── */

function HeaderNote({ name }: { name: string }) {
  return (
    <div className="rounded-xl bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
      <span className="font-semibold">{name}</span> — a designed layout. Edit text directly on the
      slide; manage its structure here.
    </div>
  );
}

function DecorField({ value, onChange }: { value: "full" | "minimal" | undefined; onChange: (v: "full" | "minimal") => void }) {
  return (
    <Field label="Decoration">
      <PillGroup options={["full", "minimal"] as const} value={value ?? "full"} label="Decoration" onChange={onChange} />
    </Field>
  );
}

/** A short plain-string slot (number / badge) — edited here, not on the slide. */
function PlainSlotField({
  label,
  value,
  maxLength,
  placeholder,
  onChange,
}: {
  label: string;
  value: string | undefined;
  maxLength: number;
  placeholder: string;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="text"
        value={value ?? ""}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="w-full rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300"
      />
    </Field>
  );
}

/** Reusable add / move / remove controls for a bounded list. */
function ListControls({
  count,
  index,
  min,
  onMove,
  onRemove,
}: {
  count: number;
  index: number;
  min: number;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} className="grid size-6 place-items-center rounded text-stone-400 hover:bg-stone-100 disabled:opacity-25">
        <ArrowUp className="size-3.5" />
      </button>
      <button type="button" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} className="grid size-6 place-items-center rounded text-stone-400 hover:bg-stone-100 disabled:opacity-25">
        <ArrowDown className="size-3.5" />
      </button>
      <button type="button" aria-label="Remove item" disabled={count <= min} onClick={onRemove} className="grid size-6 place-items-center rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-25">
        <Trash2 className="size-3.5" />
      </button>
    </>
  );
}

function reorder<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

function AddButton({ label, disabled, onClick, tool }: { label: string; disabled: boolean; onClick: () => void; tool?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-ai-tool={tool}
      data-ai-action={tool ? "UPDATE_TEMPLATE_CONTENT" : undefined}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50 disabled:opacity-30"
    >
      <Plus className="size-3.5" /> {label}
    </button>
  );
}

/* ─────────────────────────── Generic (flat 4) ──────────────────────────── */

function GenericItemEditor({ slide, blockId }: { slide: Slide; blockId: string }) {
  const template = slide.template!;
  const set = useSet(blockId, slide.id);
  const bounds = ITEM_BOUNDS[template.layoutId];
  if (!bounds) return null;
  const content = template.content as unknown as Record<string, unknown>;
  const items = (content[bounds.key] as AnyItem[] | undefined) ?? [];
  const setItems = (next: AnyItem[]) => set([bounds.key], next);
  const isMetrics = template.layoutId === "metrics_overview";
  const isKeyConcept = template.layoutId === "key_concept";

  return (
    <>
      {isKeyConcept && template.layoutId === "key_concept" && (
        <>
          <Field label="Title style">
            <PillGroup
              options={["sans", "serif"] as const}
              value={template.content.variant}
              label="Variant"
              onChange={(variant) => set(["variant"], variant)}
            />
          </Field>
          <Field label="Connector spine">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={!!template.content.spine}
                onChange={(e) => set(["spine"], e.target.checked)}
                className="size-3.5 accent-brand-600"
              />
              Draw a thin line + node dots between points
            </label>
          </Field>
        </>
      )}

      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          {bounds.key} ({items.length})
        </p>
        <AddButton
          label="Add"
          tool="structured-add-item"
          disabled={items.length >= bounds.max}
          onClick={() => items.length < bounds.max && setItems([...items, bounds.blank()])}
        />
      </div>

      <div className="space-y-2">
        {items.map((item, i) => {
          const delta = item.delta as AnyItem | undefined;
          return (
            <div key={i} className="rounded-xl border border-stone-200 p-2.5">
              <div className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">
                  {richText(item.heading) || richText(item.label) || `Item ${i + 1}`}
                </span>
                <ListControls
                  count={items.length}
                  index={i}
                  min={bounds.min}
                  onMove={(dir) => setItems(reorder(items, i, dir))}
                  onRemove={() => items.length > bounds.min && setItems(items.filter((_, idx) => idx !== i))}
                />
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="text-[11px] text-stone-400">Icon</label>
                <select
                  value={typeof item.sticker === "string" ? item.sticker : ""}
                  aria-label={`Item ${i + 1} sticker`}
                  onChange={(e) => set([bounds.key, i, "sticker"], e.target.value || undefined)}
                  className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300"
                >
                  <option value="">None</option>
                  {STICKER_REGISTRY.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              {isMetrics && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {delta ? (
                    <>
                      <PillGroup
                        options={["up", "down"] as const}
                        value={(delta.direction as "up" | "down") ?? "up"}
                        label="Direction"
                        onChange={(d) => set([bounds.key, i, "delta", "direction"], d)}
                      />
                      <PillGroup
                        options={["positive", "negative", "neutral"] as const}
                        value={(delta.sentiment as "positive" | "negative" | "neutral") ?? "positive"}
                        label="Sentiment"
                        onChange={(s) => set([bounds.key, i, "delta", "sentiment"], s)}
                      />
                      <button type="button" onClick={() => set([bounds.key, i, "delta"], undefined)} className="text-[11px] text-stone-400 hover:text-rose-600">
                        Remove change
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => set([bounds.key, i, "delta"], { direction: "up", text: { text: "0% vs last period" }, sentiment: "positive" })}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-brand-600 hover:bg-brand-50"
                    >
                      <Plus className="size-3" /> Add change indicator
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ───────────────────────────── section_break ───────────────────────────── */

function SectionBreakEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: SectionBreakContent }) {
  const set = useSet(blockId, slide.id);
  return (
    <>
      <Field label="Variant">
        <PillGroup
          options={["standard", "hero_numeral"] as const}
          value={content.variant ?? "standard"}
          label="Variant"
          onChange={(v) => set(["variant"], v)}
        />
      </Field>
      <Field label="Title style">
        <PillGroup
          options={["serif", "sans"] as const}
          value={content.titleStyle ?? "serif"}
          label="Title style"
          onChange={(v) => set(["titleStyle"], v)}
        />
      </Field>
      <PlainSlotField
        label="Section number"
        value={content.number}
        maxLength={4}
        placeholder="e.g. 02"
        onChange={(v) => set(["number"], v)}
      />
      <DecorField value={content.decor} onChange={(v) => set(["decor"], v)} />
    </>
  );
}

/* ──────────────────────────── concept_example ──────────────────────────── */

function ConceptExampleEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: ConceptExampleContent }) {
  const set = useSet(blockId, slide.id);
  const body = content.example.body;
  const isSteps = body.kind === "steps";
  const items = (body.kind === "steps" ? body.steps : body.paragraphs) as unknown as AnyItem[];
  const min = isSteps ? 2 : 1;
  const max = isSteps ? 4 : 3;
  const key = isSteps ? "steps" : "paragraphs";
  const setItems = (next: AnyItem[]) => set(["example", "body", key], next);
  const blank: AnyItem = isSteps ? { heading: { text: "New step" }, body: { text: "" } } : { text: "" };

  function switchKind(kind: "steps" | "paragraphs") {
    if (kind === body.kind) return;
    set(
      ["example", "body"],
      kind === "steps"
        ? { kind: "steps", steps: [{ heading: { text: "Step one" }, body: { text: "" } }, { heading: { text: "Step two" }, body: { text: "" } }] }
        : { kind: "paragraphs", paragraphs: [{ text: "" }] }
    );
  }

  return (
    <>
      <PlainSlotField label="Concept badge" value={content.concept.badge} maxLength={16} placeholder="e.g. Rule" onChange={(v) => set(["concept", "badge"], v)} />
      <Field label="Concept title style">
        <PillGroup options={["serif", "sans"] as const} value={content.concept.titleStyle ?? "serif"} label="Concept title style" onChange={(v) => set(["concept", "titleStyle"], v)} />
      </Field>
      <PlainSlotField label="Example badge" value={content.example.badge} maxLength={20} placeholder="e.g. Worked Example" onChange={(v) => set(["example", "badge"], v)} />

      <Field label="Example body">
        <PillGroup options={["steps", "paragraphs"] as const} value={body.kind} label="Example body" onChange={switchKind} />
      </Field>

      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          {key} ({items.length})
        </p>
        <AddButton label="Add" disabled={items.length >= max} onClick={() => items.length < max && setItems([...items, blank])} />
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl border border-stone-200 p-2.5">
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">
              {richText(item.heading) || richText(item) || `${isSteps ? "Step" : "Paragraph"} ${i + 1}`}
            </span>
            <ListControls
              count={items.length}
              index={i}
              min={min}
              onMove={(dir) => setItems(reorder(items, i, dir))}
              onRemove={() => items.length > min && setItems(items.filter((_, idx) => idx !== i))}
            />
          </div>
        ))}
      </div>

      <Field label="Footnote">
        {content.footnote ? (
          <button type="button" onClick={() => set(["footnote"], undefined)} className="text-[11px] text-stone-400 hover:text-rose-600">
            Remove footnote callout
          </button>
        ) : (
          <AddButton label="Add footnote callout" disabled={false} onClick={() => set(["footnote"], { text: "In practice, …" })} />
        )}
      </Field>

      <DecorField value={content.decor} onChange={(v) => set(["decor"], v)} />
    </>
  );
}

/* ───────────────────────────── outline_list ────────────────────────────── */

function OutlineListEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: OutlineListContent }) {
  const set = useSet(blockId, slide.id);
  const items = content.items as unknown as AnyItem[];
  const MIN = 2;
  const MAX = 5;
  const SUB_MAX = 2;
  const setItems = (next: AnyItem[]) => set(["items"], next);

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">items ({items.length})</p>
        <AddButton label="Add item" disabled={items.length >= MAX} onClick={() => items.length < MAX && setItems([...items, { text: { text: "New objective" } }])} />
      </div>

      <div className="space-y-2">
        {items.map((item, i) => {
          const subs = (item.subItems as AnyItem[] | undefined) ?? [];
          return (
            <div key={i} className="rounded-xl border border-stone-200 p-2.5">
              <div className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{String(i + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{richText(item.text) || `Item ${i + 1}`}</span>
                <ListControls
                  count={items.length}
                  index={i}
                  min={MIN}
                  onMove={(dir) => setItems(reorder(items, i, dir))}
                  onRemove={() => items.length > MIN && setItems(items.filter((_, idx) => idx !== i))}
                />
              </div>

              <div className="mt-2 flex items-center justify-between pl-7">
                <span className="text-[11px] text-stone-400">Sub-points ({subs.length})</span>
                <AddButton
                  label="Add sub-point"
                  disabled={subs.length >= SUB_MAX}
                  onClick={() => subs.length < SUB_MAX && set(["items", i, "subItems"], [...subs, { text: "" }])}
                />
              </div>
              {subs.map((sub, j) => (
                <div key={j} className="mt-1 flex items-center gap-2 pl-7">
                  <span className="text-[11px] text-stone-300">—</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-stone-600">{richText(sub) || `Sub-point ${j + 1}`}</span>
                  <button
                    type="button"
                    aria-label="Remove sub-point"
                    onClick={() => {
                      const nextSubs = subs.filter((_, idx) => idx !== j);
                      set(["items", i, "subItems"], nextSubs.length ? nextSubs : undefined);
                    }}
                    className="grid size-5 place-items-center rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <DecorField value={content.decor} onChange={(v) => set(["decor"], v)} />
    </>
  );
}

/* ───────────────────────────────── prose ───────────────────────────────── */

function ProseEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: ProseContent }) {
  const set = useSet(blockId, slide.id);
  const points = (content.points as unknown as AnyItem[] | undefined) ?? [];
  const MAX = 5;
  const setPoints = (next: AnyItem[]) => set(["points"], next.length ? next : undefined);
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">key points ({points.length})</p>
        <AddButton label="Add point" disabled={points.length >= MAX} onClick={() => points.length < MAX && setPoints([...points, { text: "" }])} />
      </div>
      <div className="space-y-2">
        {points.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl border border-stone-200 p-2.5">
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-stone-700">{richText(p) || `Point ${i + 1}`}</span>
            <ListControls
              count={points.length}
              index={i}
              min={0}
              onMove={(dir) => setPoints(reorder(points, i, dir))}
              onRemove={() => setPoints(points.filter((_, idx) => idx !== i))}
            />
          </div>
        ))}
      </div>
    </>
  );
}

/* ───────────────────────── comparison (shared bits) ────────────────────── */

const OPT_LETTERS = ["A", "B", "C"];

/** A sticker dropdown — used for option / dimension icons. */
function IconSelect({ value, label, onChange }: { value: string | undefined; label: string; onChange: (v: string | undefined) => void }) {
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="min-w-0 flex-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300"
    >
      <option value="">No icon</option>
      {STICKER_REGISTRY.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** Footer switch (none / summary / similarities) shared by both comparison
 *  layouts; the footer TEXT is edited on the slide, only kind + count here. */
function ComparisonFooterEditor({ footer, set }: { footer: ComparisonFooter | undefined; set: (path: Path, value: unknown) => void }) {
  const points = footer?.kind === "similarities" ? footer.points : [];
  return (
    <Field label="Footer">
      <div className="space-y-2">
        <PillGroup
          options={["none", "summary", "similarities"] as const}
          value={footer?.kind ?? "none"}
          label="Footer"
          onChange={(k) => {
            if (k === "none") set(["footer"], undefined);
            else if (k === "summary") set(["footer"], { kind: "summary", text: { text: "A single takeaway." } });
            else set(["footer"], { kind: "similarities", points: [{ text: "Shared trait one" }, { text: "Shared trait two" }] });
          }}
        />
        {footer?.kind === "similarities" && (
          <>
            <div className="flex items-center justify-between pl-1">
              <span className="text-[11px] text-stone-400">shared points ({points.length})</span>
              <AddButton label="Add" disabled={points.length >= 3} onClick={() => points.length < 3 && set(["footer", "points"], [...points, { text: "" }])} />
            </div>
            {points.map((p, i) => (
              <div key={i} className="flex items-center gap-2 pl-1">
                <span className="text-[11px] text-stone-300">—</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-stone-600">{richText(p) || `Point ${i + 1}`}</span>
                <button
                  type="button"
                  aria-label="Remove shared point"
                  disabled={points.length <= 2}
                  onClick={() => points.length > 2 && set(["footer", "points"], points.filter((_, idx) => idx !== i))}
                  className="grid size-5 place-items-center rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-25"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </>
        )}
        <p className="pl-1 text-[10px] text-stone-400">Edit the footer text directly on the slide.</p>
      </div>
    </Field>
  );
}

/* ───────────────────────── comparison_columns ──────────────────────────── */

function ComparisonColumnsEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: ComparisonColumnsContent }) {
  const set = useSet(blockId, slide.id);
  const options = content.options as unknown as AnyItem[];
  const OPT_MIN = 2, OPT_MAX = 3, PT_MIN = 2, PT_MAX = 4;
  const setOptions = (next: AnyItem[]) => set(["options"], next);
  const blankOption = (): AnyItem => ({ name: { text: "New option" }, points: [{ label: { text: "" } }, { label: { text: "" } }] });

  return (
    <>
      <Field label="Presentation">
        <PillGroup options={["cards", "bare"] as const} value={content.presentation ?? "cards"} label="Presentation" onChange={(v) => set(["presentation"], v)} />
      </Field>

      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">options ({options.length})</p>
        <AddButton label="Add option" disabled={options.length >= OPT_MAX} onClick={() => options.length < OPT_MAX && setOptions([...options, blankOption()])} />
      </div>

      <div className="space-y-2">
        {options.map((opt, i) => {
          const pts = (opt.points as AnyItem[] | undefined) ?? [];
          return (
            <div key={i} className="rounded-xl border border-stone-200 p-2.5">
              <div className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{OPT_LETTERS[i] ?? i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{richText(opt.name) || `Option ${i + 1}`}</span>
                <ListControls
                  count={options.length}
                  index={i}
                  min={OPT_MIN}
                  onMove={(dir) => setOptions(reorder(options, i, dir))}
                  onRemove={() => options.length > OPT_MIN && setOptions(options.filter((_, idx) => idx !== i))}
                />
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="text-[11px] text-stone-400">Icon</label>
                <IconSelect value={typeof opt.icon === "string" ? opt.icon : undefined} label={`Option ${i + 1} icon`} onChange={(v) => set(["options", i, "icon"], v)} />
              </div>

              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-stone-400">points ({pts.length})</span>
                <AddButton label="Add point" disabled={pts.length >= PT_MAX} onClick={() => pts.length < PT_MAX && set(["options", i, "points"], [...pts, { label: { text: "" } }])} />
              </div>
              {pts.map((pt, j) => (
                <div key={j} className="mt-1 flex items-center gap-2 pl-2">
                  <span className="text-[11px] text-stone-300">{j + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-stone-600">{richText(pt.label) || `Point ${j + 1}`}</span>
                  <button
                    type="button"
                    aria-label="Remove point"
                    disabled={pts.length <= PT_MIN}
                    onClick={() => pts.length > PT_MIN && set(["options", i, "points"], pts.filter((_, idx) => idx !== j))}
                    className="grid size-5 place-items-center rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-25"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <ComparisonFooterEditor footer={content.footer} set={set} />
      <DecorField value={content.decor} onChange={(v) => set(["decor"], v)} />
      <p className="text-[10px] text-stone-400">Edit option names and point text directly on the slide.</p>
    </>
  );
}

/* ───────────────────────── comparison_matrix ───────────────────────────── */

function ComparisonMatrixEditor({ slide, blockId, content }: { slide: Slide; blockId: string; content: ComparisonMatrixContent }) {
  const set = useSet(blockId, slide.id);
  const options = content.options as unknown as AnyItem[];
  const dimensions = content.dimensions as unknown as AnyItem[];
  const OPT_MIN = 2, OPT_MAX = 3, DIM_MIN = 2, DIM_MAX = 4;
  const n = options.length;

  // Options ↔ cells stay aligned: adding/removing an option adds/removes that
  // index's cell in EVERY dimension (one cell per option, in option order).
  function addOption() {
    if (n >= OPT_MAX) return;
    set(["options"], [...options, { name: { text: "New option" } }]);
    set(["dimensions"], dimensions.map((d) => ({ ...d, cells: [...((d.cells as AnyItem[] | undefined) ?? []), { detail: { text: "" } }] })));
  }
  function removeOption(i: number) {
    if (n <= OPT_MIN) return;
    set(["options"], options.filter((_, idx) => idx !== i));
    set(["dimensions"], dimensions.map((d) => ({ ...d, cells: ((d.cells as AnyItem[] | undefined) ?? []).filter((_, idx) => idx !== i) })));
  }
  function addDimension() {
    if (dimensions.length >= DIM_MAX) return;
    const cells = Array.from({ length: n }, () => ({ detail: { text: "" } }));
    set(["dimensions"], [...dimensions, { label: { text: "New dimension" }, cells }]);
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">options ({n})</p>
        <AddButton label="Add option" disabled={n >= OPT_MAX} onClick={addOption} />
      </div>
      <div className="space-y-2">
        {options.map((opt, i) => (
          <div key={i} className="rounded-xl border border-stone-200 p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{OPT_LETTERS[i] ?? i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{richText(opt.name) || `Option ${i + 1}`}</span>
              <button
                type="button"
                aria-label="Remove option"
                disabled={n <= OPT_MIN}
                onClick={() => removeOption(i)}
                className="grid size-6 place-items-center rounded text-stone-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-25"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[11px] text-stone-400">Icon</label>
              <IconSelect value={typeof opt.icon === "string" ? opt.icon : undefined} label={`Option ${i + 1} icon`} onChange={(v) => set(["options", i, "icon"], v)} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">dimensions ({dimensions.length})</p>
        <AddButton label="Add dimension" disabled={dimensions.length >= DIM_MAX} onClick={addDimension} />
      </div>
      <div className="space-y-2">
        {dimensions.map((dim, r) => (
          <div key={r} className="rounded-xl border border-stone-200 p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid size-5 shrink-0 place-items-center rounded-md bg-stone-100 text-[10px] font-semibold text-stone-500">{r + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{richText(dim.label) || `Dimension ${r + 1}`}</span>
              <ListControls
                count={dimensions.length}
                index={r}
                min={DIM_MIN}
                onMove={(dir) => set(["dimensions"], reorder(dimensions, r, dir))}
                onRemove={() => dimensions.length > DIM_MIN && set(["dimensions"], dimensions.filter((_, idx) => idx !== r))}
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[11px] text-stone-400">Icon</label>
              <IconSelect value={typeof dim.icon === "string" ? dim.icon : undefined} label={`Dimension ${r + 1} icon`} onChange={(v) => set(["dimensions", r, "icon"], v)} />
            </div>
          </div>
        ))}
      </div>

      <ComparisonFooterEditor footer={content.footer} set={set} />
      <DecorField value={content.decor} onChange={(v) => set(["decor"], v)} />
      <p className="text-[10px] text-stone-400">Edit option names, dimension labels, and cell text directly on the slide.</p>
    </>
  );
}

/* ───────────────────────────── Dispatcher ──────────────────────────────── */

export function StructuredContentEditor({ slide, blockId }: { slide: Slide; blockId: string }) {
  const template = slide.template;
  if (!template) return null;
  const def = findStructuredLayout(template.layoutId);

  return (
    <div className="space-y-4">
      <HeaderNote name={def?.name ?? template.layoutId} />
      {template.layoutId === "section_break" ? (
        <SectionBreakEditor slide={slide} blockId={blockId} content={template.content} />
      ) : template.layoutId === "concept_example" ? (
        <ConceptExampleEditor slide={slide} blockId={blockId} content={template.content} />
      ) : template.layoutId === "outline_list" ? (
        <OutlineListEditor slide={slide} blockId={blockId} content={template.content} />
      ) : template.layoutId === "prose" ? (
        <ProseEditor slide={slide} blockId={blockId} content={template.content} />
      ) : template.layoutId === "comparison_columns" ? (
        <ComparisonColumnsEditor slide={slide} blockId={blockId} content={template.content} />
      ) : template.layoutId === "comparison_matrix" ? (
        <ComparisonMatrixEditor slide={slide} blockId={blockId} content={template.content} />
      ) : (
        <GenericItemEditor slide={slide} blockId={blockId} />
      )}
    </div>
  );
}
