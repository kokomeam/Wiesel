"use client";

/**
 * Voice profile sheet (PRD §9.5): view the derived profile, tune banned
 * phrases + sample posts (edits persist as source='creator_edited'), and
 * regenerate — with an explicit confirm when regenerating over hand edits.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import type { VoiceProfileRecord } from "@/lib/marketing/social/repository";
import type { SocialVoiceProfile } from "@/lib/marketing/social/schemas";
import { SocialApiError, socialApi } from "./api";

export function VoiceProfileSheet(props: {
  open: boolean;
  onClose: () => void;
  profile: VoiceProfileRecord | null;
  onProfile: (p: VoiceProfileRecord) => void;
  showToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<SocialVoiceProfile | null>(props.profile?.profile ?? null);
  const [banInput, setBanInput] = useState("");
  const [sampleInput, setSampleInput] = useState("");
  const [confirmRegen, setConfirmRegen] = useState(false);
  const fetchStarted = useRef(false);

  // Derived-reset (React 19 pattern — no setState-in-effect): when a new
  // profile version arrives, reset the editable draft during render.
  const versionKey = props.profile ? `${props.profile.id}:${props.profile.version}` : null;
  const [lastVersionKey, setLastVersionKey] = useState(versionKey);
  if (versionKey !== lastVersionKey) {
    setLastVersionKey(versionKey);
    setDraft(props.profile?.profile ?? null);
  }

  // Derive-on-open when no profile exists yet: the effect only STARTS the
  // fetch; all setState happens in async callbacks (lint-sanctioned).
  const needsLoad = props.open && !props.profile && !loadFailed;
  const { onProfile, showToast } = props;
  useEffect(() => {
    if (!needsLoad || fetchStarted.current) return;
    fetchStarted.current = true;
    socialApi
      .getVoiceProfile()
      .then((r) => onProfile(r.voiceProfile))
      .catch(() => {
        setLoadFailed(true);
        showToast("Couldn't load the voice profile.");
      })
      .finally(() => {
        fetchStarted.current = false;
      });
  }, [needsLoad, onProfile, showToast]);

  if (!props.open) return null;
  const loading = needsLoad;

  const record = props.profile;
  const p = draft;

  const saveEdits = async () => {
    if (!p) return;
    setBusy(true);
    try {
      const r = await socialApi.putVoiceProfile(p);
      props.onProfile(r.voiceProfile);
      props.showToast("Voice profile saved — every generation now reads it.");
    } catch (err) {
      props.showToast(err instanceof SocialApiError ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (confirm: boolean) => {
    setBusy(true);
    try {
      const r = await socialApi.regenerateVoiceProfile(confirm, p?.sampleExcerpts);
      props.onProfile(r.voiceProfile);
      setConfirmRegen(false);
      props.showToast("Voice profile re-derived from your courses.");
    } catch (err) {
      if (err instanceof SocialApiError && err.code === "needs_confirm") {
        setConfirmRegen(true);
      } else {
        props.showToast(err instanceof SocialApiError ? err.message : "Regeneration failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-900/30" onClick={props.onClose} role="dialog" aria-modal="true" aria-label="Voice profile">
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-stone-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="font-serif text-lg text-stone-900">Your voice, as WiseSel hears it</h2>
          <span className="flex-1" />
          <button type="button" onClick={props.onClose} aria-label="Close" className="rounded-full p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <X className="size-4" />
          </button>
        </div>

        {loading || !p || !record ? (
          <div className="flex items-center gap-2 py-10 text-sm text-stone-500">
            <Loader2 className="size-4 animate-spin" /> Deriving your voice from your courses…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone={record.source === "creator_edited" ? "amber" : "brand"}>
                v{record.version} · {record.source === "creator_edited" ? "hand-tuned" : "derived"}
              </Badge>
            </div>

            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">Style summary</div>
              <textarea
                className="w-full rounded-xl border border-stone-200 px-3 py-2 text-[12.5px] leading-relaxed"
                rows={4}
                value={p.summary}
                onChange={(e) => setDraft({ ...p, summary: e.target.value })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-[12px]">
              <label>
                <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-stone-400">Register</span>
                <input className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5" value={p.register} onChange={(e) => setDraft({ ...p, register: e.target.value })} />
              </label>
              <label>
                <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-stone-400">Sentences</span>
                <select className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5" value={p.sentenceLength} onChange={(e) => setDraft({ ...p, sentenceLength: e.target.value as SocialVoiceProfile["sentenceLength"] })}>
                  {["short", "medium", "long", "varied"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-stone-400">Emoji tolerance</span>
                <select className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5" value={p.emojiTolerance} onChange={(e) => setDraft({ ...p, emojiTolerance: e.target.value as SocialVoiceProfile["emojiTolerance"] })}>
                  {["none", "low", "medium", "high"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">Signature moves</div>
              <ul className="list-inside list-disc text-[12px] text-stone-600">
                {p.signatureMoves.map((m) => (
                  <li key={m}>{m}</li>
                ))}
                {p.signatureMoves.length === 0 && <li className="list-none text-stone-400">none noted yet</li>}
              </ul>
            </div>

            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">Banned phrases</div>
              <div className="flex flex-wrap gap-1.5">
                {p.bannedPhrases.map((b) => (
                  <span key={b} className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700">
                    &ldquo;{b}&rdquo;
                    <button type="button" aria-label={`Remove ${b}`} className="text-stone-400 hover:text-stone-700" onClick={() => setDraft({ ...p, bannedPhrases: p.bannedPhrases.filter((x) => x !== b) })}>
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="min-w-28 rounded-full border border-dashed border-stone-300 px-2.5 py-0.5 text-[11px] focus:outline-none"
                  placeholder="+ add phrase"
                  value={banInput}
                  onChange={(e) => setBanInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && banInput.trim()) {
                      setDraft({ ...p, bannedPhrases: [...p.bannedPhrases, banInput.trim()].slice(0, 20) });
                      setBanInput("");
                    }
                  }}
                />
              </div>
            </div>

            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">
                Sample posts (up to 3 — paste your own writing)
              </div>
              {p.sampleExcerpts.map((s, i) => (
                <div key={i} className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-1.5 text-[11.5px] text-stone-600">
                  <span className="flex-1 whitespace-pre-wrap">{s.slice(0, 240)}{s.length > 240 ? "…" : ""}</span>
                  <button type="button" aria-label="Remove sample" className="text-stone-400 hover:text-stone-700" onClick={() => setDraft({ ...p, sampleExcerpts: p.sampleExcerpts.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </div>
              ))}
              {p.sampleExcerpts.length < 3 && (
                <textarea
                  className="w-full rounded-lg border border-dashed border-stone-300 px-2.5 py-1.5 text-[11.5px]"
                  rows={2}
                  placeholder="Paste a post you've written that sounds like you, then press Enter…"
                  value={sampleInput}
                  onChange={(e) => setSampleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && sampleInput.trim()) {
                      e.preventDefault();
                      setDraft({ ...p, sampleExcerpts: [...p.sampleExcerpts, sampleInput.trim().slice(0, 1200)] });
                      setSampleInput("");
                    }
                  }}
                />
              )}
            </div>

            {confirmRegen && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
                You&apos;ve hand-edited this profile — regenerating will overwrite your edits.
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void regenerate(true)}>Overwrite &amp; regenerate</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRegen(false)}>Keep my edits</Button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-stone-200/70 pt-4">
              <Button disabled={busy} onClick={() => void saveEdits()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null} Save edits
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => void regenerate(false)}>
                <RefreshCw className="size-3.5" /> Regenerate from my courses
              </Button>
            </div>
            <p className="text-[11px] text-stone-400">
              This profile is injected into every generation and revision — it&apos;s what keeps posts sounding like you instead of like an AI.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
