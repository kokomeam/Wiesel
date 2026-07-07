"use client";

/**
 * Client fetch helpers for the Social Posts REST surface. One place for the
 * typed error shape (409 conflict / 429 rate-limit / 502 generation-failed),
 * the SSE reader for /generate, and the export-telemetry pings.
 */

import type { GenerateRequest, SocialPost } from "@/lib/marketing/social/schemas";
import type { SocialBatch, VoiceProfileRecord } from "@/lib/marketing/social/repository";

export class SocialApiError extends Error {
  status: number;
  code?: string;
  stage?: string;
  constructor(status: number, payload: { error?: string; code?: string; stage?: string }) {
    super(payload.error ?? `Request failed (${status})`);
    this.status = status;
    this.code = payload.code;
    this.stage = payload.stage;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new SocialApiError(res.status, payload);
  return payload as T;
}

export interface GenerateStreamEvent {
  type: "phase" | "draft" | "complete" | "error";
  data?: Record<string, unknown>;
}

/** POST /generate and iterate the SSE draft stream. */
export async function streamGenerate(
  body: Partial<GenerateRequest> & { courseId: string },
  idempotencyKey: string,
  onEvent: (e: GenerateStreamEvent) => void
): Promise<void> {
  const res = await fetch("/api/marketing/social-posts/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    throw new SocialApiError(res.status, payload);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (chunk.startsWith("data: ")) {
        try {
          onEvent(JSON.parse(chunk.slice(6)) as GenerateStreamEvent);
        } catch {
          // malformed frame — skip
        }
      }
    }
  }
}

export interface MutationResult {
  summary: string;
  data: unknown;
  actionId: string | null;
  revertExpiresAt: string | null;
}

export const socialApi = {
  getPost: (id: string) => request<{ post: SocialPost }>(`/api/marketing/social-posts/${id}`),
  list: (params: Record<string, string>) =>
    request<{ posts: SocialPost[]; nextCursor: string | null; batches?: SocialBatch[] }>(
      `/api/marketing/social-posts?${new URLSearchParams(params)}`
    ),
  patch: (id: string, body: Record<string, unknown>) =>
    request<{ summary: string; post: unknown; actionId: string | null }>(
      `/api/marketing/social-posts/${id}`,
      { method: "PATCH", body: JSON.stringify(body) }
    ),
  softDelete: (id: string) =>
    request<{ summary: string }>(`/api/marketing/social-posts/${id}`, { method: "DELETE" }),
  revise: (id: string, expectedVersion: number, instruction: string) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/revise`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, instruction }),
    }),
  tone: (id: string, expectedVersion: number, targetTone: string) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/tone`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, targetTone }),
    }),
  regenerate: (id: string, expectedVersion: number) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    }),
  variants: (id: string, n: number) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/variants`, {
      method: "POST",
      body: JSON.stringify({ n }),
    }),
  rewrite: (id: string, targetPlatform: string) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/rewrite`, {
      method: "POST",
      body: JSON.stringify({ targetPlatform }),
    }),
  status: (id: string, status: string) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  performance: (id: string, metrics: Record<string, unknown>) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/performance`, {
      method: "POST",
      body: JSON.stringify(metrics),
    }),
  attachImage: (id: string, storagePath: string, altText: string | null) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/image`, {
      method: "POST",
      body: JSON.stringify({ storagePath, altText }),
    }),
  removeImage: (id: string) =>
    request<MutationResult>(`/api/marketing/social-posts/${id}/image`, { method: "DELETE" }),
  suggestHashtags: (id: string) =>
    request<{ summary: string; data: { hashtags: string[] } }>(
      `/api/marketing/social-posts/${id}/hashtags`,
      { method: "POST" }
    ),
  draftAltText: (id: string) =>
    request<{ summary: string; data: { altText: string } }>(
      `/api/marketing/social-posts/${id}/alt-text`,
      { method: "POST" }
    ),
  track: (id: string, what: "copied" | "downloaded", format?: string) =>
    request<{ ok: boolean }>(`/api/marketing/social-posts/${id}/track`, {
      method: "POST",
      body: JSON.stringify({ what, format }),
    }).catch(() => ({ ok: false })), // telemetry never blocks the action
  getVoiceProfile: () =>
    request<{ voiceProfile: VoiceProfileRecord }>(`/api/marketing/social-voice-profile`),
  putVoiceProfile: (profile: unknown) =>
    request<{ voiceProfile: VoiceProfileRecord }>(`/api/marketing/social-voice-profile`, {
      method: "PUT",
      body: JSON.stringify({ profile }),
    }),
  regenerateVoiceProfile: (confirm: boolean, samples?: string[]) =>
    request<{ voiceProfile: VoiceProfileRecord }>(`/api/marketing/social-voice-profile/regenerate`, {
      method: "POST",
      body: JSON.stringify({ confirm, samples }),
    }),
};
