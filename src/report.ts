/**
 * report.ts — write/share a KNOBE verification report and pick the document to
 * verify. Local only: it runs the existing verifier and renders the result;
 * nothing leaves the machine. Pure rendering lives in report-render.ts.
 */

import { App, FuzzySuggestModal, Notice, TFile, normalizePath } from "obsidian";

export { buildReportMarkdown } from "./report-render";

export const REPORT_DIR = "KNOBE Reports";

/** Write the report into the vault's report folder and return the note. */
export async function writeReport(
  app: App,
  file: TFile,
  md: string,
  generatedAt: string,
): Promise<TFile> {
  if (!app.vault.getAbstractFileByPath(REPORT_DIR)) {
    await app.vault.createFolder(REPORT_DIR);
  }
  const stamp = generatedAt.replace(/:/g, "-").replace("T", " ").slice(0, 19);
  const path = normalizePath(`${REPORT_DIR}/${file.basename} — verification ${stamp}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, md);
    return existing;
  }
  return app.vault.create(path, md);
}

/** Fuzzy picker over candidate KNOBE documents. */
export class KnobePickModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Pick a .knobe.md document to verify");
  }
  getItems(): TFile[] {
    return this.files;
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

export function reportFailedNotice(): void {
  new Notice("KNOBE report failed — see the developer console.");
}
