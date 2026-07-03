/**
 * seal.ts — KNOBE Protocol v1 sealer.
 *
 * Writes a sealed .knobe.md. Keyless: integrity hash only, no signature, no
 * secret. Reuses lens-core's canonicalization (payloadHashOf / bodyHashOf) so
 * sealed output verifies under the exact same rules — no drift between seal and
 * verify. Gated by round-trip + idempotency tests (test/seal.test.ts).
 */

import { payloadHashOf, bodyHashOf, KNOBE_BEGIN_B64, KNOBE_END_B64 } from "./lens-core";

/** One entry in a note's reseal history. Written into the sealed payload (so it
 *  round-trips with the file and is covered by payload_hash), appended only on an
 *  explicit, comment-carrying reseal — never by auto-reseal-on-save. All fields
 *  are strings so the value never trips the conformance numeric-path check. */
export interface ResealComment {
  /** ISO timestamp of the reseal. */
  at: string;
  /** The author's note about what changed. */
  comment: string;
  /** body_hash in effect just before this reseal (optional). */
  prev_body_hash?: string;
  /** payload_hash the reseal descends from (optional; ties to lineage). */
  prev_payload_hash?: string;
}

export interface SealFields {
  title: string;
  summary: string;
  content_type: string;
  created_date: string;
  license: string;
  privacy_level: string;
  quarantine_status: string;
  attribution: { sources: Array<Record<string, unknown>> };
  /** Append-only log of reseal comments, carried inside the sealed payload. */
  reseal_log?: ResealComment[];
  [k: string]: unknown;
}

const BEGIN = KNOBE_BEGIN_B64;
const END = KNOBE_END_B64;
// Strip a trailing payload block (and any blank lines before it) when re-sealing.
// `[\r\n]*` tolerates CRLF blank lines so a CRLF note re-seals cleanly.
const BLOCK_STRIP = /[\r\n]*-----BEGIN KNOBE B64-----[\s\S]*?-----END KNOBE B64-----\s*$/;

/** Split a note into its YAML frontmatter and body, dropping any existing seal. */
export function splitNote(raw: string): { frontmatter: string; body: string } {
  let frontmatter = "";
  let rest = raw;
  const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (fm) {
    frontmatter = fm[0].replace(/\r?\n$/, "");
    rest = raw.slice(fm[0].length);
  }
  rest = rest.replace(BLOCK_STRIP, "");
  return { frontmatter, body: rest };
}

function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Produce a complete sealed .knobe.md string from frontmatter + body + fields.
 * Deterministic for fixed inputs, which is what makes re-seal-on-save loop-safe.
 */
export interface SealOptions {
  /** Embed a sealed copy of the body (ext_body_snapshot) for self-contained
   *  restore. Doubles the body and spreads content — off by default; the caller
   *  must not enable it for privacy-sensitive material. */
  embedBody?: boolean;
}

export async function sealKnobe(
  frontmatter: string, body: string, fields: SealFields, opts: SealOptions = {},
): Promise<string> {
  const trimmedBody = body.trim();
  const payload: Record<string, unknown> = { spec_version: "1.0", ...fields };
  if (opts.embedBody) payload.ext_body_snapshot = trimmedBody;
  payload.body_hash = await bodyHashOf(body);
  payload.payload_hash = await payloadHashOf(payload);
  const b64 = toBase64Utf8(JSON.stringify(payload)).replace(/(.{76})/g, "$1\n");
  const bodySection = trimmedBody ? `\n\n${trimmedBody}` : "";
  return `${frontmatter.trim()}${bodySection}\n\n${BEGIN}\n${b64}\n${END}\n`;
}
