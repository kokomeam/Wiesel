"use client";

/**
 * Minimal creator review list (Milestone 2 scope: view + mark reviewed — no
 * rubric/grading UI). Lives on the Publish step: submissions only exist for
 * published courses. Data via GET /api/learn/submissions.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, FileText, Inbox } from "lucide-react";
import { cn } from "@/lib/cn";

interface SubmissionView {
  id: string;
  blockId: string;
  blockTitle: string;
  studentName: string;
  text: string;
  files: { name: string; url: string }[];
  status: string;
  createdAt: string;
}

async function fetchSubmissions(courseId: string): Promise<SubmissionView[]> {
  const res = await fetch(`/api/learn/submissions?courseId=${encodeURIComponent(courseId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { submissions?: SubmissionView[] };
  return body.submissions ?? [];
}

export function SubmissionsCard({ courseId }: { courseId: string }) {
  const [submissions, setSubmissions] = useState<SubmissionView[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSubmissions(courseId).then((list) => {
      if (alive) setSubmissions(list);
    });
    return () => {
      alive = false;
    };
  }, [courseId]);

  async function markReviewed(id: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/learn/submissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId: id }),
      });
      if (res.ok) {
        setSubmissions((prev) =>
          prev ? prev.map((s) => (s.id === id ? { ...s, status: "reviewed" } : s)) : prev
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      data-ai-tool="submissions-review"
    >
      <h2 className="text-base font-semibold text-stone-900">Learner submissions</h2>
      <p className="mt-1 text-sm text-stone-500">
        Homework handed in by your learners. Mark each one reviewed once you&apos;ve read it.
      </p>

      {submissions === null ? (
        <p className="mt-5 text-sm text-stone-400">Loading…</p>
      ) : submissions.length === 0 ? (
        <p className="mt-5 flex items-center gap-2 rounded-xl bg-stone-50 px-4 py-4 text-sm text-stone-500">
          <Inbox className="h-4 w-4 text-stone-400" aria-hidden />
          Nothing yet — submissions appear here once learners hand in homework.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {submissions.map((submission) => (
            <li
              key={submission.id}
              className="rounded-xl border border-stone-200/80 bg-stone-50/50 p-4"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-stone-800">
                  {submission.studentName}
                </span>
                <span className="text-xs text-stone-400">
                  {submission.blockTitle} · {new Date(submission.createdAt).toLocaleString()}
                </span>
                <span
                  className={cn(
                    "ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium",
                    submission.status === "reviewed"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  )}
                >
                  {submission.status === "reviewed" ? "Reviewed" : "Needs review"}
                </span>
              </div>
              {submission.text ? (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-stone-700">
                  {submission.text}
                </p>
              ) : null}
              {submission.files.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {submission.files.map((file) => (
                    <li key={file.url}>
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3 py-1 text-xs text-stone-600 hover:bg-stone-50"
                      >
                        <FileText className="h-3.5 w-3.5 text-stone-400" aria-hidden />
                        {file.name}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {submission.status !== "reviewed" ? (
                <button
                  type="button"
                  disabled={busyId === submission.id}
                  onClick={() => void markReviewed(submission.id)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  {busyId === submission.id ? "Saving…" : "Mark reviewed"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
