import { describe, expect, it } from "vitest";
import { KNOBE_EXAMPLES, decodeExample } from "../src/examples";
import { verify, hasKnobeMarker } from "../src/lens-core";

describe("bundled KNOBE examples", () => {
  it("ships a non-empty, unique-id set", () => {
    expect(KNOBE_EXAMPLES.length).toBeGreaterThan(0);
    const ids = KNOBE_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const ex of KNOBE_EXAMPLES) {
    describe(ex.id, () => {
      const text = decodeExample(ex);

      it("decodes to a sealed KNOBE document", () => {
        expect(text.length).toBeGreaterThan(0);
        expect(hasKnobeMarker(text)).toBe(true);
      });

      it("verifies clean under the plugin's own verifier", async () => {
        const r = await verify(text);
        expect(r.state).toBe("verified");
        expect(r.conformance).toBe("valid");
        expect(r.bodyVerified).toBe("yes");
      });

      it("declares the metadata the picker advertises", async () => {
        const p = (await verify(text)).payload ?? {};
        expect(p.title).toBe(ex.title);
        expect(p.content_type).toBe(ex.kind);
        expect(p.quarantine_status).toBe(ex.quarantine);
      });
    });
  }

  it("keeps the enterprise source→synthesis lineage intact (draws an arc)", async () => {
    const source = KNOBE_EXAMPLES.find((e) => e.id === "enterprise-source");
    const synth = KNOBE_EXAMPLES.find((e) => e.id === "enterprise-agent-synthesis");
    expect(source && synth).toBeTruthy();

    const srcHash = (await verify(decodeExample(source!))).computed;
    const synParents = (await verify(decodeExample(synth!))).payload?.parents as
      | Array<Record<string, unknown>>
      | undefined;
    expect(srcHash).toBeTruthy();
    expect(synParents?.some((p) => p.payload_hash === srcHash)).toBe(true);
  });
});
