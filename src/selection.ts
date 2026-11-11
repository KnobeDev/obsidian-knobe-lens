/**
 * selection.ts — pure logic for bulk card selection and "move selected to
 * portfolio" on the KNOBE Lens dashboard. No Obsidian imports, so the selection
 * model and bulk eligibility are unit-tested (test/selection.test.ts).
 *
 * Selection is a Set<string> of file paths. Every operation returns a NEW set
 * (immutable), so the view can reassign without hidden mutation.
 */

import { getVerdict, TrustLedger } from "./trust";
import type { ScanRow } from "./scanner";

/** Bulk filing is available only for verified objects with an intact payload
 * identity and no local rejection. A previous verdict does not excuse edits. */
export function canTrustAndFileRow(row: ScanRow, trust: TrustLedger): boolean {
  return row.result.state === "verified"
    && row.payloadHash !== null
    && getVerdict(trust, row.payloadHash)?.verdict !== "rejected";
}

/** Tri-state for the "Select all" checkbox: all / some / none of the selectable
 *  paths are selected. "partial" drives the checkbox's indeterminate state. */
export type SelectAllState = "all" | "partial" | "none";

export function selectAllState(selected: ReadonlySet<string>, selectable: readonly string[]): SelectAllState {
  if (selectable.length === 0) return "none";
  let n = 0;
  for (const p of selectable) if (selected.has(p)) n++;
  if (n === 0) return "none";
  return n === selectable.length ? "all" : "partial";
}

/** Toggle one path in or out of the selection. Returns a new set. */
export function toggleSelected(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Add (on=true) or remove (on=false) every selectable path, leaving any other
 *  selected paths untouched. Returns a new set. */
export function setAllSelected(selected: ReadonlySet<string>, selectable: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const p of selectable) {
    if (on) next.add(p);
    else next.delete(p);
  }
  return next;
}

/** Keep only the selected paths that are still selectable — called after a
 *  rescan so a moved/deleted/now-filed object drops out of the selection. */
export function pruneSelected(selected: ReadonlySet<string>, selectable: readonly string[]): Set<string> {
  const keep = new Set(selectable);
  const next = new Set<string>();
  for (const p of selected) if (keep.has(p)) next.add(p);
  return next;
}
