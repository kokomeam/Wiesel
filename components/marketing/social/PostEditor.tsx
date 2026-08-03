"use client";

/**
 * The post editor (PRD §11): manual editing with live counters against
 * PLATFORM_LIMITS (imported, never duplicated), AI edit actions, hashtag chip
 * input with per-platform range warnings, planned-time picker, status
 * lifecycle, image upload/preview/replace/remove with a prominent alt-text
 * field, export cluster (copy / copy hashtags / .txt / .md — each fires its
 * telemetry event), the performance log form on posted_manual posts, and the
 * pinned manual-publish notice. Saves are versioned; 409s resolve by re-read
 * + one re-apply (SocialPostsView.savePatch).
 */

import { useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  Clipboard,
  Download,
  Hash,
  History,
  ImagePlus,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import {
  IMAGE_MAX_BYTES,
  PLATFORM_LIMITS,
  platformLimitsFor,
  SOCIAL_IMAGES_BUCKET,
  type SocialPostStatus,
} from "@/lib/marketing/social/constants";
import {
  buildCopyText,
  buildHashtagText,
  buildMdExport,
  buildTxtExport,
  exportFileName,
} from "@/lib/marketing/social/exportText";
import type { SocialPost } from "@/lib/marketing/social/schemas";
import { ManualPublishNotice } from "./ManualPublishNotice";
import { ConnectedScheduler } from "./connected/ConnectedScheduler";
import type { PublishState } from "./connected/PublishStates";
import { StageChip } from "./StageChip";
import { STATUS_LABELS, StatusPill } from "./PostQueue";
import { SocialApiError, socialApi } from "./api";

function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PostEditor(props: {
  post: SocialPost;
  courseId: string;
  onClose: () => void;
  onSaved: (post: SocialPost) => void;
  savePatch: (post: SocialPost, patch: Record<string, unknown>) => Promise<void>;
  onQueueChanged: () => Promise<void>;
  showToast: (m: string) => void;
  /** M-D: connected-publish affordances (allowlisted vocabulary lives in
   *  ./connected/*; this file's own copy stays Phase-1). */
  publishState?: PublishState | null;
  onPublishChanged?: () => void;
}) {
  const { post } = props;
  const limits = platformLimitsFor(post.platform);

  const [body, setBody] = useState(post.body);
  const [cta, setCta] = useState(post.cta ?? "");
  const [hashtags, setHashtags] = useState<string[]>(post.hashtags);
  const [tagInput, setTagInput] = useState("");
  const [altText, setAltText] = useState(post.imageAltText ?? "");
  const [planned, setPlanned] = useState(isoToLocalInput(post.plannedPostAt));
  const [busy, setBusy] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const words = useMemo(() => body.split(/\s+/).filter(Boolean).length, [body]);
  const outsideTarget = words > 0 && (words < limits.targetWords[0] || words > limits.targetWords[1]);
  const overCap = body.length > limits.charCap;
  const overTags = hashtags.length > limits.hashtagMax;

  const dirty =
    body !== post.body ||
    cta !== (post.cta ?? "") ||
    hashtags.join("\u0000") !== post.hashtags.join("\u0000") ||
    altText !== (post.imageAltText ?? "") ||
    planned !== isoToLocalInput(post.plannedPostAt);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      props.showToast(err instanceof SocialApiError ? err.message : "Something went wrong — nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  const refetch = async () => {
    const { post: fresh } = await socialApi.getPost(post.id);
    props.onSaved(fresh);
  };

  const save = () =>
    run("save", async () => {
      await props.savePatch(post, {
        body,
        cta: cta || null,
        hashtags,
        imageAltText: altText || null,
        plannedPostAt: planned ? new Date(planned).toISOString() : null,
        clearNulls: true,
      });
      props.showToast("Saved.");
    });

  const aiAction = (label: string, fn: () => Promise<unknown>) =>
    run(label, async () => {
      await fn();
      await refetch();
      await props.onQueueChanged();
      props.showToast("Done — the revision is in the revert log if you want it back.");
    });

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/[^\p{L}\p{N}_#]/gu, "");
    if (!t) return;
    const tag = t.startsWith("#") ? t : `#${t}`;
    if (!hashtags.includes(tag)) setHashtags([...hashtags, tag]);
    setTagInput("");
  };

  const copy = async (what: "body" | "hashtags") => {
    const text = what === "body" ? buildCopyText({ body, cta: cta || null }) : buildHashtagText({ hashtags });
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1600);
    void socialApi.track(post.id, "copied", what === "hashtags" ? "hashtags" : "body");
    props.showToast(what === "body" ? "Post copied — paste it on the platform." : "Hashtags copied.");
  };

  const download = (format: "txt" | "md") => {
    const exportable = {
      id: post.id,
      platform: post.platform,
      funnelStage: post.funnelStage,
      status: post.status,
      body,
      cta: cta || null,
      hashtags,
      plannedPostAt: planned ? new Date(planned).toISOString() : null,
    };
    const content = format === "txt" ? buildTxtExport(exportable) : buildMdExport(exportable);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = exportFileName(exportable, format);
    a.click();
    URL.revokeObjectURL(a.href);
    void socialApi.track(post.id, "downloaded", format);
  };

  const upload = (file: File) =>
    run("image", async () => {
      if (file.size > IMAGE_MAX_BYTES) throw new SocialApiError(400, { error: "That image is over 10MB." });
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        throw new SocialApiError(400, { error: "Use a JPEG, PNG, or WebP image." });
      }
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new SocialApiError(401, { error: "Signed out — sign in again." });
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
      const path = `${user.id}/social/${post.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from(SOCIAL_IMAGES_BUCKET).upload(path, file, {
        contentType: file.type,
      });
      if (error) throw new SocialApiError(500, { error: `Upload failed: ${error.message} — the post is unchanged.` });
      const result = await socialApi.attachImage(post.id, path, altText || null);
      const data = result.data as { warning?: string | null } | null;
      if (data?.warning) props.showToast(data.warning);
      await refetch();
    });

  const otherPlatform = post.platform === "linkedin" ? "facebook" : "linkedin";

  return (
    <div className="h-fit rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div className="flex items-center gap-2 border-b border-stone-200/70 px-4 py-3">
        <span className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone-600">
          {limits.label}
        </span>
        <StageChip stage={post.funnelStage} />
        <StatusPill status={post.status} />
        <span className="font-mono text-[10px] text-stone-400">v{post.version}</span>
        <span className="flex-1" />
        <a
          href={`/marketing?course=${props.courseId}#activity`}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-800"
          title="Every AI change is revertable from the marketing activity log"
        >
          <History className="size-3.5" /> History
        </a>
        <button type="button" onClick={props.onClose} className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" aria-label="Close editor">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="post-body" className="font-mono text-[10px] uppercase tracking-wider text-stone-400">
              Body
            </label>
            <span className={cn("font-mono text-[10px]", overCap ? "text-rose-600" : outsideTarget ? "text-amber-600" : "text-stone-400")}>
              {words} words · {body.length.toLocaleString()} / {limits.charCap.toLocaleString()} chars · target {limits.targetWords[0]}–{limits.targetWords[1]} words
              {overCap ? " — over the cap" : outsideTarget ? " — outside target" : " ✓"}
            </span>
          </div>
          <textarea
            id="post-body"
            className="w-full rounded-xl border border-stone-200 bg-[#fdfdfc] px-3.5 py-3 text-[13px] leading-relaxed text-stone-800 focus:border-brand-300 focus:outline-none"
            rows={9}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="post-cta" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone-400">
            CTA <span className="normal-case tracking-normal">(optional — tofu posts usually go soft or none)</span>
          </label>
          <input
            id="post-cta"
            className="w-full rounded-xl border border-stone-200 px-3.5 py-2 text-[13px] text-stone-800 focus:border-brand-300 focus:outline-none"
            maxLength={200}
            value={cta}
            onChange={(e) => setCta(e.target.value)}
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="post-tags" className="font-mono text-[10px] uppercase tracking-wider text-stone-400">
              Hashtags
            </label>
            <span className={cn("font-mono text-[10px]", overTags ? "text-rose-600" : "text-stone-400")}>
              {hashtags.length} / {limits.hashtagMax} max
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-stone-200 px-2.5 py-2">
            {hashtags.map((h) => (
              <span key={h} className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700">
                {h}
                <button type="button" aria-label={`Remove ${h}`} onClick={() => setHashtags(hashtags.filter((x) => x !== h))} className="text-stone-400 hover:text-stone-700">
                  ×
                </button>
              </span>
            ))}
            <input
              id="post-tags"
              className="min-w-24 flex-1 border-none bg-transparent px-1 text-[12px] focus:outline-none"
              placeholder="add…"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " " || e.key === ",") {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
              onBlur={() => addTag(tagInput)}
            />
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-2 py-0.5 text-[11px] text-stone-500 hover:border-stone-300"
              onClick={() =>
                run("hashtags", async () => {
                  const r = await socialApi.suggestHashtags(post.id);
                  setSuggestions(r.data.hashtags);
                })
              }
            >
              <Hash className="size-3" /> Suggest
            </button>
          </div>
          {suggestions && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-stone-400">Suggested:</span>
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-brand-800 hover:border-brand-300"
                  onClick={() => {
                    if (!hashtags.includes(s)) setHashtags([...hashtags, s]);
                  }}
                >
                  {s} +
                </button>
              ))}
              <button type="button" className="text-stone-400 hover:text-stone-600" onClick={() => setSuggestions(null)}>
                dismiss
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="post-planned" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone-400">
              Planned post time <span className="normal-case tracking-normal">(a label for your plan — nothing fires)</span>
            </label>
            <input
              id="post-planned"
              type="datetime-local"
              className="rounded-xl border border-stone-200 px-3 py-1.5 text-[12px] text-stone-700"
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="post-status" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone-400">
              Status
            </label>
            <select
              id="post-status"
              className="rounded-xl border border-stone-200 bg-white px-3 py-1.5 text-[12px] text-stone-700"
              value={post.status}
              onChange={(e) =>
                run("status", async () => {
                  await socialApi.status(post.id, e.target.value);
                  await refetch();
                  await props.onQueueChanged();
                  if (e.target.value === "posted_manual") {
                    props.showToast("Marked posted manually — you can log performance below.");
                  }
                })
              }
            >
              {(Object.keys(STATUS_LABELS) as SocialPostStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          {post.postedManuallyAt && (
            <span className="pb-1.5 font-mono text-[10px] text-stone-400">
              posted · {new Date(post.postedManuallyAt).toLocaleString()}
            </span>
          )}
        </div>

        {/* AI edit actions */}
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-stone-400">
            <Sparkles className="size-3 text-brand-600" /> AI edit actions
            {busy && <Loader2 className="size-3 animate-spin text-brand-600" />}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "Make shorter", fn: () => socialApi.revise(post.id, post.version, "Make it noticeably shorter while keeping the strongest hook and the concrete course detail.") },
              { label: "More professional", fn: () => socialApi.tone(post.id, post.version, "professional") },
              { label: "More casual", fn: () => socialApi.tone(post.id, post.version, "casual") },
              { label: "Stronger CTA", fn: () => socialApi.revise(post.id, post.version, "Give it a stronger, clearer call to action appropriate to its funnel stage.") },
              { label: "Fresh take", fn: () => socialApi.regenerate(post.id, post.version) },
              { label: "3 variants", fn: () => socialApi.variants(post.id, 3) },
              { label: `Rewrite for ${PLATFORM_LIMITS[otherPlatform].label}`, fn: () => socialApi.rewrite(post.id, otherPlatform) },
            ].map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={busy !== null || dirty}
                title={dirty ? "Save your manual edits first" : undefined}
                onClick={() => aiAction(a.label, a.fn)}
                className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-[11.5px] font-medium text-stone-600 transition-colors hover:border-brand-300 hover:text-brand-800 disabled:opacity-50"
              >
                {a.label}
              </button>
            ))}
          </div>
          {dirty && <p className="mt-1 text-[10.5px] text-stone-400">Save your manual edits first — AI actions work on the saved version.</p>}
        </div>

        {/* Image */}
        <div className="rounded-xl border border-stone-200 p-3.5">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-stone-400">Image (yours — never generated)</div>
          <div className="flex flex-wrap items-start gap-3.5">
            {post.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-TTL signed URL; a remote-image loader config isn't wanted for this
              <img src={post.imageUrl} alt={altText || "Attached image"} className="h-24 w-36 rounded-lg border border-stone-200 object-cover" />
            ) : (
              <div className="flex h-24 w-36 items-center justify-center rounded-lg border border-dashed border-stone-300 bg-stone-50 text-stone-400">
                <ImagePlus className="size-5" />
              </div>
            )}
            <div className="min-w-56 flex-1 space-y-2">
              {post.suggestedImageIdea && (
                <p className="text-[11.5px] text-stone-500">
                  <span className="text-stone-400">Idea:</span> {post.suggestedImageIdea}
                </p>
              )}
              <div>
                <label htmlFor="post-alt" className="mb-0.5 block text-[10.5px] font-medium text-stone-500">
                  Alt text <span className="font-normal text-stone-400">(accessibility + platform best practice)</span>
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="post-alt"
                    className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-[12px]"
                    maxLength={500}
                    value={altText}
                    onChange={(e) => setAltText(e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run("alt", async () => {
                        const r = await socialApi.draftAltText(post.id);
                        setAltText(r.data.altText);
                      })
                    }
                  >
                    Draft it
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void upload(f);
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
                  {post.imageStoragePath ? "Replace" : "Upload"}
                </Button>
                {post.imageStoragePath && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        run("image", async () => {
                          await socialApi.removeImage(post.id);
                          await refetch();
                        })
                      }
                    >
                      Remove
                    </Button>
                    {post.imageUrl && (
                      <a href={post.imageUrl} download className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-stone-600 hover:bg-stone-900/[0.06]" onClick={() => void socialApi.track(post.id, "downloaded", "image")}>
                        <Download className="size-3.5" /> Download
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Performance log — posted_manual only */}
        {post.status === "posted_manual" && (
          <PerformanceForm post={post} onLogged={refetch} run={run} showToast={props.showToast} />
        )}

        {/* Save + export cluster */}
        <div className="flex flex-wrap items-center gap-2 border-t border-stone-200/70 pt-4">
          <Button disabled={busy !== null || !dirty || overCap} onClick={save}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
          </Button>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => void copy("body")}>
            <Clipboard className="size-3.5" /> {copied === "body" ? "Copied!" : "Copy post"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void copy("hashtags")}>
            {copied === "hashtags" ? "Copied!" : "Copy hashtags"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => download("txt")}>
            <Download className="size-3.5" /> .txt
          </Button>
          <Button variant="ghost" size="sm" onClick={() => download("md")}>
            <Download className="size-3.5" /> .md
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
            disabled={busy !== null}
            onClick={() =>
              run("archive", async () => {
                await socialApi.softDelete(post.id);
                await props.onQueueChanged();
                props.onClose();
                props.showToast("Archived — recoverable from the revert log.");
              })
            }
          >
            {post.status === "archived" ? <Trash2 className="size-3.5" /> : <Archive className="size-3.5" />} Archive
          </Button>
        </div>

        <ConnectedScheduler
          post={{ id: post.id, platform: post.platform, postType: post.postType }}
          state={props.publishState ?? null}
          onChanged={() => props.onPublishChanged?.()}
          showToast={props.showToast}
        />
        {/* The Phase-1 notice (bytes unchanged — AC-MD.5) renders only when
            no connected affordance applies; beside a live publish control its
            "never publishes" claim would contradict the surface. */}
        {!(post.platform === "linkedin" || post.platform === "youtube_shorts") && (
          <ManualPublishNotice />
        )}
      </div>
    </div>
  );
}

function PerformanceForm(props: {
  post: SocialPost;
  onLogged: () => Promise<void>;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  showToast: (m: string) => void;
}) {
  const existing = props.post.performance;
  const [qualitative, setQualitative] = useState<string | null>(existing?.qualitative ?? null);
  const [metrics, setMetrics] = useState<Record<string, string>>({
    impressions: existing?.impressions?.toString() ?? "",
    likes: existing?.likes?.toString() ?? "",
    comments: existing?.comments?.toString() ?? "",
    shares: existing?.shares?.toString() ?? "",
    clicks: existing?.clicks?.toString() ?? "",
  });
  const anySignal = qualitative !== null || Object.values(metrics).some((v) => v.trim() !== "");

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5">
      <div className="mb-1 text-[12.5px] font-semibold text-stone-800">How did this post do?</div>
      <p className="mb-2.5 text-[11px] text-stone-500">
        Log whatever you have — a gut call is enough. It trains future generation; nothing else happens now.
      </p>
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {(["flop", "ok", "good", "viral"] as const).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setQualitative(qualitative === q ? null : q)}
            className={cn(
              "rounded-full border px-3 py-1 text-[11.5px] font-medium capitalize",
              qualitative === q
                ? "border-emerald-400 bg-emerald-100 text-emerald-800"
                : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
            )}
          >
            {q}
          </button>
        ))}
      </div>
      <div className="mb-2.5 flex flex-wrap gap-2">
        {(["impressions", "likes", "comments", "shares", "clicks"] as const).map((k) => (
          <label key={k} className="text-[10.5px] text-stone-500">
            <span className="mb-0.5 block capitalize">{k}</span>
            <input
              type="number"
              min={0}
              className="w-24 rounded-lg border border-stone-200 px-2 py-1 text-[12px]"
              value={metrics[k]}
              onChange={(e) => setMetrics({ ...metrics, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={!anySignal}
        onClick={() =>
          props.run("performance", async () => {
            const payload: Record<string, unknown> = { qualitative };
            for (const [k, v] of Object.entries(metrics)) {
              payload[k] = v.trim() === "" ? null : Number(v);
            }
            await socialApi.performance(props.post.id, payload);
            await props.onLogged();
            props.showToast("Performance logged.");
          })
        }
      >
        Save log
      </Button>
    </div>
  );
}
