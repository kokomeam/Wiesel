import { Waypoints } from "lucide-react";
import { EmptyState } from "@/components/studio/analytics/EmptyState";

/**
 * Concept graph tab — PLACEHOLDER (P5.1). P5.2 replaces this component's BODY;
 * the file path + the frozen prop signature `({ courseId }: { courseId: string })`
 * stay fixed (the route shell already wires `<GraphTab courseId=... />`). Server
 * component — P5.2 loads its own data here.
 */
export function GraphTab({ courseId }: { courseId: string }) {
  void courseId; // wired by the shell; P5.2 loads its own data.
  return (
    <EmptyState
      icon={Waypoints}
      title="Concept graph — coming in this wave"
      hint="The concept-graph editor (review staged extractions, rename/merge nodes, inspect mastery and confusion overlays) lands in the next package."
    />
  );
}
