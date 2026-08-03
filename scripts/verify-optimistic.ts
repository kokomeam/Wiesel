/**
 * PERF-1 B3 optimistic-UI PURE test suite — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-optimistic.ts`
 *
 * Covers lib/perf/optimistic.ts, the rollback state machines behind every
 * optimistic surface:
 *  - the generic single-value machine (settings default-portal radio, learner
 *    review submit + slide-in dismiss): apply→confirm, apply→fail→rollback,
 *    stale-op / double-fire guarding, local reset.
 *  - the change-set review machine (editor Accept/Reject): optimistic accept
 *    clear + byte-for-byte restore, reject 'reverting' chrome + rollback,
 *    double-fire guards, cross-set independence.
 */

import {
  applyValue,
  beginAccept,
  beginReject,
  confirmResolve,
  confirmValue,
  failValue,
  idleValue,
  resetValue,
  rollbackAccept,
  rollbackReject,
  type ChangeSetReviewSlice,
} from "@/lib/perf/optimistic";

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

/** Key-order-insensitive deep equality (rollback merges may reorder keys). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
function eq(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/* ─────────────────── Generic single-value machine ──────────────────────── */

console.log("\nGeneric value machine (portal radio / review submit)");
{
  const s0 = idleValue<"creator" | "learner">("creator");
  check("idleValue: settled at the initial value", s0.value === "creator" && s0.committed === "creator" && !s0.inFlight && s0.error === null && s0.op === 0);

  const a1 = applyValue(s0, "learner");
  check("apply: value flips immediately, in flight, op bumped", a1.state.value === "learner" && a1.state.inFlight && a1.op === 1 && a1.state.committed === "creator");

  const c1 = confirmValue(a1.state, a1.op);
  check("apply→confirm: commits the optimistic value", c1.value === "learner" && c1.committed === "learner" && !c1.inFlight && c1.error === null);

  const f1 = failValue(a1.state, a1.op, "boom");
  check("apply→fail: rolls back to the committed value + error", f1.value === "creator" && f1.committed === "creator" && !f1.inFlight && f1.error === "boom");

  const cServer = confirmValue(applyValue(s0, "learner").state, 1, "creator");
  check("confirm with a server value: server wins", cServer.value === "creator" && cServer.committed === "creator");

  // Double-fire / stale-op guarding: two rapid applies, the FIRST settles late.
  const b1 = applyValue(s0, "learner");
  const b2 = applyValue(b1.state, "creator");
  const staleFail = failValue(b2.state, b1.op, "late failure");
  check("stale fail (older op) is ignored", staleFail === b2.state && staleFail.value === "creator" && staleFail.inFlight);
  const staleConfirm = confirmValue(b2.state, b1.op);
  check("stale confirm (older op) is ignored", staleConfirm === b2.state);
  const latestFail = failValue(b2.state, b2.op, "boom");
  check("latest op's fail rolls back to the ORIGINAL committed value", latestFail.value === "creator" && latestFail.committed === "creator" && !latestFail.inFlight);

  const settled = confirmValue(a1.state, a1.op);
  check("settle after settle is ignored (not in flight)", failValue(settled, a1.op, "boom") === settled);

  const reFail = applyValue(f1, "learner");
  check("re-apply after a failure clears the error", reFail.state.error === null && reFail.state.value === "learner" && reFail.op === 2);

  // resetValue: "Edit your review" while a submit is still in flight — the
  // reset drops inFlight, so the eventual settle for the old op is ignored.
  const r1 = applyValue(idleValue<string | null>(null), "optimistic");
  const reset = resetValue(r1.state, null);
  check("reset: back to a settled local value, op kept monotonic", reset.value === null && reset.committed === null && !reset.inFlight && reset.op === r1.op);
  check("settle after reset is ignored", confirmValue(reset, r1.op, "server") === reset && failValue(reset, r1.op, "boom") === reset);
}

/* ─────────────────── Change-set review machine ─────────────────────────── */

type Block = { changeSetId: string; evidence?: unknown };
type Node = { changeSetId: string; nodeType: "module" | "lesson"; op: string };
type Set_ = { id: string; count: number; summary?: string; structuralCount?: number };
type Slice = ChangeSetReviewSlice<Block, Node, Set_>;

function fixture(): Slice {
  return {
    pendingBlocks: {
      b1: { changeSetId: "A", evidence: { kind: "quiz" } },
      b2: { changeSetId: "A" },
      b3: { changeSetId: "B" },
    },
    pendingNodes: {
      n1: { changeSetId: "A", nodeType: "lesson", op: "create_lesson" },
    },
    changeSets: {
      A: { id: "A", count: 3, summary: "Fix the quiz", structuralCount: 1 },
      B: { id: "B", count: 1 },
    },
    resolving: {},
  };
}

console.log("\nChange-set machine — optimistic ACCEPT");
{
  const s0 = fixture();
  const begun = beginAccept(s0, "A");
  check("beginAccept returns a new slice + snapshot", begun !== null);
  if (!begun) process.exit(1);

  check("accept clears ONLY the target set's blocks", eq(Object.keys(begun.slice.pendingBlocks), ["b3"]));
  check("accept clears the target set's nodes", eq(begun.slice.pendingNodes, {}));
  check(
    "accept removes the change-set, keeps the others",
    !("A" in begun.slice.changeSets) && eq(begun.slice.changeSets.B, s0.changeSets.B)
  );
  check("accept marks the set resolving", begun.slice.resolving.A === "accept");
  check(
    "snapshot holds exactly what was cleared (evidence intact)",
    eq(begun.snapshot, {
      changeSetId: "A",
      blocks: { b1: s0.pendingBlocks.b1, b2: s0.pendingBlocks.b2 },
      nodes: { n1: s0.pendingNodes.n1 },
      changeSet: s0.changeSets.A,
    })
  );
  check("original slice untouched (pure)", eq(s0, fixture()));

  check("beginAccept on an unknown id → null", beginAccept(s0, "nope") === null);
  check("beginAccept double-fire → null", beginAccept(begun.slice, "A") === null);

  const rolled = rollbackAccept(begun.slice, begun.snapshot);
  check("rollbackAccept restores the review state byte-for-byte", eq(rolled, s0));

  // A block re-claimed by a NEWER change-set while the accept was in flight
  // keeps its new claim.
  const reclaimed: Slice = {
    ...begun.slice,
    pendingBlocks: { ...begun.slice.pendingBlocks, b1: { changeSetId: "C" } },
    changeSets: { ...begun.slice.changeSets, C: { id: "C", count: 1 } },
  };
  const rolledOver = rollbackAccept(reclaimed, begun.snapshot);
  check("rollbackAccept: a newer claim on the same block wins", rolledOver.pendingBlocks.b1.changeSetId === "C" && rolledOver.pendingBlocks.b2.changeSetId === "A");

  const confirmed = confirmResolve(begun.slice, "A");
  check("confirmResolve after accept: resolving cleared, nothing else changes", eq(confirmed, { ...begun.slice, resolving: {} }));
}

console.log("\nChange-set machine — REJECT (server-authoritative revert)");
{
  const s0 = fixture();
  const rejecting = beginReject(s0, "A");
  check("beginReject keeps the pending chrome (server owns the doc revert)", rejecting !== null && eq({ ...rejecting, resolving: {} }, s0));
  if (!rejecting) process.exit(1);
  check("beginReject marks the set 'reverting'", rejecting.resolving.A === "reject");
  check("beginReject double-fire → null", beginReject(rejecting, "A") === null);
  check("beginAccept on a set already rejecting → null (cross-action guard)", beginAccept(rejecting, "A") === null);
  check("beginReject on an unknown id → null", beginReject(s0, "nope") === null);

  const rolled = rollbackReject(rejecting, "A");
  check("rollbackReject: actionable again, byte-for-byte", eq(rolled, s0));

  const confirmed = confirmResolve(rejecting, "A");
  check(
    "confirmResolve after reject drops the set's review state",
    eq(Object.keys(confirmed.pendingBlocks), ["b3"]) &&
      eq(confirmed.pendingNodes, {}) &&
      !("A" in confirmed.changeSets) &&
      eq(confirmed.resolving, {})
  );
  check("confirmResolve keeps the other set intact", eq(confirmed.changeSets.B, s0.changeSets.B));
}

console.log("\nChange-set machine — cross-set independence");
{
  const s0 = fixture();
  const rejecting = beginReject(s0, "A");
  if (!rejecting) process.exit(1);
  const accepted = beginAccept(rejecting, "B");
  check("accepting B while A reverts: both resolutions coexist", accepted !== null && accepted.slice.resolving.A === "reject" && accepted.slice.resolving.B === "accept");
  if (!accepted) process.exit(1);
  check("B's chrome cleared, A's kept", !("b3" in accepted.slice.pendingBlocks) && accepted.slice.pendingBlocks.b1.changeSetId === "A");
  const aSettled = confirmResolve(accepted.slice, "A");
  check("settling A leaves B's in-flight accept untouched", aSettled.resolving.B === "accept" && !("A" in aSettled.resolving));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
