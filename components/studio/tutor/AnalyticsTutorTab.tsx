/**
 * Creator Tutor Console — ANALYTICS tab (TUTOR-1 Wave 5, P5.3). Server component;
 * loads its OWN data (the P5.1 shell wires `<AnalyticsTutorTab courseId=… />` and
 * already author-gated the page). Renders bad-lesson detection + most-missed
 * questions + confusion/mastery overlays over the outline.
 *
 * PRIVACY (Amendment D-4): every number here comes from an author-gated definer
 * RPC that has ALREADY applied the ≥5 cohort floor / is a per-lesson aggregate:
 *   • lesson_health(courseId)          — ranked per-lesson composite + rationale.
 *   • most_missed_questions(courseId)  — cohort-floored (sub-floor OMITTED).
 * The confusion heatmap + mastery funnel are derived from lesson_health's floored
 * per-lesson inputs — NO extra learner read, NO recomputed floor. The only extra
 * read is the immutable published snapshot (for lesson/module titles), the same
 * sanctioned read the analytics dashboard makes.
 *
 * SECTIONS: (1) Lessons needing attention — ranked, Terra rationale + evidence
 * naming the implicated question/node; (2) Most-missed questions — ranked table
 * with per-option distractor counts + teaching-slide deep links (suppressed
 * sub-floor EmptyState); (3) Confusion heatmap over the outline; (4) Mastery
 * funnel by module. Charts are the dependency-free Area/Bar (empty-guarded).
 */

import Link from "next/link";
import { AlertTriangle, LineChart, ListChecks, Layers, MessageCircleWarning } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
import { editorBlockHref } from "@/lib/analytics/dashboard";
import {
  loadLessonHealth,
  loadMostMissed,
  LESSON_HEALTH_WEIGHTS,
  type LessonHealthRow,
  type MostMissedRow,
} from "@/lib/analytics/lessonHealth";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import { Table, Td } from "@/components/studio/Table";
import { BarChart } from "@/components/charts/BarChart";

/* ────────────────────────────── snapshot outline ────────────────────────────
 * A minimal walk of the immutable snapshot → lesson titles + module→lessons order
 * (buildSnapshotMaps drops module grouping, which the mastery funnel needs). */
interface OutlineLesson {
  lessonId: string;
  title: string;
}
interface OutlineModule {
  moduleId: string;
  title: string;
  lessons: OutlineLesson[];
}

function num(v: number | null): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function pct(v: number | null): string {
  return `${Math.round(num(v) * 100)}%`;
}

export async function AnalyticsTutorTab({ courseId }: { courseId: string }) {
  const supabase = await createClient();

  // Resolve the LIVE publication for this course (author-scoped client — RLS lets
  // the author read their own live row). No live publication → nothing to analyze.
  const pubRow = await supabase
    .from("course_publications")
    .select("id, version")
    .eq("course_id", courseId)
    .eq("status", "live")
    .maybeSingle();

  if (pubRow.error || !pubRow.data) {
    return (
      <EmptyState
        icon={LineChart}
        title="Publish to see tutor analytics"
        hint="Bad-lesson detection and most-missed questions read the live version's learner data. Publish the course, then check back once learners have engaged."
        action={
          <Link
            href={`/studio?course=${courseId}`}
            className="mt-1 inline-flex h-9 items-center rounded-full bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            Open the studio
          </Link>
        }
      />
    );
  }

  const publicationId = (pubRow.data as { id: string }).id;

  // Parallel: the two author-gated RPCs + the immutable snapshot (id→title).
  const [lessonHealth, mostMissed, snap] = await Promise.all([
    loadLessonHealth(supabase, courseId),
    loadMostMissed(supabase, courseId),
    getCachedSnapshot(publicationId).catch(() => null),
  ]);

  const outline: OutlineModule[] = (snap?.snapshot.modules ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((m) => ({
      moduleId: m.id,
      title: m.title,
      lessons: m.lessons
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((l) => ({ lessonId: l.id, title: l.title })),
    }));
  const lessonTitle = new Map<string, string>();
  for (const m of outline) for (const l of m.lessons) lessonTitle.set(l.lessonId, l.title);

  const healthByLesson = new Map<string, LessonHealthRow>();
  for (const h of lessonHealth) healthByLesson.set(h.lessonId, h);

  const nothingYet = lessonHealth.length === 0 && mostMissed.length === 0;
  if (nothingYet) {
    return (
      <EmptyState
        icon={LineChart}
        title="No analytics yet"
        hint="Once at least five learners engage with a lesson or answer a quiz, this course's health signals and most-missed questions appear here. Numbers below a five-learner cohort are never shown."
      />
    );
  }

  return (
    <div className="space-y-6">
      <LessonsNeedingAttention
        courseId={courseId}
        rows={lessonHealth}
        lessonTitle={lessonTitle}
        mostMissed={mostMissed}
      />
      <MostMissedQuestions courseId={courseId} rows={mostMissed} lessonTitle={lessonTitle} />
      <ConfusionHeatmap courseId={courseId} outline={outline} healthByLesson={healthByLesson} />
      <MasteryFunnel outline={outline} healthByLesson={healthByLesson} />
    </div>
  );
}

/* ─────────────────── 1. Lessons needing attention (ranked) ──────────────────
 * lesson_health is already ranked by composite_score desc. Each card shows the
 * composite, the strongest driving signal, the Terra rationale, and the
 * implicated worst question when one exists. */
function LessonsNeedingAttention({
  courseId,
  rows,
  lessonTitle,
  mostMissed,
}: {
  courseId: string;
  rows: LessonHealthRow[];
  lessonTitle: Map<string, string>;
  mostMissed: MostMissedRow[];
}) {
  // The worst most-missed question per lesson (already ranked by first-attempt
  // error desc), so a lesson's rationale can NAME the concrete question.
  const worstQById = new Map<string, MostMissedRow>();
  for (const q of mostMissed) {
    if (q.lessonId && !worstQById.has(q.lessonId)) worstQById.set(q.lessonId, q);
  }

  const flagged = rows.filter((r) => num(r.compositeScore) > 0);

  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="inline-flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" aria-hidden />
            Lessons needing attention
          </span>
        }
        subtitle="Ranked by a composite health score. Higher means more learners are struggling."
      />
      <div className="p-card-pad">
        {flagged.length === 0 ? (
          <p className="py-4 text-sm text-stone-500">
            No lesson is currently flagged — every lesson with data is within a healthy range.
          </p>
        ) : (
          <ul className="space-y-3">
            {flagged.map((r) => {
              const signals = rankSignals(r);
              const worst = r.lessonId ? worstQById.get(r.lessonId) : undefined;
              return (
                <li
                  key={r.lessonId}
                  className="rounded-xl border border-stone-200/80 bg-stone-50/40 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-stone-900">
                      <Link
                        href={editorBlockHref(courseId, r.lessonId)}
                        className="hover:text-brand-700 hover:underline"
                      >
                        {lessonTitle.get(r.lessonId) ?? "Untitled lesson"}
                      </Link>
                    </h3>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                      Health {Math.round(num(r.compositeScore) * 100)}
                    </span>
                  </div>

                  {r.rationale ? (
                    <p className="mt-2 text-sm leading-relaxed text-stone-600">{r.rationale}</p>
                  ) : (
                    <p className="mt-2 text-sm leading-relaxed text-stone-500">
                      Driven by {signals[0]?.label ?? "multiple signals"}
                      {signals[0] ? ` (${pct(signals[0].value)})` : ""}. A written summary appears after
                      the nightly analysis runs.
                    </p>
                  )}

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {signals
                      .filter((s) => s.value > 0)
                      .slice(0, 3)
                      .map((s) => (
                        <span
                          key={s.key}
                          className="rounded-md bg-white px-2 py-0.5 text-[11px] font-medium text-stone-500 ring-1 ring-stone-200/80"
                        >
                          {s.label}: {pct(s.value)}
                        </span>
                      ))}
                  </div>

                  {worst && (
                    <p className="mt-2 text-xs text-stone-500">
                      Implicated question:{" "}
                      <Link
                        href={editorBlockHref(courseId, worst.lessonId ?? r.lessonId, worst.blockId)}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {worst.questionId}
                      </Link>{" "}
                      · {pct(worst.firstAttemptErrorRate)} first-attempt error over{" "}
                      {worst.distinctLearnerCount} learners
                      {worst.conceptNodeIds.length > 0
                        ? ` · ${worst.conceptNodeIds.length} concept${
                            worst.conceptNodeIds.length === 1 ? "" : "s"
                          } mapped`
                        : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The five composite signals for a lesson, labeled + ranked strongest-first. */
function rankSignals(r: LessonHealthRow): Array<{ key: string; label: string; value: number }> {
  const signals = [
    { key: "masteryShortfall", label: "Mastery shortfall", value: num(r.masteryShortfall) },
    { key: "firstAttemptErrorRate", label: "First-attempt errors", value: num(r.firstAttemptErrorRate) },
    { key: "confusionDensity", label: "Reported confusion", value: num(r.confusionDensity) },
    { key: "dropoutAfterRate", label: "Drop-off", value: num(r.dropoutAfterRate) },
    { key: "rewatchScrubDensity", label: "Video rewatch", value: num(r.rewatchScrubDensity) },
  ];
  return signals.sort((a, b) => b.value - a.value);
}

/* ────────────────────── 2. Most-missed questions (table) ────────────────────
 * Ranked by first-attempt error desc. Distractor per-option counts + a
 * teaching-slide deep link per row. Sub-floor questions are OMITTED by the RPC —
 * an empty result is the suppressed state. */
function MostMissedQuestions({
  courseId,
  rows,
  lessonTitle,
}: {
  courseId: string;
  rows: MostMissedRow[];
  lessonTitle: Map<string, string>;
}) {
  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="inline-flex items-center gap-2">
            <ListChecks className="size-4 text-brand-500" aria-hidden />
            Most-missed questions
          </span>
        }
        subtitle="Cohort-floored to five or more learners. Questions below that floor are never shown."
      />
      {rows.length === 0 ? (
        <div className="p-card-pad">
          <EmptyState
            icon={MessageCircleWarning}
            title="No question meets the five-learner floor yet"
            hint="Per-question error rates and distractor breakdowns appear once at least five learners have answered a question. This protects individual learners from being identifiable."
          />
        </div>
      ) : (
        <Table
          head={["Question", "Lesson", "1st-attempt error", "2nd attempt", "Learners", "Top distractors", ""]}
          estimateRows={Math.min(rows.length, 10)}
        >
          {rows.map((q) => (
            <tr key={`${q.blockId}:${q.questionId}`} className="border-t border-stone-100">
              <Td className="font-medium text-stone-800">{q.questionId}</Td>
              <Td>{q.lessonId ? lessonTitle.get(q.lessonId) ?? "—" : "—"}</Td>
              <Td className="tabular-nums">{pct(q.firstAttemptErrorRate)}</Td>
              <Td className="tabular-nums text-stone-500">
                {q.secondAttemptErrorRate === null ? "—" : pct(q.secondAttemptErrorRate)}
              </Td>
              <Td className="tabular-nums">{q.distinctLearnerCount}</Td>
              <Td>
                <span className="flex flex-wrap gap-1">
                  {q.perOption.slice(0, 3).map((o, i) => (
                    <span
                      key={`${o.option ?? "blank"}-${i}`}
                      className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600"
                    >
                      {o.option ?? "(blank)"}: {o.count}
                    </span>
                  ))}
                  {q.perOption.length === 0 && <span className="text-stone-400">—</span>}
                </span>
              </Td>
              <Td>
                <Link
                  href={editorBlockHref(courseId, q.deepLink.lessonId ?? q.lessonId ?? "", q.deepLink.blockId)}
                  title="Open the teaching material in the editor"
                  className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium text-brand-700 hover:bg-stone-100 hover:underline"
                >
                  Teach
                </Link>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/* ──────────────────── 3. Confusion heatmap over the outline ─────────────────
 * Per-lesson confusion_density (from lesson_health, floored). A lesson with no
 * confusion signal renders neutral (suppressed / no data). */
function ConfusionHeatmap({
  courseId,
  outline,
  healthByLesson,
}: {
  courseId: string;
  outline: OutlineModule[];
  healthByLesson: Map<string, LessonHealthRow>;
}) {
  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="inline-flex items-center gap-2">
            <MessageCircleWarning className="size-4 text-rose-500" aria-hidden />
            Confusion heatmap
          </span>
        }
        subtitle="Learner-reported confusion per lesson. Neutral means no signal (or below the five-learner floor)."
      />
      <div className="space-y-4 p-card-pad">
        {outline.length === 0 ? (
          <p className="py-2 text-sm text-stone-500">The outline is unavailable for the live version.</p>
        ) : (
          outline.map((m) => (
            <div key={m.moduleId}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                {m.title}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {m.lessons.map((l) => {
                  const v = num(healthByLesson.get(l.lessonId)?.confusionDensity ?? null);
                  return (
                    <Link
                      key={l.lessonId}
                      href={editorBlockHref(courseId, l.lessonId)}
                      title={`${l.title} — ${pct(v)} confusion`}
                      className="inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"
                      style={heatStyle(v)}
                    >
                      {l.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/** Deterministic confusion tint (no randomness) — neutral stone at 0, deepening
 *  rose toward 1. Inline style keeps the ramp continuous without arbitrary classes. */
function heatStyle(v: number): React.CSSProperties {
  const clamped = Math.max(0, Math.min(1, v));
  if (clamped <= 0.001) {
    return { backgroundColor: "#fafaf9", color: "#78716c", borderColor: "#e7e5e4" };
  }
  // rose-500 (#f43f5e) alpha ramp for background; darker text as it deepens.
  const alpha = 0.12 + clamped * 0.55;
  return {
    backgroundColor: `rgba(244, 63, 94, ${alpha.toFixed(3)})`,
    color: clamped > 0.5 ? "#881337" : "#9f1239",
    borderColor: "rgba(244, 63, 94, 0.35)",
  };
}

/* ─────────────────────── 4. Mastery funnel by module ────────────────────────
 * Per-module mastery: the mean over the module's lessons of (1 - masteryShortfall)
 * = the mastered share (floored inputs). A dependency-free BarChart with an
 * empty-guard on the module set. */
function MasteryFunnel({
  outline,
  healthByLesson,
}: {
  outline: OutlineModule[];
  healthByLesson: Map<string, LessonHealthRow>;
}) {
  const modules = outline
    .map((m) => {
      const vals: number[] = [];
      for (const l of m.lessons) {
        const h = healthByLesson.get(l.lessonId);
        if (h && h.masteryShortfall !== null) vals.push(1 - num(h.masteryShortfall));
      }
      const mastered = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return { moduleId: m.moduleId, title: m.title, mastered };
    })
    .filter((m) => m.mastered !== null) as Array<{ moduleId: string; title: string; mastered: number }>;

  return (
    <Card>
      <CardHeader
        as="h2"
        title={
          <span className="inline-flex items-center gap-2">
            <Layers className="size-4 text-emerald-600" aria-hidden />
            Mastery by module
          </span>
        }
        subtitle="Share of learners at or above the mastery threshold, averaged over each module's concepts (five-learner floor)."
      />
      <div className="p-card-pad">
        {modules.length === 0 ? (
          <p className="py-2 text-sm text-stone-500">
            No module has a cohort of five or more learners with mastery data yet.
          </p>
        ) : (
          <>
            <div className="h-40">
              <BarChart
                data={modules.map((m) => Math.round(m.mastered * 100))}
                color="bg-emerald-500"
              />
            </div>
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {modules.map((m) => (
                <li key={m.moduleId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-stone-600">{m.title}</span>
                  <span className="tabular-nums font-medium text-stone-800">
                    {Math.round(m.mastered * 100)}% mastered
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* The composite weights, disclosed so the score is legible, not a black box. */}
      <div className="border-t border-stone-100 px-card-pad py-3">
        <p className="text-[11px] leading-relaxed text-stone-400">
          Health score weighting — mastery shortfall{" "}
          {Math.round(LESSON_HEALTH_WEIGHTS.masteryShortfall * 100)}%, first-attempt errors{" "}
          {Math.round(LESSON_HEALTH_WEIGHTS.firstAttemptErrorRate * 100)}%, confusion{" "}
          {Math.round(LESSON_HEALTH_WEIGHTS.confusionDensity * 100)}%, drop-off{" "}
          {Math.round(LESSON_HEALTH_WEIGHTS.dropoutAfterRate * 100)}%, video rewatch{" "}
          {Math.round(LESSON_HEALTH_WEIGHTS.rewatchScrubDensity * 100)}%.
        </p>
      </div>
    </Card>
  );
}
