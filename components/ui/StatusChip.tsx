import { cn } from "@/lib/cn";

/**
 * The one status chip. Five semantic statuses with FIXED meaning across the
 * whole marketing surface (UI-1 §4) — the same state never renders green in
 * one card and orange in another:
 *
 *   success      published / completed / live
 *   pending      queued / processing / held
 *   attention    needs review / approval / question
 *   neutral      draft / dismissed / inactive
 *   destructive  cancelled / unpublished / failed
 *
 * Colors come ONLY from the status tokens in app/globals.css; no component
 * defines its own status colors (enforced by verify:ui).
 */

export type UiStatus = "success" | "pending" | "attention" | "neutral" | "destructive";

export const STATUS_CHIP_CLASSES: Record<UiStatus, string> = {
  success: "text-status-success bg-status-success-bg ring-status-success-ring",
  pending: "text-status-pending bg-status-pending-bg ring-status-pending-ring",
  attention: "text-status-attention bg-status-attention-bg ring-status-attention-ring",
  neutral: "text-status-neutral bg-status-neutral-bg ring-status-neutral-ring",
  destructive: "text-status-destructive bg-status-destructive-bg ring-status-destructive-ring",
};

export function StatusChip({
  status,
  children,
  className,
}: {
  status: UiStatus;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta font-medium ring-1 ring-inset",
        STATUS_CHIP_CLASSES[status],
        className
      )}
    >
      {children}
    </span>
  );
}
