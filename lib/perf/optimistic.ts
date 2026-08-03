/**
 * Pure optimistic-mutation state machines (PERF-1 B3). Every surface that
 * mutates optimistically (change-set Accept/Reject chrome, learner review
 * submit/dismiss, the settings default-portal radio) keeps its apply→confirm /
 * apply→fail→rollback transitions HERE, as pure functions over plain state —
 * testable without a browser (scripts/verify-optimistic.ts) and deterministic
 * for Playwright failure-injection (intercept the API route, observe rollback).
 *
 * No timers, no IO, no React: callers own the fetch and feed results back in.
 */

/* ────────────────── Generic single-value machine ─────────────────────────
 * For a mutation whose optimistic result is one locally-predictable value
 * (the portal radio's role, a review form's submitted state). The `op` token
 * makes settles race-safe: only the LATEST in-flight op may confirm/fail, so
 * a slow failure response can never clobber a newer optimistic apply. */

export interface OptimisticValue<V> {
  /** What the UI renders right now (optimistic while `inFlight`). */
  value: V;
  /** The last server-confirmed value — restored on failure. */
  committed: V;
  /** Monotonic op token; settles must present the token their apply returned. */
  op: number;
  inFlight: boolean;
  error: string | null;
}

export function idleValue<V>(value: V): OptimisticValue<V> {
  return { value, committed: value, op: 0, inFlight: false, error: null };
}

/** Apply optimistically. Returns the op token the caller settles with. */
export function applyValue<V>(
  s: OptimisticValue<V>,
  next: V
): { state: OptimisticValue<V>; op: number } {
  const op = s.op + 1;
  return { state: { ...s, value: next, op, inFlight: true, error: null }, op };
}

/** The server confirmed `op` — commit (an explicit server value wins over the
 *  optimistic one). Stale/settled ops are ignored (double-fire guard). */
export function confirmValue<V>(s: OptimisticValue<V>, op: number, serverValue?: V): OptimisticValue<V> {
  if (op !== s.op || !s.inFlight) return s;
  const value = serverValue === undefined ? s.value : serverValue;
  return { ...s, value, committed: value, inFlight: false, error: null };
}

/** The server failed `op` — roll back to the committed value. Stale/settled
 *  ops are ignored (double-fire guard). */
export function failValue<V>(s: OptimisticValue<V>, op: number, error: string): OptimisticValue<V> {
  if (op !== s.op || !s.inFlight) return s;
  return { ...s, value: s.committed, inFlight: false, error };
}

/** A purely LOCAL transition to a new settled value (e.g. "Edit your review"
 *  re-opens the form). Keeps the op counter monotonic and drops `inFlight`,
 *  so an in-flight settle from before the reset is ignored. */
export function resetValue<V>(s: OptimisticValue<V>, value: V): OptimisticValue<V> {
  return { value, committed: value, op: s.op, inFlight: false, error: null };
}

/* ────────────────── Change-set review machine ────────────────────────────
 * The agentStore's pending-review chrome (amber rings + Accept/Reject).
 *  - ACCEPT is optimistic: the edits already live in the DB doc, so clearing
 *    the chrome is locally predictable. `beginAccept` clears it NOW and hands
 *    back a snapshot; `rollbackAccept` restores it byte-for-byte on failure.
 *  - REJECT is server-authoritative (inverse patches revert the doc) — the doc
 *    mutation is NEVER faked. The optimistic part is the chrome flipping to
 *    'reverting' (disabled + dimmed) via `resolving`; `rollbackReject` returns
 *    it to actionable on failure.
 *  - `confirmResolve` is the shared success terminal: it drops the change-set's
 *    review state (a no-op removal after accept) and clears `resolving`. */

export type ResolveAction = "accept" | "reject";

interface WithChangeSetId {
  changeSetId: string;
}

export interface ChangeSetReviewSlice<B extends WithChangeSetId, N extends WithChangeSetId, C> {
  pendingBlocks: Record<string, B>;
  pendingNodes: Record<string, N>;
  changeSets: Record<string, C>;
  /** change-set id → its in-flight resolution (the double-fire guard). */
  resolving: Record<string, ResolveAction>;
}

export interface ChangeSetSnapshot<B extends WithChangeSetId, N extends WithChangeSetId, C> {
  changeSetId: string;
  blocks: Record<string, B>;
  nodes: Record<string, N>;
  changeSet: C;
}

function partitionBySet<E extends WithChangeSetId>(
  entries: Record<string, E>,
  changeSetId: string
): { taken: Record<string, E>; kept: Record<string, E> } {
  const taken: Record<string, E> = {};
  const kept: Record<string, E> = {};
  for (const [id, e] of Object.entries(entries)) {
    if (e.changeSetId === changeSetId) taken[id] = e;
    else kept[id] = e;
  }
  return { taken, kept };
}

/** Optimistically clear one change-set's review chrome for Accept. Returns
 *  null when the id is unknown or already resolving (double-fire guard). */
export function beginAccept<B extends WithChangeSetId, N extends WithChangeSetId, C>(
  slice: ChangeSetReviewSlice<B, N, C>,
  changeSetId: string
): { slice: ChangeSetReviewSlice<B, N, C>; snapshot: ChangeSetSnapshot<B, N, C> } | null {
  const changeSet = slice.changeSets[changeSetId];
  if (!changeSet || slice.resolving[changeSetId]) return null;
  const blocks = partitionBySet(slice.pendingBlocks, changeSetId);
  const nodes = partitionBySet(slice.pendingNodes, changeSetId);
  const changeSets = { ...slice.changeSets };
  delete changeSets[changeSetId];
  return {
    slice: {
      pendingBlocks: blocks.kept,
      pendingNodes: nodes.kept,
      changeSets,
      resolving: { ...slice.resolving, [changeSetId]: "accept" },
    },
    snapshot: { changeSetId, blocks: blocks.taken, nodes: nodes.taken, changeSet },
  };
}

/** The accept POST failed — restore exactly what `beginAccept` cleared. An
 *  entry claimed by a NEWER change-set while the accept was in flight keeps
 *  its new claim; the snapshot only fills the gaps it left. */
export function rollbackAccept<B extends WithChangeSetId, N extends WithChangeSetId, C>(
  slice: ChangeSetReviewSlice<B, N, C>,
  snapshot: ChangeSetSnapshot<B, N, C>
): ChangeSetReviewSlice<B, N, C> {
  const resolving = { ...slice.resolving };
  delete resolving[snapshot.changeSetId];
  return {
    pendingBlocks: { ...snapshot.blocks, ...slice.pendingBlocks },
    pendingNodes: { ...snapshot.nodes, ...slice.pendingNodes },
    changeSets: { ...slice.changeSets, [snapshot.changeSetId]: snapshot.changeSet },
    resolving,
  };
}

/** Mark a change-set 'reverting' (its chrome dims + disables). Returns null
 *  when the id is unknown or already resolving (double-fire guard). */
export function beginReject<B extends WithChangeSetId, N extends WithChangeSetId, C>(
  slice: ChangeSetReviewSlice<B, N, C>,
  changeSetId: string
): ChangeSetReviewSlice<B, N, C> | null {
  if (!slice.changeSets[changeSetId] || slice.resolving[changeSetId]) return null;
  return { ...slice, resolving: { ...slice.resolving, [changeSetId]: "reject" } };
}

/** The reject POST failed — the chrome returns to actionable, nothing lost. */
export function rollbackReject<B extends WithChangeSetId, N extends WithChangeSetId, C>(
  slice: ChangeSetReviewSlice<B, N, C>,
  changeSetId: string
): ChangeSetReviewSlice<B, N, C> {
  const resolving = { ...slice.resolving };
  delete resolving[changeSetId];
  return { ...slice, resolving };
}

/** Success terminal for BOTH actions: drop the change-set's review state
 *  (already gone after an accept) and clear its resolving flag. */
export function confirmResolve<B extends WithChangeSetId, N extends WithChangeSetId, C>(
  slice: ChangeSetReviewSlice<B, N, C>,
  changeSetId: string
): ChangeSetReviewSlice<B, N, C> {
  const blocks = partitionBySet(slice.pendingBlocks, changeSetId);
  const nodes = partitionBySet(slice.pendingNodes, changeSetId);
  const changeSets = { ...slice.changeSets };
  delete changeSets[changeSetId];
  const resolving = { ...slice.resolving };
  delete resolving[changeSetId];
  return { pendingBlocks: blocks.kept, pendingNodes: nodes.kept, changeSets, resolving };
}
