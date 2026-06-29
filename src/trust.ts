/**
 * trust.ts — local receiver-side trust verdicts ("unquarantine").
 *
 * A verdict records the *receiver's* decision and is keyed by the object's
 * payload hash. It is NEVER written into the file — the sealed quarantine_status
 * remains the maker's declaration. Because the key is the content hash, a verdict
 * automatically goes stale if the file changes (the new hash has no verdict),
 * which is the safety property: you cannot trust content, then swap it underneath.
 *
 * Pure + immutable (returns new ledgers, never mutates).
 */

export type Verdict = "trusted" | "rejected";

export interface TrustEntry {
  verdict: Verdict;
  note: string;
  at: string; // ISO timestamp supplied by the caller
}

export type TrustLedger = Record<string, TrustEntry>;

export function getVerdict(ledger: TrustLedger, hash: string | null): TrustEntry | null {
  if (!hash) return null;
  return ledger[hash] ?? null;
}

export function setVerdict(
  ledger: TrustLedger, hash: string, verdict: Verdict, note: string, at: string,
): TrustLedger {
  return { ...ledger, [hash]: { verdict, note, at } };
}

export function clearVerdict(ledger: TrustLedger, hash: string): TrustLedger {
  if (!(hash in ledger)) return ledger;
  const next = { ...ledger };
  delete next[hash];
  return next;
}
