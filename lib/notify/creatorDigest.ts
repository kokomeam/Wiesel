/**
 * Creator escalation DIGEST — the ONLY sanctioned creator-addressed mail seam
 * (TUTOR-1 Wave 6 · P6.5).
 *
 * ════════════════════════ THE NO-AUTO-SEND INVARIANT ════════════════════════
 * lib/comms is the SINGLE learner-mail send site (its `approveAndSend` is the one
 * caller of a learner `provider.send`). This module NEVER imports lib/comms's send
 * path (service.ts). It is a SEPARATE creator-notification seam that mails the
 * COURSE AUTHOR a nightly summary of their escalation loop. It reuses ONLY:
 *   • `createResendProvider` — the fetch/Idempotency-Key/retry provider FACTORY,
 *   • `isEmailConfigured` — the same env gate,
 *   • `comms_suppressions` — the shared per-user suppression list (a bounced /
 *     complained address is honoured for creator mail too).
 * The tutor RUNTIME (lib/tutor/**, app/api/learn/tutor/**) does NOT import this
 * module, so no learner turn can ever reach a `provider.send`. Both facts are
 * asserted by the verify:comms negatives + verify-creator-digest greps.
 *
 * ════════════════════════════ THE FOOTGUN GUARD ═════════════════════════════
 * An unset RESEND_API_KEY silently downgrades the provider to a recording MOCK
 * (nothing leaves the machine). We therefore persist `provider_mode` on EVERY
 * digest row and mark `status='sent'` ONLY when `provider_mode==='resend'` AND
 * the send actually succeeded. Under DIGEST_DRY_RUN (default ON) we RENDER +
 * PERSIST the digest but never call `send` — the row is `status='dry_run'`. A
 * mock (no key, dry-run off) also persists `status='dry_run'` (rendered, not
 * sent). This makes "did mail actually leave?" answerable from the row alone.
 *
 * FAIL-BENIGN: `sendCreatorDigest` NEVER throws — it returns a settled result the
 * Inngest step / nightly cron records. `buildDigestContent` returns null when
 * there is nothing new (no row is written for an empty digest).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { createResendProvider } from "@/lib/comms/resendProvider";
import { isEmailConfigured } from "@/lib/comms/factory";
import { MASTERY_MIN_COHORT } from "@/lib/tutor/mastery/config";

type DB = SupabaseClient<Database>;

/* ────────────────────────────── Tunables ──────────────────────────────────
 * DIGEST_DRY_RUN defaults ON: the digest is rendered + persisted but no mail is
 * sent unless the operator explicitly sets DIGEST_DRY_RUN=false AND a Resend key
 * is present. This is the belt to the provider_mode braces. */
export function digestDryRun(): boolean {
  return process.env.DIGEST_DRY_RUN !== "false";
}

/** How many freshly-opened clusters / movers / missed-question rows to surface. */
const DIGEST_ITEM_CAP = 8;
/** New clusters opened within this window count as "new" for the digest. */
const NEW_CLUSTER_WINDOW_HOURS = 26;
/** A question is a "most-missed" mover only at/above the cohort floor (identity
 *  safety — never surface a stat computed from < 5 learners). */
const MISSED_COHORT_FLOOR = MASTERY_MIN_COHORT;
/** Below this pct_correct a question is worth flagging in the digest. */
const MISSED_PCT_THRESHOLD = 0.5;

/* ─────────────────────────────── Content ──────────────────────────────────
 * The digest content is IDENTITY-FREE by construction: every field is an
 * aggregate (a count, a question string, a node title). No user_id / roster
 * ever enters the content jsonb. */

export interface DigestClusterItem {
  clusterId: string;
  nodeId: string;
  representativeQuestion: string;
  memberCount: number;
  status: string;
}

export interface DigestMissedItem {
  questionId: string;
  lessonId: string | null;
  pctCorrect: number;
  n: number;
}

export interface DigestContent {
  courseTitle: string;
  generatedAt: string;
  /** Clusters that opened in the last window — the "new escalations" headline. */
  newClusters: DigestClusterItem[];
  /** Open clusters whose member_count grew (learners piling onto one question). */
  clusterMovers: DigestClusterItem[];
  /** A1.4 most-missed questions above the cohort floor. */
  mostMissed: DigestMissedItem[];
  /** Total open clusters awaiting a creator reply (aggregate). */
  openClusterTotal: number;
}

function cluster(row: {
  id: string;
  node_id: string;
  representative_question: string | null;
  member_count: number;
  status: string;
}): DigestClusterItem {
  return {
    clusterId: row.id,
    nodeId: row.node_id,
    representativeQuestion: (row.representative_question ?? "").trim() || "(question pending synthesis)",
    memberCount: row.member_count,
    status: row.status,
  };
}

/**
 * Assemble the digest for one course. Returns null when there is nothing new to
 * report (so no row is written for an empty digest). NEVER throws — a query
 * failure degrades that section to empty; if EVERY section is empty we return
 * null.
 */
export async function buildDigestContent(
  admin: DB,
  courseId: string
): Promise<DigestContent | null> {
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - NEW_CLUSTER_WINDOW_HOURS * 3600_000
  ).toISOString();

  const course = await admin
    .from("courses")
    .select("title")
    .eq("id", courseId)
    .maybeSingle();
  const courseTitle = course.data?.title?.trim() || "your course";

  // Open / replied clusters (identity-free surface; author-visible by RLS but we
  // read as service role here). member_count desc so movers surface first.
  const clustersRes = await admin
    .from("escalation_cluster")
    .select("id, node_id, representative_question, member_count, status, created_at")
    .eq("course_id", courseId)
    .in("status", ["open", "replied"])
    .order("member_count", { ascending: false })
    .limit(200);
  const clusters = clustersRes.data ?? [];

  const openClusterTotal = clusters.filter((c) => c.status === "open").length;

  const newClusters = clusters
    .filter((c) => c.status === "open" && c.created_at >= windowStart)
    .slice(0, DIGEST_ITEM_CAP)
    .map(cluster);

  // Movers = open clusters with more than one learner piled on, that are NOT in
  // the just-opened set (those are already the headline). member_count > 1 is the
  // "multiple learners asked the same thing" signal.
  const newIds = new Set(newClusters.map((c) => c.clusterId));
  const clusterMovers = clusters
    .filter((c) => c.status === "open" && c.member_count > 1 && !newIds.has(c.id))
    .slice(0, DIGEST_ITEM_CAP)
    .map(cluster);

  // A1.4 most-missed movers — cohort-floored (n >= MISSED_COHORT_FLOOR) so no
  // small-cohort stat is ever exposed. Lowest pct_correct first.
  const missedRes = await admin
    .from("rollup_question_stats")
    .select("question_id, lesson_id, pct_correct, n")
    .eq("course_id", courseId)
    .gte("n", MISSED_COHORT_FLOOR)
    .lt("pct_correct", MISSED_PCT_THRESHOLD)
    .order("pct_correct", { ascending: true })
    .limit(DIGEST_ITEM_CAP);
  const mostMissed: DigestMissedItem[] = (missedRes.data ?? []).map((r) => ({
    questionId: r.question_id,
    lessonId: r.lesson_id,
    pctCorrect: Number(r.pct_correct ?? 0),
    n: r.n,
  }));

  if (
    newClusters.length === 0 &&
    clusterMovers.length === 0 &&
    mostMissed.length === 0
  ) {
    return null;
  }

  return {
    courseTitle,
    generatedAt: now.toISOString(),
    newClusters,
    clusterMovers,
    mostMissed,
    openClusterTotal,
  };
}

/* ─────────────────────────────── Renderer ─────────────────────────────────
 * A small local HTML renderer — deliberately NOT the lib/comms EmailBody
 * renderer (that seam is learner-mail-only). Compliant footer: what this is,
 * why the creator got it, and how to turn it off. */

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderDigestEmail(content: DigestContent): RenderedDigest {
  const totalHeadline =
    content.newClusters.length + content.clusterMovers.length;
  const subject =
    totalHeadline > 0
      ? `${content.courseTitle}: ${totalHeadline} learner question${
          totalHeadline === 1 ? "" : "s"
        } need your attention`
      : `${content.courseTitle}: teaching insights from your learners`;

  const consoleUrl = `${siteUrl()}/studio`;
  const settingsUrl = `${siteUrl()}/studio`;

  const rows: string[] = [];
  const textRows: string[] = [];

  function section(title: string, items: string[], textItems: string[]) {
    if (items.length === 0) return;
    rows.push(
      `<h2 style="font-size:16px;margin:24px 0 8px;color:#292524">${escapeHtml(
        title
      )}</h2><ul style="padding-left:18px;margin:0">${items.join("")}</ul>`
    );
    textRows.push(`\n${title}\n${textItems.join("\n")}`);
  }

  section(
    "New escalations",
    content.newClusters.map(
      (c) =>
        `<li style="margin:6px 0;color:#44403c">${escapeHtml(
          c.representativeQuestion
        )} <span style="color:#78716c">(${c.memberCount} learner${
          c.memberCount === 1 ? "" : "s"
        })</span></li>`
    ),
    content.newClusters.map(
      (c) => `  • ${c.representativeQuestion} (${c.memberCount} learners)`
    )
  );

  section(
    "Questions gaining learners",
    content.clusterMovers.map(
      (c) =>
        `<li style="margin:6px 0;color:#44403c">${escapeHtml(
          c.representativeQuestion
        )} <span style="color:#78716c">(${c.memberCount} learners)</span></li>`
    ),
    content.clusterMovers.map(
      (c) => `  • ${c.representativeQuestion} (${c.memberCount} learners)`
    )
  );

  section(
    "Most-missed quiz questions",
    content.mostMissed.map(
      (m) =>
        `<li style="margin:6px 0;color:#44403c">${Math.round(
          m.pctCorrect * 100
        )}% correct <span style="color:#78716c">(n=${m.n})</span></li>`
    ),
    content.mostMissed.map(
      (m) => `  • ${Math.round(m.pctCorrect * 100)}% correct (n=${m.n})`
    )
  );

  const footer = `
    <hr style="border:none;border-top:1px solid #e7e5e4;margin:28px 0 12px" />
    <p style="font-size:12px;color:#78716c;line-height:1.5">
      You're receiving this because you're the creator of
      <strong>${escapeHtml(content.courseTitle)}</strong> and your AI tutor's
      escalation digest is on. This summary contains only aggregate teaching
      signals — never a learner's identity.
      <br />
      Manage this digest in your
      <a href="${settingsUrl}" style="color:#c2410c">course tutor settings</a>
      (set the cadence to “off” to stop).
    </p>`;

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;padding:8px 4px">
    <p style="font-size:14px;color:#44403c">Here's what your learners have been
    asking about in <strong>${escapeHtml(content.courseTitle)}</strong>.</p>
    ${rows.join("")}
    <p style="margin:24px 0 0">
      <a href="${consoleUrl}" style="display:inline-block;background:#ea580c;color:#fff;
      text-decoration:none;padding:10px 18px;border-radius:9999px;font-size:14px">
      Open the escalations queue</a>
    </p>
    <p style="font-size:12px;color:#78716c;margin-top:12px">
      ${content.openClusterTotal} open cluster${
        content.openClusterTotal === 1 ? "" : "s"
      } awaiting a reply.</p>
    ${footer}
  </div>`;

  const text = [
    `Here's what your learners have been asking about in ${content.courseTitle}.`,
    ...textRows,
    ``,
    `Open the escalations queue: ${consoleUrl}`,
    `${content.openClusterTotal} open clusters awaiting a reply.`,
    ``,
    `You're receiving this because you're the creator of ${content.courseTitle}.`,
    `This summary contains only aggregate teaching signals — never a learner's identity.`,
    `Manage this digest in your course tutor settings: ${settingsUrl}`,
  ].join("\n");

  return { subject, html, text };
}

/* ───────────────────────────── Orchestrator ──────────────────────────────── */

export type ProviderMode = "resend" | "mock" | "dry_run";
export type DigestStatus = "pending" | "sent" | "failed" | "dry_run";

/**
 * PURE provider_mode resolution (the footgun guard, testable without env-poking
 * a live process): DIGEST_DRY_RUN on → 'dry_run'; else configured → 'resend';
 * else → 'mock'. Injectable flags so tests can enumerate the truth table.
 */
export function resolveProviderMode(flags: {
  dryRun: boolean;
  emailConfigured: boolean;
}): ProviderMode {
  if (flags.dryRun) return "dry_run";
  return flags.emailConfigured ? "resend" : "mock";
}

/**
 * PURE status rule (the load-bearing golden): a digest row is 'sent' ONLY when
 * provider_mode==='resend' AND the send succeeded. Any non-resend mode →
 * 'dry_run' (rendered + persisted, nothing sent). A resend attempt that fails →
 * 'failed'. This function is the single source of the row's terminal status.
 */
export function digestStatusFor(
  providerMode: ProviderMode,
  sendSucceeded: boolean
): DigestStatus {
  if (providerMode !== "resend") return "dry_run";
  return sendSucceeded ? "sent" : "failed";
}

/** The unique idempotency key for one course on one UTC day. Exported so the
 *  pure suite can assert its shape (same course+day → same key → DB no-op). */
export function digestIdempotencyKey(courseId: string, now: Date): string {
  return `digest:${courseId}:${digestDateUTC(now)}`;
}

export interface SendCreatorDigestResult {
  ok: boolean;
  /** null when nothing was written (empty digest / opted out / suppressed / dup). */
  digestId: string | null;
  status: DigestStatus | null;
  providerMode: ProviderMode | null;
  /** Machine-readable reason for a non-send outcome. */
  reason?:
    | "empty"
    | "opted_out"
    | "cadence_off"
    | "suppressed"
    | "no_recipient"
    | "duplicate"
    | "sent"
    | "dry_run"
    | "failed";
  detail?: string;
}

/** UTC calendar date (YYYY-MM-DD) — the digest is once-per-course-per-day. */
function digestDateUTC(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build + persist + (conditionally) send one course's digest.
 *
 * Idempotency: `idempotency_key = digest:{courseId}:{digestDateUTC}` is UNIQUE,
 * so a same-day re-run (nightly cron replay OR an immediate post-consent fire)
 * inserts nothing and returns { reason: "duplicate" }.
 *
 * provider_mode resolution:
 *   DIGEST_DRY_RUN on (default) → 'dry_run'  (render + persist, NEVER send)
 *   else isEmailConfigured()    → 'resend'    (real send attempted)
 *   else                        → 'mock'      (render + persist, NEVER send)
 *
 * STATUS RULE (the footgun guard): status='sent' ONLY when provider_mode==='resend'
 * AND the send succeeded (sent_at stamped). A send failure → 'failed' + error.
 * dry_run / mock → status='dry_run' (rendered + persisted, nothing left the box).
 *
 * NEVER throws.
 */
export async function sendCreatorDigest(
  admin: DB,
  args: { courseId: string; now?: Date }
): Promise<SendCreatorDigestResult> {
  const now = args.now ?? new Date();
  const { courseId } = args;

  try {
    // ── Opt-out / cadence re-checked AT SEND (settings may have changed since
    //    the cron selected this course). ──
    const settings = await admin
      .from("tutor_course_settings")
      .select("digest_opt_out, digest_cadence")
      .eq("course_id", courseId)
      .maybeSingle();
    if (settings.data?.digest_opt_out === true) {
      return { ok: true, digestId: null, status: null, providerMode: null, reason: "opted_out" };
    }
    if (settings.data?.digest_cadence === "off") {
      return { ok: true, digestId: null, status: null, providerMode: null, reason: "cadence_off" };
    }

    // ── Content. Empty → no row. ──
    const content = await buildDigestContent(admin, courseId);
    if (!content) {
      return { ok: true, digestId: null, status: null, providerMode: null, reason: "empty" };
    }

    // ── Recipient (the course author's email). ──
    const course = await admin
      .from("courses")
      .select("author_id")
      .eq("id", courseId)
      .maybeSingle();
    const authorId = course.data?.author_id ?? null;
    if (!authorId) {
      return { ok: true, digestId: null, status: null, providerMode: null, reason: "no_recipient", detail: "No author on course." };
    }
    const userData = await admin.auth.admin.getUserById(authorId);
    const recipient = userData.data.user?.email ?? null;
    if (!recipient) {
      return { ok: true, digestId: null, status: null, providerMode: null, reason: "no_recipient", detail: "No email on file." };
    }

    // ── Suppression re-checked AT SEND (shared learner/creator suppression list;
    //    a bounced/complained address is honoured for creator mail too). ──
    const suppression = await admin
      .from("comms_suppressions")
      .select("reason")
      .eq("user_id", authorId)
      .maybeSingle();
    if (suppression.data) {
      return {
        ok: true,
        digestId: null,
        status: null,
        providerMode: null,
        reason: "suppressed",
        detail: suppression.data.reason ?? undefined,
      };
    }

    // ── provider_mode resolution (the footgun guard). ──
    const providerMode: ProviderMode = resolveProviderMode({
      dryRun: digestDryRun(),
      emailConfigured: isEmailConfigured(),
    });

    const rendered = renderDigestEmail(content);
    const idempotencyKey = digestIdempotencyKey(courseId, now);

    // ── Persist the row FIRST (rendered + provider_mode). status starts as the
    //    NON-SENT terminal for this mode; a successful resend send upgrades it. ──
    const initialStatus: DigestStatus =
      providerMode === "resend" ? "pending" : "dry_run";
    const insert: Database["public"]["Tables"]["creator_digest"]["Insert"] = {
      course_id: courseId,
      author_id: authorId,
      digest_date: digestDateUTC(now),
      content: content as unknown as Json,
      provider_mode: providerMode,
      status: initialStatus,
      idempotency_key: idempotencyKey,
    };
    const inserted = await admin
      .from("creator_digest")
      .insert(insert)
      .select("id")
      .single();

    // Unique-key violation → a same-day digest already exists → no-op.
    if (inserted.error) {
      if (inserted.error.code === "23505") {
        return { ok: true, digestId: null, status: null, providerMode, reason: "duplicate" };
      }
      throw inserted.error;
    }
    const digestId = inserted.data.id;

    // ── Non-'resend' modes NEVER send — the row stays 'dry_run'. ──
    if (providerMode !== "resend") {
      return { ok: true, digestId, status: "dry_run", providerMode, reason: "dry_run" };
    }

    // ── The ONE send. Uses the comms PROVIDER FACTORY (fetch + Idempotency-Key +
    //    retry) — NOT lib/comms's send site. status='sent' ONLY on success. ──
    const provider = createResendProvider();
    try {
      await provider.send({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromName: "WiseSel Tutor",
        // The digest is transactional creator mail; the unsubscribe link points
        // the creator at their tutor settings (cadence → off).
        unsubscribeUrl: `${siteUrl()}/studio`,
        idempotencyKey: digestId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await admin
        .from("creator_digest")
        .update({ status: "failed", error: message })
        .eq("id", digestId);
      return { ok: false, digestId, status: "failed", providerMode, reason: "failed", detail: message };
    }

    // Success — and ONLY here — do we mark 'sent'.
    await admin
      .from("creator_digest")
      .update({ status: "sent", sent_at: now.toISOString() })
      .eq("id", digestId);
    return { ok: true, digestId, status: "sent", providerMode, reason: "sent" };
  } catch (err) {
    // Fail-benign: never throw into the cron/Inngest step.
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({ tag: "creator_digest_error", courseId, detail })
    );
    return { ok: false, digestId: null, status: null, providerMode: null, reason: "failed", detail };
  }
}
