import { describe, expect, it } from "vitest";
import { PROTOCOL_REFERENCE } from "../src/protocol-info";
import { CANONICAL_VOCAB, REQUIRED } from "../src/lens-core";

describe("protocol reference", () => {
  it("glosses every canonical vocabulary term (no drift from the verifier)", () => {
    // Fields the reference surfaces as term lists.
    const surfaced = ["content_type", "privacy_level", "quarantine_status"];
    const allTerms = PROTOCOL_REFERENCE.flatMap((s) => s.terms ?? []);
    for (const field of surfaced) {
      for (const value of CANONICAL_VOCAB[field]) {
        const entry = allTerms.find((t) => t.term === value);
        expect(entry, `missing reference term for ${field}=${value}`).toBeTruthy();
        expect(entry?.def).not.toBe("(no description)");
      }
    }
  });

  it("lists exactly the ten required fields the verifier enforces", () => {
    const fieldsSection = PROTOCOL_REFERENCE.find((s) => Array.isArray(s.list));
    expect(fieldsSection?.list).toEqual([...REQUIRED]);
    expect(REQUIRED.length).toBe(10);
  });

  it("every section has a heading and some content", () => {
    for (const s of PROTOCOL_REFERENCE) {
      expect(s.heading.length).toBeGreaterThan(0);
      const hasBody = !!s.intro || !!(s.terms && s.terms.length) || !!(s.list && s.list.length);
      expect(hasBody, `section "${s.heading}" is empty`).toBe(true);
    }
  });
});
