import { describe, it, expect } from "vitest";
import { mergePayloadFields, parentReceipt, sealKnobe, splitNote, SealFields } from "../src/seal";
import { verify } from "../src/lens-core";

const FM = `---\ntitle: "Round Trip"\nspec_version: "1.0"\n---`;
const BODY = "# Round Trip\n\nHello world. This body gets sealed.";

const fields = (): SealFields => ({
  title: "Round Trip",
  summary: "demo object",
  content_type: "original",
  created_date: "2026-06-28",
  license: "CC BY 4.0",
  privacy_level: "public",
  quarantine_status: "quarantine",
  attribution: { sources: [{ author: "A. Author", contribution: "authorship" }] },
});

describe("sealer round-trips through the verifier", () => {
  it("seal -> verify = verified / body yes / valid", async () => {
    const r = await verify(await sealKnobe(FM, BODY, fields()));
    expect(r.state).toBe("verified");
    expect(r.bodyVerified).toBe("yes");
    expect(r.conformance).toBe("valid");
  });

  it("editing the sealed body is detected as body-modified", async () => {
    const sealed = await sealKnobe(FM, BODY, fields());
    const r = await verify(sealed.replace("Hello world.", "Hello changed world."));
    expect(r.state).toBe("verified-body-modified");
  });

  it("works with no pre-existing frontmatter (minimal frontmatter is synthesized)", async () => {
    const r = await verify(await sealKnobe(`---\ntitle: "x"\nspec_version: "1.0"\n---`, "plain body", fields()));
    expect(r.state).toBe("verified");
    expect(r.conformance).toBe("valid");
  });

  it("is idempotent — re-sealing yields identical bytes (no save loop)", async () => {
    const once = await sealKnobe(FM, BODY, fields());
    const split = splitNote(once);
    const twice = await sealKnobe(split.frontmatter, split.body, fields());
    expect(twice).toBe(once);
  });

  it("re-sealing strips the previous block — exactly one seal remains", async () => {
    const once = await sealKnobe(FM, BODY, fields());
    const split = splitNote(once);
    const twice = await sealKnobe(split.frontmatter, split.body, fields());
    expect((twice.match(/-----BEGIN KNOBE B64-----/g) || []).length).toBe(1);
  });

  it("embed body snapshot: round-trips and carries ext_body_snapshot", async () => {
    const sealed = await sealKnobe(FM, BODY, fields(), { embedBody: true });
    const r = await verify(sealed);
    expect(r.state).toBe("verified");
    expect(r.conformance).toBe("valid");
    const snap = (r.payload as Record<string, unknown>).ext_body_snapshot;
    expect(typeof snap).toBe("string");
    expect(snap as string).toContain("This body gets sealed");
  });

  it("embed body snapshot is idempotent (no reseal loop)", async () => {
    const once = await sealKnobe(FM, BODY, fields(), { embedBody: true });
    const split = splitNote(once);
    const twice = await sealKnobe(split.frontmatter, split.body, fields(), { embedBody: true });
    expect(twice).toBe(once);
  });

  it("reseal_log rides inside the sealed payload, verifies, and stays conformant", async () => {
    const withLog = (): SealFields => ({
      ...fields(),
      reseal_log: [{ at: "2026-07-02T10:00:00.000Z", comment: "fixed the citation in §2", prev_payload_hash: "abc" }],
    });
    const r = await verify(await sealKnobe(FM, BODY, withLog()));
    expect(r.state).toBe("verified");
    // The comment history is integrity-protected (covered by payload_hash) and
    // all-string, so conformance stays valid — no numeric-path downgrade.
    expect(r.conformance).toBe("valid");
    const log = (r.payload as Record<string, unknown>).reseal_log as Array<{ comment: string }>;
    expect(Array.isArray(log)).toBe(true);
    expect(log[0].comment).toBe("fixed the citation in §2");
  });

  it("a note without reseal_log seals identically to before (back-compat)", async () => {
    const sealed = await sealKnobe(FM, BODY, fields());
    expect(sealed).not.toContain("reseal_log");
    const r = await verify(sealed);
    expect(r.state).toBe("verified");
  });

  it("losslessly carries protocol context and opaque extensions through a reseal", () => {
    const existing = {
      ...fields(),
      payload_hash: "a".repeat(64),
      body_hash: "b".repeat(64),
      fidelity_limits: { represents: "source excerpt", do_not_infer: ["completeness"] },
      use_conditions: { consent_note: "classroom use only" },
      accessibility: [{ adaptation_type: "simplification", review_date: "2026-07-01" }],
      transformation_history: [{ date: "2026-07-01", strategy: "summarized" }],
      attribution: {
        sources: [
          { author: "Original", contribution: "authorship", rights_bearing: true },
          { author: "Research assistant", contribution: "fact checking" },
        ],
      },
      "lab:review_state": "approved",
    };

    const merged = mergePayloadFields(existing, {
      title: "Updated title",
      attribution: { sources: [{ author: "Updated", contribution: "editing" }] },
    });

    expect(merged).toMatchObject({
      title: "Updated title",
      fidelity_limits: existing.fidelity_limits,
      use_conditions: existing.use_conditions,
      accessibility: existing.accessibility,
      transformation_history: existing.transformation_history,
      "lab:review_state": "approved",
    });
    expect(merged.attribution).toEqual({
      sources: [
        { author: "Updated", contribution: "editing", rights_bearing: true },
        { author: "Research assistant", contribution: "fact checking" },
      ],
    });
    expect(merged).not.toHaveProperty("payload_hash");
    expect(merged).not.toHaveProperty("body_hash");
  });

  it("creates protocol-shaped parent relationship receipts", () => {
    expect(parentReceipt("a".repeat(64), "supersedes")).toEqual({
      payload_hash: "a".repeat(64),
      relationship: "supersedes",
    });
  });
});
