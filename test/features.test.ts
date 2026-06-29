import { describe, it, expect } from "vitest";
import { verify } from "../src/lens-core";
import { sealKnobe, SealFields } from "../src/seal";
import { getVerdict, setVerdict, clearVerdict } from "../src/trust";
import { diagnoseBreak } from "../src/diagnose";
import { lineDiff } from "../src/diff";
import { buildLineage, isolatedHashes } from "../src/lineage";

const FM = `---\ntitle: "x"\nspec_version: "1.0"\n---`;
const fields = (): SealFields => ({
  title: "x", summary: "s", content_type: "original", created_date: "2026-06-28",
  license: "CC BY 4.0", privacy_level: "public", quarantine_status: "quarantine",
  attribution: { sources: [{ author: "A" }] },
});

describe("trust ledger", () => {
  it("set / get / clear, and stale-on-hash-change", () => {
    let led = {};
    led = setVerdict(led, "hashA", "trusted", "reviewed", "2026-06-28T00:00:00Z");
    expect(getVerdict(led, "hashA")?.verdict).toBe("trusted");
    expect(getVerdict(led, "hashB")).toBeNull(); // different content hash -> stale -> no verdict
    expect(getVerdict(led, null)).toBeNull();
    led = clearVerdict(led, "hashA");
    expect(getVerdict(led, "hashA")).toBeNull();
  });
  it("is immutable", () => {
    const a = {};
    const b = setVerdict(a, "h", "rejected", "", "t");
    expect(a).toEqual({});
    expect(b).not.toBe(a);
  });
});

describe("break diagnosis", () => {
  const COMPOSED = "café"; // café with composed é (U+00E9)
  const DECOMPOSED = "café"; // e + combining acute (U+0065 U+0301)
  const bodyOf = () => `# ${COMPOSED}\n\nORIGINAL line`;

  it("benign Unicode normalization is distinguished from a real edit", async () => {
    const sealed = await sealKnobe(FM, bodyOf(), fields());
    const decomposed = sealed.replace(COMPOSED, DECOMPOSED); // server/editor NFD round-trip
    expect(decomposed).not.toBe(sealed);
    const r = await verify(decomposed);
    expect(r.state).toBe("verified-body-modified");
    const d = await diagnoseBreak(decomposed, r);
    expect(d.kind).toBe("body-benign-normalization");
    expect(d.benign).toBe(true);
  });

  it("a genuine body edit is flagged as not benign", async () => {
    const sealed = await sealKnobe(FM, bodyOf(), fields());
    const edited = sealed.replace("ORIGINAL", "CHANGED");
    const r = await verify(edited);
    const d = await diagnoseBreak(edited, r);
    expect(d.kind).toBe("body-edited");
    expect(d.benign).toBe(false);
  });

  it("a verified file diagnoses as ok", async () => {
    const sealed = await sealKnobe(FM, bodyOf(), fields());
    const d = await diagnoseBreak(sealed, await verify(sealed));
    expect(d.kind).toBe("ok");
  });
});

describe("line diff", () => {
  it("marks added and removed lines", () => {
    const ops = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(ops.filter((o) => o.type === "del").map((o) => o.line)).toContain("b");
    expect(ops.filter((o) => o.type === "add").map((o) => o.line)).toEqual(expect.arrayContaining(["B", "d"]));
    expect(ops.filter((o) => o.type === "same").map((o) => o.line)).toEqual(["a", "c"]);
  });
});

describe("lineage graph", () => {
  it("links children to parents and synthesizes external nodes", () => {
    const g = buildLineage([
      { hash: "child", title: "Adaptation", state: "verified", contentType: "adaptation", parents: ["parentLocal", "parentExternalaaaaaaaa"] },
      { hash: "parentLocal", title: "Source", state: "verified", contentType: "original", parents: [] },
    ]);
    expect(g.nodes.find((n) => n.hash === "parentExternalaaaaaaaa")?.present).toBe(false);
    expect(g.edges).toEqual(expect.arrayContaining([{ from: "parentLocal", to: "child" }]));
    expect(isolatedHashes(g).size).toBe(0);
  });
  it("flags isolated objects", () => {
    const g = buildLineage([{ hash: "lonely", title: "x", state: "verified", contentType: "original", parents: [] }]);
    expect(isolatedHashes(g).has("lonely")).toBe(true);
  });
});

describe("security", () => {
  it("a __proto__ key cannot smuggle data past the seal (prototype pollution)", async () => {
    const sealed = await sealKnobe(FM, "# x\n\nbody", fields()); // valid, verifies
    const m = sealed.match(/-----BEGIN KNOBE B64-----\n([\s\S]*?)\n-----END/);
    const json = Buffer.from((m as RegExpMatchArray)[1].replace(/\s/g, ""), "base64").toString("utf-8");
    // inject a prototype-pollution attempt carrying a fake body_hash
    const tampered = json.replace(/^\{/, '{"__proto__":{"body_hash":"deadbeef"},');
    const b64 = Buffer.from(tampered, "utf-8").toString("base64");
    const r = await verify(sealed.replace((m as RegExpMatchArray)[1], b64));
    // __proto__ is now an own key -> changes the canonical hash -> must NOT verify
    expect(r.state).not.toBe("verified");
    expect(r.bodyVerified).not.toBe("yes");
  });

  it("deeply nested JSON is rejected, not a stack overflow", async () => {
    const deep = "[".repeat(5000) + "]".repeat(5000);
    const b64 = Buffer.from(deep, "utf-8").toString("base64");
    const file = `---\ntitle: "x"\nspec_version: "1.0"\n---\n\nb\n\n-----BEGIN KNOBE B64-----\n${b64}\n-----END KNOBE B64-----\n`;
    const r = await verify(file);
    expect(r.state).toBe("unreadable");
  });
});
