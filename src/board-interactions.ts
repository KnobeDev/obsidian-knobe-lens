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

export function trustToFilePolicy(state: Status): TrustToFilePolicy {
  if (state === "verified-body-modified") {
    return {
      tone: "promote",
      warning: "Have you checked the payload yet? The sealed payload is intact, but the document body has changed. Review the decoded payload and body differences before trusting this file.",
    };
  }
  if (state === "failed") {
    return {
      tone: "reject",
      warning: "Have you checked the payload yet? The verification failed, so the sealed payload may have changed or may not be trustworthy. Review the decoded payload before trusting this file.",
    };
  }
  return { tone: "trust", warning: null };
}
