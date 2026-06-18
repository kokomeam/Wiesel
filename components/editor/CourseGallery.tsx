/**
 * Creator Studio landing: a gallery of the author's courses (server-rendered
 * from Postgres). Opening Creator Studio ALWAYS lands here — never auto-opens a
 * course. Each card links to /studio?course=<id> (which opens the editor,
 * unchanged) and offers a confirmed delete; a creation card runs the same
 * `createNewCourse` server action the sidebar uses. With zero courses the
 * gallery still renders, showing only the "Create your first course" card.
 */

import { Plus } from "lucide-react";
import { createNewCourse } from "@/app/(app)/studio/actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { CourseCardItem } from "./CourseCardItem";

export interface CourseCard {
  id: string;
  title: string;
  description: string | null;
  status: string;
  level: string | null;
  updated_at: string;
}

function CreateCard({ first }: { first: boolean }) {
  return (
    <form action={createNewCourse} className="h-full">
      <button
        type="submit"
        className="group flex h-full min-h-[168px] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-stone-200 bg-white/40 px-5 py-6 text-stone-400 transition-colors hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-600"
      >
        <span className="grid size-11 place-items-center rounded-xl border border-stone-200 bg-white text-stone-400 transition-colors group-hover:border-brand-200 group-hover:text-brand-600">
          <Plus className="size-5" />
        </span>
        <span className="text-sm font-semibold">
          {first ? "Create your first course" : "New course"}
        </span>
        <span className="text-xs text-stone-400">Start with the AI co-author</span>
      </button>
    </form>
  );
}

export function CourseGallery({ courses }: { courses: CourseCard[] }) {
  return (
    <div className="mx-auto max-w-7xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Creator Studio"
        description="Open a course to keep building with your AI co-author, or start a new one."
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((c) => (
          <CourseCardItem key={c.id} course={c} />
        ))}
        <CreateCard first={courses.length === 0} />
      </div>
    </div>
  );
}
