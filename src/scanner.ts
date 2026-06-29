import { App, TFile } from "obsidian";
import { verify, LensResult } from "./lens-core";

const MARKER = "-----BEGIN KNOBE B64-----";

export interface ScanRow {
  file: TFile;
  raw: string;
  result: LensResult;
  title: string;
  quarantine: string;
  contentType: string;
  /** Content identity hash (verifier's computed hash); null when unreadable. */
  payloadHash: string | null;
  /** Declared parent payload hashes, for lineage. */
  parents: string[];
}

function parentHashes(payload: Record<string, unknown> | null): string[] {
  const parents = payload && Array.isArray(payload.parents) ? payload.parents : [];
  return parents.flatMap((p) =>
    p && typeof p === "object" && typeof (p as Record<string, unknown>).payload_hash === "string"
      ? [(p as Record<string, string>).payload_hash]
      : [],
  );
}

/** Scan every markdown file for a KNOBE payload block and verify it. */
export async function scanVault(app: App): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const raw = await app.vault.cachedRead(file);
    if (!raw.includes(MARKER)) continue;
    const result = await verify(raw);
    const p = result.payload ?? {};
    rows.push({
      file,
      raw,
      result,
      title: typeof p.title === "string" ? p.title : file.basename,
      quarantine: typeof p.quarantine_status === "string" ? p.quarantine_status : "—",
      contentType: typeof p.content_type === "string" ? p.content_type : "—",
      payloadHash: result.computed,
      parents: parentHashes(result.payload),
    });
  }
  return rows;
}
