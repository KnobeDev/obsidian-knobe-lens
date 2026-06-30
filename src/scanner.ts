import { App, TFile } from "obsidian";
import { verify, LensResult, hasKnobeMarker } from "./lens-core";

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

/** Object title: top-level `title` (PEM/B64 format) or `header.title` (the
 *  KNOBE.AI 0.1 envelope), falling back to the file name. */
function pickTitle(p: Record<string, unknown>, fallback: string): string {
  if (typeof p.title === "string") return p.title;
  const header = p.header;
  if (header && typeof header === "object" && typeof (header as Record<string, unknown>).title === "string") {
    return (header as Record<string, string>).title;
  }
  return fallback;
}

function parentHashes(payload: Record<string, unknown> | null): string[] {
  const parents = payload && Array.isArray(payload.parents) ? payload.parents : [];
  return parents.flatMap((p) =>
    p && typeof p === "object" && typeof (p as Record<string, unknown>).payload_hash === "string"
      ? [(p as Record<string, string>).payload_hash]
      : [],
  );
}

// Hard cap on filesystem reads during a deep disk reconciliation, so a vault
// with a large external/symlinked tree can't make the scan crawl. Only unindexed
// .md files are read, and only on an explicit user Rescan.
const MAX_DISK_READS = 300;

export interface DiskReconcileResult {
  /** Vault-relative paths of KNOBE files present on disk but not in the index. */
  paths: string[];
  /** True if the read cap was hit before all candidates were checked. */
  capped: boolean;
}

/**
 * Find KNOBE files that exist on disk but are missing from Obsidian's index
 * (e.g. added by another app while the watcher missed them). Directory listing
 * is cheap; only .md files absent from the index are read, capped at
 * MAX_DISK_READS. Dot-folders (.obsidian, .git, .trash, …) are skipped. Intended
 * for explicit user-triggered rescans only — not the live auto-refresh.
 */
export async function findUnindexedKnobeFiles(app: App): Promise<DiskReconcileResult> {
  const indexed = new Set(app.vault.getMarkdownFiles().map((f) => f.path));
  const adapter = app.vault.adapter;
  const candidates: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await adapter.list(dir);
    } catch {
      return; // unreadable directory — skip
    }
    for (const p of listing.files) {
      if (p.endsWith(".md") && !indexed.has(p)) candidates.push(p);
    }
    for (const sub of listing.folders) {
      const base = sub.split("/").pop() ?? sub;
      if (base.startsWith(".")) continue; // dot-folders aren't vault content
      await walk(sub);
    }
  };
  await walk("");

  const paths: string[] = [];
  let reads = 0;
  let capped = false;
  for (const p of candidates) {
    if (reads >= MAX_DISK_READS) {
      capped = true;
      break;
    }
    reads++;
    try {
      if (hasKnobeMarker(await adapter.read(p))) paths.push(p);
    } catch {
      /* unreadable file — skip */
    }
  }
  return { paths, capped };
}

/** Scan every markdown file for a KNOBE payload block and verify it. */
export async function scanVault(app: App): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const raw = await app.vault.cachedRead(file);
    if (!hasKnobeMarker(raw)) continue;
    const result = await verify(raw);
    const p = result.payload ?? {};
    rows.push({
      file,
      raw,
      result,
      title: pickTitle(p, file.basename),
      quarantine: typeof p.quarantine_status === "string" ? p.quarantine_status : "—",
      contentType: typeof p.content_type === "string" ? p.content_type : "—",
      payloadHash: result.computed,
      parents: parentHashes(result.payload),
    });
  }
  return rows;
}
