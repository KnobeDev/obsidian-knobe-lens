/**
 * ERRATA drift guard: the upstream interpretation vectors pin rulings on
 * questions the v1 specification text left open (ERRATA.md E2, E5–E9). They
 * are not part of the nine-vector compatibility bar, but a verifier that
 * matches the reference on all six follows the published rulings. Runs
 * against the upstream files directly, so a new or revised ruling fails here
 * until this plugin is updated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verify } from "../src/lens-core";

// Transcribed from upstream test-vectors/interpretation/README.md. An
// unreadable file's body_verified is the mandated "omitted" of spec §7, which
// may also be spelled null (erratum E11).
const INTERPRETATION: Record<string, { state: string; bodyVerified: string | null; conformance: string }> = {
  "boolean-null-values.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "valid" },
  "spec-version-frontmatter-mismatch.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "warnings" },
  "begin-marker-mid-line.knobe.md": { state: "verified", bodyVerified: "yes", conformance: "valid" },
  "base64-unpadded.knobe.md": { state: "unreadable", bodyVerified: null, conformance: "invalid" },
  "attribution-missing.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "invalid" },
  "astral-unicode-literal.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "valid" },
};

function resolveInterpretationDir(): string | null {
  const candidates = [
    process.env.KNOBE_PROTOCOL_DIR,
    "/home/jdhori/dev/knobe-protocol",
    "/mnt/devdrive/knobe-protocol",
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    for (const dir of [join(base, "test-vectors", "interpretation"), join(base, "interpretation")]) {
      if (existsSync(join(dir, "README.md"))) return dir;
    }
  }
  return null;
}

const DIR = resolveInterpretationDir();
if (!DIR) {
  throw new Error(
    "KNOBE interpretation vectors not found. Clone KnobeOne/knobe-protocol beside this repo "
    + "or set KNOBE_PROTOCOL_DIR to its root directory.",
  );
}

const load = (name: string): string => readFileSync(join(DIR as string, name), "utf-8");

describe("lens-core follows the ERRATA rulings pinned by the interpretation vectors", () => {
  it("upstream ships exactly the six rulings we lock against", () => {
    const files = readdirSync(DIR as string).filter((f) => f.endsWith(".knobe.md")).sort();
    expect(files).toEqual(Object.keys(INTERPRETATION).sort());
  });

  for (const [name, want] of Object.entries(INTERPRETATION)) {
    it(`${name} → ${want.state} / ${want.bodyVerified ?? "omitted"} / ${want.conformance}`, async () => {
      const r = await verify(load(name));
      expect(r.state).toBe(want.state);
      expect(r.conformance).toBe(want.conformance);
      if (want.bodyVerified === null) expect(["omitted", null]).toContain(r.bodyVerified);
      else expect(r.bodyVerified).toBe(want.bodyVerified);
    });
  }

  it("E5: frontmatter/payload spec_version disagreement names both values", async () => {
    const r = await verify(load("spec-version-frontmatter-mismatch.knobe.md"));
    expect(r.conformanceIssues).toContain(
      "frontmatter spec_version '1.1' does not match sealed payload spec_version '1.0'",
    );
  });

  it("E9: a wholly absent attribution reports exactly one issue", async () => {
    const r = await verify(load("attribution-missing.knobe.md"));
    expect(r.conformanceIssues.filter((i) => i.includes("attribution"))).toEqual([
      "required field missing: attribution",
    ]);
  });
});
