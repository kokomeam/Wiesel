import type { Metadata } from "next";
import { CourseEditorShell } from "@/components/editor/CourseEditorShell";

export const metadata: Metadata = {
  title: "Creator Studio — CourseGen Pro",
};

export default function StudioPage() {
  return <CourseEditorShell />;
}
