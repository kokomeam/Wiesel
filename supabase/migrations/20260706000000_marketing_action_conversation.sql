/* ──────────────────────────────────────────────────────────────────────────
   marketing_action.conversation_id — tie an agent-requested pending action
   back to the conversation that raised it (marketing_question already has
   this). The approval resume (agent/resume.ts) previously relied on
   "most recent marketing conversation for the course", which is right only
   by accident; storing the id makes the resume land deterministically in
   the SAME thread the run paused in. Nullable + additive: user-surface
   actions (buttons) have no conversation and stay null.
   ────────────────────────────────────────────────────────────────────────── */

alter table public.marketing_action
  add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
