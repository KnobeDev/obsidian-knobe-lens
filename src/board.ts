import type { OtherFormatCheck, Status } from "./lens-core";

export const RECOGNITION_ORDER: readonly Status[] = [
  "verified",
  "verified-body-modified",
  "failed",
  "unreadable",
];

export interface RecognitionRow {
  result: { state: Status };
}

export interface RecognitionColumn<T> {
  state: Status;
  rows: T[];
}

/**
 * Build the stable four-column recognition board. Recognition is derived from
 * verification, so columns are deliberately read-only: users can inspect cards
 * and file trusted objects, but cannot drag a failed seal into "Verified".
 */
export function groupRecognitionRows<T extends RecognitionRow>(
  rows: readonly T[],
  isFiled: (row: T) => boolean = () => false,
): RecognitionColumn<T>[] {
  return RECOGNITION_ORDER.map((state) => ({
    state,
    rows: rows.filter((row) => !isFiled(row) && row.result.state === state),
  }));
}

export interface PortfolioFolder {
  name: string;
  path: string;
}

export interface PortfolioRow {
  file: { path: string };
  result: { state: Status };
}

export interface PortfolioLane<T> {
  folder: PortfolioFolder;
  rows: T[];
}

/**
 * Build one collapsible lane per immediate portfolio folder. A lane includes
 * descendants as well as direct children so nested organisation never makes a
 * filed KNOBE disappear from the portfolio board. A file that is not KNOBE v1
 * is never shown as part of a portfolio, wherever it sits (groupOtherFormatRows).
 */
export function groupPortfolioRows<T extends PortfolioRow>(
  folders: readonly PortfolioFolder[],
  rows: readonly T[],
): PortfolioLane<T>[] {
  return folders.map((folder) => {
    const pathClean = folder.path.endsWith("/") ? folder.path.slice(0, -1) : folder.path;
    const prefix = pathClean ? `${pathClean}/` : "";
    return {
      folder,
      rows: rows.filter((row) => row.result.state !== "not-v1" && row.file.path.startsWith(prefix)),
    };
  });
}

/**
 * Files Lens recognizes as KNOBE but not as KNOBE v1 (the KNOBE.AI 0.1
 * envelope), from the scan and the portfolios, once each. They are listed on
 * their own, outside Recognition, portfolios, the world and lineage.
 */
export function groupOtherFormatRows<T extends PortfolioRow>(
  scanned: readonly T[],
  filed: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...scanned, ...filed].filter((row) => {
    if (row.result.state !== "not-v1" || seen.has(row.file.path)) return false;
    seen.add(row.file.path);
    return true;
  });
}

/** One-line label for a file that is not KNOBE v1, e.g. "KNOBE.AI 0.1 · its
 *  hash matches the 7 fields it lists, and only those". Never says "verified". */
export function otherFormatLabel(check: OtherFormatCheck): string {
  const n = check.coveredFields.length;
  const fields = `${n} field${n === 1 ? "" : "s"} it lists`;
  if (check.hashMatches === null) return `${check.format} · hash not checked`;
  return check.hashMatches
    ? `${check.format} · its hash matches the ${fields}, and only those`
    : `${check.format} · its hash does not match the ${fields}`;
}
