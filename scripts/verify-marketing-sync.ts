/**
 * verify:marketing:sync — the cross-surface approval/question sync layer +
 * lifecycle-control invariants. PURE (no Supabase, no key, no browser):
 *
 *   A. followUpFromEvents — folding a captured resume-run event stream into
 *      the replayable follow-up (delta accumulation, assistant_message dedupe,
 *      ordering around tool results, nested blockers, paused flag).
 *   B. approvalSync store — first-writer-wins resolutions, question map,
 *      channel broadcast + remote apply + garbage rejection.
 *   C. Lifecycle tool registry — pause/resume for campaigns AND sequences
 *      exist with the right grades; cancel stays hard-denied; the system
 *      prompt actually teaches the stopping capability.
 *
 * Run: npm run verify:marketing:sync
 */

import { followUpFromEvents, type MarketingAgentEvent } from "@/lib/marketing/agent/events";
import {
  connectApprovalSyncChannel,
  resetApprovalSyncForTests,
  useApprovalSync,
  type SyncChannelLike,
  type SyncMessage,
} from "@/lib/marketing/approvalSync";
import { buildMarketingSystemPrompt } from "@/lib/marketing/agent/prompt";
import { HARD_DENY_TOOLS } from "@/lib/marketing/autonomy";
import { ALL_MARKETING_TOOLS, getMarketingTool } from "@/lib/marketing/tools";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/* ───────────────────────── A. followUpFromEvents ───────────────────────── */

console.log("# A · followUpFromEvents (pure fold of the resume-run stream)");

{
  const events: MarketingAgentEvent[] = [
    { type: "conversation", conversationId: "conv-1" },
    { type: "observation", summary: "Funnel: 10 views · 2 leads" },
    { type: "assistant_delta", text: "Launch confirmed — " },
    { type: "assistant_delta", text: "4 people enrolled." },
    { type: "tool_start", toolCallId: "c1", tool: "get_analytics_summary" },
    { type: "tool_result", toolCallId: "c1", tool: "get_analytics_summary", ok: true, summary: "Summary read.", status: "read" },
    { type: "assistant_delta", text: "Sends go out 9–11 UTC weekdays." },
    { type: "done", paused: false },
  ];
  const fu = followUpFromEvents(events);
  check("captures the conversation id", fu.conversationId === "conv-1");
  check("not paused on a clean finish", fu.paused === false);
  check("observation is first", fu.items[0]?.kind === "observation");
  check(
    "deltas accumulate into ONE assistant item per segment",
    fu.items[1]?.kind === "assistant" && fu.items[1].text === "Launch confirmed — 4 people enrolled.",
    JSON.stringify(fu.items)
  );
  check("tool result lands AFTER the text that preceded it", fu.items[2]?.kind === "tool" && fu.items[2].tool === "get_analytics_summary");
  check(
    "post-tool deltas become a second assistant item",
    fu.items[3]?.kind === "assistant" && fu.items[3].text.includes("9–11 UTC"),
    JSON.stringify(fu.items[3])
  );
  check("tool_start itself carries nothing", fu.items.every((i) => i.kind !== ("tool_start" as never)));
}

{
  // assistant_message when deltas already streamed the same text → deduped
  const fu = followUpFromEvents([
    { type: "assistant_delta", text: "All done." },
    { type: "assistant_message", content: "All done." },
    { type: "done", paused: false },
  ]);
  check(
    "assistant_message deduped when deltas carried the text",
    fu.items.filter((i) => i.kind === "assistant").length === 1,
    JSON.stringify(fu.items)
  );
}

{
  // assistant_message with NO deltas (a client that doesn't stream) → kept
  const fu = followUpFromEvents([
    { type: "assistant_message", content: "Non-streaming final answer." },
    { type: "done", paused: false },
  ]);
  check(
    "assistant_message kept when no deltas streamed",
    fu.items.length === 1 && fu.items[0].kind === "assistant" && fu.items[0].text === "Non-streaming final answer."
  );
}

{
  // the resume paused AGAIN — a nested approval must ride the follow-up
  const fu = followUpFromEvents([
    { type: "conversation", conversationId: "conv-2" },
    { type: "assistant_delta", text: "Next I need a send." },
    {
      type: "agent_blocked",
      kind: "approval",
      tool: "send_broadcast",
      summary: "Send to 12 people",
      actionId: "act-9",
      preview: { audience: 12 },
    },
    { type: "done", paused: true },
  ]);
  check("nested approval becomes an approval item", fu.items.some((i) => i.kind === "approval" && i.actionId === "act-9"));
  check("paused flag survives", fu.paused === true);
  const approvalIdx = fu.items.findIndex((i) => i.kind === "approval");
  check("text before the blocker is flushed first", fu.items[approvalIdx - 1]?.kind === "assistant");
}

{
  const fu = followUpFromEvents([
    {
      type: "agent_blocked",
      kind: "question",
      tool: "ask_creator",
      summary: "Which list?",
      questionId: "q-1",
      question: { question: "Which list?", options: [{ label: "A", value: "a", description: null }] },
    },
    { type: "error", message: "boom" },
    { type: "done", paused: true },
  ]);
  check("nested question becomes a question item", fu.items.some((i) => i.kind === "question" && i.questionId === "q-1"));
  check("errors ride through", fu.items.some((i) => i.kind === "error" && i.text === "boom"));
}

check("empty stream folds to an empty follow-up", followUpFromEvents([]).items.length === 0);

/* ─────────────────────────── B. approvalSync store ─────────────────────── */

console.log("\n# B · approvalSync store (cross-surface resolution fan-out)");

{
  resetApprovalSyncForTests();
  const sent: SyncMessage[] = [];
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const fakeChannel: SyncChannelLike = {
    postMessage: (m) => sent.push(m),
    addEventListener: (_t, cb) => listeners.push(cb),
  };
  connectApprovalSyncChannel(fakeChannel);

  useApprovalSync.getState().markActionResolved("act-1", { decision: "approved", message: "Approved.", followUp: null });
  check("resolution lands in the store", useApprovalSync.getState().actions["act-1"]?.decision === "approved");
  check("resolution broadcasts to the channel", sent.length === 1 && sent[0].kind === "action" && sent[0].id === "act-1");

  // first-writer-wins: a later vaguer "resolved" must not clobber "approved"
  useApprovalSync.getState().markActionResolved("act-1", { decision: "resolved", message: null, followUp: null });
  check("first writer wins (no overwrite)", useApprovalSync.getState().actions["act-1"]?.decision === "approved");
  check("the losing write does NOT re-broadcast", sent.length === 1);

  // remote apply (another tab resolved act-2)
  listeners.forEach((cb) =>
    cb({
      data: {
        source: "wisesel-marketing-approval-sync",
        kind: "action",
        id: "act-2",
        res: { decision: "denied", message: "Denied.", followUp: null },
      },
    })
  );
  check("remote resolution applies", useApprovalSync.getState().actions["act-2"]?.decision === "denied");
  check("remote apply does not re-broadcast (no loop)", sent.length === 1);

  // garbage on the channel is ignored
  listeners.forEach((cb) => cb({ data: { hello: "world" } }));
  listeners.forEach((cb) => cb({ data: null }));
  listeners.forEach((cb) => cb({ data: "str" }));
  check("garbage messages are ignored", Object.keys(useApprovalSync.getState().actions).length === 2);

  // questions map
  useApprovalSync.getState().markQuestionResolved("q-1", { outcome: "answered", label: "List A", followUp: null });
  check("question resolution lands", useApprovalSync.getState().questions["q-1"]?.label === "List A");
  check("question resolution broadcasts", sent.some((m) => m.kind === "question" && m.id === "q-1"));
  useApprovalSync.getState().markQuestionResolved("q-1", { outcome: "dismissed", label: null, followUp: null });
  check("question first-writer-wins", useApprovalSync.getState().questions["q-1"]?.outcome === "answered");

  // a follow-up rides the resolution (the chat replays it)
  useApprovalSync.getState().markActionResolved("act-3", {
    decision: "approved",
    message: "Approved.",
    followUp: { conversationId: "conv-9", paused: false, items: [{ kind: "assistant", text: "Wrapped up." }] },
  });
  const fu = useApprovalSync.getState().actions["act-3"]?.followUp;
  check("follow-up rides the resolution", fu?.items[0]?.kind === "assistant");
  const broadcastFu = sent.find((m) => m.kind === "action" && m.id === "act-3");
  check(
    "follow-up rides the broadcast too (other tabs replay it)",
    broadcastFu?.kind === "action" && broadcastFu.res.followUp?.conversationId === "conv-9"
  );
  resetApprovalSyncForTests();
}

/* ─────────────────── C. lifecycle tools + prompt teaching ──────────────── */

console.log("\n# C · lifecycle controls — registry grades + prompt teaching");

{
  const byName = new Map(ALL_MARKETING_TOOLS.map((t) => [t.name, t]));
  const pauseSeq = byName.get("pause_sequence");
  const resumeSeq = byName.get("resume_sequence");
  check("pause_sequence is registered", !!pauseSeq);
  check("resume_sequence is registered", !!resumeSeq);
  check("pause_sequence is REVERSIBLE (no approval friction)", pauseSeq?.reversibility === "reversible");
  check("resume_sequence is REVERSIBLE", resumeSeq?.reversibility === "reversible");
  check(
    "pause_sequence snapshots the sequence (revertable)",
    typeof pauseSeq?.existingTarget === "function"
  );
  check("pause_campaign stays reversible", getMarketingTool("pause_campaign")?.reversibility === "reversible");
  check("resume_campaign stays reversible", getMarketingTool("resume_campaign")?.reversibility === "reversible");
  check("cancel_campaign stays irreversible", getMarketingTool("cancel_campaign")?.reversibility === "irreversible");
  check("cancel_campaign stays HARD-DENIED from auto-approval", HARD_DENY_TOOLS.has("cancel_campaign"));
  check("pause tools are NOT hard-denied (they must never card)", !HARD_DENY_TOOLS.has("pause_campaign") && !HARD_DENY_TOOLS.has("pause_sequence"));

  const prompt = buildMarketingSystemPrompt();
  check("prompt teaches STOPPING THINGS", prompt.includes("STOPPING THINGS"));
  check("prompt names pause_campaign + pause_sequence", prompt.includes("pause_campaign") && prompt.includes("pause_sequence"));
  check("prompt marks cancel as permanent + approval-gated", prompt.includes("cancel_campaign") && prompt.includes("PERMANENTLY"));
  check("prompt tells the agent held sends are kept", prompt.includes("held sends are kept, not lost"));
  check(
    "cancel tool description points at pause for the undoable stop",
    (getMarketingTool("cancel_campaign")?.description ?? "").includes("pause_campaign")
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
