import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verify } from "../src/lens-core";

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
