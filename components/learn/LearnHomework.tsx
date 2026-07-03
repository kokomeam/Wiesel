"use client";

/**
 * Homework display + submission. Instructions/exercises render read-only
 * (hints and solutions are self-serve reveals — low-stakes practice); the
 * submission form collects text and/or files. Files upload straight to the
 * course-assets bucket under the learner's OWN {uid}/homework/… folder (the
 * storage RLS enforces the path), then the object paths ride in the
 * /api/learn/homework submission. Past submissions (the learner's own, via
 * RLS) show beneath the form with their review status.
 */

import { useRef, useState } from "react";
import { CheckCircle2, FileText, Lightbulb, Paperclip, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { HomeworkBlock } from "@/lib/course/types";
import { createClient } from "@/lib/supabase/client";
import { RevealPanel } from "./readOnlyBlocks";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file

export interface PriorSubmission {
  id: string;
  status: string;
  createdAt: string;
  fileCount: number;
}

interface PendingFile {
  name: string;
  path: string;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-80);
}

export function LearnHomework({
  block,
  courseId,
  publicationId,
  userId,
  priorSubmissions,
  disabled = false,
}: {
  block: HomeworkBlock;
  courseId: string;
  publicationId: string;
  userId: string;
  priorSubmissions: PriorSubmission[];
  /** Author preview: form shown but submission disabled. */
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState(priorSubmissions);
  const [justSubmitted, setJustSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // file_upload leads with the attach control; external_link pastes into the
  // text box; text_response is the default prose response.
  const wantsFiles = block.deliverableType === "file_upload";

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setError(null);
    const room = MAX_FILES - files.length;
    const picked = [...list].slice(0, room);
    const oversized = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (oversized) {
      setError(`"${oversized.name}" is over 20 MB.`);
      return;
    }
    setUploading(true);
    try {
      const supabase = createClient();
      const uploaded: PendingFile[] = [];
      for (const file of picked) {
        const path = `${userId}/homework/${courseId}/${block.id}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
        const { error: uploadError } = await supabase.storage
          .from("course-assets")
          .upload(path, file, { upsert: false });
        if (uploadError) throw uploadError;
        uploaded.push({ name: file.name, path });
      }
      setFiles((prev) => [...prev, ...uploaded]);
    } catch {
      setError("A file failed to upload — please try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/learn/homework", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicationId,
          blockId: block.id,
          text: text.trim(),
          filePaths: files.map((f) => f.path),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't submit — please try again.");
      }
      const body = (await res.json()) as {
        submission: { id: string; status: string; created_at: string };
      };
      setSubmissions((prev) => [
        {
          id: body.submission.id,
          status: body.submission.status,
          createdAt: body.submission.created_at,
          fileCount: files.length,
        },
        ...prev,
      ]);
      setText("");
      setFiles([]);
      setJustSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !disabled && !busy && !uploading && (text.trim().length > 0 || files.length > 0);

  return (
    <div className="space-y-5" data-ai-tool="learn-homework">
      <p className="text-[15px] leading-relaxed text-stone-700">{block.instructions}</p>

      {block.exercises.length > 0 ? (
        <ol className="space-y-4">
          {block.exercises.map((exercise, i) => (
            <li key={exercise.id} className="rounded-xl border border-stone-200/80 bg-stone-50/50 p-4">
              <p className="text-sm font-medium text-stone-800">
                <span className="mr-2 text-stone-400">{i + 1}.</span>
                {exercise.title}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{exercise.prompt}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {exercise.hint ? (
                  <RevealPanel label="Hint" icon={<Lightbulb className="h-3.5 w-3.5" aria-hidden />}>
                    {exercise.hint}
                  </RevealPanel>
                ) : null}
                {exercise.solution ? (
                  <RevealPanel label="Solution" icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}>
                    {exercise.solution}
                  </RevealPanel>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {block.deliverableType !== "none" ? (
        <div className="rounded-xl border border-stone-200/80 bg-white p-4">
          <p className="text-sm font-medium text-stone-800">Submit your work</p>
          {justSubmitted ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> Submitted — your instructor can now
              review it.
            </p>
          ) : null}
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setJustSubmitted(false);
            }}
            rows={4}
            disabled={disabled || busy}
            placeholder={
              wantsFiles
                ? "Optional notes about your files…"
                : block.deliverableType === "external_link"
                  ? "Paste a link to your work…"
                  : "Write your response…"
            }
            className="mt-3 w-full resize-y rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          {files.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {files.map((file) => (
                <li
                  key={file.path}
                  className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-1.5 text-xs text-stone-600"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((prev) => prev.filter((f) => f.path !== file.path))}
                    className="text-stone-400 hover:text-stone-600"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              data-ai-tool="learn-homework-submit"
              className="brand-gradient rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:pointer-events-none disabled:opacity-50"
            >
              {busy ? "Submitting…" : "Submit"}
            </button>
            <label
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50",
                (disabled || uploading || files.length >= MAX_FILES) &&
                  "pointer-events-none opacity-50"
              )}
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              {uploading ? "Uploading…" : "Attach files"}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => void addFiles(event.target.files)}
              />
            </label>
            {disabled ? (
              <span className="text-xs text-stone-400">Preview — submissions are disabled</span>
            ) : null}
            {error ? <p className="text-xs text-rose-600">{error}</p> : null}
          </div>
        </div>
      ) : null}

      {submissions.length > 0 ? (
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400">
            Your submissions
          </p>
          <ul className="mt-2 space-y-1.5">
            {submissions.map((submission) => (
              <li
                key={submission.id}
                className="flex items-center gap-2 rounded-lg border border-stone-200/80 bg-white px-3 py-2 text-xs text-stone-600"
              >
                <CheckCircle2
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    submission.status === "reviewed" ? "text-emerald-500" : "text-stone-300"
                  )}
                  aria-hidden
                />
                <span className="flex-1">
                  Submitted {new Date(submission.createdAt).toLocaleString()}
                  {submission.fileCount > 0
                    ? ` · ${submission.fileCount} ${submission.fileCount === 1 ? "file" : "files"}`
                    : ""}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 font-medium",
                    submission.status === "reviewed"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-stone-100 text-stone-500"
                  )}
                >
                  {submission.status === "reviewed" ? "Reviewed" : "Awaiting review"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
