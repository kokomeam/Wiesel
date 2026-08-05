import { LineChart } from "lucide-react";
import { EmptyState } from "@/components/studio/analytics/EmptyState";

/**
 * Tutor analytics tab — PLACEHOLDER (P5.1). P5.3 replaces this component's BODY;
 * the file path + the frozen prop signature `({ courseId }: { courseId: string })`
 * stay fixed (the route shell already wires `<AnalyticsTutorTab courseId=... />`).
 * Server component — P5.3 loads its own data here.
 */
export function AnalyticsTutorTab({ courseId }: { courseId: string }) {
  void courseId; // wired by the shell; P5.3 loads its own data.
  return (
    <EmptyState
      icon={LineChart}
      title="Analytics — coming in this wave"
      hint="Lessons needing attention, most-missed questions with distractor breakdowns, and the confusion/mastery overlays land in the next package."
    />
  );
}
