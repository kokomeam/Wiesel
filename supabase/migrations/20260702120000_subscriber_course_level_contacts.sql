-- Contacts are course-level people; a campaign association is optional context
-- (recipient selection is via lead_list_member + the launch audience snapshot,
-- never subscriber.campaign_id). The NOT NULL made every campaign-less lead
-- import fail with "This list has no campaign to attach subscribers to."
alter table public.subscriber alter column campaign_id drop not null;

-- UNIQUE(campaign_id, email) treats NULLs as distinct — dedupe course-level
-- contacts explicitly.
create unique index if not exists subscriber_course_email_no_campaign_key
  on public.subscriber (course_id, email)
  where campaign_id is null;
