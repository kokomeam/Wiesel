/**
 * Deterministic landing-page generator — the mock-first content engine.
 *
 * Builds a complete, schema-valid `LandingSection[]` grounded in the course's
 * own title / description / outcomes / curriculum / price. It invents no social
 * proof or fake stats (only truthful copy derived from the course). Phase 1 adds
 * an LLM-backed variant BEHIND THE SAME SIGNATURE; this one stays as the no-key
 * fallback and the deterministic fixture for tests.
 *
 * Every string is clamped to its schema cap so the generator can never trip its
 * own validation (the validate→repair guard still backstops the LLM variant).
 */

import { LIMITS } from "./schemas";
import type { CourseMarketingContext, LandingSection } from "./types";

function clamp(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

/** A URL-safe, reasonably-unique slug from a title. */
export function slugify(title: string, salt?: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
  const tail = (salt ?? "").slice(0, 6);
  return tail ? `${base || "course"}-${tail}` : base || "course";
}

function priceLabel(priceCents: number): string {
  if (priceCents <= 0) return "Free";
  const dollars = priceCents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** A simple, stable id (used at tool/event time, never in render). */
function sid(): string {
  return crypto.randomUUID();
}

export interface GenerateLandingOptions {
  /** Override the CTA label (defaults to a free-lesson offer). */
  ctaLabel?: string;
}

/**
 * Produce the full ordered section list for a landing page from the course.
 * Sections that have no grounding (e.g. no modules) are omitted rather than
 * filled with placeholder noise.
 */
export function generateLandingSections(
  course: CourseMarketingContext,
  opts: GenerateLandingOptions = {}
): LandingSection[] {
  const sections: LandingSection[] = [];
  const cta = clamp(opts.ctaLabel ?? "Get the free first lesson", LIMITS.cta);
  const levelWord = course.level ? `${course.level[0].toUpperCase()}${course.level.slice(1)}` : null;

  // 1 · Hero
  sections.push({
    id: sid(),
    kind: "hero",
    eyebrow: clamp(levelWord ? `${levelWord} · New cohort open` : "New cohort open", LIMITS.eyebrow),
    headline: clamp(course.title, LIMITS.headline),
    subhead: clamp(
      course.description ||
        `A practical, ${course.audience ?? "beginner"}-friendly path through ${course.title}.`,
      LIMITS.subhead
    ),
    ctaLabel: cta,
  });

  // 2 · Outcomes (from the course plan; fall back to a single derived line)
  const outcomes = course.outcomes.length
    ? course.outcomes
    : [`Understand the core ideas behind ${course.title}`, "Apply what you learn with confidence"];
  sections.push({
    id: sid(),
    kind: "outcomes",
    heading: "What you'll be able to do",
    items: outcomes.slice(0, LIMITS.outcomesCount).map((o) => clamp(o, LIMITS.outcome)),
  });

  // 3 · Curriculum (only when there are modules)
  if (course.modules.length) {
    sections.push({
      id: sid(),
      kind: "curriculum",
      heading: "Inside the course",
      modules: course.modules.slice(0, LIMITS.curriculumModules).map((m) => ({
        title: clamp(m.title, LIMITS.heading),
        lessonCount: m.lessonCount,
      })),
    });
  }

  // 4 · Instructor (truthful, generic frame — the creator edits the details)
  sections.push({
    id: sid(),
    kind: "instructor",
    heading: "Who's teaching",
    name: "Your instructor",
    bio: clamp(
      course.teachingStyle
        ? `Taught in a ${course.teachingStyle} style, this course distills real expertise into clear, usable lessons.`
        : "This course distills real expertise into clear, usable lessons you can apply right away.",
      LIMITS.bio
    ),
  });

  // 5 · Pricing + CTA
  sections.push({
    id: sid(),
    kind: "pricing_cta",
    heading: "Start learning today",
    priceLabel: clamp(priceLabel(course.priceCents), LIMITS.priceLabel),
    points: outcomes
      .slice(0, LIMITS.pricingPoints)
      .map((o) => clamp(o, LIMITS.pricingPoint)),
    ctaLabel: clamp(course.priceCents > 0 ? "Enroll now" : "Start free", LIMITS.cta),
  });

  // 6 · Lead capture (free-lesson offer; consent line is mandatory)
  sections.push({
    id: sid(),
    kind: "lead_capture",
    heading: "Start free — get Lesson 1",
    subhead: clamp("Enter your email and we'll send the first lesson instantly.", LIMITS.subhead),
    buttonLabel: clamp("Send me Lesson 1", LIMITS.cta),
    consentText: clamp(
      "By submitting, you agree to receive course emails. Unsubscribe anytime — one click, in every email.",
      LIMITS.consent
    ),
    offerFreeLesson: true,
  });

  // 7 · FAQ (grounded in prerequisites/level)
  const faq: { q: string; a: string }[] = [];
  faq.push({
    q: "Do I need any prior experience?",
    a: clamp(
      course.prerequisites.length
        ? `A little. Helpful to know: ${course.prerequisites.join(", ")}. Everything else is taught from the ground up.`
        : "No — this course starts from the fundamentals and builds up step by step.",
      LIMITS.faqA
    ),
  });
  faq.push({
    q: "How is the course delivered?",
    a: clamp(
      "It's a self-paced online course of lessons you can work through anytime, on any device.",
      LIMITS.faqA
    ),
  });
  sections.push({ id: sid(), kind: "faq", heading: "Frequently asked", items: faq });

  return sections;
}
