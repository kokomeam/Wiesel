/**
 * TUTOR-1 Wave 6 (P6.3) PURE verification — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-tutor-escalation-queue.ts`
 *
 * Covers the creator escalation-QUEUE + reply-delivery render-decision core:
 *   - askedLabel: COUNT formatting (singular/plural, clamps negatives) — a count,
 *     NEVER a roster/name.
 *   - CLUSTER_STATUS_CHIP: status → chip tone/label, exhaustive over the four
 *     EscalationCluster statuses; isClusterActionable gates reply affordances.
 *   - anchorHref: block-level vs lesson-level studio deep-link (the graph/analytics
 *     format).
 *   - NO-IDENTITY assertion on the frozen EscalationCluster shape: a queue row's
 *     keys are a subset of ALLOWED_CLUSTER_KEYS and carry NONE of the forbidden
 *     identity fields (the roster-privacy guarantee, pinned in one place).
 *   - the tab FLAG-GATING logic: escalationsUiEnabled() default-ON + env override,
 *     and the visible-tabs filter (escalations appended only when the flag is on).
 */

import type { EscalationCluster } from "@/lib/studio/escalationQueue";
import {
  askedLabel,
  anchorHref,
  isClusterActionable,
  CLUSTER_STATUS_CHIP,
  ALLOWED_CLUSTER_KEYS,
  FORBIDDEN_IDENTITY_KEYS,
} from "@/lib/studio/escalationCardView";
import { escalationsUiEnabled } from "@/lib/tutor/flags";

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

/** The pure visible-tabs filter the page applies (mirrored here so the flag-gating
 *  decision is testable without importing the server page). */
function visibleTabIds(flagOn: boolean): string[] {
  const all = ["overview", "charter", "graph", "analytics", "escalations"];
  return flagOn ? all : all.filter((t) => t !== "escalations");
}

function countTests() {
  console.log("\n— askedLabel (COUNT only) —");
  check("1 learner is singular", askedLabel(1) === "1 learner asked", askedLabel(1));
  check("0 learners is plural", askedLabel(0) === "0 learners asked", askedLabel(0));
  check("14 learners is plural", askedLabel(14) === "14 learners asked", askedLabel(14));
  check("a negative clamps to 0", askedLabel(-3) === "0 learners asked", askedLabel(-3));
  check("a fractional count truncates", askedLabel(2.9) === "2 learners asked", askedLabel(2.9));
  // The count copy never mentions identity words.
  const label = askedLabel(14).toLowerCase();
  check(
    "the count copy carries NO identity word (name/email/who)",
    !label.includes("name") && !label.includes("email") && !label.includes("who")
  );
}

function statusTests() {
  console.log("\n— CLUSTER_STATUS_CHIP + actionable —");
  const statuses: EscalationCluster["status"][] = ["open", "replied", "dismissed", "resolved_in_content"];
  check("every status has a chip mapping", statuses.every((s) => CLUSTER_STATUS_CHIP[s] != null));
  check("open → attention", CLUSTER_STATUS_CHIP.open.tone === "attention");
  check("replied → success", CLUSTER_STATUS_CHIP.replied.tone === "success");
  check("dismissed → neutral", CLUSTER_STATUS_CHIP.dismissed.tone === "neutral");
  check("resolved_in_content → success", CLUSTER_STATUS_CHIP.resolved_in_content.tone === "success");
  check("every chip carries a non-empty label", statuses.every((s) => CLUSTER_STATUS_CHIP[s].label.length > 0));

  check("open is actionable", isClusterActionable("open"));
  check("replied is actionable (a later consent can still be delivered)", isClusterActionable("replied"));
  check("dismissed is NOT actionable", !isClusterActionable("dismissed"));
  check("resolved_in_content is NOT actionable", !isClusterActionable("resolved_in_content"));
}

function anchorTests() {
  console.log("\n— anchorHref deep-link —");
  const courseId = "course-abc";
  check(
    "a block-level anchor deep-links to the block",
    anchorHref(courseId, { lessonId: "les-1", blockId: "blk-2" }) ===
      "/studio?course=course-abc&lesson=les-1&block=blk-2"
  );
  check(
    "a slide anchor with a block still deep-links block-level",
    anchorHref(courseId, { lessonId: "les-1", blockId: "blk-2", slideId: "sld-3" }) ===
      "/studio?course=course-abc&lesson=les-1&block=blk-2"
  );
  check(
    "a bare anchor (empty blockId) falls back to lesson-level",
    anchorHref(courseId, { lessonId: "les-1", blockId: "" }) === "/studio?course=course-abc&lesson=les-1"
  );
}

function noIdentityTests() {
  console.log("\n— NO-IDENTITY on the frozen EscalationCluster shape —");
  // A fully-populated queue row (the exact frozen contract shape).
  const row: EscalationCluster = {
    id: "cluster-1",
    nodeId: "node-1",
    nodeTitle: "Asymptotic notation",
    anchors: [{ lessonId: "les-1", blockId: "blk-1", slideId: "sld-1" }],
    representativeQuestion: "Why does my Theta bound differ from the book?",
    representativeAnswer: "Theta is a tight bound — check your recurrence.",
    memberCount: 14,
    status: "open",
    changeSetId: null,
  };

  const keys = Object.keys(row);
  check(
    "every queue-row key is in the ALLOWED set (frozen contract)",
    keys.every((k) => (ALLOWED_CLUSTER_KEYS as readonly string[]).includes(k)),
    `keys=${keys.join(",")}`
  );
  check(
    "the queue row carries NONE of the forbidden identity fields",
    FORBIDDEN_IDENTITY_KEYS.every((k) => !(k in (row as Record<string, unknown>)))
  );
  check("the ALLOWED set itself lists NO identity field", ALLOWED_CLUSTER_KEYS.every((k) => !(FORBIDDEN_IDENTITY_KEYS as readonly string[]).includes(k)));
  // memberCount is a NUMBER (an aggregate), not a list of learners.
  check("memberCount is a number (an aggregate, never a roster array)", typeof row.memberCount === "number");
  check("there is no user_id / roster array anywhere on the row", !("user_id" in (row as Record<string, unknown>)) && !("members" in (row as Record<string, unknown>)) && !("roster" in (row as Record<string, unknown>)));
}

function flagGatingTests() {
  console.log("\n— tab flag-gating —");
  const prev = process.env.TUTOR_ESCALATIONS_UI;
  try {
    delete process.env.TUTOR_ESCALATIONS_UI;
    check("flag defaults ON when unset", escalationsUiEnabled() === true);
    process.env.TUTOR_ESCALATIONS_UI = "true";
    check("flag is ON for 'true'", escalationsUiEnabled() === true);
    process.env.TUTOR_ESCALATIONS_UI = "1";
    check("flag is ON for any non-'false' value ('1')", escalationsUiEnabled() === true);
    process.env.TUTOR_ESCALATIONS_UI = "false";
    check("flag is OFF only for the literal 'false'", escalationsUiEnabled() === false);
  } finally {
    if (prev === undefined) delete process.env.TUTOR_ESCALATIONS_UI;
    else process.env.TUTOR_ESCALATIONS_UI = prev;
  }

  // The visible-tab filter appends escalations LAST, and only when the flag is on.
  const on = visibleTabIds(true);
  const off = visibleTabIds(false);
  check("with the flag ON, escalations is the LAST tab", on[on.length - 1] === "escalations");
  check("with the flag ON there are 5 tabs", on.length === 5);
  check("with the flag OFF the escalations tab is ABSENT", !off.includes("escalations"));
  check("with the flag OFF there are 4 tabs", off.length === 4);
  check("the flag never removes any of the base tabs", ["overview", "charter", "graph", "analytics"].every((t) => off.includes(t)));
}

function main() {
  countTests();
  statusTests();
  anchorTests();
  noIdentityTests();
  flagGatingTests();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
