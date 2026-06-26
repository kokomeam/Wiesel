/**
 * Zod mirrors of the marketing domain model.
 *
 * Two jobs, one source of truth (the studio's proven pattern):
 *   1. Validate tool arguments at runtime (the real trust boundary).
 *   2. Generate the strict, model-facing JSON schema (via lib/ai/schema.ts).
 *
 * Constraint policy = "constrain variable content AT THE SCHEMA": every text
 * slot and list is length-capped here with `.max(...)`. Strict-mode JSON schema
 * STRIPS those caps, so they don't constrain the model directly — instead they
 * are the validate→repair guard: an over-long generation FAILS Zod parsing and
 * the loop re-asks. `coerceSections` clamps list lengths so a slightly-too-long
 * generation repairs deterministically instead of hard-failing.
 */

import { z } from "zod";
import type { EmailBody, LandingSection, LandingTheme } from "./types";

/* ─────────────────────────────── limits ──────────────────────────────── */

export const LIMITS = {
  eyebrow: 40,
  headline: 90,
  subhead: 220,
  cta: 32,
  heading: 80,
  outcome: 120,
  outcomesCount: 6,
  curriculumModules: 12,
  bio: 600,
  quote: 320,
  attribution: 80,
  priceLabel: 40,
  pricingPoint: 90,
  pricingPoints: 6,
  consent: 240,
  faqQ: 140,
  faqA: 400,
  faqCount: 8,
  subject: 120,
  preview: 160,
  emailHeading: 120,
  emailParagraph: 800,
  emailBullet: 160,
  emailBlocks: 12,
  sectionsCount: 12,
} as const;

const id = z.string().min(1);

/* ─────────────────────────── landing sections ────────────────────────── */

const HeroSectionSchema = z.object({
  id,
  kind: z.literal("hero"),
  eyebrow: z.string().max(LIMITS.eyebrow).optional(),
  headline: z.string().min(1).max(LIMITS.headline),
  subhead: z.string().min(1).max(LIMITS.subhead),
  ctaLabel: z.string().min(1).max(LIMITS.cta),
  variant: z.enum(["centered", "split", "minimal"]).optional(),
});

const OutcomesSectionSchema = z.object({
  id,
  kind: z.literal("outcomes"),
  heading: z.string().min(1).max(LIMITS.heading),
  items: z.array(z.string().min(1).max(LIMITS.outcome)).min(2).max(LIMITS.outcomesCount),
  variant: z.enum(["grid", "list"]).optional(),
});

const CurriculumSectionSchema = z.object({
  id,
  kind: z.literal("curriculum"),
  heading: z.string().min(1).max(LIMITS.heading),
  modules: z
    .array(
      z.object({
        title: z.string().min(1).max(LIMITS.heading),
        lessonCount: z.number().int().min(0).max(99),
      })
    )
    .min(1)
    .max(LIMITS.curriculumModules),
});

const InstructorSectionSchema = z.object({
  id,
  kind: z.literal("instructor"),
  heading: z.string().min(1).max(LIMITS.heading),
  name: z.string().min(1).max(LIMITS.heading),
  bio: z.string().min(1).max(LIMITS.bio),
});

const SocialProofSectionSchema = z.object({
  id,
  kind: z.literal("social_proof"),
  heading: z.string().min(1).max(LIMITS.heading),
  quote: z.string().min(1).max(LIMITS.quote),
  attribution: z.string().min(1).max(LIMITS.attribution),
});

const PricingCtaSectionSchema = z.object({
  id,
  kind: z.literal("pricing_cta"),
  heading: z.string().min(1).max(LIMITS.heading),
  priceLabel: z.string().min(1).max(LIMITS.priceLabel),
  points: z.array(z.string().min(1).max(LIMITS.pricingPoint)).min(1).max(LIMITS.pricingPoints),
  ctaLabel: z.string().min(1).max(LIMITS.cta),
});

const LeadCaptureSectionSchema = z.object({
  id,
  kind: z.literal("lead_capture"),
  heading: z.string().min(1).max(LIMITS.heading),
  subhead: z.string().min(1).max(LIMITS.subhead),
  buttonLabel: z.string().min(1).max(LIMITS.cta),
  consentText: z.string().min(1).max(LIMITS.consent),
  offerFreeLesson: z.boolean(),
});

const FaqSectionSchema = z.object({
  id,
  kind: z.literal("faq"),
  heading: z.string().min(1).max(LIMITS.heading),
  items: z
    .array(z.object({ q: z.string().min(1).max(LIMITS.faqQ), a: z.string().min(1).max(LIMITS.faqA) }))
    .min(1)
    .max(LIMITS.faqCount),
});

export const LandingSectionSchema = z.discriminatedUnion("kind", [
  HeroSectionSchema,
  OutcomesSectionSchema,
  CurriculumSectionSchema,
  InstructorSectionSchema,
  SocialProofSectionSchema,
  PricingCtaSectionSchema,
  LeadCaptureSectionSchema,
  FaqSectionSchema,
]) satisfies z.ZodType<LandingSection>;

export const LandingSectionsSchema = z
  .array(LandingSectionSchema)
  .min(1)
  .max(LIMITS.sectionsCount);

export const LandingThemeSchema = z.object({
  accent: z.string().optional(),
  colorTheme: z.enum(["warm", "cool", "mono", "bold"]).optional(),
  typePairing: z.enum(["editorial", "modern", "classic"]).optional(),
  density: z.enum(["compact", "normal", "airy"]).optional(),
  buttonStyle: z.enum(["pill", "rounded", "square"]).optional(),
}) satisfies z.ZodType<LandingTheme>;

/** The per-section layout variants the renderer supports (for tool schemas). */
export const SECTION_VARIANTS: Record<string, readonly string[]> = {
  hero: ["centered", "split", "minimal"],
  outcomes: ["grid", "list"],
};

/** The set of section kinds the generator/agent may emit, exposed for tool
 *  schemas and the renderer registry. */
export const LANDING_SECTION_KINDS = [
  "hero",
  "outcomes",
  "curriculum",
  "instructor",
  "social_proof",
  "pricing_cta",
  "lead_capture",
  "faq",
] as const;

/* ───────────────────────────── email body ────────────────────────────── */

export const EmailBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: z.string().min(1).max(LIMITS.emailHeading) }),
  z.object({ kind: z.literal("paragraph"), text: z.string().min(1).max(LIMITS.emailParagraph) }),
  z.object({
    kind: z.literal("button"),
    label: z.string().min(1).max(LIMITS.cta),
    href: z.string().min(1),
  }),
  z.object({
    kind: z.literal("bullets"),
    items: z.array(z.string().min(1).max(LIMITS.emailBullet)).min(1).max(8),
  }),
]);

export const EmailBodySchema = z.object({
  blocks: z.array(EmailBlockSchema).min(1).max(LIMITS.emailBlocks),
}) satisfies z.ZodType<EmailBody>;

/* ───────────────────────── coercion (validate→repair) ─────────────────── */

/** Clamp a section's variable-length lists into range, so a slightly-too-long
 *  generation repairs deterministically rather than hard-failing the parse. */
function clampSection(s: LandingSection): LandingSection {
  switch (s.kind) {
    case "outcomes":
      return { ...s, items: s.items.slice(0, LIMITS.outcomesCount) };
    case "curriculum":
      return { ...s, modules: s.modules.slice(0, LIMITS.curriculumModules) };
    case "pricing_cta":
      return { ...s, points: s.points.slice(0, LIMITS.pricingPoints) };
    case "faq":
      return { ...s, items: s.items.slice(0, LIMITS.faqCount) };
    default:
      return s;
  }
}

/**
 * Validate + repair a generated section list. Returns the parsed sections (with
 * lists clamped) or a list of human-readable errors. Mirrors the studio's
 * coerceOutline contract.
 */
export function coerceSections(
  value: unknown
): { sections?: LandingSection[]; errors: string[] } {
  if (!Array.isArray(value)) return { errors: ["sections must be an array"] };
  const clamped = value.slice(0, LIMITS.sectionsCount);
  const res = LandingSectionsSchema.safeParse(clamped);
  if (!res.success) {
    return { errors: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { sections: res.data.map(clampSection), errors: [] };
}
