import type { Status } from "./lens-core";

/** Distinct, moderately saturated defaults; lane CSS blends these with the
 * active Obsidian theme so headings retain contrast in light and dark modes. */
export const DEFAULT_PORTFOLIO_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
  "#84cc16",
] as const;

const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i;

export type PortfolioColors = Record<string, string>;

export function normalizePortfolioColor(candidate: unknown): string | null {
  return typeof candidate === "string" && SIX_DIGIT_HEX.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

export function portfolioColor(
  folderPath: string,
  index: number,
  saved: PortfolioColors,
): string {
  const fallback = DEFAULT_PORTFOLIO_COLORS[
    ((index % DEFAULT_PORTFOLIO_COLORS.length) + DEFAULT_PORTFOLIO_COLORS.length)
      % DEFAULT_PORTFOLIO_COLORS.length
  ];
  return normalizePortfolioColor(saved[folderPath]) ?? fallback;
}

/** A drop onto the current direct parent is a no-op. Keeping this decision pure
 * prevents duplicate rename attempts in both drag and select interactions. */
export function shouldMovePortfolioCard(
  currentFolderPath: string,
  destinationFolderPath: string,
): boolean {
  return currentFolderPath !== destinationFolderPath;
}

export interface TrustToFilePolicy {
  tone: "trust" | "promote" | "reject";
  warning: string | null;
}

/** What trusting an object asks of the user first. A failed or edited object
 * gets a warning; the detail pane's Trust button shows it before recording the
 * verdict. Trusting records a local verdict only, so the warning also says that
 * filing still needs a verified seal (see canFileRow). */
export function trustToFilePolicy(state: Status): TrustToFilePolicy {
  const filingNote = " Trusting records your local verdict only: it can't be filed in a portfolio until its seal verifies.";
  if (state === "verified-body-modified") {
    return {
      tone: "promote",
      warning: "Have you checked the payload yet? The sealed payload is intact, but the document body has changed. Review the decoded payload and body differences before trusting this file." + filingNote,
    };
  }
  if (state === "failed") {
    return {
      tone: "reject",
      warning: "Have you checked the payload yet? The verification failed, so the sealed payload may have changed or may not be trustworthy. Review the decoded payload before trusting this file." + filingNote,
    };
  }
  return { tone: "trust", warning: null };
}

/** One board object as the summary line counts it. */
export interface SummaryEntry {
  state: Status;
  filed: boolean;
  quarantined: boolean;
}

/** Filed objects whose seal is broken, e.g. "1 failed, 1 unreadable", or "". */
function brokenFiled(entries: readonly SummaryEntry[]): string {
  const filed = entries.filter((e) => e.filed);
  const failed = filed.filter((e) => e.state === "failed").length;
  const unreadable = filed.filter((e) => e.state === "unreadable").length;
  return [failed ? `${failed} failed` : "", unreadable ? `${unreadable} unreadable` : ""].filter(Boolean).join(", ");
}

/** The board's summary line. State counts cover the unfiled objects on the
 * recognition board; filed objects with a broken seal are named after the
 * filed count, so filing a failed object never hides it. */
export function boardSummary(entries: readonly SummaryEntry[]): string {
  if (entries.length === 0) return "No sealed KNOBE notes found in this vault yet.";
  const unfiled = entries.filter((e) => !e.filed);
  const filed = entries.length - unfiled.length;
  const broken = brokenFiled(entries);
  if (unfiled.length === 0) {
    return `All ${entries.length} KNOBE${entries.length === 1 ? "" : "s"} filed in portfolios${broken ? ` (${broken})` : ""}.`;
  }
  const counts: Record<Status, number> = { verified: 0, "verified-body-modified": 0, failed: 0, unreadable: 0 };
  let quarantined = 0;
  for (const e of unfiled) {
    counts[e.state]++;
    if (e.quarantined) quarantined++;
  }
  return (
    `${counts.verified} verified · ${counts["verified-body-modified"]} body-modified · ` +
    `${counts.failed} failed · ${counts.unreadable} unreadable · ${quarantined} quarantined` +
    (filed ? ` · ${filed} filed${broken ? ` (${broken})` : ""}` : "")
  );
}
