/**
 * Creator voice profile derivation (PRD §9.5) — the single highest-leverage
 * lever against generic output. Derived on first generation, viewable and
 * regenerable from the settings sheet, creator edits set
 * source='creator_edited' (regeneration over edits requires an explicit
 * confirm upstream).
 *
 * Derivation inputs: the creator's course contexts (descriptions, teaching
 * style), the EMAIL suite's voice_profile rules when present (real signal,
 * free to reuse), and any creator-pasted sample posts. Small-tier structured
 * call with one retry; deterministic fallback keeps the zero-key path whole.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { loadVoiceProfile } from "../persistence";
import type { CourseMarketingContext } from "../types";
import { socialConfig } from "./constants";
import { SocialVoiceProfileSchema, type SocialVoiceProfile } from "./schemas";

type DB = SupabaseClient<Database>;

const DERIVE_SYSTEM = [
  "You are analyzing a course creator's writing to derive their social-media voice profile.",
  "Work ONLY from the provided material. Describe how THEY write, not how marketing copy should sound.",
  "The summary is 2-4 sentences of concrete style description (sentence shape, vocabulary, how they open, how they teach).",
  "signatureMoves are recurring habits (e.g. \"opens with a question\", \"uses numbered mini-lists\").",
  "bannedPhrases: only include phrases the material suggests they would never use; empty is fine.",
  "Return JSON matching the schema exactly.",
].join("\n");

export interface VoiceDerivationInput {
  courses: CourseMarketingContext[];
  /** The email suite's creator-authored voice RULES, when present. */
  emailVoiceRules: string[];
  /** Creator-pasted sample posts (≤3). */
  samples: string[];
}

/** Deterministic derivation — the zero-key fallback. Also the base the model
 *  path falls back to on double failure. */
export function deriveVoiceProfileDeterministic(input: VoiceDerivationInput): SocialVoiceProfile {
  const teaching = input.courses.map((c) => c.teachingStyle).find((t) => t && t.trim());
  const audience = input.courses.map((c) => c.audience).find((a) => a && a.trim());
  const summaryParts = [
    teaching
      ? `Teaches in a ${teaching.toLowerCase()} style and writes the same way.`
      : "Direct and practical; explains by example rather than abstraction.",
    audience ? `Speaks to ${audience} without talking down.` : "Prefers plain language over jargon.",
    "Short paragraphs, concrete detail, almost no exclamation marks.",
  ];
  return SocialVoiceProfileSchema.parse({
    summary: summaryParts.join(" "),
    register: "friendly-professional",
    sentenceLength: "medium",
    emojiTolerance: "low",
    signatureMoves: ["names the learner's real problem before the product"],
    bannedPhrases: ["game-changer", "unlock your potential"],
    sampleExcerpts: input.samples.slice(0, 3),
  });
}

/** Model-backed derivation with one retry; falls back to deterministic. */
export async function deriveVoiceProfile(
  model: ModelClient | undefined,
  input: VoiceDerivationInput
): Promise<{ profile: SocialVoiceProfile; via: "model" | "deterministic" }> {
  if (!model) return { profile: deriveVoiceProfileDeterministic(input), via: "deterministic" };
  const cfg = socialConfig();
  const material = [
    ...input.courses.map(
      (c) =>
        `COURSE "${c.title}": ${c.description ?? "(no description)"} · teaching style: ${c.teachingStyle ?? "unspecified"} · audience: ${c.audience ?? "unspecified"}`
    ),
    input.emailVoiceRules.length
      ? `THE CREATOR'S OWN EMAIL VOICE RULES: ${input.emailVoiceRules.join(" | ")}`
      : "",
    ...input.samples.map((s) => `SAMPLE POST BY THE CREATOR:\n${s}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const schema = toStrictJsonSchema(SocialVoiceProfileSchema);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.runTurn(
        {
          system: DERIVE_SYSTEM,
          input: [{ role: "developer", content: material }],
          tools: [],
          stream: false,
          model: cfg.reviseModel,
          effort: cfg.reviseEffort,
          responseFormat: { name: "social_voice_profile", schema },
        },
        () => {}
      );
      const parsed = SocialVoiceProfileSchema.safeParse(JSON.parse(result.text));
      if (parsed.success) {
        // The creator's pasted samples always ride along verbatim.
        return {
          profile: { ...parsed.data, sampleExcerpts: input.samples.slice(0, 3) },
          via: "model",
        };
      }
    } catch {
      // fall through to retry / deterministic
    }
  }
  return { profile: deriveVoiceProfileDeterministic(input), via: "deterministic" };
}

/** Gather derivation inputs for the signed-in creator (their courses + the
 *  email voice rules) — RLS scopes both queries. */
export async function collectVoiceDerivationInput(
  supabase: DB,
  ownerId: string,
  samples: string[] = []
): Promise<VoiceDerivationInput> {
  const { loadCourseMarketingContext } = await import("../persistence");
  const { data: courses } = await supabase
    .from("courses")
    .select("id")
    .order("updated_at", { ascending: false })
    .limit(3);
  const contexts: CourseMarketingContext[] = [];
  for (const c of courses ?? []) {
    const ctx = await loadCourseMarketingContext(supabase, c.id);
    if (ctx) contexts.push(ctx);
  }
  const emailVoice = await loadVoiceProfile(supabase, ownerId);
  return { courses: contexts, emailVoiceRules: emailVoice?.rules ?? [], samples };
}
