/* social_voice_profile: allow the creator to DELETE their own profile row.
 *
 * Needed by the governance gate's revert path: the first-ever voice-profile
 * write is a CREATE (no before-snapshot), so Reject must delete the row.
 * This does NOT weaken the posts invariant — social_post and
 * social_post_batch deliberately keep ZERO delete policies (soft delete
 * only); a voice profile is a preferences row, not content history. */

create policy "social_voice_profile_delete" on public.social_voice_profile
  for delete using (creator_id = (select auth.uid()));
