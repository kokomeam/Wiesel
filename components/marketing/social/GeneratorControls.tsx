"use client";

/**
 * Generation controls (PRD §6.1 steps 2–8): source · platform · goal (stage
 * chip auto-derives, editable) · tone · count (balanced-mix toggle at ≥3) ·
 * timing. Collapses to a compact row after first use — the queue is the hero.
 * Defaults seed from the platform emphasis conventions; everything is
 * creator-overridable.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  GOAL_LABELS,
  GOAL_STAGE_MAP,
  PLATFORMS,
  PLATFORM_LIMITS,
  SOCIAL_GOALS,
  SOCIAL_TONES,
  type FunnelStage,
  type SocialGoal,
  type SocialPlatform,
  type SocialTone,
  type TimingPreset,
} from "@/lib/marketing/social/constants";
import { StageChip } from "./StageChip";

export interface GeneratorSetup {
  sourceType: "course" | "module" | "lesson" | "manual";
  moduleId: string | null;
  lessonId: string | null;
  sourceText: string;
  platform: SocialPlatform;
  goal: SocialGoal;
  funnelMix: "balanced" | "pinned";
  tone: SocialTone;
  count: number;
  timingPreset: TimingPreset;
}

const TIMING_LABELS: Record<TimingPreset, string> = {
  none: "No planned times",
  same_day: "Same day",
  spread_week: "Spread across this week",
  spread_2_weeks: "Spread across 2 weeks",
  custom: "Custom (set per post after)",
};

const TONE_LABELS: Record<SocialTone, string> = {
  professional: "Professional",
  friendly: "Friendly",
  founder_led: "Founder-led",
  educational: "Educational",
  casual: "Casual",
};

function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={props.disabled}
          onClick={() => props.onChange(o.value)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            o.value === props.value
              ? "border-brand-300 bg-brand-50 text-brand-800"
              : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-20 shrink-0 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-stone-400">
      {children}
    </div>
  );
}

export function GeneratorControls(props: {
  course: { id: string; title: string };
  courses: { id: string; title: string }[];
  modules: { id: string; title: string }[];
  lessons: { id: string; title: string; moduleId: string }[];
  busy: boolean;
  startCollapsed: boolean;
  onGenerate: (setup: GeneratorSetup) => void;
  onOpenVoice: () => void;
}) {
  const [collapsed, setCollapsed] = useState(props.startCollapsed);
  const [sourceType, setSourceType] = useState<GeneratorSetup["sourceType"]>("course");
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [platform, setPlatform] = useState<SocialPlatform>("linkedin");
  const [goal, setGoal] = useState<SocialGoal>("value");
  const [stageOverride, setStageOverride] = useState<FunnelStage | null>(null);
  const [tone, setTone] = useState<SocialTone>("friendly");
  const [count, setCount] = useState(5);
  const [balanced, setBalanced] = useState(true);
  const [timingPreset, setTimingPreset] = useState<TimingPreset>("spread_week");

  const stage = stageOverride ?? GOAL_STAGE_MAP[goal];
  const funnelMix: "balanced" | "pinned" = count >= 3 && balanced ? "balanced" : "pinned";
  const moduleLessons = useMemo(
    () => props.lessons.filter((l) => !moduleId || l.moduleId === moduleId),
    [props.lessons, moduleId]
  );

  const canGenerate =
    !props.busy &&
    (sourceType !== "manual" || sourceText.trim().length > 0) &&
    (sourceType !== "module" || moduleId !== null) &&
    (sourceType !== "lesson" || lessonId !== null);

  const summary = `${PLATFORM_LIMITS[platform].label} · ${count} post(s) · ${
    funnelMix === "balanced" ? "balanced mix" : GOAL_LABELS[goal]
  } · ${TIMING_LABELS[timingPreset].toLowerCase()}`;

  if (collapsed) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200/80 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <Sparkles className="size-4 text-brand-600" />
        <span className="text-xs text-stone-600">{summary}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={props.onOpenVoice}>
          Voice profile
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCollapsed(false)}>
          <ChevronDown className="size-3.5" /> Adjust
        </Button>
        <Button size="sm" disabled={!canGenerate} onClick={() => props.onGenerate({ sourceType, moduleId, lessonId, sourceText, platform, goal, funnelMix, tone, count, timingPreset })}>
          <Wand2 className="size-3.5" /> Generate {count}
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div className="mb-4 flex items-center gap-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-stone-400">Create social posts</div>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={props.onOpenVoice}>
          Voice profile
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setCollapsed(true)}>
          <ChevronUp className="size-3.5" /> Collapse
        </Button>
      </div>

      <div className="space-y-3.5">
        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Source</FieldLabel>
          <div className="space-y-2">
            <Segmented
              value={sourceType}
              disabled={props.busy}
              onChange={(v) => {
                setSourceType(v);
                if (v !== "module") setModuleId(null);
                if (v !== "lesson") setLessonId(null);
              }}
              options={[
                { value: "course", label: `Course · ${props.course.title.slice(0, 28)}` },
                { value: "module", label: "Module" },
                { value: "lesson", label: "Lesson" },
                { value: "manual", label: "Manual topic" },
              ]}
            />
            {sourceType === "module" && (
              <select
                className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs"
                value={moduleId ?? ""}
                onChange={(e) => setModuleId(e.target.value || null)}
              >
                <option value="">Choose a module…</option>
                {props.modules.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            )}
            {sourceType === "lesson" && (
              <select
                className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs"
                value={lessonId ?? ""}
                onChange={(e) => setLessonId(e.target.value || null)}
              >
                <option value="">Choose a lesson…</option>
                {moduleLessons.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            )}
            {sourceType === "manual" && (
              <textarea
                className="w-full min-w-72 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs"
                rows={3}
                maxLength={8000}
                placeholder="Topic + any context to write from (your own claims are allowed verbatim)…"
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Platform</FieldLabel>
          <Segmented
            value={platform}
            disabled={props.busy}
            onChange={setPlatform}
            options={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LIMITS[p].label }))}
          />
          <span className="pt-1.5 text-[11px] text-stone-400">
            Instagram returns when image &amp; video generation ship.
          </span>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Goal</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={goal}
              disabled={props.busy}
              onChange={(g) => {
                setGoal(g);
                setStageOverride(null);
              }}
              options={SOCIAL_GOALS.map((g) => ({ value: g, label: GOAL_LABELS[g] }))}
            />
            <button
              type="button"
              title="Funnel stage (auto-derived from the goal — click to cycle)"
              onClick={() =>
                setStageOverride(stage === "tofu" ? "mofu" : stage === "mofu" ? "bofu" : "tofu")
              }
            >
              <StageChip stage={stage} suffix={stageOverride ? "" : " · auto"} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Tone</FieldLabel>
          <Segmented
            value={tone}
            disabled={props.busy}
            onChange={setTone}
            options={SOCIAL_TONES.map((t) => ({ value: t, label: TONE_LABELS[t] }))}
          />
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Count</FieldLabel>
          <Segmented
            value={String(count) as "1"}
            disabled={props.busy}
            onChange={(v) => setCount(Number(v))}
            options={["1", "2", "3", "4", "5"].map((n) => ({ value: n as "1", label: n }))}
          />
          {count >= 3 && (
            <label className="flex items-center gap-2 pt-1.5 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={balanced}
                onChange={(e) => setBalanced(e.target.checked)}
                className="accent-brand-600"
              />
              Balanced funnel mix
              <span className="text-[11px] text-stone-400">
                ({count === 5 ? "3 tofu / 1 mofu / 1 bofu" : count === 4 ? "2/1/1" : "2 tofu / 1 bofu"} — value first)
              </span>
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-3">
          <FieldLabel>Timing</FieldLabel>
          <Segmented
            value={timingPreset}
            disabled={props.busy}
            onChange={setTimingPreset}
            options={(Object.keys(TIMING_LABELS) as TimingPreset[])
              .filter((t) => t !== "custom")
              .map((t) => ({ value: t, label: TIMING_LABELS[t] }))}
          />
          <span className="pt-1.5 text-[11px] text-stone-400">
            Planned times are labels for your own manual plan — nothing is scheduled.
          </span>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button
          disabled={!canGenerate}
          onClick={() =>
            props.onGenerate({
              sourceType,
              moduleId,
              lessonId,
              sourceText,
              platform,
              goal,
              funnelMix,
              tone,
              count,
              timingPreset,
            })
          }
        >
          <Wand2 className="size-4" /> Generate {count} draft{count > 1 ? "s" : ""}
        </Button>
        <span className="text-[11px] text-stone-400">
          Quality first — drafts stream in as they&apos;re ready.
        </span>
      </div>
    </div>
  );
}
