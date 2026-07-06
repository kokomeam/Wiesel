"use client";

/**
 * Publish step — the real thing (Milestone 1 of publishing). Shows the
 * publication state (version, URL, visibility, unpublished-changes drift),
 * runs the pre-flight LIVE against the in-store draft (errors block, warnings
 * are overridable), previews a concise diff vs the live version, and drives
 * publish / republish / unpublish / restore / slug + visibility edits through
 * /api/publish.
 *
 * Drift detection is client-side and reactive: the same snapshot + hash code
 * the server publishes with (WebCrypto sha256) runs against the store doc, so
 * the "unpublished changes" chip updates as you edit, no refetch needed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  Pencil,
  Rocket,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { computeContentHash } from "@/lib/course/publish/hash";
import { runPublishPreflight } from "@/lib/course/publish/preflight";
import type {
  PreflightIssue,
  PublicationSummary,
  PublicationVisibility,
  PublishDiffSummary,
} from "@/lib/course/publish/schemas";
import { buildPublicationSnapshot } from "@/lib/course/publish/snapshot";
import { isValidSlug, publicCoursePath, slugifyTitle } from "@/lib/course/publish/slug";
import { useEditorStore } from "@/lib/course/store";
import { SubmissionsCard } from "./SubmissionsCard";

interface RemoteStatus {
  publication: PublicationSummary | null;
  diff: PublishDiffSummary;
}

async function fetchRemoteStatus(courseId: string): Promise<RemoteStatus> {
  const res = await fetch(`/api/publish?courseId=${encodeURIComponent(courseId)}`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = (await res.json()) as RemoteStatus;
  return { publication: data.publication, diff: data.diff };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function IssueList({ issues, tone }: { issues: PreflightIssue[]; tone: "error" | "warning" }) {
  return (
    <ul className="space-y-1">
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`} className="flex items-start gap-2 text-left text-xs leading-relaxed">
          {tone === "error" ? (
            <XCircle className="mt-0.5 size-3.5 shrink-0 text-rose-500" />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          )}
          <span className="text-stone-600">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

function DiffLine({ label, counts }: { label: string; counts: { added: number; changed: number; removed: number } }) {
  const parts: string[] = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.changed) parts.push(`${counts.changed} changed`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-stone-500">{label}</span>
      <span className={cn("font-medium", parts.length ? "text-stone-800" : "text-stone-400")}>
        {parts.length ? parts.join(" · ") : "unchanged"}
      </span>
    </div>
  );
}

export function PublishPanel() {
  const doc = useEditorStore((s) => s.doc);

  /* ── live client-side pre-flight + drift hash ── */
  const preflight = useMemo(() => runPublishPreflight(doc), [doc]);
  const [draftHash, setDraftHash] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      const { snapshot, answerKeys } = buildPublicationSnapshot(doc);
      void computeContentHash(snapshot, answerKeys).then((h) => {
        if (alive) setDraftHash(h);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [doc]);

  /* ── server state (publication + diff) ── */
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRemote(await fetchRemoteStatus(doc.id));
      setRemoteError(null);
    } catch {
      setRemoteError("Couldn't load the publication status.");
    }
  }, [doc.id]);
  useEffect(() => {
    let alive = true;
    fetchRemoteStatus(doc.id)
      .then((status) => {
        if (alive) {
          setRemote(status);
          setRemoteError(null);
        }
      })
      .catch(() => {
        if (alive) setRemoteError("Couldn't load the publication status.");
      });
    return () => {
      alive = false;
    };
  }, [doc.id]);

  const publication = remote?.publication ?? null;
  const isLive = publication?.status === "live";
  const draftChanged = !publication || !isLive || publication.contentHash !== draftHash;

  /* ── actions ── */
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justPublished, setJustPublished] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [visibility, setVisibility] = useState<PublicationVisibility>("public");
  const [slugEditOpen, setSlugEditOpen] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [copied, setCopied] = useState(false);

  const firstPublish = !publication;
  const effectiveSlug = slugInput || slugifyTitle(doc.title);
  const slugOk = isValidSlug(effectiveSlug);
  const needsAck = preflight.warnings.length > 0 && !ackWarnings;

  const openReview = async () => {
    setActionError(null);
    setJustPublished(false);
    setAckWarnings(false);
    await refresh();
    setReviewOpen(true);
  };

  const publish = async () => {
    setBusy("publish");
    setActionError(null);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: doc.id,
          ...(firstPublish ? { slug: effectiveSlug, visibility } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Publish failed (${res.status})`);
      setReviewOpen(false);
      setJustPublished(true);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Publish failed");
    } finally {
      setBusy(null);
    }
  };

  const patch = async (update: Record<string, unknown>, label: string) => {
    setBusy(label);
    setActionError(null);
    try {
      const res = await fetch("/api/publish", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: doc.id, update }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `Update failed (${res.status})`);
      await refresh();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Update failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!publication) return;
    await navigator.clipboard.writeText(
      `${window.location.origin}${publicCoursePath(publication.slug)}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin" data-ai-component="publish-panel">
      <div className="mx-auto max-w-xl px-6 py-12">
        <div className="text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl brand-gradient text-white">
            <Rocket className="size-5" />
          </div>
          <h1 className="mt-4 text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
            {isLive ? "Your course is live" : publication ? "Currently unpublished" : "Publish your course"}
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-stone-500">
            Publishing takes an immutable snapshot for learners — you keep editing the
            draft freely, and nothing changes for them until you publish again.
          </p>
        </div>

        {/* ── publication state ── */}
        {publication && (
          <div className="mt-8 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    isLive ? "bg-emerald-500" : "bg-stone-300"
                  )}
                />
                <span className="text-sm font-medium text-stone-900">
                  {isLive ? "Live" : "Unpublished"} · v{publication.version}
                </span>
                <span className="rounded-full border border-stone-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
                  {publication.visibility}
                </span>
              </div>
              <span className="text-xs text-stone-400">{formatDate(publication.publishedAt)}</span>
            </div>

            <div className="mt-3 flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-2">
              <Link2 className="size-3.5 shrink-0 text-stone-400" />
              {slugEditOpen ? (
                <SlugEditor
                  initial={publication.slug}
                  busy={busy === "slug"}
                  onCancel={() => setSlugEditOpen(false)}
                  onSave={async (slug) => {
                    const ok = await patch({ action: "set_slug", slug }, "slug");
                    if (ok) setSlugEditOpen(false);
                  }}
                />
              ) : (
                <>
                  <code className="flex-1 truncate font-mono text-xs text-stone-700">
                    {publicCoursePath(publication.slug)}
                  </code>
                  <button
                    type="button"
                    className="text-stone-400 hover:text-stone-700"
                    title="Change the course URL"
                    onClick={() => setSlugEditOpen(true)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="text-stone-400 hover:text-stone-700"
                    title="Copy public link"
                    onClick={copyLink}
                  >
                    {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                  </button>
                  {isLive && (
                    <a
                      href={publicCoursePath(publication.slug)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-stone-400 hover:text-stone-700"
                      title="Open the public page"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </>
              )}
            </div>

            {isLive && draftHash && (
              <div className="mt-3 flex items-center gap-2 text-xs">
                {draftChanged ? (
                  <>
                    <span className="size-1.5 rounded-full bg-amber-400" />
                    <span className="text-amber-700">
                      The draft has unpublished changes — learners see v{publication.version}.
                    </span>
                  </>
                ) : (
                  <>
                    <span className="size-1.5 rounded-full bg-emerald-400" />
                    <span className="text-stone-500">The live version matches your draft.</span>
                  </>
                )}
              </div>
            )}

            <div className="mt-4 flex items-center gap-2">
              {isLive && (
                <VisibilityToggle
                  value={publication.visibility}
                  busy={busy === "visibility"}
                  onChange={(v) => void patch({ action: "set_visibility", visibility: v }, "visibility")}
                />
              )}
              <div className="flex-1" />
              {isLive ? (
                confirmUnpublish ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-stone-500">Hide it from learners?</span>
                    <Button size="sm" variant="outline" onClick={() => setConfirmUnpublish(false)}>
                      Keep live
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === "unpublish"}
                      onClick={async () => {
                        const ok = await patch({ action: "unpublish" }, "unpublish");
                        if (ok) setConfirmUnpublish(false);
                      }}
                    >
                      {busy === "unpublish" && <Loader2 className="size-3 animate-spin" />}
                      Unpublish
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmUnpublish(true)}>
                    Unpublish
                  </Button>
                )
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === "restore"}
                  onClick={() => void patch({ action: "restore" }, "restore")}
                >
                  {busy === "restore" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3" />
                  )}
                  Restore v{publication.version}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── pre-flight ── */}
        <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <div className="flex items-center justify-between">
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-stone-400">
              Pre-flight
            </h2>
            <span className="text-xs text-stone-400">
              {preflight.counts.lessons} lessons · {preflight.counts.blocks} blocks ·{" "}
              {preflight.counts.slides} slides
            </span>
          </div>
          {preflight.errors.length === 0 && preflight.warnings.length === 0 ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-stone-500">
              <Check className="size-3.5 text-emerald-500" /> Everything looks good.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {preflight.errors.length > 0 && <IssueList issues={preflight.errors} tone="error" />}
              {preflight.warnings.length > 0 && (
                <IssueList issues={preflight.warnings} tone="warning" />
              )}
            </div>
          )}
        </div>

        {/* ── review + publish ── */}
        <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          {!reviewOpen ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-relaxed text-stone-500">
                {firstPublish
                  ? "Choose the course URL and go live."
                  : isLive && !draftChanged
                    ? "Learners already have your latest version."
                    : "Review what changed, then publish a new version."}
              </p>
              <Button
                size="sm"
                disabled={!preflight.ok || (isLive && !draftChanged) || !remote}
                title={
                  !preflight.ok
                    ? "Fix the pre-flight errors first"
                    : isLive && !draftChanged
                      ? "No unpublished changes"
                      : undefined
                }
                onClick={() => void openReview()}
                data-ai-tool="publish-review"
              >
                <Rocket className="size-3.5" />
                {firstPublish ? "Review & publish" : "Review & republish"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {remote && (
                <div className="space-y-1.5 rounded-xl bg-stone-50 px-3 py-2.5">
                  <DiffLine label="Lessons" counts={remote.diff.lessons} />
                  <DiffLine label="Blocks" counts={remote.diff.blocks} />
                </div>
              )}

              {firstPublish && (
                <>
                  <div>
                    <label className="font-mono text-[11px] font-medium uppercase tracking-wider text-stone-400">
                      Course URL
                    </label>
                    <div className="mt-1.5 flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2 font-mono text-xs text-stone-700 focus-within:border-brand-400">
                      <span className="text-stone-400">/learn/</span>
                      <input
                        value={slugInput}
                        onChange={(e) => setSlugInput(e.target.value)}
                        placeholder={slugifyTitle(doc.title)}
                        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-stone-300"
                        spellCheck={false}
                      />
                    </div>
                    {!slugOk && (
                      <p className="mt-1 text-[11px] text-rose-500">
                        Lowercase letters and numbers, separated by hyphens.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="font-mono text-[11px] font-medium uppercase tracking-wider text-stone-400">
                      Visibility
                    </label>
                    <div className="mt-1.5">
                      <VisibilityToggle value={visibility} onChange={setVisibility} />
                    </div>
                  </div>
                </>
              )}

              {preflight.warnings.length > 0 && (
                <label className="flex items-start gap-2 text-xs text-stone-600">
                  <input
                    type="checkbox"
                    checked={ackWarnings}
                    onChange={(e) => setAckWarnings(e.target.checked)}
                    className="mt-0.5 accent-orange-600"
                  />
                  Publish anyway with {preflight.warnings.length} warning
                  {preflight.warnings.length === 1 ? "" : "s"} outstanding.
                </label>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setReviewOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={busy === "publish" || needsAck || (firstPublish && !slugOk)}
                  onClick={() => void publish()}
                  data-ai-tool="publish-confirm"
                >
                  {busy === "publish" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Rocket className="size-3.5" />
                  )}
                  {firstPublish ? "Publish course" : `Publish v${(publication?.version ?? 0) + 1}`}
                </Button>
              </div>
            </div>
          )}
        </div>

        {justPublished && publication && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
            <Globe className="size-4 shrink-0" />
            <span>
              Version {publication.version} is live at{" "}
              <code className="font-mono">{publicCoursePath(publication.slug)}</code>.
            </span>
          </div>
        )}
        {(actionError ?? remoteError) && (
          <p className="mt-4 text-center text-xs text-rose-500">{actionError ?? remoteError}</p>
        )}

        {/* ── learner submissions (review + mark reviewed) ── */}
        {publication && (
          <div className="mt-8">
            <SubmissionsCard courseId={doc.id} />
          </div>
        )}
      </div>
    </div>
  );
}

function VisibilityToggle({
  value,
  onChange,
  busy,
}: {
  value: PublicationVisibility;
  onChange: (v: PublicationVisibility) => void;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center rounded-full border border-stone-200 p-0.5 text-xs">
      {(["public", "unlisted"] as const).map((v) => (
        <button
          key={v}
          type="button"
          disabled={busy}
          onClick={() => value !== v && onChange(v)}
          className={cn(
            "rounded-full px-3 py-1 capitalize transition-colors",
            value === v ? "bg-stone-900 font-medium text-white" : "text-stone-500 hover:text-stone-800"
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

function SlugEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  onSave: (slug: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const valid = isValidSlug(value);
  return (
    <div className="flex flex-1 items-center gap-2">
      <span className="font-mono text-xs text-stone-400">/learn/</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-2 py-1 font-mono text-xs text-stone-800 outline-none focus:border-brand-400"
        spellCheck={false}
        autoFocus
      />
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" disabled={!valid || busy || value === initial} onClick={() => onSave(value)}>
        {busy && <Loader2 className="size-3 animate-spin" />}
        Save
      </Button>
    </div>
  );
}
