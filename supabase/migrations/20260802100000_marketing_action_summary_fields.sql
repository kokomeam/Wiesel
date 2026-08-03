/* UI-1 Wave 3 (DEV-1, approved at CHECKPOINT-0): structured result fields for
 * the activity feed's deterministic summary templates.
 *
 * `summary_fields` is an ADDITIVE, nullable jsonb payload each mutating tool
 * emits alongside its prose `summary` (a small typed bag: entity, counts,
 * platform, stage, keyword, short code, outcome…). The feed's collapsed
 * one-line summaries render from it via pure templates keyed off the tool
 * union (lib/marketing/activitySummaries.ts); historical rows (NULL) render
 * under a generic humanized template with the legacy prose relegated to the
 * expanded detail area. No backfill — prose-only history is a supported
 * state forever.
 */

alter table public.marketing_action
  add column if not exists summary_fields jsonb;
