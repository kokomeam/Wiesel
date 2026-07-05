/**
 * ask_creator — the clarifying-question tool (modeled on Claude Code's own
 * AskUserQuestion): ONE specific multiple-choice question the agent genuinely
 * can't proceed without (which list, which sender identity, which segment).
 *
 * It is an INTERACTION tool, not a mutation: `interaction: "question"` makes
 * the gate intercept it before grade routing — the gate records a
 * marketing_question row and returns `needs_clarification`, which pauses the
 * loop through the SAME blocked branch a pending approval uses. `execute`
 * never runs. The creator's answer resumes the conversation via
 * resumeAgentAfterAnswer.
 *
 * Deliberately narrow: 2–5 options, one question, no free-form prompts — the
 * agent asks when blocked, it does not chat through this tool. The gate ALSO
 * raises questions of this exact shape itself (tool.clarifyTargeting) when an
 * irreversible tool arrives with ambiguous targeting, so the creator sees one
 * consistent question surface whichever side noticed the gap.
 */

import { z } from "zod";
import { defineMarketingTool, MarketingToolError } from "./types";

export const askTools = [
  defineMarketingTool({
    name: "ask_creator",
    description:
      "Ask the creator ONE specific multiple-choice question (2–5 options) when you genuinely cannot proceed without their answer — e.g. which lead list, which sender identity, which segment. This PAUSES the run until they answer. Never use it to confirm an approval (the gate handles approvals) or for open-ended discussion (just reply in text for that).",
    params: z.object({
      question: z.string().min(1).max(200).describe("The one specific question, e.g. 'Which lead list should this campaign use?'"),
      options: z
        .array(
          z.object({
            label: z.string().min(1).max(80).describe("Short display label, e.g. 'Spring launch list (214 contacts)'"),
            value: z.string().min(1).max(120).describe("The machine value you need back, e.g. the list id or segment key"),
            description: z.string().max(200).nullable().describe("One-line explanation of the option, or null"),
          })
        )
        .min(2)
        .max(5),
    }),
    reversibility: "read",
    interaction: "question",
    actionKind: "ask_creator",
    execute() {
      // The gate intercepts interaction tools before execute — reaching this
      // line means something routed around the gate, which must never happen.
      throw new MarketingToolError("ask_creator is resolved by the gate, never executed");
    },
  }),
];
