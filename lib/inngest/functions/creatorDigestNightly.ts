/**
 * Durable creator-DIGEST nightly function (TUTOR-1 Wave 6 · P6.5).
 *
 *   creatorDigestNightly — cron "0 7 * * *" (07:00 UTC, after the mastery [04:00]
 *     + lesson-health [05:00] nightlies so rollups are fresh): for every course
 *     that has a LIVE publication AND an ENABLED tutor AND digest_cadence='daily'
 *     AND is NOT opted out, build + persist + (conditionally) send the creator's
 *     escalation digest via lib/notify/creatorDigest.sendCreatorDigest.
 *
 * THE NO-AUTO-SEND INVARIANT holds: this function reaches mail ONLY through the
 * sanctioned lib/notify seam (which uses the comms PROVIDER FACTORY, never
 * lib/comms's send site). It NEVER touches the learner-mail path.
 *
 * FAIL-BENIGN + IDEMPOTENT (the tutorLessonHealth/tutorMastery precedent): a
 * missing admin env settles the step with a benign not-configured stub — never a
 * throw. sendCreatorDigest never throws and is idempotent per (course, UTC day)
 * via the unique idempotency_key, so a cron replay is a no-op. DEV has no
 * INNGEST_EVENT_KEY, so the cron simply reconciles — correctness never depends on
 * event round-trips. Under DIGEST_DRY_RUN (default ON) nothing leaves the box:
 * every row is rendered + persisted as status='dry_run'.
 */

import { inngest } from "../client";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { sendCreatorDigest } from "@/lib/notify/creatorDigest";

/** A course eligible for a daily digest (live publication + enabled tutor + not
 *  opted out + daily cadence). */
interface DigestCourse {
  courseId: string;
}

export const creatorDigestNightly = inngest.createFunction(
  { id: "creator-digest-nightly", triggers: [{ cron: "0 7 * * *" }] },
  async ({ step }) => {
    // (1) Select eligible courses. A course qualifies iff it has a LIVE
    // publication AND its tutor settings say enabled + daily + not opted out.
    const courses = await step.run("select-digest-courses", async (): Promise<DigestCourse[]> => {
      if (!isAdminConfigured()) return [];
      const admin = createAdminClient();

      // Live-published course ids.
      const pubs = await admin
        .from("course_publications")
        .select("course_id")
        .eq("status", "live");
      if (pubs.error) throw new Error(`select-digest-courses/pubs: ${pubs.error.message}`);
      const live = new Set<string>();
      for (const r of pubs.data ?? []) {
        const cid = (r as { course_id: string | null }).course_id;
        if (cid) live.add(cid);
      }
      if (live.size === 0) return [];

      // Tutor settings gate: enabled + daily cadence + not opted out.
      const settings = await admin
        .from("tutor_course_settings")
        .select("course_id, enabled, digest_cadence, digest_opt_out")
        .eq("enabled", true)
        .eq("digest_cadence", "daily")
        .eq("digest_opt_out", false);
      if (settings.error) throw new Error(`select-digest-courses/settings: ${settings.error.message}`);

      const out: DigestCourse[] = [];
      const seen = new Set<string>();
      for (const s of settings.data ?? []) {
        const cid = (s as { course_id: string | null }).course_id;
        if (cid && live.has(cid) && !seen.has(cid)) {
          seen.add(cid);
          out.push({ courseId: cid });
        }
      }
      // Deterministic order (a sweep should be reproducible).
      out.sort((a, b) => (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0));
      return out;
    });

    // (2) One digest per course — one step each keeps a large sweep inside
    // durable-execution limits + makes a partial failure resumable. Each call is
    // idempotent per (course, day) so a step retry re-uses the same row.
    let sent = 0;
    let dryRun = 0;
    let empty = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < courses.length; i++) {
      const { courseId } = courses[i];
      const outcome = await step.run(`digest-${i}`, async () => {
        if (!isAdminConfigured()) return { ok: false as const, checkpoint: "admin not configured" };
        const admin = createAdminClient();
        const result = await sendCreatorDigest(admin, { courseId });
        return { ok: true as const, courseId, status: result.status, reason: result.reason };
      });
      if (!outcome.ok) continue;
      if (outcome.status === "sent") sent += 1;
      else if (outcome.status === "dry_run") dryRun += 1;
      else if (outcome.reason === "empty") empty += 1;
      else if (outcome.reason === "failed") failed += 1;
      else skipped += 1;
    }

    console.log(
      JSON.stringify({
        tag: "creator_digest_nightly",
        courses: courses.length,
        sent,
        dryRun,
        empty,
        skipped,
        failed,
      })
    );
    return { courses: courses.length, sent, dryRun, empty, skipped, failed };
  }
);
