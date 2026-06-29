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
