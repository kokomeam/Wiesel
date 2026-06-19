"use client";

/**
 * Transient (non-persisted) state for the docked AI agent: the live chat
 * transcript, per-turn tool cards, and the set of blocks with a PENDING change
 * (the editor-highlight source). Deliberately separate from uiStore — this
 * updates at streaming frequency and must never hit localStorage.
 *
 * Pending highlights survive a soft refresh (router.refresh keeps client
 * state) and a full reload (the studio server-loads them back via
 * getPendingBlocks → hydratePending).
 */

import { create } from "zustand";
import type { PlanOutline } from "@/lib/ai/events";

/** Which phase of the content pipeline the agent is in (drives the sidebar
 *  indicator). `null` for the single-turn edit path / when idle. */
export type AgentPhase = "plan" | "generate" | "validate" | "repair" | "review" | "critique" | null;

/** The latest VALIDATION status line (calm progress: "Checking coverage…",
 *  "Found 4 missing slides. Repairing…", "Final validation passed."). */
export interface ValidationStatus {
  message: string;
  ok: boolean;
  incomplete?: boolean;
}

/** Soft, optional quality findings surfaced after a generation (never blocking). */
export interface QualityReport {
  warnings: { code: string; message: string; slideId?: string }[];
  suggestions: { title: string; detail: string }[];
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
}

export interface AgentToolCard {
  toolCallId: string;
  tool: string;
  status: "running" | "done" | "error";
  summary?: string;
  blockId?: string;
}

export interface PendingChangeSet {
  id: string;
  count: number;
  summary?: string;
}

/** A destructive action the agent proposed and is PAUSED on, awaiting the
 *  user's confirm/cancel (echoed back to /api/ai/agent/confirm to resume). */
export interface PendingConfirmation {
  toolCallId: string;
  toolMessageId: string;
  kind: "module" | "lesson";
  label: string;
  patch: unknown;
}

/** A planned outline the agent is PAUSED on, awaiting the creator's approval
 *  (echoed back to /api/ai/agent/plan to resume). A single lesson's deck or a
 *  whole module. Transient. */
export type PendingOutline = PlanOutline;

interface AgentState {
  conversationId: string | null;
  messages: AgentChatMessage[];
  toolCards: AgentToolCard[];
  thinking: boolean;
  error: string | null;
  checkpoint: string | null;
  /** Set while the agent is paused awaiting confirmation of a destructive
   *  delete; drives the confirm popup. */
  pendingConfirmation: PendingConfirmation | null;
  /** Which pipeline phase the agent is in (sidebar indicator). */
  phase: AgentPhase;
  /** The latest validation status line for the in-flight generation. */
  validation: ValidationStatus | null;
  /** The latest soft quality report (lint + optional review suggestions). */
  qualityReport: QualityReport | null;
  /** Set while the agent is paused awaiting approval of a planned outline. */
  pendingOutline: PendingOutline | null;
  /** blockId → the pending change-set it belongs to (drives the highlight). */
  pendingBlocks: Record<string, { changeSetId: string }>;
  changeSets: Record<string, PendingChangeSet>;
  /** Block ids touched during the in-flight turn (bound to its change-set on
   *  the change_set event). */
  turnBlockIds: string[];
  /** Session preference: skip the PLAN approval pause and generate straight through. */
  autoApprovePlan: boolean;

  setConversation: (id: string) => void;
  setAutoApprovePlan: (v: boolean) => void;
  hydratePending: (blocks: { blockId: string; changeSetId: string }[]) => void;
  startTurn: (userText: string) => void;
  resumeTurn: () => void;
  appendAssistant: (delta: string) => void;
  addToolStart: (toolCallId: string, tool: string) => void;
  resolveTool: (toolCallId: string, ok: boolean, summary: string, blockId?: string) => void;
  registerChangeSet: (id: string, count: number, summary?: string) => void;
  setCheckpoint: (reason: string | null) => void;
  setPendingConfirmation: (c: PendingConfirmation | null) => void;
  setPhase: (phase: AgentPhase) => void;
  setValidation: (v: ValidationStatus | null) => void;
  setQualityReport: (q: QualityReport | null) => void;
  setPendingOutline: (o: PendingOutline | null) => void;
  finishTurn: (finalText: string) => void;
  setError: (msg: string | null) => void;
  clearChangeSet: (changeSetId: string) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  conversationId: null,
  messages: [],
  toolCards: [],
  thinking: false,
  error: null,
  checkpoint: null,
  pendingConfirmation: null,
  phase: null,
  validation: null,
  qualityReport: null,
  pendingOutline: null,
  pendingBlocks: {},
  changeSets: {},
  turnBlockIds: [],
  autoApprovePlan: false,

  setConversation: (id) => set({ conversationId: id }),

  setAutoApprovePlan: (v) => set({ autoApprovePlan: v }),

  hydratePending: (blocks) =>
    set(() => {
      const pendingBlocks: Record<string, { changeSetId: string }> = {};
      const changeSets: Record<string, PendingChangeSet> = {};
      for (const b of blocks) {
        pendingBlocks[b.blockId] = { changeSetId: b.changeSetId };
        changeSets[b.changeSetId] = changeSets[b.changeSetId] ?? {
          id: b.changeSetId,
          count: 0,
        };
        changeSets[b.changeSetId].count += 1;
      }
      return { pendingBlocks, changeSets };
    }),

  startTurn: (userText) =>
    set((s) => ({
      thinking: true,
      error: null,
      checkpoint: null,
      pendingConfirmation: null,
      phase: null,
      validation: null,
      qualityReport: null,
      pendingOutline: null,
      toolCards: [],
      turnBlockIds: [],
      messages: [
        ...s.messages,
        { id: crypto.randomUUID(), role: "user", text: userText, streaming: false },
        { id: crypto.randomUUID(), role: "assistant", text: "", streaming: true },
      ],
    })),

  /** Continue a turn the user paused at a confirmation: keep the transcript +
   *  tool cards, clear the pending confirmation, and open a fresh streaming
   *  assistant bubble for the agent's resumed reply. */
  resumeTurn: () =>
    set((s) => ({
      thinking: true,
      error: null,
      checkpoint: null,
      pendingConfirmation: null,
      pendingOutline: null,
      validation: null,
      qualityReport: null,
      turnBlockIds: [],
      messages: [
        ...s.messages,
        { id: crypto.randomUUID(), role: "assistant", text: "", streaming: true },
      ],
    })),

  appendAssistant: (delta) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        messages[messages.length - 1] = { ...last, text: last.text + delta };
      }
      return { messages };
    }),

  addToolStart: (toolCallId, tool) =>
    set((s) =>
      s.toolCards.some((c) => c.toolCallId === toolCallId)
        ? {}
        : { toolCards: [...s.toolCards, { toolCallId, tool, status: "running" }] }
    ),

  resolveTool: (toolCallId, ok, summary, blockId) =>
    set((s) => {
      const exists = s.toolCards.some((c) => c.toolCallId === toolCallId);
      const card: AgentToolCard = { toolCallId, tool: "", status: ok ? "done" : "error", summary, blockId };
      const toolCards = exists
        ? s.toolCards.map((c) =>
            c.toolCallId === toolCallId ? { ...c, status: card.status, summary, blockId } : c
          )
        : [...s.toolCards, { ...card, tool: summary }];
      const turnBlockIds = blockId && !s.turnBlockIds.includes(blockId)
        ? [...s.turnBlockIds, blockId]
        : s.turnBlockIds;
      return { toolCards, turnBlockIds };
    }),

  registerChangeSet: (id, count, summary) =>
    set((s) => {
      const pendingBlocks = { ...s.pendingBlocks };
      for (const blockId of s.turnBlockIds) pendingBlocks[blockId] = { changeSetId: id };
      return {
        changeSets: { ...s.changeSets, [id]: { id, count, summary } },
        pendingBlocks,
      };
    }),

  setCheckpoint: (reason) => set({ checkpoint: reason }),

  setPendingConfirmation: (c) => set({ pendingConfirmation: c }),

  setPhase: (phase) => set({ phase }),

  setValidation: (v) => set({ validation: v }),

  setQualityReport: (q) => set({ qualityReport: q }),

  setPendingOutline: (o) => set({ pendingOutline: o }),

  finishTurn: (finalText) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        messages[messages.length - 1] = {
          ...last,
          text: finalText.trim() ? finalText : last.text,
          streaming: false,
        };
      }
      // Don't drop the phase while paused for outline approval (the pipeline
      // resumes on approve); otherwise the turn is over → clear it.
      return { messages, thinking: false, phase: s.pendingOutline ? s.phase : null };
    }),

  setError: (msg) => set({ error: msg, thinking: false, phase: null }),

  clearChangeSet: (changeSetId) =>
    set((s) => {
      const pendingBlocks = Object.fromEntries(
        Object.entries(s.pendingBlocks).filter(([, v]) => v.changeSetId !== changeSetId)
      );
      const changeSets = { ...s.changeSets };
      delete changeSets[changeSetId];
      return { pendingBlocks, changeSets };
    }),
}));

/** True when a block has a pending agent change (editor highlight). */
export function usePendingChangeSetId(blockId: string): string | null {
  return useAgentStore((s) => s.pendingBlocks[blockId]?.changeSetId ?? null);
}
