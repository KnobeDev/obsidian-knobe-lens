/**
 * protocol-info.ts — an in-app reference for KNOBE Protocol v1.
 *
 * The plugin verifies KNOBE objects but never explained the protocol it checks
 * against. This module carries a plain-language reference (states, conformance,
 * the field vocabulary, honest limits, links) so a user can learn what the
 * dashboard is telling them without leaving Obsidian.
 *
 * The vocabulary sections are generated from lens-core's canonical vocab, so
 * they can never drift from what the verifier actually accepts. Prose is
 * paraphrased from the KNOBE Protocol project (knobe.org, CC BY 4.0).
 */

import { CANONICAL_VOCAB, REQUIRED } from "./lens-core";

export const KNOBE_LINKS: Record<string, string> = {
  home: "https://knobe.org",
  spec: "https://knobe.org/spec",
  lens: "https://knobe.org/lens",
  threatModel: "https://knobe.org/threat-model",
};

export interface RefTerm {
  term: string;
  def: string;
}
export interface RefSection {
  heading: string;
  intro?: string;
  terms?: RefTerm[];
  /** A plain bullet list (used for the required-field roster). */
  list?: string[];
}

/** Human glosses for each canonical vocabulary term. Every value a term can
 *  take (per lens-core's CANONICAL_VOCAB) has an entry here — the drift guard
 *  in protocol-info.test.ts fails the build if one is ever missing. */
const GLOSS: Record<string, Record<string, string>> = {
  content_type: {
    original: "First-party content authored here — not derived from another KNOBE.",
    synthesis: "New content generated from one or more sources (e.g. an AI-written summary).",
    adaptation: "The same content reworked for a new audience or medium (e.g. an accessibility remediation).",
    compression: "A shortened form — a digest or summary that deliberately drops detail.",
    annotation: "Commentary, markup, or notes layered onto an existing object.",
    seed: "A minimal starting point meant to be grown, forked, or expanded.",
    collection: "A bundle that groups several objects together.",
    translation: "The same content rendered in another language.",
  },
  privacy_level: {
    public: "No access restriction declared.",
    internal: "For an organization or group, not the open public.",
    sensitive: "Handle with care — limited distribution.",
    restricted: "Tightly controlled; the body may be withheld from embedded snapshots.",
  },
  quarantine_status: {
    quarantine: "Newly sealed or not yet reviewed — inspect before relying on it.",
    trusted: "The maker (or a reviewer) has vouched for it.",
    rejected: "Flagged as not to be relied upon.",
  },
  identity_status: {
    declared: "Attribution is asserted by the maker, not cryptographically signed.",
    signed: "Attribution is backed by a signature.",
  },
};

/** Turn a canonical vocab set into reference terms, in the vocab's own order. */
function vocabTerms(field: string): RefTerm[] {
  const set = CANONICAL_VOCAB[field];
  const glosses = GLOSS[field] ?? {};
  return [...(set ?? [])].map((term) => ({ term, def: glosses[term] ?? "(no description)" }));
}

export const PROTOCOL_REFERENCE: RefSection[] = [
  {
    heading: "What a KNOBE is",
    intro:
      "A KNOBE is a single Markdown file with three layers: human-scannable YAML frontmatter, the Markdown body itself, and a Base64-encoded JSON payload carrying attribution, transformation history, fidelity limits, use conditions, accessibility lineage, and a SHA-256 integrity hash. A human reads the first two layers; a verifier checks the third. No sidecar files, platform, or account required.",
  },
  {
    heading: "Three independent verdicts",
    intro: "KNOBE Lens reports three things that do not imply one another.",
    terms: [
      { term: "Integrity (status)", def: "Is the sealed payload byte-intact? — verified, body modified, failed, or unreadable." },
      { term: "Body verified", def: "Does the visible body still match its recorded body_hash? — yes, modified, or omitted." },
      { term: "Conformance", def: "Does the payload satisfy the v1 schema? — valid, warnings, or invalid." },
    ],
  },
  {
    heading: "Recognition states",
    terms: [
      { term: "Verified", def: "The sealed payload is byte-identical to what was hashed when it was sealed." },
      { term: "Body modified", def: "The payload seal is intact, but the visible body changed since sealing — reverify before relying on it." },
      { term: "Failed", def: "The stored hash does not match the payload: the seal is broken or the payload was edited." },
      { term: "Unreadable", def: "No decodable KNOBE payload block was found in the note." },
    ],
  },
  {
    heading: "Conformance",
    terms: [
      { term: "Valid", def: "Every required field is present and well-formed." },
      { term: "Warnings", def: "Verifies, but something is non-canonical (e.g. multiple payload blocks or an unnamespaced custom vocabulary value)." },
      { term: "Invalid", def: "A required field is missing or malformed." },
    ],
  },
  {
    heading: "Content kinds (content_type)",
    intro: "The kind of knowledge object. On the Knowledge world, grouping by Kind turns each of these into a continent.",
    terms: vocabTerms("content_type"),
  },
  {
    heading: "Privacy levels (privacy_level)",
    terms: vocabTerms("privacy_level"),
  },
  {
    heading: "Quarantine status (quarantine_status)",
    intro: "A declared trust posture — the maker's claim, not a verdict. Your own local review is separate and never written to the file.",
    terms: vocabTerms("quarantine_status"),
  },
  {
    heading: "Required fields",
    intro: "A conformant v1 payload declares all ten:",
    list: [...REQUIRED],
  },
  {
    heading: "Honest limits",
    intro:
      "A verified result proves the payload is byte-identical to what was hashed at sealing. It does not prove the content is accurate, the attribution honest, the consent real, or the object appropriate for any particular use. Integrity is the substrate; interpretive context is the point. KNOBE is not DRM, not a truth machine, and not an identity system.",
  },
];
