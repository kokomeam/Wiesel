-- M-AG: agentic publishing — chat-filed publish approvals remember the
-- marketing conversation that requested them, so approve/skip can resume the
-- SAME thread with the agent's wrap-up (the marketing_action.conversation_id
-- precedent, migration 20260706). Nullable: cards filed from the review page /
-- queue / editor have no conversation. Never part of governance — the token
-- flow, content-hash binding, and RLS are untouched.

alter table public.social_publish_approval
  add column conversation_id uuid;

comment on column public.social_publish_approval.conversation_id is
  'Marketing agent conversation that filed this approval (null = non-chat surface). Powers the post-decision follow-up resume only; never part of the approval/token governance.';
