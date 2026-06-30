/**
 * portfolio.ts — pure helpers for organising KNOBE objects into portfolio
 * folders (real vault folders under a configurable root). No Obsidian runtime
 * dependency: types are imported type-only (erased at build), and folder/file
 * discrimination is structural, so every function here is unit-testable without
 * an Obsidian mock. Side-effecting vault operations live on the plugin.
 */

import type { TFile, TFolder, TAbstractFile } from "obsidian";

/** Sentinel option value for the "+ New folder…" entry in the move dropdown. */
export const NEW_FOLDER_VALUE = "__knobe_new_folder__";
/** Sentinel value for the placeholder / "not in a portfolio" dropdown entry. */
export const NO_FOLDER_VALUE = "";

// Reject characters that are illegal in vault paths on common filesystems.
const ILLEGAL_CHARS = /[\\/:*?"<>|]/;

/**
 * Normalise a user-entered portfolio name, or return null if unusable. Trims,
 * drops leading dots and trailing dots/spaces (which break on Windows), and
 * rejects empty names or names with path-illegal characters.
 */
export function sanitizePortfolioName(name: string): string | null {
  const trimmed = name.trim().replace(/^\.+/, "").replace(/[.\s]+$/, "").trim();
  if (!trimmed) return null;
  if (ILLEGAL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/** Structural folder check — a TFolder has a `children` array, a TFile does not.
 *  Avoids an `instanceof TFolder` runtime import so this module stays pure. */
export function isFolder(f: TAbstractFile | null | undefined): f is TFolder {
  return !!f && Array.isArray((f as TFolder).children);
}

/** Immediate subfolders of the resolved portfolio root, sorted by name.
 *  Pass null (root missing / not yet created) to get an empty list. */
export function listPortfolioFolders(root: TFolder | null): TFolder[] {
  if (!root) return [];
  return root.children.filter(isFolder).sort((a, b) => a.name.localeCompare(b.name));
}

/** The portfolio a file currently lives in (an immediate subfolder of root), or
 *  null if it is loose / outside the portfolio root. */
export function currentPortfolioName(file: TFile, rootPath: string): string | null {
  const parent = file.parent;
  if (!parent || !parent.parent) return null;
  return parent.parent.path === rootPath ? parent.name : null;
}

/** Vault path for a new portfolio folder of the given (already-sanitised) name. */
export function portfolioPath(rootPath: string, name: string): string {
  return `${rootPath}/${name}`;
}

/** Destination path for moving a file named `fileName` into `folderPath`. */
export function targetPathFor(folderPath: string, fileName: string): string {
  return `${folderPath}/${fileName}`;
}

/** True when a file lives anywhere inside the portfolio root — i.e. it has been
 *  "filed". Filed objects move out of the main list into the Portfolios section. */
export function isFiledUnder(filePath: string, rootPath: string): boolean {
  return filePath.startsWith(`${rootPath}/`);
}
