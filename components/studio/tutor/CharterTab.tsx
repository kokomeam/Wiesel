"use client";

/**
 * Tutor charter editor (TUTOR-1 Wave 5, P5.1). CLIENT form.
 *
 * The six creator-owned charter knobs — guidance style / course canon / scope /
 * assessment help / escalation sensitivity (five SegmentedControls) + tone notes
 * (a ≤500 textarea). Dirty/discard tracking + a sticky action bar, the
 * AutonomySettings pattern. Save routes through saveCharterAction (which
 * re-validates the enums server-side). The version history list (actor + when +
 * what changed) reads from the bundle. Controls carry toolAttrs()/aiAttrs().
 *
 * Charter changes are DIRECT creator config — never change-set-gated; the save is
 * immediate + versioned (an append-only tutor_charter_versions row).
 */

import { useMemo, useState, useTransition } from "react";
import type { LucideIcon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { FieldGroup } from "@/components/ui/FieldGroup";
import { StickyActionBar } from "@/components/ui/StickyActionBar";
import { IconTile } from "@/components/ui/IconTile";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/studio/analytics/EmptyState";
import {
  FileText,
  Compass,
  BookMarked,
  Radius,
  ShieldCheck,
  LifeBuoy,
  MessageSquareQuote,
  History,
} from "lucide-react";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { saveCharterAction } from "@/app/(app)/studio/[courseId]/tutor/actions";
import type {
  ConsoleCharter,
  TutorCharterVersion,
} from "@/lib/studio/tutorConsole";
import type {
  GuidanceStyle,
  CourseCanon,
  TutorScope,
  AssessmentHelpMode,
  EscalationSensitivity,
} from "@/lib/tutor/runtime/charter";

const GUIDANCE_OPTIONS: { value: GuidanceStyle; label: string }[] = [
  { value: "socratic_strict", label: "Socratic" },
  { value: "guided_default", label: "Guided" },
  { value: "answer_forward", label: "Answer-first" },
];
const CANON_OPTIONS: { value: CourseCanon; label: string }[] = [
  { value: "strict", label: "This course only" },
  { value: "open", label: "Course + general" },
];
const SCOPE_OPTIONS: { value: TutorScope; label: string }[] = [
  { value: "course_only", label: "Course concepts" },
  { value: "course_plus_adjacent", label: "+ prerequisites" },
];
const ASSESSMENT_OPTIONS: { value: AssessmentHelpMode; label: string }[] = [
  { value: "block", label: "Block on active work" },
  { value: "concept_review_only", label: "Concepts only" },
];
const ESCALATION_OPTIONS: { value: EscalationSensitivity; label: string }[] = [
  { value: "low", label: "Rarely" },
  { value: "default", label: "Balanced" },
  { value: "high", label: "Readily" },
];

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A stable JSON key for dirty comparison (fixed key order via the field list). */
function charterKey(c: ConsoleCharter): string {
  return JSON.stringify([
    c.guidanceStyle,
    c.courseCanon,
    c.scope,
    c.assessmentHelp,
    c.escalationSensitivity,
    c.toneNotes ?? "",
  ]);
}

/** A one-line description of what changed between two charter snapshots (history). */
function describeSnapshot(snapshot: Record<string, unknown>): string {
  const parts: string[] = [];
  const g = snapshot.guidanceStyle;
  if (typeof g === "string") {
    parts.push(GUIDANCE_OPTIONS.find((o) => o.value === g)?.label ?? g);
  }
  const c = snapshot.courseCanon;
  if (typeof c === "string") {
    parts.push(CANON_OPTIONS.find((o) => o.value === c)?.label ?? c);
  }
  return parts.join(" · ") || "Charter updated";
}

/**
 * One charter knob as a warm row: a brand icon tile, the mono eyebrow label +
 * help (via FieldGroup), and the control. The icon + serif-adjacent hierarchy
 * is what lifts the tab out of the flat mono-grey "worksheet" feel.
 */
function CharterField({
  icon: Icon,
  label,
  help,
  htmlFor,
  error,
  children,
}: {
  icon: LucideIcon;
  label: string;
  help: React.ReactNode;
  htmlFor?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <IconTile icon={Icon} size="sm" tone="brand" className="mt-0.5" />
      <FieldGroup className="flex-1" label={label} help={help} htmlFor={htmlFor} error={error}>
        {children}
      </FieldGroup>
    </div>
  );
}

export function CharterTab({
  courseId,
  charter,
  versions,
}: {
  courseId: string;
  charter: ConsoleCharter;
  versions: TutorCharterVersion[];
}) {
  const [baseline, setBaseline] = useState<ConsoleCharter>(charter);
  const [form, setForm] = useState<ConsoleCharter>(charter);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const set = <K extends keyof ConsoleCharter>(key: K, value: ConsoleCharter[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toneLen = (form.toneNotes ?? "").length;
  const toneError = toneLen > 500 ? "Keep tone notes to 500 characters or fewer." : undefined;
  const dirty = useMemo(
    () => charterKey(form) !== charterKey(baseline),
    [form, baseline]
  );
  const invalid = Boolean(toneError);

  const onSave = () => {
    setError(null);
    startTransition(async () => {
      const result = await saveCharterAction(courseId, {
        guidanceStyle: form.guidanceStyle,
        courseCanon: form.courseCanon,
        scope: form.scope,
        assessmentHelp: form.assessmentHelp,
        escalationSensitivity: form.escalationSensitivity,
        toneNotes: form.toneNotes && form.toneNotes.trim().length > 0 ? form.toneNotes.trim() : null,
      });
      if (result.ok) {
        setBaseline(form);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start gap-3 border-b border-stone-200/70 px-card-pad py-4">
          <IconTile icon={ShieldCheck} tone="gradient" />
          <div>
            <h2 className="font-display text-section font-light tracking-tight text-stone-900">
              Tutor charter
            </h2>
            <p className="mt-0.5 text-xs text-stone-600">
              How the tutor behaves in this course. Changes apply to the next learner turn.
            </p>
          </div>
        </div>
        <div className="divide-y divide-stone-200/60" data-ai-component="tutor-charter-form">
          <div className="px-card-pad py-5">
            <CharterField
              icon={Compass}
              label="Guidance style"
              help="How directly the tutor gives answers."
            >
              <div
                {...toolAttrs({
                  tool: "charter-guidance",
                  action: "SET_GUIDANCE_STYLE",
                  targetType: "segmented-control",
                  label: "Set the tutor guidance style",
                })}
              >
                <SegmentedControl<GuidanceStyle>
                  aria-label="Guidance style"
                  tone="brand"
                  value={form.guidanceStyle}
                  onChange={(v) => set("guidanceStyle", v)}
                  options={GUIDANCE_OPTIONS}
                />
              </div>
            </CharterField>
          </div>

          <div className="px-card-pad py-5">
            <CharterField
              icon={BookMarked}
              label="Course canon"
              help="Whether the tutor may draw on general knowledge."
            >
              <div
                {...toolAttrs({
                  tool: "charter-canon",
                  action: "SET_COURSE_CANON",
                  targetType: "segmented-control",
                  label: "Set the course canon",
                })}
              >
                <SegmentedControl<CourseCanon>
                  aria-label="Course canon"
                  tone="brand"
                  value={form.courseCanon}
                  onChange={(v) => set("courseCanon", v)}
                  options={CANON_OPTIONS}
                />
              </div>
            </CharterField>
          </div>

          <div className="px-card-pad py-5">
            <CharterField
              icon={Radius}
              label="Scope"
              help="How far beyond the course the tutor may range."
            >
              <div
                {...toolAttrs({
                  tool: "charter-scope",
                  action: "SET_SCOPE",
                  targetType: "segmented-control",
                  label: "Set the tutor scope",
                })}
              >
                <SegmentedControl<TutorScope>
                  aria-label="Scope"
                  tone="brand"
                  value={form.scope}
                  onChange={(v) => set("scope", v)}
                  options={SCOPE_OPTIONS}
                />
              </div>
            </CharterField>
          </div>

          <div className="px-card-pad py-5">
            <CharterField
              icon={ShieldCheck}
              label="Assessment help"
              help="What the tutor does during graded work."
            >
              <div
                {...toolAttrs({
                  tool: "charter-assessment",
                  action: "SET_ASSESSMENT_HELP",
                  targetType: "segmented-control",
                  label: "Set the assessment-help policy",
                })}
              >
                <SegmentedControl<AssessmentHelpMode>
                  aria-label="Assessment help"
                  tone="brand"
                  value={form.assessmentHelp}
                  onChange={(v) => set("assessmentHelp", v)}
                  options={ASSESSMENT_OPTIONS}
                />
              </div>
            </CharterField>
          </div>

          <div className="px-card-pad py-5">
            <CharterField
              icon={LifeBuoy}
              label="Escalation sensitivity"
              help="How readily the tutor offers a human hand-off."
            >
              <div
                {...toolAttrs({
                  tool: "charter-escalation",
                  action: "SET_ESCALATION_SENSITIVITY",
                  targetType: "segmented-control",
                  label: "Set the escalation sensitivity",
                })}
              >
                <SegmentedControl<EscalationSensitivity>
                  aria-label="Escalation sensitivity"
                  tone="brand"
                  value={form.escalationSensitivity}
                  onChange={(v) => set("escalationSensitivity", v)}
                  options={ESCALATION_OPTIONS}
                />
              </div>
            </CharterField>
          </div>

          <div className="px-card-pad py-5">
            <CharterField
              icon={MessageSquareQuote}
              label="Tone notes"
              htmlFor="tutor-tone-notes"
              help={`Optional voice guidance for the tutor. ${toneLen}/500`}
              error={toneError}
            >
              <textarea
                id="tutor-tone-notes"
                rows={3}
                value={form.toneNotes ?? ""}
                onChange={(e) => set("toneNotes", e.target.value)}
                placeholder="e.g. Warm and encouraging; use concrete examples from the lessons."
                className="w-full rounded-control border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 shadow-sm placeholder:text-stone-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                {...toolAttrs({
                  tool: "charter-tone",
                  action: "SET_TONE_NOTES",
                  targetType: "textarea",
                  label: "Set the tutor tone notes",
                })}
              />
            </CharterField>
          </div>

          {error ? (
            <div className="px-card-pad py-4">
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">
                {error}
              </p>
            </div>
          ) : null}
        </div>

        <StickyActionBar note={dirty ? "You have unsaved changes" : "Everything saved"}>
          <button
            type="button"
            onClick={() => {
              setForm(baseline);
              setError(null);
            }}
            disabled={pending || !dirty}
            className="rounded-full border border-stone-200 bg-white px-4 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={pending || !dirty || invalid}
            className="rounded-full brand-gradient px-5 py-1.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:opacity-50"
            {...toolAttrs({
              tool: "charter-save",
              action: "SAVE_CHARTER",
              targetType: "button",
              label: "Save the tutor charter",
            })}
          >
            {pending ? "Saving…" : "Save charter"}
          </button>
        </StickyActionBar>
      </Card>

      {/* ── Version history ── */}
      <Card>
        <div className="flex items-start gap-3 border-b border-stone-200/70 px-card-pad py-4">
          <IconTile icon={History} size="sm" tone="neutral" />
          <div>
            <h2 className="font-display text-title font-medium tracking-tight text-stone-900">
              History
            </h2>
            <p className="mt-0.5 text-xs text-stone-600">Every charter change, most recent first</p>
          </div>
        </div>
        {versions.length > 0 ? (
          <ul className="divide-y divide-stone-200/70">
            {versions.map((v) => (
              <li key={v.id} className="flex items-start gap-3 px-card-pad py-3.5">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-400 ring-2 ring-brand-100"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-stone-800">
                    {describeSnapshot(v.snapshot)}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-600">
                    {v.actorEmail ?? "Unknown"} · {dateFmt.format(new Date(v.createdAt))}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-card-pad">
            <EmptyState
              icon={FileText}
              title="No changes yet"
              hint="Your charter is running with its defaults. Every time you save a change, it is recorded here with who changed it and when."
            />
          </div>
        )}
      </Card>
    </div>
  );
}
