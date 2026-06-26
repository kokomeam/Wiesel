"use client";

/**
 * The lead-capture form — the public conversion point. Posts to the service-role
 * ingest route, which creates the subscriber + form_submit event. Owns its own
 * success/error state; the consent line is mandatory and always shown.
 */

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { LeadCaptureSection } from "@/lib/marketing/types";
import { getAnonymousId } from "./anon";

type Status = "idle" | "submitting" | "done" | "error";

export function LeadCaptureForm({
  section,
  slug,
  preview = false,
}: {
  section: LeadCaptureSection;
  slug: string;
  preview?: boolean;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (preview) return; // drafts don't capture — the form goes live on publish
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/marketing/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "lead",
          slug,
          email,
          name: name || null,
          anonymousId: getAnonymousId(),
          freeLesson: section.offerFreeLesson,
          consentText: section.consentText,
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("done");
    } catch {
      setError("Network error. Please try again.");
      setStatus("error");
    }
  }

  return (
    <section id="get-started" className="mx-auto max-w-4xl scroll-mt-8 px-6 py-16">
      <div className="rounded-2xl border border-stone-200/80 bg-stone-50/60 p-8 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <h2 className="text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)] sm:text-3xl">
          {section.heading}
        </h2>
        <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-stone-600">{section.subhead}</p>

        {status === "done" ? (
          <div className="mt-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-800">
            <Check className="size-5 shrink-0" />
            {section.offerFreeLesson
              ? "You're in — check your inbox, your first lesson is on its way."
              : "You're on the list — keep an eye on your inbox."}
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 max-w-md space-y-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
              className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              autoComplete="email"
              className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <button
              type="submit"
              disabled={status === "submitting" || preview}
              className="brand-gradient inline-flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95 disabled:opacity-60"
            >
              {status === "submitting" ? <Loader2 className="size-4 animate-spin" /> : null}
              {section.buttonLabel}
            </button>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <p className="pt-1 text-xs leading-relaxed text-stone-400">{section.consentText}</p>
            {preview ? (
              <p className="text-xs font-medium text-amber-700">
                Preview — the form captures leads once the page is published.
              </p>
            ) : null}
          </form>
        )}
      </div>
    </section>
  );
}
