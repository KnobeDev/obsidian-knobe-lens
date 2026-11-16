/**
 * report-render.ts — pure Markdown rendering for a KNOBE verification report.
 * No Obsidian imports, so it is unit-testable in isolation.
 */

import { Conformance, LensResult, OtherFormatCheck, Status, safe } from "./lens-core";
import { TrustEntry } from "./trust";

const STATUS_LABEL: Record<Status, string> = {
  verified: "Verified — seal intact",
  "verified-body-modified": "Verified, body modified after sealing",
  failed: "Failed — seal does not match",
  unreadable: "Unreadable — no valid payload",
  "not-v1": "Not a KNOBE v1 result",
};

const CONFORMANCE_LABEL: Record<Conformance, string> = {
  valid: "valid",
  warnings: "warnings",
  invalid: "invalid",
  "not-assessed": "not assessed (not a KNOBE v1 object)",
};

const HEX64 = /^[0-9a-f]{64}$/;
// Longest conformance issue shown. Issues can quote payload keys of any length.
const ISSUE_LIMIT = 1000;
// Field names listed in a non-v1 report before the rest are counted.
const MAX_REPORT_FIELDS = 50;

const V1_FOOTER = "> **Integrity is not truth.** A verified seal proves the payload is byte-intact — not that the content is true, safe, or cleared. Inspect quarantined objects before trusting.";
const OTHER_FORMAT_FOOTER = "> **Not a KNOBE v1 result.** This file's own hash covers only the fields it lists. A match says nothing about the rest of the file, or about whether the content is true, safe, or cleared.";

/** Payload-derived text as inert Markdown on one line. safe() first: control
 *  characters, line breaks, bidi controls and unpaired surrogates become visible
 *  escapes, and the text is cut at `limit` characters. Then every ASCII
 *  punctuation character gets a backslash, which CommonMark and GFM always read
 *  as a literal, so no code span, table cell, link, image or heading can open;
 *  this also covers Obsidian's $math$, ==highlight==, [[links]] and #tags.
 *  `%` becomes an entity instead, so no %%comment%% can hide the rest of the
 *  report. */
function safeMarkdown(v: unknown, limit: number | null = 300): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return safe(v, limit).replace(/[!-/:-@[-`{-~]/g, (c) => (c === "%" ? "&#37;" : "\\" + c));
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${safeMarkdown(i, ISSUE_LIMIT) ?? "—"}`).join("\n") : "_None._";
}

/** A hash cell. Only a well-formed hash goes in a code span: anything else is
 *  payload text, so it is escaped like any other. */
function hashCell(h: string | null): string {
  if (h === null || h === "") return "—";
  if (HEX64.test(h)) return `\`${h}\``;
  return `${safeMarkdown(h) ?? "(blank)"} _(not a 64-character lowercase hex hash)_`;
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

/** Status cell. A non-v1 file names its own format after the label. */
function statusCell(r: LensResult): string {
  const label = STATUS_LABEL[r.state] ?? r.state;
  return r.otherFormat ? `${label} — ${safeMarkdown(r.otherFormat.format) ?? "other format"} file` : label;
}

/** Integrity section for a non-v1 file: its own hash check, labelled as such,
 *  never as a payload_hash match. */
function otherFormatIntegrity(r: LensResult, check: OtherFormatCheck): string {
  const match = check.hashMatches === null ? "not checked"
    : check.hashMatches ? "yes, for the listed fields only" : "no";
  const shown = check.coveredFields.slice(0, MAX_REPORT_FIELDS).map((f) => safeMarkdown(f, 60) ?? "(blank)").join(", ");
  const more = check.coveredFields.length - MAX_REPORT_FIELDS;
  const fields = more > 0 ? `${shown}, and ${more} more` : shown;
  return `_${safeMarkdown(check.format) ?? "Other format"} hash, not a KNOBE v1 check._ ${safeMarkdown(r.reason, ISSUE_LIMIT) ?? ""}

| | |
|---|---|
| Stored \`integrity.sha256\` | ${hashCell(r.stored)} |
| Computed over the listed fields | ${hashCell(r.computed)} |
| Fields the file lists | ${fields || "—"} |
| Match | ${match} |`;
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
| **${r.otherFormat ? "Checked at" : "Verified at"}** | ${safeMarkdown(generatedAt) ?? "—"} |
| **Status** | ${statusCell(r)} |
| **Conformance** | ${CONFORMANCE_LABEL[r.conformance] ?? r.conformance} |
| **Body** | ${r.bodyVerified ?? "—"} |
| **Payload blocks** | ${r.blockCount}${r.multipleBlocks ? " (last block evaluated, per spec §3.3)" : ""} |

## Integrity

${r.otherFormat ? otherFormatIntegrity(r, r.otherFormat) : `| | |
|---|---|
| Stored \`payload_hash\` | ${hashCell(r.stored)} |
| Computed \`payload_hash\` | ${hashCell(r.computed)} |
| Match | ${match ? "✅ yes" : "❌ no"} |`}

## Conformance issues

${bullets(r.conformanceIssues)}

## Missing required fields

${bullets(r.missing)}

## Declared metadata (from the ${r.otherFormat ? "file's payload" : "sealed payload"})

| Field | Value |
|---|---|
${declared}

**Attribution**
${attributionLine(p)}

## Local trust verdict

${verdict ? `**${verdict.verdict}**${verdict.note ? ` — ${safeMarkdown(verdict.note)}` : ""} _(recorded ${safeMarkdown(verdict.at)})_` : "_No local verdict recorded._"}

---
${r.otherFormat ? OTHER_FORMAT_FOOTER : V1_FOOTER} Report generated locally by KNOBE Lens (KnobeDev).
`;
}
