/**
 * Analytics READ tools (Milestone 5) — the Analyst subagent's window onto the
 * rollups. All six are pure lookups over the pre-loaded `ctx.analytics`
 * capability (never raw event pagination), returning COMPACT JSON: numbers
 * rounded, text truncated, lists capped — an Analyst turn should cost tokens
 * proportional to the problems, not the course size.
 *
 * Deliberately NO learner emails in any tool output: PII stays out of model
 * prompts; the send seam resolves recipients server-side at send time.
 */

import { z } from "zod";
import { dwellOutlier, questionFlags } from "@/lib/analytics/flags";
import { median } from "@/lib/analytics/stats";
import { bucketLabel } from "@/lib/analytics/dashboard";
import { defineTool, ToolError, type AnalyticsToolContext, type ToolContext } from "./types";

const FUNNEL_CAP = 30;
const QUESTION_CAP = 20;
const DWELL_CAP = 15;
const LEARNER_CAP = 20;

function requireAnalytics(ctx: ToolContext): AnalyticsToolContext {
  if (!ctx.analytics) {
    throw new ToolError(
      "Analytics are not available in this context — these tools only run inside a maintenance analysis."
    );
  }
  return ctx.analytics;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function clip(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const analyticsTools = [
  defineTool({
    name: "get_course_health_summary",
    description:
      "The course's learner-analytics health at a glance: enrollment/completion numbers, the worst drop-off lessons, and counts of flagged questions and struggling learners. Start here.",
    readOnly: true,
    params: z.object({}),
    execute(_args, ctx) {
      const { data, maps } = requireAnalytics(ctx);
      const worstDropoffs = [...data.funnel]
        .filter((f) => f.dropoff_pct !== null && Number(f.dropoff_pct) > 0)
        .sort((a, b) => Number(b.dropoff_pct) - Number(a.dropoff_pct))
        .slice(0, 3)
        .map((f) => ({
          lessonId: f.lesson_id,
          title: clip(maps.lessonTitles.get(f.lesson_id) ?? "Untitled lesson", 80),
          dropoffPct: round1(Number(f.dropoff_pct) * 100),
        }));
      const flaggedQuestions = data.questionStats.filter(
        (q) =>
          questionFlags({
            n: q.n,
            pctCorrect: q.pct_correct,
            answerDistribution: (q.answer_distribution ?? {}) as Record<string, number>,
            keyValue: q.key_value,
            discrimination: q.discrimination,
          }).length > 0
      ).length;
      const strugglingLearners = new Set(data.flags.map((f) => f.user_id)).size;
      return {
        summary: "Course health summary",
        data: {
          enrollments: data.overview.totalEnrollments,
          active7d: data.overview.active7d,
          completedEnrollments: data.overview.completedEnrollments,
          lessonsLive: data.funnel.length,
          worstDropoffs,
          flaggedQuestions,
          strugglingLearners,
          rollupsComputedAt: data.computedAt,
        },
      };
    },
  }),

  defineTool({
    name: "get_lesson_funnel",
    description:
      "Started/completed learner counts + drop-off per lesson, in course order. Pass lessonId to inspect one lesson, or null for the whole course.",
    readOnly: true,
    params: z.object({ lessonId: z.string().nullable() }),
    execute(args, ctx) {
      const { data, maps } = requireAnalytics(ctx);
      const rows = data.funnel
        .filter((f) => !args.lessonId || f.lesson_id === args.lessonId)
        .slice(0, FUNNEL_CAP)
        .map((f) => ({
          lessonId: f.lesson_id,
          order: f.lesson_order,
          title: clip(maps.lessonTitles.get(f.lesson_id) ?? "Untitled lesson", 80),
          started: f.started_count,
          completed: f.completed_count,
          dropoffPct: f.dropoff_pct === null ? null : round1(Number(f.dropoff_pct) * 100),
        }));
      return { summary: `Funnel for ${rows.length} lesson(s)`, data: { lessons: rows } };
    },
  }),

  defineTool({
    name: "get_question_item_stats",
    description:
      "Per-question item analysis (worst first): % correct, top distractor vs the key, discrimination, and which flags trip. Pass lessonId to scope, or null for the whole course.",
    readOnly: true,
    params: z.object({ lessonId: z.string().nullable() }),
    execute(args, ctx) {
      const { data, maps } = requireAnalytics(ctx);
      const rows = data.questionStats
        .filter((q) => !args.lessonId || q.lesson_id === args.lessonId)
        .map((q) => {
          const distribution = (q.answer_distribution ?? {}) as Record<string, number>;
          const flags = questionFlags({
            n: q.n,
            pctCorrect: q.pct_correct,
            answerDistribution: distribution,
            keyValue: q.key_value,
            discrimination: q.discrimination,
          });
          const topWrong = Object.entries(distribution)
            .filter(([bucket]) => bucket !== q.key_value)
            .sort((a, b) => b[1] - a[1])[0];
          const keyCount = q.key_value ? (distribution[q.key_value] ?? 0) : null;
          return {
            questionId: q.question_id,
            blockId: q.block_id,
            lessonId: q.lesson_id,
            prompt: clip(maps.questions.get(q.question_id)?.prompt ?? ""),
            n: q.n,
            pctCorrect: q.pct_correct === null ? null : round1(Number(q.pct_correct)),
            discrimination:
              q.discrimination === null
                ? null
                : Math.round(Number(q.discrimination) * 100) / 100,
            topDistractor: topWrong
              ? {
                  label: clip(bucketLabel(topWrong[0], maps), 80),
                  count: topWrong[1],
                  keyCount,
                }
              : null,
            flags: flags.map((f) => f.type),
          };
        })
        .sort((a, b) => b.flags.length - a.flags.length || (a.pctCorrect ?? 100) - (b.pctCorrect ?? 100))
        .slice(0, QUESTION_CAP);
      return { summary: `Item stats for ${rows.length} question(s)`, data: { questions: rows } };
    },
  }),

  defineTool({
    name: "get_slide_dwell_outliers",
    description:
      "Slides learners SKIM past or STALL on, vs the course's median dwell — candidates for splitting (stall) or beefing up (skim).",
    readOnly: true,
    params: z.object({}),
    execute(_args, ctx) {
      const { data, maps } = requireAnalytics(ctx);
      const reference =
        median(
          data.slideDwell.map((s) => s.median_dwell_ms).filter((v): v is number => v !== null)
        ) ?? 0;
      const rows = data.slideDwell
        .map((s) => ({
          row: s,
          outlier: dwellOutlier(s.median_dwell_ms ?? 0, reference, s.n),
        }))
        .filter((e) => e.outlier !== null)
        .slice(0, DWELL_CAP)
        .map(({ row, outlier }) => ({
          slideId: row.slide_id,
          blockId: row.block_id,
          lessonId: row.lesson_id,
          deck: clip(maps.blocks.get(row.block_id)?.title || maps.blocks.get(row.block_id)?.lessonTitle || "Slide deck", 80),
          signal: outlier,
          medianSeconds: round1((row.median_dwell_ms ?? 0) / 1000),
          courseMedianSeconds: round1(reference / 1000),
          views: row.n,
        }));
      return {
        summary: rows.length ? `${rows.length} dwell outlier(s)` : "No dwell outliers",
        data: { outliers: rows },
      };
    },
  }),

  defineTool({
    name: "get_struggling_learners",
    description:
      "Learners the nightly flag pass marked as needing attention (inactive with an unfinished course, or repeatedly failing the same quiz). No emails — ids and names only.",
    readOnly: true,
    params: z.object({}),
    execute(_args, ctx) {
      const { data } = requireAnalytics(ctx);
      const rosterById = new Map(data.roster.map((r) => [r.user_id, r]));
      const grouped = new Map<string, string[]>();
      for (const flag of data.flags) {
        const list = grouped.get(flag.user_id) ?? [];
        list.push(flag.flag_type);
        grouped.set(flag.user_id, list);
      }
      const rows = [...grouped.entries()].slice(0, LEARNER_CAP).map(([userId, flagTypes]) => {
        const roster = rosterById.get(userId);
        return {
          userId,
          displayName: clip(roster?.display_name ?? "Learner", 60),
          flags: flagTypes,
          progressPct: round1(Number(roster?.progress_pct ?? 0)),
          completedLessons: roster?.completed_lessons ?? 0,
          totalLessons: roster?.total_lessons ?? 0,
          enrolledAt: roster?.enrolled_at ?? null,
        };
      });
      return {
        summary: rows.length ? `${rows.length} struggling learner(s)` : "Nobody's flagged",
        data: { learners: rows },
      };
    },
  }),

  defineTool({
    name: "get_learner_profile",
    description:
      "One learner's detail: per-lesson progress, recent quiz outcomes, flags, last activity. Use for a learner surfaced by get_struggling_learners.",
    readOnly: true,
    params: z.object({ userId: z.string().min(1) }),
    async execute(args, ctx) {
      const analytics = requireAnalytics(ctx);
      const profile = await analytics.loadLearnerProfile(args.userId);
      if (!profile) throw new ToolError("No such learner in this course.");
      return { summary: `Profile for ${profile.displayName}`, data: profile };
    },
  }),
];
