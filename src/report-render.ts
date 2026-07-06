/**
 * report-render.ts — pure Markdown rendering for a KNOBE verification report.
 * No Obsidian imports, so it is unit-testable in isolation.
 */

import { LensResult, Status } from "./lens-core";
import { TrustEntry } from "./trust";

const STATUS_LABEL: Record<Status, string> = {
  verified: "Verified — seal intact",
  "verified-body-modified": "Verified, body modified after sealing",
  failed: "Failed — seal does not match",
  unreadable: "Unreadable — no valid payload",
};

function safeMarkdown(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const visibleControls = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  return visibleControls
    .replace(/`/g, "\\x60")
    .replace(/([\\!*_[\]{}<>#+|~-])/g, "\\$1");
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${safeMarkdown(i) ?? "—"}`).join("\n") : "_None._";
}

function attributionLine(payload: Record<string, unknown> | null): string {
  const att = payload?.attribution;
  if (!att || typeof att !== "object") return "_Not declared._";
  const sources = (att as Record<string, unknown>).sources;
  if (!Array.isArray(sources) || !sources.length) return "_Not declared._";
  return sources
    .map((s) => {
      const o = (s && typeof s === "object") ? (s as Record<string, unknown>) : {};
      const author = safeMarkdown(o.author) ?? "unknown";
      const contribution = safeMarkdown(o.contribution);
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
    ["Title", safeMarkdown(p?.title)],
    ["Content type", safeMarkdown(p?.content_type)],
    ["Quarantine status", safeMarkdown(p?.quarantine_status)],
    ["Privacy level", safeMarkdown(p?.privacy_level)],
    ["License", safeMarkdown(p?.license)],
    ["Created", safeMarkdown(p?.created_date)],
  ]
    .map(([k, v]) => `| ${k} | ${v ?? "—"} |`)
    .join("\n");

  return `# KNOBE verification report — ${safeMarkdown(file.basename) ?? "untitled"}

| | |
|---|---|
| **Document** | ${safeMarkdown(file.path) ?? "—"} |
| **Verified at** | ${safeMarkdown(generatedAt) ?? "—"} |
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

${verdict ? `**${verdict.verdict}**${verdict.note ? ` — ${safeMarkdown(verdict.note)}` : ""} _(recorded ${safeMarkdown(verdict.at)})_` : "_No local verdict recorded._"}

---
> **Integrity is not truth.** A verified seal proves the payload is byte-intact — not that the content is true, safe, or cleared. Inspect quarantined objects before trusting. Report generated locally by KNOBE Lens.
`;
}
