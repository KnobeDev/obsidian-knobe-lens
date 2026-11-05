import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { verify, hasKnobeMarker, payloadHashOf, safeLines } from "../src/lens-core";

const ROOT = process.cwd();
const VEC = join(ROOT, "test", "vectors");

interface Expected {
  state: string;
  conformance: string;
  body_verified: string;
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

describe("current spec verification output", () => {
  it("reports omitted body verification for unreadable and failed payloads", async () => {
    for (const file of ["unreadable.knobe.md", "payload-modified.knobe.md"]) {
      const result = await verify(readFileSync(join(VEC, file), "utf-8"));
      expect(result.bodyVerified).toBe("omitted");
    }
  });

  it("identifies both the evaluated block index and total block count", async () => {
    const result = await verify(readFileSync(join(VEC, "multi-block.knobe.md"), "utf-8"));
    expect(result.conformanceIssues).toContain(
      "multiple payload blocks present (2); evaluated block 2 of 2 per spec §3.3",
    );
    expect(result.bodyVerified).toBe("omitted");
  });
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

  it("non-1.0 spec_version is unreadable because this v1 lens cannot infer its semantics", async () => {
    const fakeHash = "0".repeat(64);
    const r = await verify(wrap(b64(`{"spec_version":"3.0","title":"x","payload_hash":"${fakeHash}"}`)));
    expect(r.state).toBe("unreadable");
    expect(r.computed).toBeNull();
    expect(r.reason).toContain("unsupported spec_version");
  });

  it("frontmatter without spec_version is nonconforming even when the payload verifies", async () => {
    const raw = readFileSync(join(VEC, "minimal-valid.knobe.md"), "utf-8")
      .replace(/^spec_version:.*\n/m, "");
    const r = await verify(raw);
    expect(r.state).toBe("verified");
    expect(r.conformance).toBe("invalid");
    expect(r.conformanceIssues).toContain("YAML frontmatter missing required spec_version");
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

  it("rejects an unpaired surrogate, which would hash the same as U+FFFD", async () => {
    // TextEncoder writes a lone surrogate as EF BF BD, the bytes of U+FFFD, so
    // two different claims would share one hash.
    const sha = claimHash([String.fromCharCode(0xfffd), "beta value"]);
    const json = JSON.stringify(payload(sha)).replace('"a":"alpha"', '"a":"\\ud800"');
    const r = await verify(`# n\n\n<!-- KNOBE_PAYLOAD_START -->\n<script type="application/json">\n${json}\n</script>\n<!-- KNOBE_PAYLOAD_END -->\n`);
    expect(r.state).toBe("unreadable");
    expect(r.reason).toContain("unpaired surrogate");
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

describe("upstream lens.py behavior the port lacked (KnobeOne/knobe-protocol 6132595)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
  const file = (block: string) =>
    `---\ntitle: "x"\nspec_version: "1.0"\n---\n\nbody\n\n-----BEGIN KNOBE B64-----\n${block}\n-----END KNOBE B64-----\n`;
  const esc = (cp: number) => "\\u" + cp.toString(16).padStart(4, "0"); // a JSON \uXXXX escape
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
  const ZERO = "0".repeat(64);
  const MIN = '"spec_version":"1.0","title":"T","summary":"S","content_type":"original",'
    + '"created_date":"2026-01-02","license":"CC0-1.0","privacy_level":"public",'
    + '"quarantine_status":"quarantine","attribution":{"sources":[{"author":"A"}]}';

  it("rejects an unpaired surrogate as unreadable, not failed", async () => {
    const r = await verify(file(b64(`{${MIN},"x":"${esc(0xd800)}","payload_hash":"${ZERO}"}`)));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toBe(
      "payload contains characters that cannot be UTF-8 encoded (e.g. an unpaired surrogate); rejected");
    expect(r.payload).toBeNull();
  });

  it("rejects a float that overflows to infinity, payload_hash included", async () => {
    for (const json of [`{${MIN},"x":1e400,"payload_hash":"${ZERO}"}`, `{${MIN},"payload_hash":1e400}`]) {
      const r = await verify(file(b64(json)));
      expect(r.state).toBe("unreadable");
      expect(r.reason).toBe("payload contains a non-JSON numeric constant (NaN/Infinity); rejected");
    }
  });

  it("strips only ASCII space, tab, CR and LF from a block (ERRATA E12)", async () => {
    const raw = readFileSync(join(VEC, "minimal-valid.knobe.md"), "utf-8");
    const inBlock = (s: string) => raw.replace("\n-----END KNOBE B64-----", `${s}\n-----END KNOBE B64-----`);
    expect((await verify(inBlock(String.fromCharCode(0xa0)))).state).toBe("unreadable"); // NBSP
    expect((await verify(inBlock(String.fromCharCode(0x85)))).state).toBe("unreadable"); // NEL
    expect((await verify(inBlock(" \t"))).state).toBe("verified");
  });

  it("escapes a duplicate key in the reason, as lens.py's safe() does", async () => {
    const key = `a${esc(0x202e)}${esc(0x1b)}[31mX`;
    const r = await verify(file(b64(`{"${key}":"1","${key}":"2"}`)));
    expect(r.reason).toBe("payload contains duplicate JSON key: a\\u202e\\x1b[31mX (ambiguous; rejected)");
    const lone = await verify(file(b64(`{"${esc(0xd800)}":"1","${esc(0xd800)}":"2"}`)));
    expect(lone.reason).toBe("payload contains duplicate JSON key: \\ud800 (ambiguous; rejected)");
  });

  it("reports a duplicate key only when its object closes, as json.loads does", async () => {
    const r = await verify(file(b64('{"a":"1","a":"2","x":NaN}')));
    expect(r.reason).toBe("payload contains a non-JSON numeric constant (NaN/Infinity); rejected");
  });

  it("reports an object-valued spec_version instead of throwing", async () => {
    const r = await verify(file(b64(`{"spec_version":{"v":"1.0"},"payload_hash":"${ZERO}"}`)));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toBe("unsupported spec_version: {'v': '1.0'}");
  });

  it("does not drop a byte-order mark at the start of the payload JSON", async () => {
    const r = await verify(file(b64(String.fromCharCode(0xfeff) + `{${MIN},"payload_hash":"${ZERO}"}`)));
    expect(r.state).toBe("unreadable");
    expect(r.reason).toBe("payload could not be decoded or parsed");
  });

  it("hashes bare numbers as Python does: 1.0 stays 1.0, big integers keep every digit", async () => {
    const canon = '{"x":1.0,"y":12345678901234567890}';
    const r = await verify(file(b64(`{"x":1.0,"y":12345678901234567890,"payload_hash":"${sha(canon)}"}`)));
    expect(r.state).toBe("verified");
    expect(r.computed).toBe(sha(canon));
  });
});

describe("seal == verify for numbers a sealer passes as JS numbers", () => {
  // The sealer hashes a plain object, then writes it with JSON.stringify; the
  // verifier hashes what it parses back. Both must agree, as lens.py would.
  const file = (json: string) =>
    `---\nspec_version: "1.0"\n---\n\n-----BEGIN KNOBE B64-----\n${Buffer.from(json).toString("base64")}\n-----END KNOBE B64-----\n`;
  for (const n of [0, -0, 7, 1.5, 1e-7, 2 ** 53 + 2, 1.2345678901234568e20, 1e21, 1e300]) {
    it(`${n}`, async () => {
      const payload: Record<string, unknown> = { x: n };
      payload.payload_hash = await payloadHashOf(payload);
      const r = await verify(file(JSON.stringify(payload)));
      expect(r.state).toBe("verified");
    });
  }
});

describe("safeLines", () => {
  it("escapes like safe() on each line, keeps line breaks and does not truncate", () => {
    const RLO = String.fromCharCode(0x202e), ESC = String.fromCharCode(0x1b);
    const long = "x".repeat(400);
    expect(safeLines(`Trusted Source${RLO}\n${ESC}[2Jnext\r\n${long}`))
      .toBe(`Trusted Source\\u202e\n\\x1b[2Jnext\\x0d\n${long}`);
  });
});
