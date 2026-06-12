"use client";

/**
 * Inspector · Metadata tab. Stable identifiers for humans who need them and
 * the collapsed "AI Structure" debug view (manifest entry, data-ai-*
 * attributes, node JSON) — present but never in the way.
 */

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ResolvedSelection } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { ComponentMetadataPanel } from "../ComponentMetadataPanel";

export function MetadataTab({ resolved }: { resolved: ResolvedSelection }) {
  const updatedAt = useEditorStore((s) => s.doc.metadata.updatedAt);
  const [copied, setCopied] = useState(false);

  function copyId() {
    navigator.clipboard?.writeText(resolved.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-5">
      <dl className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <dt className="w-16 shrink-0 text-stone-400">ID</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-stone-600">
            {resolved.id}
          </dd>
          <button
            type="button"
            aria-label="Copy ID"
            onClick={copyId}
            className="shrink-0 text-stone-300 transition-colors hover:text-stone-600"
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <dt className="w-16 shrink-0 text-stone-400">Type</dt>
          <dd className="font-mono text-[11px] text-stone-600">{resolved.typeName}</dd>
        </div>
        {resolved.parentId && (
          <div className="flex items-center gap-2">
            <dt className="w-16 shrink-0 text-stone-400">Parent</dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-stone-600">
              {resolved.parentId}
            </dd>
          </div>
        )}
        {resolved.order !== undefined && (
          <div className="flex items-center gap-2">
            <dt className="w-16 shrink-0 text-stone-400">Order</dt>
            <dd className="text-stone-600">{resolved.order}</dd>
          </div>
        )}
        <div className="flex items-center gap-2">
          <dt className="w-16 shrink-0 text-stone-400">Updated</dt>
          <dd className="text-stone-600">{updatedAt.slice(0, 10)}</dd>
        </div>
      </dl>

      <div className="border-t border-stone-100 pt-4">
        <ComponentMetadataPanel resolved={resolved} />
      </div>
    </div>
  );
}
