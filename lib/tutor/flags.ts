/**
 * TUTOR-1 — server-side tutor feature flags (ONE resolution point, no drift).
 *
 * These read `process.env` and are used only in SERVER components / routes (the
 * value is passed down as a plain boolean prop; a client component never reads the
 * env). Keeping the resolution in one module means the learner sidebar card + the
 * creator console badge can never disagree about whether escalations are live.
 */

/**
 * Is the escalation consent + creator-surface UI enabled?
 *
 * ── DEFAULT (Wave 6): ON ──────────────────────────────────────────────────────
 * The escalation loop shipped complete in Wave 6, so the flag now DEFAULTS ON —
 * the tutor may surface an escalation proposal + the real consent card, and the
 * creator console shows the Escalations surface. It stays env-overridable: set
 * `TUTOR_ESCALATIONS_UI=false` to ship the path dormant (uncertainty lives in the
 * prose, the consent card never renders). Any value other than the literal
 * "false" (unset, "true", "1", …) resolves ON.
 */
export function escalationsUiEnabled(): boolean {
  return process.env.TUTOR_ESCALATIONS_UI !== "false";
}
