/**
 * Posting kit (M-D, PRD §10) — the copy bundle a creator pastes when
 * MANUALLY posting a rendered clip: caption + hashtags + comment keyword +
 * a short link + the disclosure line.
 *
 * Split of responsibilities (binding):
 *   - AI (ONE small-tier structured call) drafts caption + hashtags +
 *     keyword CANDIDATES — grounded in the candidate's hook/rationale and
 *     the course context; platform caps clamp in CODE.
 *   - The DISCLOSURE LINE is CODE-INSERTED (never model output) — the §10
 *     rule; `disclosureLine()` is the single source.
 *   - Comment-keyword UNIQUENESS is enforced by a partial unique index per
 *     creator among ACTIVE kits + a deterministic suffix walk here.
 *   - The short link (`/l/{code}`) targets the ctaDestination rule:
 *     /learn/{slug} when a live publication exists, else /p/{slug} — the
 *     click route re-resolves at CLICK time too, so publishing upgrades old
 *     links (the email-CTA lesson).
 *   - No model ⇒ a deterministic template kit (the blueprint-fallback
 *     precedent): the feature degrades, never blocks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { withSemaphore } from "@/lib/ai/subagent";
import { z } from "zod";
import { CLIP_PLATFORM_SPECS, type ClipPlatform, CLIP_PLATFORMS } from "./constants";
import { emitClipEvent } from "./events";

type DB = SupabaseClient<Database>;

/* ─────────────────────── disclosure (code-inserted) ────────────────────── */

/** THE disclosure line (§10 — code-inserted, never model output). */
export function disclosureLine(courseTitle: string): string {
  return `From my course "${courseTitle}" — full lesson inside.`;
}

/* ─────────────────────────── short links ──────────────────────────────── */

/** Human-typeable alphabet — no 0/O/1/l/I ambiguity. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const SHORT_CODE_LENGTH = 7;

export function generateShortCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

export async function createShortLink(
  supabase: DB,
  args: { creatorId: string; courseId: string | null; destination: string }
): Promise<{ id: string; code: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    const { data, error } = await supabase
      .from("short_link")
      .insert({
        creator_id: args.creatorId,
        course_id: args.courseId,
        code,
        destination: args.destination,
      })
      .select("id, code")
      .single();
    if (!error) return data;
    if (!/duplicate key|23505/.test(error.message + (error.code ?? ""))) {
      throw new Error(`short_link insert: ${error.message}`);
    }
    // collision (1-in-27B per code) — walk to a fresh one
  }
  throw new Error("short_link: could not allocate a unique code");
}

/* ─────────────── comment keyword (uniqueness in code + DB) ─────────────── */

const KEYWORD_RE = /^[A-Z]{3,12}$/;

export function normalizeKeyword(raw: string): string | null {
  const k = raw.trim().toUpperCase().replace(/[^A-Z]/g, "");
  return KEYWORD_RE.test(k) ? k : null;
}

/** Walk KEYWORD, KEYWORD2, … until one is free among the creator's ACTIVE
 *  kits (the DB's partial unique index is the authoritative backstop). */
export async function ensureUniqueKeyword(
  supabase: DB,
  creatorId: string,
  candidate: string
): Promise<string> {
  const base = normalizeKeyword(candidate) ?? "LEARN";
  for (let i = 0; i < 10; i++) {
    const attempt = i === 0 ? base : `${base.slice(0, 10)}${i + 1}`;
    const { data } = await supabase
      .from("posting_kit")
      .select("id")
      .eq("creator_id", creatorId)
      .eq("comment_keyword", attempt)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return attempt;
  }
  return `${base.slice(0, 6)}${Date.now() % 1000}`;
}

/* ──────────────────────── the AI draft (small tier) ────────────────────── */

const KitDraftSchema = z.object({
  caption: z.string().min(1).describe("the post caption WITHOUT hashtags or disclosure — hook-led, creator voice"),
  hashtags: z.array(z.string().min(2)).describe("without # prefixes"),
  commentKeyword: z
    .string()
    .describe("ONE upper-case DM keyword (3-12 letters) viewers comment to get the link"),
});
type KitDraft = z.infer<typeof KitDraftSchema>;

const KIT_SYSTEM_PROMPT = [
  "You draft the POSTING KIT for a short vertical clip a course creator will post MANUALLY (WiseSel never posts or schedules; never imply otherwise).",
  "Write a caption that pays off the clip's hook honestly — no fabricated outcomes, stats, urgency, or income claims; no engagement-bait.",
  "Hashtags: specific to the subject matter, no generic spam tags.",
  "The comment keyword is the word viewers comment to get the course link by DM — short, memorable, topical.",
  "Return JSON matching the schema exactly.",
].join("\n");

function templateKit(hookText: string, courseTitle: string): KitDraft {
  return {
    caption: `${hookText} — the full walkthrough is in ${courseTitle}.`,
    hashtags: [],
    commentKeyword: "LEARN",
  };
}

/* ──────────────────────────── assembly ────────────────────────────────── */

export interface PostingKitResult {
  kitId: string;
  caption: string;
  hashtags: string[];
  commentKeyword: string | null;
  disclosureLine: string;
  shortCode: string | null;
  /** caption + link + disclosure + hashtags — the one-tap copy text. */
  fullText: string;
}

export interface GenerateKitDeps {
  supabase: DB;
  ownerId: string;
  courseIdForEvents: string;
  model?: ModelClient;
  siteUrl: string;
}

export async function generatePostingKit(
  deps: GenerateKitDeps,
  args: {
    postId: string;
    platform: ClipPlatform;
    hookText: string;
    rationale: string;
    courseId: string | null;
    courseTitle: string;
    /** The ctaDestination-resolved path (/learn/{slug} or /p/{slug}). */
    destinationPath: string | null;
  }
): Promise<PostingKitResult> {
  // One kit per post — regenerating replaces (retire + insert keeps the
  // keyword index honest).
  const { data: existing } = await deps.supabase
    .from("posting_kit")
    .select("id")
    .eq("post_id", args.postId)
    .maybeSingle();
  if (existing) {
    await deps.supabase.from("posting_kit").update({ status: "retired", comment_keyword: null }).eq("id", existing.id);
    await deps.supabase.from("posting_kit").delete().eq("id", existing.id);
  }

  // 1) draft (small tier; template fallback keeps the feature alive keyless)
  let draft = templateKit(args.hookText, args.courseTitle);
  let model = "template-fallback";
  if (deps.model) {
    try {
      const result = await withSemaphore(deps.model).runTurn(
        {
          system: KIT_SYSTEM_PROMPT,
          input: [
            {
              role: "developer",
              content: [
                `CLIP HOOK: "${args.hookText}"`,
                `WHY THIS MOMENT: ${args.rationale}`,
                `COURSE: "${args.courseTitle}"`,
                `PLATFORM: ${CLIP_PLATFORM_SPECS[args.platform].label} (caption cap ${CLIP_PLATFORM_SPECS[args.platform].captionCap} chars; ${CLIP_PLATFORM_SPECS[args.platform].hashtagMin}-${CLIP_PLATFORM_SPECS[args.platform].hashtagMax} hashtags)`,
              ].join("\n"),
            },
          ],
          tools: [],
          stream: false,
          timeoutMs: 60_000,
          maxRetries: 1,
          effort: "low",
          responseFormat: { name: "clip_posting_kit", schema: toStrictJsonSchema(KitDraftSchema) },
        },
        () => {}
      );
      if (result.finishReason !== "error") {
        const parsed = KitDraftSchema.safeParse(JSON.parse(result.text));
        if (parsed.success) {
          draft = parsed.data;
          model = deps.model.model;
        }
      }
    } catch {
      // fall through to the template kit
    }
  }

  // 2) clamp to the platform's caps IN CODE (never trust the model's fit)
  const spec = CLIP_PLATFORM_SPECS[args.platform];
  const hashtags = draft.hashtags
    .map((h) => h.replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, spec.hashtagMax);
  const keyword = await ensureUniqueKeyword(deps.supabase, deps.ownerId, draft.commentKeyword);

  // 3) short link → the resolved destination (?ref threads attribution)
  let shortLinkId: string | null = null;
  let shortCode: string | null = null;
  if (args.destinationPath) {
    const link = await createShortLink(deps.supabase, {
      creatorId: deps.ownerId,
      courseId: args.courseId,
      destination: args.destinationPath,
    });
    shortLinkId = link.id;
    shortCode = link.code;
  }

  // 4) the code-inserted disclosure + assembled copy text
  const disclosure = disclosureLine(args.courseTitle);
  const linkLine = shortCode ? `${deps.siteUrl.replace(/\/$/, "")}/l/${shortCode}` : null;
  let caption = draft.caption.trim();
  const budget = spec.captionCap - disclosure.length - (linkLine?.length ?? 0) - hashtags.join(" #").length - 12;
  if (caption.length > budget && budget > 20) caption = `${caption.slice(0, budget - 1)}…`;
  const fullText = [
    caption,
    keyword ? `Comment "${keyword}" and I'll DM you the link.` : null,
    linkLine,
    disclosure,
    hashtags.length ? hashtags.map((h) => `#${h}`).join(" ") : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data: kit, error } = await deps.supabase
    .from("posting_kit")
    .insert({
      creator_id: deps.ownerId,
      post_id: args.postId,
      course_id: args.courseId,
      caption,
      hashtags: hashtags as unknown as Json,
      comment_keyword: keyword,
      short_link_id: shortLinkId,
      disclosure_line: disclosure,
      ai_metadata: { model, platform: args.platform } as unknown as Json,
    })
    .select("id")
    .single();
  if (error) throw new Error(`posting_kit insert: ${error.message}`);

  await emitClipEvent(deps.supabase, deps.courseIdForEvents, "posting_kit_generated", {
    kitId: kit.id,
    postId: args.postId,
    platform: args.platform,
    model,
    hasShortLink: shortCode !== null,
  });

  return {
    kitId: kit.id,
    caption,
    hashtags,
    commentKeyword: keyword,
    disclosureLine: disclosure,
    shortCode,
    fullText,
  };
}

/** Type guard the tools use for platform args. */
export function isClipPlatform(v: string): v is ClipPlatform {
  return (CLIP_PLATFORMS as readonly string[]).includes(v);
}
