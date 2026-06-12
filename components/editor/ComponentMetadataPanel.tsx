"use client";

/**
 * "AI Structure" — the developer/debug view of the selected component:
 * its manifest entry, the data-ai-* attributes it renders, and its JSON.
 * This panel is the proof that what the human sees is what an agent sees.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import type { ComponentTypeName } from "@/lib/course/manifest";
import type { ResolvedSelection } from "@/lib/course/queries";

function Chips({ items, tone }: { items: string[]; tone: "brand" | "slate" }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <code
          key={item}
          className={cn(
            "rounded-md px-1.5 py-0.5 font-mono text-[10px]",
            tone === "brand" ? "bg-brand-50 text-brand-700" : "bg-stone-100 text-stone-600"
          )}
        >
          {item}
        </code>
      ))}
    </div>
  );
}

export function ComponentMetadataPanel({ resolved }: { resolved: ResolvedSelection }) {
  const [open, setOpen] = useState(false);

  const domAttrs = aiAttrs({
    component: "—",
    type: resolved.typeName as ComponentTypeName,
    id: resolved.id,
    parentId: resolved.parentId,
    order: resolved.order,
    label: resolved.title,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-400 transition-colors hover:text-stone-600"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        AI Structure
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-300">
              Manifest · {resolved.typeName}
            </p>
            <p className="text-xs leading-relaxed text-stone-500">
              {resolved.manifestEntry.description}
            </p>
          </div>

          {resolved.manifestEntry.allowedChildren && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-300">
                Allowed children
              </p>
              <Chips items={resolved.manifestEntry.allowedChildren} tone="slate" />
            </div>
          )}

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-300">
              Allowed actions
            </p>
            <Chips items={resolved.manifestEntry.allowedActions} tone="brand" />
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-300">
              DOM attributes
            </p>
            <div className="space-y-0.5 font-mono text-[10px] leading-relaxed text-stone-500">
              {Object.entries(domAttrs)
                .filter(([k]) => k.startsWith("data-ai"))
                .map(([k, v]) => (
                  <p key={k} className="truncate">
                    <span className="text-stone-400">{k}=</span>
                    <span className="text-stone-600">&quot;{String(v)}&quot;</span>
                  </p>
                ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-300">
              Node JSON
            </p>
            <pre className="max-h-64 overflow-auto rounded-xl bg-stone-900 p-3 font-mono text-[10px] leading-relaxed text-stone-200 scrollbar-thin">
              {JSON.stringify(resolved.node, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
