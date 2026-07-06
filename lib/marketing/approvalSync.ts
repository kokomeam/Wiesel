"use client";

/**
 * Cross-surface approval/question resolution sync.
 *
 * The same pending action (or clarifying question) can be rendered on several
 * surfaces at once — the agent chat, the hub inbox, the campaign builder, the
 * leads page — each from its own snapshot or client state. The DB row is the
 * single source of truth, but nothing used to tell surface B that surface A
 * resolved it, so a stale, still-clickable card lingered until a manual
 * reload ("accepting on one just makes the other one stay there").
 *
 * This store is the missing invalidation channel:
 *   - every ApprovalCard/QuestionCard SUBSCRIBES by its actionId/questionId
 *     and collapses the moment a resolution lands, whoever resolved it;
 *   - resolving a card WRITES here (same tab, instantly) and mirrors over a
 *     BroadcastChannel (other tabs of the same origin);
 *   - a resolution can carry the agent's FOLLOW-UP (the resumed run's
 *     transcript) — the chat panel replays it so the wrap-up the agent is
 *     prompted to give is actually seen.
 *
 * Deliberately in-memory + broadcast only (no persistence): the server list
 * is authoritative on the next load; this store only heals the window where
 * two already-rendered surfaces disagree.
 */

import { create } from "zustand";
import type { AgentFollowUp } from "./agent/events";

export interface ActionResolution {
  /** "resolved" = handled on another surface, direction unknown (e.g. the
   *  double-click race loser) — collapse neutrally, never re-clickable. */
  decision: "approved" | "denied" | "resolved";
  message: string | null;
  /** The resumed agent run (agent-requested actions only) — replayed once by
   *  the chat panel. */
  followUp: AgentFollowUp | null;
}

export interface QuestionResolution {
  outcome: "answered" | "dismissed" | "resolved";
  /** The chosen option's label (answered only). */
  label: string | null;
  followUp: AgentFollowUp | null;
}

interface ApprovalSyncState {
  actions: Record<string, ActionResolution>;
  questions: Record<string, QuestionResolution>;
  markActionResolved: (actionId: string, res: ActionResolution) => void;
  markQuestionResolved: (questionId: string, res: QuestionResolution) => void;
  /** Apply a remote (other-tab) resolution — same merge, no re-broadcast. */
  applyRemote: (msg: SyncMessage) => void;
}

export type SyncMessage =
  | { source: typeof CHANNEL_SOURCE; kind: "action"; id: string; res: ActionResolution }
  | { source: typeof CHANNEL_SOURCE; kind: "question"; id: string; res: QuestionResolution };

const CHANNEL_SOURCE = "wisesel-marketing-approval-sync" as const;
export const APPROVAL_SYNC_CHANNEL = CHANNEL_SOURCE;

/** The minimal channel surface we use — BroadcastChannel satisfies it; tests
 *  inject a fake. */
export interface SyncChannelLike {
  postMessage(msg: SyncMessage): void;
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
}

let broadcast: ((msg: SyncMessage) => void) | null = null;

function isSyncMessage(data: unknown): data is SyncMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.source === CHANNEL_SOURCE && (d.kind === "action" || d.kind === "question") && typeof d.id === "string";
}

export const useApprovalSync = create<ApprovalSyncState>((set, get) => ({
  actions: {},
  questions: {},
  markActionResolved(actionId, res) {
    // First writer wins — a later, vaguer "resolved elsewhere" must not
    // overwrite a concrete approved/denied (which may carry a follow-up).
    if (get().actions[actionId]) return;
    set((s) => ({ actions: { ...s.actions, [actionId]: res } }));
    broadcast?.({ source: CHANNEL_SOURCE, kind: "action", id: actionId, res });
  },
  markQuestionResolved(questionId, res) {
    if (get().questions[questionId]) return;
    set((s) => ({ questions: { ...s.questions, [questionId]: res } }));
    broadcast?.({ source: CHANNEL_SOURCE, kind: "question", id: questionId, res });
  },
  applyRemote(msg) {
    if (msg.kind === "action") {
      if (get().actions[msg.id]) return;
      set((s) => ({ actions: { ...s.actions, [msg.id]: msg.res } }));
    } else {
      if (get().questions[msg.id]) return;
      set((s) => ({ questions: { ...s.questions, [msg.id]: msg.res } }));
    }
  },
}));

/** Wire a channel into the store (exported for tests; called once below with
 *  the real BroadcastChannel in the browser). */
export function connectApprovalSyncChannel(channel: SyncChannelLike): void {
  broadcast = (msg) => {
    try {
      channel.postMessage(msg);
    } catch {
      // a closed/failed channel must never break the resolution itself
    }
  };
  channel.addEventListener("message", (e) => {
    if (isSyncMessage(e.data)) useApprovalSync.getState().applyRemote(e.data);
  });
}

/** Reset hook state between test cases. */
export function resetApprovalSyncForTests(): void {
  broadcast = null;
  useApprovalSync.setState({ actions: {}, questions: {} });
}

if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  connectApprovalSyncChannel(new BroadcastChannel(CHANNEL_SOURCE));
}
