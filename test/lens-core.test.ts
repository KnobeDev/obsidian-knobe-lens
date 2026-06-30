import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verify, hasKnobeMarker } from "../src/lens-core";

const ROOT = process.cwd();
const VEC = join(ROOT, "test", "vectors");

interface Expected {
  state: string;
  conformance: string;
  body_verified: string | null;
  computed: string | null;
  stored: string | null;
  block_count: number;
}
const expected: Record<string, Expected> = JSON.parse(
  readFileSync(join(ROOT, "test", "expected.json"), "utf-8"),
);

describe("lens-core matches reference lens.py on the 9 conformance vectors", () => {
  for (const file of Object.keys(expected)) {
    it(file, async () => {
      const raw = readFileSync(join(VEC, file), "utf-8");
      const r = await verify(raw);
      const e = expected[file];
      expect(r.state).toBe(e.state);
      expect(r.conformance).toBe(e.conformance);
      expect(r.bodyVerified).toBe(e.body_verified);
      expect(r.blockCount).toBe(e.block_count);
      if (e.computed !== null) expect(r.computed).toBe(e.computed);
      if (e.stored) expect(r.stored).toBe(e.stored);
    });
  }
});

describe("hardening cases beyond the published vectors", () => {
  const wrap = (b64: string) =>
    `---\ntitle: "x"\nspec_version: "1.0"\n---\n\n# x\n\nbody\n\n-----BEGIN KNOBE B64-----\n${b64}\n-----END KNOBE B64-----\n`;
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

  it("duplicate JSON key -> unreadable", async () => {
    const r = await verify(wrap(b64('{"a":"1","a":"2"}')));
    expect(r.state).toBe("unreadable");
  });

  it("NaN constant -> unreadable", async () => {
    const r = await verify(wrap(b64('{"a":NaN}')));
    expect(r.state).toBe("unreadable");
  });

  it("payload that is a JSON array -> unreadable", async () => {
    const r = await verify(wrap(b64('["not","an","object"]')));
    expect(r.state).toBe("unreadable");
  });

  it("no payload block -> unreadable", async () => {
    const r = await verify("# just markdown, no seal\n");
    expect(r.state).toBe("unreadable");
  });
});

describe("line-ending robustness (CRLF / doubled-CR exporters)", () => {
  const lfFor = (file: string) => readFileSync(join(VEC, file), "utf-8");

  it("CRLF verifies identically to LF (minimal-valid)", async () => {
    const lf = lfFor("minimal-valid.knobe.md");
    const a = await verify(lf);
    const b = await verify(lf.replace(/\n/g, "\r\n"));
    expect(a.state).toBe("verified");
    expect(b.state).toBe("verified");
    expect(b.computed).toBe(a.computed);
    expect(b.stored).toBe(a.stored);
    expect(b.blockCount).toBe(1);
    expect(b.conformance).toBe(a.conformance);
  });

  it("doubled-CR (\\r\\r\\n) still verifies (minimal-valid)", async () => {
    const lf = lfFor("minimal-valid.knobe.md");
    const a = await verify(lf);
    const b = await verify(lf.replace(/\n/g, "\r\r\n"));
    expect(b.state).toBe("verified");
    expect(b.computed).toBe(a.computed);
  });

  it("CRLF preserves body-hash verification (full-valid)", async () => {
    const lf = lfFor("full-valid.knobe.md");
    const a = await verify(lf);
    const b = await verify(lf.replace(/\n/g, "\r\n"));
    expect(a.bodyVerified).toBe("yes"); // guards the assumption the vector seals its body
    expect(b.state).toBe(a.state);
    expect(b.bodyVerified).toBe("yes");
    expect(b.computed).toBe(a.computed);
  });
});

describe("recognition: surface objects this lens cannot verify", () => {
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const wrap = (body64: string) =>
    `---\ntitle: "x"\nspec_version: "1.0"\n---\n\n# x\n\nbody\n\n-----BEGIN KNOBE B64-----\n${body64}\n-----END KNOBE B64-----\n`;

  it("hasKnobeMarker matches both B64 and bare-B markers, rejects plain text", () => {
    expect(hasKnobeMarker("x\n-----BEGIN KNOBE B64-----\n")).toBe(true);
    expect(hasKnobeMarker("x\n-----BEGIN KNOBE B-----\n")).toBe(true);
    expect(hasKnobeMarker("just some markdown")).toBe(false);
  });

  it("bare-B (non-B64) block surfaces as unreadable with its title + a re-seal hint", async () => {
    const payload = b64('{"title":"A v3 knote","spec_version":"3.0","content_type":"original"}');
    const doc = `---\ntitle: x\n---\n\nbody\n\n-----BEGIN KNOBE B-----\n${payload}\n-----END KNOBE B-----\n`;
    const r = await verify(doc);
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("re-seal");
    expect(r.payload?.title).toBe("A v3 knote"); // dashboard can show the real title
  });

  it("non-1.0 spec_version is verified under 1.0 rules, not rejected as unsupported", async () => {
    // A fake payload_hash means the hash check is reached (and fails) — proving the
    // file is no longer short-circuited to 'unreadable: unsupported spec_version'.
    const fakeHash = "0".repeat(64);
    const r = await verify(wrap(b64(`{"spec_version":"3.0","title":"x","payload_hash":"${fakeHash}"}`)));
    expect(r.state).toBe("failed"); // reached hash verification, not version-gated
    expect(r.conformanceIssues.some((i) => i.includes("not a finalized KNOBE version"))).toBe(true);
  });
});

describe("KNOBE.AI 0.1 HTML-comment / claim-fields-join envelope", () => {
  const SEP = "\n---\n";
  const claimHash = (vals: string[]) => createHash("sha256").update(vals.join(SEP), "utf8").digest("hex");
  const doc = (payload: object) =>
    `# A note\n\n<!-- KNOBE_PAYLOAD_START -->\n<script type="application/json" id="knobe-payload">\n${JSON.stringify(payload)}\n</script>\n<!-- KNOBE_PAYLOAD_END -->\n<!-- KNOBE_INTEGRITY -->\n`;
  const payload = (sha: string, fields: Record<string, string> = { a: "alpha", b: "beta value" }) => ({
    knobe_version: "0.1",
    content_type: "original",
    header: { title: "Grove journey" },
    fields,
    integrity: {
      algo: "SHA-256",
      canonicalization: { method: "claim-fields-join-v0.1", separator: "\\n---\\n", encoding: "UTF-8" },
      claim_fields: ["a", "b"],
      sha256: sha,
    },
  });

  it("hasKnobeMarker matches the HTML payload-start comment", () => {
    expect(hasKnobeMarker("x\n<!-- KNOBE_PAYLOAD_START -->\n")).toBe(true);
  });

  it("verifies a correct claim-fields-join seal", async () => {
    const r = await verify(doc(payload(claimHash(["alpha", "beta value"]))));
    expect(r.state).toBe("verified");
    expect(r.conformance).toBe("valid");
    expect((r.payload?.header as Record<string, string>)?.title).toBe("Grove journey");
  });

  it("fails when a sealed claim field is tampered", async () => {
    const sha = claimHash(["alpha", "beta value"]); // hash over the ORIGINAL values
    const r = await verify(doc(payload(sha, { a: "alpha", b: "TAMPERED" })));
    expect(r.state).toBe("failed");
  });

  it("surfaces an unsupported canonicalization method as unreadable but recognized", async () => {
    const p = payload("0".repeat(64));
    p.integrity.canonicalization.method = "claim-fields-join-v9.9";
    const r = await verify(doc(p));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("unsupported KNOBE canonicalization");
    expect(r.payload).toBeTruthy(); // still recognized, just not verified
  });

  it("refuses to verify when a claim value contains the join separator (injection guard)", async () => {
    const fields = { a: "alpha\n---\ninjected", b: "beta value" };
    const r = await verify(doc(payload(claimHash(["alpha\n---\ninjected", "beta value"]), fields)));
    expect(r.state).toBe("unreadable"); // would otherwise hash-match — refused as ambiguous
    expect(r.reason).toContain("separator");
  });

  it("treats a missing integrity.sha256 as unreadable, not failed", async () => {
    const p = payload("");
    (p.integrity as Record<string, unknown>).sha256 = undefined;
    const r = await verify(doc(p));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("integrity.sha256");
  });
});

describe("input bounds", () => {
  it("refuses to scan an oversized file instead of running the block regexes", async () => {
    const r = await verify("-----BEGIN KNOBE B64-----\n" + "x".repeat(1_000_001));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("too large");
  });

  it("returns quickly on an HTML start marker with no end marker", async () => {
    const r = await verify("<!-- KNOBE_PAYLOAD_START -->\n" + "z".repeat(50_000));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("payload markers not found");
  });
});
