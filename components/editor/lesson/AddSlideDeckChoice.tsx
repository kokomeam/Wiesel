"use client";

/**
 * Secondary "Add slide deck" chooser. Opened when the educator picks
 * "Slide deck" from the Add-block menu, so the user-facing category stays
 * unified while the underlying block type forks:
 *   • Create new deck     → the existing native slide_deck block (unchanged)
 *   • Import existing deck → upload .ppt/.pptx/.pdf → imported_deck block
 *   • Google Slides        → schema-ready, shown as a polished "coming soon"
 *
 * Portalled overlay matching the editor's dialog style (cf. ImageUploadDialog).
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Cloud, Plus, UploadCloud, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { addBlockPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import { useEscapeToClose } from "../QualityHintBadge";
import { DeckUploadButton } from "./DeckUploadButton";

type Stage = "choose" | "upload";

export function AddSlideDeckChoice({
  open,
  lessonId,
  atIndex,
  onClose,
}: {
  open: boolean;
  lessonId: string;
  atIndex?: number;
  onClose: () => void;
}) {
  const apply = useEditorStore((s) => s.apply);
  const [stage, setStage] = useState<Stage>("choose");
  useEscapeToClose(open, onClose);

  if (!open) return null;

  function createNative() {
    apply(addBlockPatch(lessonId, "slide_deck", atIndex), "human");
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/30 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add slide deck"
        data-ai-tool="add-slide-deck-choice"
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-stone-200/70 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Add slide deck</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              {stage === "choose" ? "Start fresh or bring in a deck you already have." : "Upload a PowerPoint or PDF."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="p-5">
          {stage === "choose" ? (
            <div className="space-y-2.5">
              <ChoiceCard
                icon={Plus}
                title="Create new deck"
                subtitle="Build an editable AI-native slide deck"
                onClick={createNative}
                toolName="create-native-deck"
              />
              <ChoiceCard
                icon={UploadCloud}
                title="Import existing deck"
                subtitle="Upload PowerPoint or PDF"
                onClick={() => setStage("upload")}
                toolName="import-existing-deck"
              />
              <ChoiceCard
                icon={Cloud}
                title="Import from Google Slides"
                subtitle="Connect Google Drive"
                disabled
                badge="Coming soon"
              />
            </div>
          ) : (
            <DeckUploadButton
              lessonId={lessonId}
              atIndex={atIndex}
              onDone={onClose}
              onBack={() => setStage("choose")}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  subtitle,
  onClick,
  disabled,
  badge,
  toolName,
}: {
  icon: typeof Plus;
  title: string;
  subtitle: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  toolName?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-ai-tool={toolName}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-xl border px-4 py-3.5 text-left transition-all",
        disabled
          ? "cursor-not-allowed border-stone-200/70 bg-stone-50/60 opacity-70"
          : "border-stone-200/80 bg-white hover:border-brand-300 hover:bg-brand-50/40 hover:shadow-sm"
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-xl transition-colors",
          disabled ? "bg-stone-100 text-stone-400" : "bg-brand-50 text-brand-600 group-hover:bg-brand-100"
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold text-stone-900">{title}</span>
          {badge && <Badge tone="slate" className="px-2 py-0 text-[10px]">{badge}</Badge>}
        </span>
        <span className="mt-0.5 block text-xs text-stone-500">{subtitle}</span>
      </span>
    </button>
  );
}
