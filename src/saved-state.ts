/**
 * saved-state.ts — derives a filed object's "saved" presentation state from
 * signals the scan already computes. Pure and unit-tested (test/saved-state.test.ts)
 * so the checkmark/reverify affordances can't drift from the seal.
 *
 *   saved-verified — filed and the seal is currently intact (body matches).
 *   needs-reverify — filed but the body was edited since sealing (seal block
 *                    intact, body_hash no longer matches): prompt to re-review.
 *   none           — not filed, or the seal is broken/unreadable (which routes to
 *                    the Break inspector instead, a stronger signal than "reverify").
 */

import { Conformance, Status } from "./lens-core";

export type SavedState = "saved-verified" | "needs-reverify" | "none";

export function savedState(filed: boolean, state: Status, conformance: Conformance): SavedState {
  if (!filed) return "none";
  // A body edit leaves the payload seal intact but flips state to
  // verified-body-modified — that is exactly "someone changed a saved object."
  if (state === "verified-body-modified") return "needs-reverify";
  // Warnings (e.g. a custom vocab value) are not integrity failures, so a
  // warnings-but-valid seal still earns the checkmark; only invalid is excluded.
  if (state === "verified" && conformance !== "invalid") return "saved-verified";
  return "none";
}
