/**
 * report-render.ts — pure Markdown rendering for a KNOBE verification report.
 * No Obsidian imports, so it is unit-testable in isolation.
 */

import { LensResult } from "./lens-core";
import { TrustEntry } from "./trust";

const STATUS_LABEL: Record<string, string> = {
  verified: "Verified — seal intact",
  "verified-body-modified": "Verified, body modified after sealing",
  failed: "Failed — seal does not match",
  unreadable: "Unreadable — no valid payload",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "_None._";
}

function attributionLine(payload: Record<string, unknown> | null): string {
  const att = payload?.attribution;
  if (!att || typeof att !== "object") return "_Not declared._";
  const sources = (att as Record<string, unknown>).sources;
  if (!Array.isArray(sources) || !sources.length) return "_Not declared._";
  return sources
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const author = str(o.author) ?? "unknown";
      const contribution = str(o.contribution);
      return `- ${author}${contribution ? ` — ${contribution}` : ""}`;
    })
    .join("\n");
}

export function buildReportMarkdown(args: {
  file: { basename: string; path: string };
  result: LensResult;
  verdict: TrustEntry | null;
  generatedAt: string;
}): string {
  const { file, result: r, verdict, generatedAt } = args;
  const p = r.payload;
  const match = r.computed !== null && r.computed === r.stored;

  const declared = [
    ["Title", str(p?.title)],
    ["Content type", str(p?.content_type)],
    ["Quarantine status", str(p?.quarantine_status)],
    ["Privacy level", str(p?.privacy_level)],
    ["License", str(p?.license)],
    ["Created", str(p?.created_date)],
  ]
    .map(([k, v]) => `| ${k} | ${v ?? "—"} |`)
    .join("\n");

  return `# KNOBE verification report — ${file.basename}

| | |
|---|---|
| **Document** | \`${file.path}\` |
| **Verified at** | ${generatedAt} |
| **Status** | ${STATUS_LABEL[r.state] ?? r.state} |
| **Conformance** | ${r.conformance} |
| **Body** | ${r.bodyVerified ?? "—"} |
| **Payload blocks** | ${r.blockCount}${r.multipleBlocks ? " (last block evaluated, per spec §3.3)" : ""} |

## Integrity

| | |
|---|---|
| Stored \`payload_hash\` | \`${r.stored || "—"}\` |
| Computed \`payload_hash\` | \`${r.computed || "—"}\` |
| Match | ${match ? "✅ yes" : "❌ no"} |

## Conformance issues

${bullets(r.conformanceIssues)}

## Missing required fields

${bullets(r.missing)}

## Declared metadata (from the sealed payload)

| Field | Value |
|---|---|
${declared}

**Attribution**
${attributionLine(p)}

## Local trust verdict

${verdict ? `**${verdict.verdict}**${verdict.note ? ` — ${verdict.note}` : ""} _(recorded ${verdict.at})_` : "_No local verdict recorded._"}

---
> **Integrity is not truth.** A verified seal proves the payload is byte-intact — not that the content is true, safe, or cleared. Inspect quarantined objects before trusting. Report generated locally by KNOBE Lens.
`;
}
