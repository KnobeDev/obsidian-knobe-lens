/**
 * seal.ts — KNOBE Protocol v1 sealer.
 *
 * Writes a sealed .knobe.md. Keyless: integrity hash only, no signature, no
 * secret. Reuses lens-core's canonicalization (payloadHashOf / bodyHashOf) so
 * sealed output verifies under the exact same rules — no drift between seal and
 * verify. Gated by round-trip + idempotency tests (test/seal.test.ts).
 */

import { payloadHashOf, bodyHashOf, verify, KNOBE_BEGIN_B64, KNOBE_END_B64 } from "./lens-core";

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
  /** Plain-language instruction set for AI/readers, sealed into the payload.
   *  Advisory by protocol posture — never absolute. Omitted when blank. */
  instructions?: string;
  /** Append-only log of reseal comments, carried inside the sealed payload. */
  reseal_log?: unknown[];
  [k: string]: unknown;
}

const BEGIN = KNOBE_BEGIN_B64;
const END = KNOBE_END_B64;
// Strip a trailing payload block (and any blank lines before it) when re-sealing.
// `[\r\n]*` tolerates CRLF blank lines so a CRLF note re-seals cleanly.
const BLOCK_STRIP = /[\r\n]*-----BEGIN KNOBE B64-----(?:(?!-----BEGIN KNOBE B64-----)[\s\S])*?-----END KNOBE B64-----\s*$/;
const RECOMPUTED_FIELDS = new Set(["spec_version", "payload_hash", "body_hash", "ext_body_snapshot"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/**
 * Carry an intact payload into a new seal without shedding optional or extension
 * fields. Hash fields and the plugin-managed body snapshot are recomputed by the
 * sealer. Attribution overrides update matching sources while preserving source
 * metadata and additional contributors.
 */
export function mergePayloadFields(
  existing: Record<string, unknown>,
  overrides: Partial<SealFields>,
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!RECOMPUTED_FIELDS.has(key)) carried[key] = value;
  }

  const merged: Record<string, unknown> = { ...carried, ...overrides };
  const oldAttribution = record(carried.attribution);
  const newAttribution = record(overrides.attribution);
  const oldSources = oldAttribution && Array.isArray(oldAttribution.sources) ? oldAttribution.sources : null;
  const newSources = newAttribution && Array.isArray(newAttribution.sources) ? newAttribution.sources : null;
  if (oldAttribution && newAttribution && oldSources && newSources) {
    const sources = oldSources.slice();
    for (let i = 0; i < newSources.length; i++) {
      const oldSource = record(oldSources[i]);
      const newSource = record(newSources[i]);
      sources[i] = oldSource && newSource ? { ...oldSource, ...newSource } : newSources[i];
    }
    merged.attribution = { ...oldAttribution, ...newAttribution, sources };
  }
  return merged;
}

/** Create a protocol-shaped lineage receipt. */
export function parentReceipt(
  payloadHash: string,
  relationship: string,
  title?: string,
): Record<string, string> {
  return {
    payload_hash: payloadHash,
    relationship,
    ...(title ? { title } : {}),
  };
}

/**
 * Fields to carry from a note's existing intact seal into a fresh seal: every
 * non-recomputed payload field, so opaque/extension/fidelity/consent/attribution
 * context survives a re-seal. Returns `{}` for a note with no seal, or one whose
 * seal is not intact (verified / body-modified) — never launder a broken or
 * tampered payload into a new seal.
 */
export async function carriedFields(raw: string): Promise<Partial<SealFields>> {
  if (!raw.includes(KNOBE_BEGIN_B64)) return {};
  const r = await verify(raw);
  if (r.state !== "verified" && r.state !== "verified-body-modified") return {};
  return mergePayloadFields(r.payload ?? {}, {}) as Partial<SealFields>;
}

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
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
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
  // Blank/undefined instruction sets are never sealed — callers pass
  // `instructions: undefined` to mean "removed" (see detailsToOverrides).
  if (typeof payload.instructions !== "string" || !payload.instructions.trim()) {
    delete payload.instructions;
  }
  if (opts.embedBody) payload.ext_body_snapshot = trimmedBody;
  payload.body_hash = await bodyHashOf(trimmedBody);
  payload.payload_hash = await payloadHashOf(payload);
  const b64 = toBase64Utf8(JSON.stringify(payload)).replace(/(.{76})/g, "$1\n");
  const bodySection = trimmedBody ? `\n\n${trimmedBody}` : "";
  return `${frontmatter.trim()}${bodySection}\n\n${BEGIN}\n${b64}\n${END}\n`;
}
