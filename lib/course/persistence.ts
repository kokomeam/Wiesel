/**
 * Pure mapping between the editor's `CourseDocument` tree and the normalized
 * Postgres rows (courses → modules → lessons → blocks). No Supabase import —
 * the data-access layer (lib/editor/coursePersistence.ts on the client,
 * app/(app)/studio/page.tsx on the server) calls these.
 *
 * The schema was designed to map (CLAUDE.md): stable UUID ids, integer
 * `order`, ISO timestamps, block payloads as jsonb. Module/lesson/block ids
 * ARE the DB primary keys (see factories.ts `newRowId`). A block's whole
 * payload (slides[], questions[], paragraphs[], ai, …) rides in `content`;
 * `type`/`title`/`order` are mirrored to columns for querying + ordering.
 */

import { DEFAULT_THEME_ID } from "./slide/themes";
import type {
  CourseDocument,
  CoursePlan,
  CourseTheme,
  LessonBlock,
} from "./types";
import type { Database, Json } from "@/lib/database.types";

type CourseRow = Database["public"]["Tables"]["courses"]["Row"];
type ModuleRow = Database["public"]["Tables"]["modules"]["Row"];
type LessonRow = Database["public"]["Tables"]["lessons"]["Row"];
type BlockRow = Database["public"]["Tables"]["blocks"]["Row"];

export type CourseInsert = Database["public"]["Tables"]["courses"]["Insert"];
type ModuleInsert = Database["public"]["Tables"]["modules"]["Insert"];
type LessonInsert = Database["public"]["Tables"]["lessons"]["Insert"];
type BlockInsert = Database["public"]["Tables"]["blocks"]["Insert"];

export interface CourseRowSet {
  course: CourseInsert;
  modules: ModuleInsert[];
  lessons: LessonInsert[];
  blocks: BlockInsert[];
}

export function defaultCourseTheme(): CourseTheme {
  return {
    name: "Editorial Warm",
    accent: "amber",
    slideDefaults: { layout: "title", themeId: DEFAULT_THEME_ID },
  };
}

/** A CoursePlan with its required arrays present (new rows store `{}`). */
function normalizePlan(plan: Json | null | undefined): CoursePlan {
  const p = (plan && typeof plan === "object" && !Array.isArray(plan) ? plan : {}) as Record<
    string,
    unknown
  >;
  return {
    category: typeof p.category === "string" ? p.category : undefined,
    outcomes: Array.isArray(p.outcomes) ? (p.outcomes as string[]) : [],
    prerequisites: Array.isArray(p.prerequisites) ? (p.prerequisites as string[]) : [],
    teachingStyle: typeof p.teachingStyle === "string" ? p.teachingStyle : undefined,
  };
}

function normalizeTheme(theme: Json | null | undefined): CourseTheme {
  if (theme && typeof theme === "object" && !Array.isArray(theme) && "slideDefaults" in theme) {
    return theme as unknown as CourseTheme;
  }
  return defaultCourseTheme();
}

/* ─────────────────────────── rows → document ──────────────────────────── */

export function courseDocFromRows(
  course: CourseRow,
  modules: ModuleRow[],
  lessons: LessonRow[],
  blocks: BlockRow[]
): CourseDocument {
  const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
  const lessonsByModule = new Map<string, LessonRow[]>();
  for (const l of lessons) {
    const arr = lessonsByModule.get(l.module_id) ?? [];
    arr.push(l);
    lessonsByModule.set(l.module_id, arr);
  }
  const blocksByLesson = new Map<string, BlockRow[]>();
  for (const b of blocks) {
    const arr = blocksByLesson.get(b.lesson_id) ?? [];
    arr.push(b);
    blocksByLesson.set(b.lesson_id, arr);
  }

  return {
    id: course.id,
    title: course.title,
    description: course.description ?? undefined,
    audience: course.audience ?? undefined,
    level: (course.level as CourseDocument["level"]) ?? undefined,
    plan: normalizePlan(course.plan),
    theme: normalizeTheme(course.theme),
    modules: [...modules].sort(byOrder).map((m) => ({
      id: m.id,
      type: "module" as const,
      title: m.title,
      description: m.description ?? undefined,
      order: m.order,
      lessons: (lessonsByModule.get(m.id) ?? []).sort(byOrder).map((l) => ({
        id: l.id,
        type: "lesson" as const,
        title: l.title,
        objective: l.objective ?? undefined,
        order: l.order,
        estimatedMinutes: l.estimated_minutes ?? undefined,
        blocks: (blocksByLesson.get(l.id) ?? []).sort(byOrder).map((b) => ({
          // content carries the full payload incl. type/title/order/ai
          ...(b.content as object),
          id: b.id,
        })) as LessonBlock[],
      })),
    })),
    metadata: {
      createdAt: course.created_at,
      updatedAt: course.updated_at,
      ownerId: course.author_id,
      aiReadableVersion: "1.0",
    },
  };
}

/* ─────────────────────────── document → rows ──────────────────────────── */

export function courseDocToRows(doc: CourseDocument, ownerId: string): CourseRowSet {
  const modules: ModuleInsert[] = [];
  const lessons: LessonInsert[] = [];
  const blocks: BlockInsert[] = [];

  doc.modules.forEach((m, mi) => {
    modules.push({
      id: m.id,
      course_id: doc.id,
      title: m.title,
      description: m.description ?? null,
      order: m.order ?? mi,
    });
    m.lessons.forEach((l, li) => {
      lessons.push({
        id: l.id,
        module_id: m.id,
        course_id: doc.id,
        title: l.title,
        objective: l.objective ?? null,
        order: l.order ?? li,
        estimated_minutes: l.estimatedMinutes ?? null,
      });
      l.blocks.forEach((b, bi) => {
        const { id, ...payload } = b;
        blocks.push({
          id,
          lesson_id: l.id,
          course_id: doc.id,
          type: b.type,
          title: b.title ?? null,
          order: b.order ?? bi,
          content: payload as unknown as Json,
        });
      });
    });
  });

  return {
    course: {
      id: doc.id,
      author_id: ownerId,
      title: doc.title,
      description: doc.description ?? null,
      audience: doc.audience ?? null,
      level: doc.level ?? null,
      plan: doc.plan as unknown as Json,
      theme: doc.theme as unknown as Json,
    },
    modules,
    lessons,
    blocks,
  };
}
