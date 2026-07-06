-- Correction to 20260702030000: question ids are NOT row UUIDs. Modules /
-- lessons / blocks use full UUIDs (they are table PKs), but questions live
-- inside blocks.content jsonb with short prefixed ids ("q-1a2b3c4d") — see
-- lib/course/factories.ts newId(). The responses column must be text.
alter table public.question_responses
  alter column question_id type text using question_id::text;
