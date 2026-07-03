/**
 * THE learner-comms send seam (Milestone 6). `approveAndSend` is the ONLY
 * function in the repository that calls `CommsProvider.send()` — grep-able
 * invariant; the maintenance agent and the cron drain never import it, so no
 * auto-send path can exist.
 *
 * Enforcement lives HERE, not in the UI:
 *   1. status gate (draft | approved | failed-retry),
 *   2. enrollments.comms_opt_out RE-READ at send time — opted-out returns
 *      {ok:false, reason:"opted_out"} and the row STAYS draft ('failed' is
 *      reserved for provider errors),
 *   3. recipient resolved server-side (auth.users email via the admin API —
 *      never from the client payload),
 *   4. rendered at send time from the stored body (what the author last saw),
 *   5. every attempt logged (structured console line + the row itself).
 *
 * Drafting runs on the AUTHOR-scoped client (RLS enforces course ownership);
 * approveAndSend takes the ADMIN client (it must read auth.users + the
 * learner's enrollment row).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { getCommsProvider } from "./factory";
import { renderEmail } from "./render";
import { optOutUrl } from "./tokens";
import { CommsError, EmailBodySchema, type EmailBody } from "./types";

type DB = SupabaseClient<Database>;

export type LearnerMessageRow = Database["public"]["Tables"]["learner_messages"]["Row"];

export interface CreateDraftInput {
  courseId: string;
  userId: string;
  findingId?: string | null;
  subject: string;
  body: EmailBody;
}

/** Insert a draft. Client = author-scoped (RLS) or admin (agent runs). */
export async function createDraft(
  db: DB,
  input: CreateDraftInput
): Promise<LearnerMessageRow> {
  const body = EmailBodySchema.parse(input.body);
  const { data, error } = await db
    .from("learner_messages")
    .insert({
      course_id: input.courseId,
      user_id: input.userId,
      finding_id: input.findingId ?? null,
      subject: input.subject.slice(0, 300),
      body: body as unknown as Json,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Edit a draft's subject/body. Only drafts are editable. */
export async function updateDraft(
  db: DB,
  messageId: string,
  patch: { subject?: string; body?: EmailBody }
): Promise<LearnerMessageRow> {
  const update: Database["public"]["Tables"]["learner_messages"]["Update"] = {};
  if (patch.subject !== undefined) update.subject = patch.subject.slice(0, 300);
  if (patch.body !== undefined) {
    update.body = EmailBodySchema.parse(patch.body) as unknown as Json;
  }
  const { data, error } = await db
    .from("learner_messages")
    .update(update)
    .eq("id", messageId)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CommsError("Only drafts can be edited.", "invalid_request");
  return data;
}

export type SendOutcome =
  | { ok: true; message: LearnerMessageRow }
  | { ok: false; reason: "opted_out" | "bad_status" | "no_recipient" | "provider_error"; detail?: string };

export async function approveAndSend(admin: DB, messageId: string): Promise<SendOutcome> {
  const loaded = await admin
    .from("learner_messages")
    .select("*")
    .eq("id", messageId)
    .maybeSingle();
  if (loaded.error) throw loaded.error;
  const message = loaded.data;
  if (!message) return { ok: false, reason: "bad_status", detail: "Message not found." };
  // failed = provider error; the author may retry it. sent is final.
  if (!["draft", "approved", "failed"].includes(message.status)) {
    return { ok: false, reason: "bad_status", detail: `Message is ${message.status}.` };
  }

  // ── The opt-out gate: re-read at SEND time, never trust the UI. ──
  const enrollment = await admin
    .from("enrollments")
    .select("comms_opt_out")
    .eq("course_id", message.course_id)
    .eq("user_id", message.user_id)
    .maybeSingle();
  if (enrollment.error) throw enrollment.error;
  if (!enrollment.data) {
    return { ok: false, reason: "no_recipient", detail: "The learner is no longer enrolled." };
  }
  if (enrollment.data.comms_opt_out) {
    console.log(
      JSON.stringify({ tag: "comms_send", messageId, outcome: "opted_out" })
    );
    return { ok: false, reason: "opted_out" };
  }

  // ── Resolve recipient + sender + course (all server-side). ──
  const [{ data: userData, error: userError }, course] = await Promise.all([
    admin.auth.admin.getUserById(message.user_id),
    admin
      .from("courses")
      .select("title, author_id")
      .eq("id", message.course_id)
      .single(),
  ]);
  if (userError || !userData.user?.email) {
    return { ok: false, reason: "no_recipient", detail: "No email on file." };
  }
  if (course.error) throw course.error;
  const creator = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", course.data.author_id)
    .maybeSingle();
  const fromName = creator.data?.display_name ?? "Your course creator";

  // ── Render + send through the ONE provider seam. ──
  const body = EmailBodySchema.parse(message.body);
  const unsubscribeUrl = optOutUrl(message.course_id, message.user_id);
  const { html, text } = renderEmail(body, {
    fromName,
    courseTitle: course.data.title || "your course",
    unsubscribeUrl,
  });

  const provider = getCommsProvider();
  try {
    const result = await provider.send({
      to: userData.user.email,
      subject: message.subject,
      html,
      text,
      fromName,
      unsubscribeUrl,
      meta: { messageId, courseId: message.course_id },
    });
    const updated = await admin
      .from("learner_messages")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: result.providerMessageId,
        error: null,
      })
      .eq("id", messageId)
      .select("*")
      .single();
    if (updated.error) throw updated.error;
    console.log(
      JSON.stringify({
        tag: "comms_send",
        messageId,
        outcome: "sent",
        provider: provider.mode,
        providerMessageId: result.providerMessageId,
      })
    );
    return { ok: true, message: updated.data };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await admin
      .from("learner_messages")
      .update({ status: "failed", error: detail.slice(0, 500) })
      .eq("id", messageId);
    console.error(
      JSON.stringify({ tag: "comms_send", messageId, outcome: "failed", detail })
    );
    return { ok: false, reason: "provider_error", detail };
  }
}

/** Flip the opt-out flag (the opt-out route's write path, admin client). */
export async function setCommsOptOut(
  admin: DB,
  courseId: string,
  userId: string,
  optOut: boolean
): Promise<boolean> {
  const { data, error } = await admin
    .from("enrollments")
    .update({ comms_opt_out: optOut })
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}
