import type { Status } from "./lens-core";

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
}

export interface PortfolioLane<T> {
  folder: PortfolioFolder;
  rows: T[];
}

/**
 * Build one collapsible lane per immediate portfolio folder. A lane includes
 * descendants as well as direct children so nested organisation never makes a
 * filed KNOBE disappear from the portfolio board.
 */
export function groupPortfolioRows<T extends PortfolioRow>(
  folders: readonly PortfolioFolder[],
  rows: readonly T[],
): PortfolioLane<T>[] {
  return folders.map((folder) => {
    const prefix = `${folder.path}/`;
    return {
      folder,
      rows: rows.filter((row) => row.file.path.startsWith(prefix)),
    };
  });
}
