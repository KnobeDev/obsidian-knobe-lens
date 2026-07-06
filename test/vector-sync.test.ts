/**
 * Conformance drift-guard: lock this plugin's bundled conformance vectors to the
 * upstream KNOBE Protocol repository, so an upstream revision of the vectors can never
 * silently pass here against a stale copy.
 *
 * Set KNOBE_PROTOCOL_DIR to a clone of github.com/KnobeOne/knobe-protocol (either the
 * repo root or its test-vectors/ dir). The test fails clearly when no clone is
 * available; CI checks out the canonical repository before running it. This proves
 * three things at once: (1) each bundled vector is byte-identical to upstream, (2) the two
 * sets are complete (no missing/extra), and (3) this plugin's verify() reproduces the nine
 * official verdicts on the UPSTREAM files directly — not just on its own bundled copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verify } from "../src/lens-core";

// The nine official (status, conformance) verdicts, transcribed from the upstream
// test-vectors/README.md table. This is the source of truth the plugin is locked to.
const OFFICIAL: Record<string, { state: string; conformance: string }> = {
  "minimal-valid.knobe.md": { state: "verified", conformance: "valid" },
  "full-valid.knobe.md": { state: "verified", conformance: "valid" },
  "body-modified.knobe.md": { state: "verified-body-modified", conformance: "valid" },
  "payload-modified.knobe.md": { state: "failed", conformance: "valid" },
  "unreadable.knobe.md": { state: "unreadable", conformance: "invalid" },
  "unicode-valid.knobe.md": { state: "verified", conformance: "valid" },
  "numeric-violation.knobe.md": { state: "verified", conformance: "invalid" },
  "omitted-body-hash.knobe.md": { state: "verified", conformance: "valid" },
  "multi-block.knobe.md": { state: "verified", conformance: "warnings" },
};

const ADVERSARIAL: Record<string, { state: string; bodyVerified: string | null; conformance: string }> = {
  "bad-attribution-sources-type.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "invalid" },
  "bad-body-hash-format.knobe.md": { state: "verified-body-modified", bodyVerified: "modified", conformance: "invalid" },
  "bad-created-date.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "invalid" },
  "control-character-title.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "valid" },
  "duplicate-key.knobe.md": { state: "unreadable", bodyVerified: null, conformance: "invalid" },
  "multi-block-warning.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "warnings" },
  "nfc-key-collision.knobe.md": { state: "unreadable", bodyVerified: null, conformance: "invalid" },
  "no-frontmatter-valid-payload.knobe.md": { state: "verified", bodyVerified: "omitted", conformance: "invalid" },
  "payload-array.knobe.md": { state: "unreadable", bodyVerified: null, conformance: "invalid" },
  "unsupported-spec-version.knobe.md": { state: "unreadable", bodyVerified: null, conformance: "invalid" },
};

const BUNDLED = join(process.cwd(), "test", "vectors");

/** Resolve the upstream test-vectors directory from the env var (root or subdir), or the
 *  known local clone. Returns null when no clone is available (→ the block skips). */
function resolveUpstream(): string | null {
  const candidates = [
    process.env.KNOBE_PROTOCOL_DIR,
    "/home/jdhori/dev/knobe-protocol",
    "/mnt/devdrive/knobe-protocol",
    "/mnt/devdrive/HarnessConsole/forks/knobe-protocol",
  ].filter(Boolean) as string[];
  for (const base of candidates) {
    const withSub = join(base, "test-vectors");
    if (existsSync(join(withSub, "minimal-valid.knobe.md"))) return withSub;
    if (existsSync(join(base, "minimal-valid.knobe.md"))) return base;
  }
  return null;
}

const UPSTREAM = resolveUpstream();
if (!UPSTREAM) {
  throw new Error(
    "KNOBE protocol vectors not found. Clone KnobeOne/knobe-protocol beside this repo "
    + "or set KNOBE_PROTOCOL_DIR to its root/test-vectors directory.",
  );
}

describe(
  "bundled conformance vectors stay in sync with upstream knobe-protocol",
  () => {
    it("upstream ships exactly the nine vectors we lock against (no drift in the set)", () => {
      const upstreamVectors = readdirSync(UPSTREAM as string)
        .filter((f) => f.endsWith(".knobe.md"))
        .sort();
      expect(upstreamVectors).toEqual(Object.keys(OFFICIAL).sort());
    });

    for (const name of Object.keys(OFFICIAL)) {
      it(`${name}: bundled copy is byte-identical to upstream`, () => {
        const up = readFileSync(join(UPSTREAM as string, name));
        const bundled = readFileSync(join(BUNDLED, name));
        expect(bundled.equals(up)).toBe(true);
      });

      it(`${name}: verify() reproduces the official verdict on the upstream file`, async () => {
        const raw = readFileSync(join(UPSTREAM as string, name), "utf-8");
        const r = await verify(raw);
        expect(r.state).toBe(OFFICIAL[name].state);
        expect(r.conformance).toBe(OFFICIAL[name].conformance);
      });
    }

    for (const [name, expected] of Object.entries(ADVERSARIAL)) {
      it(`adversarial/${name}: verify() matches the upstream hardening verdict`, async () => {
        const raw = readFileSync(join(UPSTREAM as string, "adversarial", name), "utf-8");
        const r = await verify(raw);
        expect(r.state).toBe(expected.state);
        expect(r.bodyVerified).toBe(expected.bodyVerified);
        expect(r.conformance).toBe(expected.conformance);
      });
    }
  },
);
