/**
 * Maintenance-agent schemas + pure helpers (Milestone 5). Importable by verify
 * scripts with no DB/model — keep this file side-effect free.
 */

import { z } from "zod";
import type { CourseDocument } from "@/lib/course/types";

/* ─────────────────────────────── Schemas ───────────────────────────────── */

export const FindingSchema = z.object({
  /** Stable id within the run (the Analyst invents it; threshold findings keep
   *  their filed uuid). */
  id: z.string().min(1),
  kind: z.enum(["content_issue", "learner_risk", "structure_gap"]),
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1).max(200),
  evidence: z.object({
    /** Named metrics backing the finding, e.g. {pctCorrect: 36, n: 41}. */
    metrics: z.record(z.string(), z.number()),
    /** The one-sentence case — this becomes the evidence card's headline:
     *  "Q3: 64% incorrect over 41 attempts; distractor B chosen 3× the key —
     *  likely ambiguous wording." */
    summary: z.string().min(1).max(500),
  }),
  targets: z.object({
    lessonId: z.string().nullable(),
    blockId: z.string().nullable(),
    questionId: z.string().nullable(),
    userId: z.string().nullable(),
  }),
  recommendation: z.string().min(1).max(500),
});
export type Finding = z.infer<typeof FindingSchema>;

export const InsightReportSchema = z.object({
  summary: z.string().min(1).max(2000),
  findings: z.array(FindingSchema).max(20),
});
export type InsightReport = z.infer<typeof InsightReportSchema>;

export const CommsDraftSchema = z.object({
  template: z.enum(["stalled_nudge", "almost_done", "struggling_topic"]),
  subject: z.string().min(1).max(200),
  /** Short, warm paragraphs — the service assembles the EmailBody (greeting +
   *  paragraphs + continue button + sign-off) around them. */
  paragraphs: z.array(z.string().min(1).max(600)).min(1).max(4),
});
export type CommsDraft = z.infer<typeof CommsDraftSchema>;

/* ─────────────────────────── Dedupe + priority ─────────────────────────── */

/** Mirrors the SQL filing's dedupe keys (migration 20260703000000): one finding
 *  per QUESTION, one per (learner, risk flavor). */
export function dedupeKeyForFinding(f: Finding): string {
  if (f.targets.questionId) return `question:${f.targets.questionId}`;
  if (f.kind === "learner_risk" && f.targets.userId) {
    return `learner_risk:${f.targets.userId}`;
  }
  if (f.targets.blockId) return `block:${f.targets.blockId}`;
  if (f.targets.lessonId) return `lesson:${f.kind}:${f.targets.lessonId}`;
  return `course:${f.kind}:${f.title.toLowerCase().slice(0, 60)}`;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };

export interface ThresholdFindingRow {
  id: string;
  dedupe_key: string;
  finding: Finding;
}

export interface PrioritizedFinding {
  finding: Finding;
  dedupeKey: string;
  /** Set when this adopts a previously-filed open threshold finding (its
   *  agent_findings row gets run_id + status updates instead of an insert). */
  adoptedFindingId: string | null;
}

/**
 * Merge the Analyst's findings with the open threshold-filed ones, dedupe by
 * key (the Analyst wins a collision — richer evidence — but ADOPTS the filed
 * row's id), sort severity-desc, and cap the fan-out.
 */
export function dedupeAndPrioritize(
  analystFindings: Finding[],
  openThresholdRows: ThresholdFindingRow[],
  cap = 5
): PrioritizedFinding[] {
  const byKey = new Map<string, PrioritizedFinding>();
  const thresholdByKey = new Map(openThresholdRows.map((r) => [r.dedupe_key, r]));

  for (const finding of analystFindings) {
    const key = dedupeKeyForFinding(finding);
    if (byKey.has(key)) continue; // the Analyst duplicated itself — first wins
    byKey.set(key, {
      finding,
      dedupeKey: key,
      adoptedFindingId: thresholdByKey.get(key)?.id ?? null,
    });
  }
  for (const row of openThresholdRows) {
    if (byKey.has(row.dedupe_key)) continue;
    const parsed = FindingSchema.safeParse(row.finding);
    if (!parsed.success) continue; // a malformed filed row never crashes a run
    byKey.set(row.dedupe_key, {
      finding: parsed.data,
      dedupeKey: row.dedupe_key,
      adoptedFindingId: row.id,
    });
  }

  return [...byKey.values()]
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity])
    .slice(0, cap);
}

/* ───────────────────────────── Scope parsing ───────────────────────────── */

export interface AnalysisScope {
  moduleId?: string;
  lessonIds?: string[];
  prompt?: string;
}

const ORDINAL_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};

function ordinalToIndex(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return n;
  return ORDINAL_WORDS[raw.toLowerCase()] ?? null;
}

/**
 * Parse "module 3" / "the second module" / "lesson 2" / a quoted title out of
 * an analyze prompt into a concrete lesson-id subset. Returns {} (whole course)
 * when nothing matches — a bad guess must widen, never mis-scope.
 */
export function parseAnalysisScope(doc: CourseDocument, message: string): AnalysisScope {
  const moduleMatch =
    message.match(/\bmodule\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i) ??
    message.match(/\bthe\s+(first|second|third|fourth|fifth)\s+(?:module|chapter|unit)\b/i);
  if (moduleMatch) {
    const idx = ordinalToIndex(moduleMatch[1]);
    const courseModule = idx !== null ? doc.modules[idx - 1] : undefined;
    if (courseModule) {
      return {
        moduleId: courseModule.id,
        lessonIds: courseModule.lessons.map((l) => l.id),
        prompt: message,
      };
    }
  }

  const lessonMatch = message.match(/\blesson\s+(\d+|one|two|three|four|five)\b/i);
  if (lessonMatch) {
    const idx = ordinalToIndex(lessonMatch[1]);
    const ordered = doc.modules.flatMap((m) => m.lessons);
    const lesson = idx !== null ? ordered[idx - 1] : undefined;
    if (lesson) return { lessonIds: [lesson.id], prompt: message };
  }

  const quoted = message.match(/[“"']([^”"']{3,80})[”"']/);
  if (quoted) {
    const needle = quoted[1].toLowerCase();
    for (const courseModule of doc.modules) {
      if (courseModule.title.toLowerCase().includes(needle)) {
        return {
          moduleId: courseModule.id,
          lessonIds: courseModule.lessons.map((l) => l.id),
          prompt: message,
        };
      }
      const lesson = courseModule.lessons.find((l) =>
        l.title.toLowerCase().includes(needle)
      );
      if (lesson) return { lessonIds: [lesson.id], prompt: message };
    }
  }

  return { prompt: message };
}
