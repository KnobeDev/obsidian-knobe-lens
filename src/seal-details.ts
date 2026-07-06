/**
 * seal-details.ts — pure logic behind the "Save with KNOBE" prompt.
 *
 * The modal (seal-details-modal.ts) collects a SealDetails record; these
 * helpers translate between plugin settings / an existing sealed payload and
 * that record, and from the record to SealFields overrides for the sealer.
 * Kept free of Obsidian imports so it is unit-testable (test/seal-details.test.ts).
 */

import type { SealFields } from "./seal";
import type { KnobeLensSettings } from "./settings";

/** Everything the user can edit in the save prompt. All plain strings. */
export interface SealDetails {
  title: string;
  summary: string;
  author: string;
  contribution: string;
  license: string;
  content_type: string;
  privacy_level: string;
  quarantine_status: string;
  /** Plain-language instruction set sealed into the payload (advisory). */
  instructions: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** First attribution source of an intact payload, or null if malformed. */
function payloadSource(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const attribution = payload?.attribution;
  if (!attribution || typeof attribution !== "object") return null;
  const sources = (attribution as Record<string, unknown>).sources;
  if (!Array.isArray(sources) || !sources[0] || typeof sources[0] !== "object") return null;
  return sources[0] as Record<string, unknown>;
}

/**
 * Initial values for the prompt. `fields` is the plugin's usual seal-field
 * resolution (frontmatter over settings); the existing payload — when the note
 * is already a sealed KNOBE — wins for the two things only it can know:
 * the instruction set and the attribution author/contribution.
 */
export function prefillDetails(
  settings: KnobeLensSettings, fields: SealFields, payload: Record<string, unknown> | null,
): SealDetails {
  const source = payloadSource(payload);
  return {
    title: fields.title,
    summary: fields.summary,
    author: str(source?.author) ?? settings.author,
    contribution: str(source?.contribution) ?? settings.contribution,
    license: fields.license,
    content_type: fields.content_type,
    privacy_level: fields.privacy_level,
    quarantine_status: fields.quarantine_status,
    instructions: str(payload?.instructions) ?? settings.defaultInstructions,
  };
}

/**
 * Convert the user's edited details into overrides for buildSealed(). Text is
 * trimmed. The `instructions` key is always present: a blank value becomes
 * undefined, which tells buildSealed "the user cleared this" (so it must not
 * carry the previously sealed instructions forward), and the sealer itself
 * drops blank/undefined instructions so the payload never carries an empty field.
 */
export function detailsToOverrides(d: SealDetails): Partial<SealFields> {
  return {
    title: d.title.trim() || "(untitled)",
    summary: d.summary.trim() || "(no summary provided)",
    content_type: d.content_type,
    license: d.license.trim() || "unknown",
    privacy_level: d.privacy_level,
    quarantine_status: d.quarantine_status,
    attribution: {
      sources: [{ author: d.author.trim() || "unknown", contribution: d.contribution.trim() || "authorship" }],
    },
    instructions: d.instructions.trim() || undefined,
  };
}
