/**
 * diff.ts — minimal LCS line diff for the break inspector (current vs. the
 * last-verified snapshot). Pure; no dependencies.
 */

export type DiffOp = { type: "same" | "add" | "del"; line: string };

const MAX_DIFF_LINES = 2000;

export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;

  // Guard the O(m*n) table against memory exhaustion on very large bodies.
  if (m > MAX_DIFF_LINES || n > MAX_DIFF_LINES) {
    return [{ type: "del", line: `(diff skipped — content exceeds ${MAX_DIFF_LINES} lines)` }];
  }

  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ type: "same", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "del", line: a[i] }); i++; }
    else { ops.push({ type: "add", line: b[j] }); j++; }
  }
  while (i < m) ops.push({ type: "del", line: a[i++] });
  while (j < n) ops.push({ type: "add", line: b[j++] });
  return ops;
}

/**
 * 1-based line numbers in `newText` that changed relative to `oldText`:
 * added lines directly, and for deletions the line adjacent to the removal
 * point (so a pure deletion still gets a visible marker). Drives the
 * in-editor "EDITED, RECONFIRM" highlights.
 */
export function changedLineNumbers(oldText: string, newText: string): number[] {
  const out = new Set<number>();
  let newLine = 0; // lines of newText consumed so far
  for (const op of lineDiff(oldText, newText)) {
    if (op.type === "same") {
      newLine++;
    } else if (op.type === "add") {
      newLine++;
      out.add(newLine);
    } else {
      // Deletion: mark the boundary it happened at in the new text.
      out.add(Math.max(1, newLine));
      out.add(newLine + 1); // may exceed the doc; callers clamp
    }
  }
  return [...out].sort((a, b) => a - b);
}
