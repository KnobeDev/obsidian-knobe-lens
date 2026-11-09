/**
 * Differential parity with the reference verifier on a battery of crafted
 * files: for each, lens-core must report exactly what `python3 lens.py --json`
 * reported (test/lens-parity.json): state, conformance, body_verified, both
 * hashes, block count, exit code, reason and every conformance issue.
 *
 * The battery and its expected results come from test/gen_lens_parity.py, a
 * port of knobe-rs's hostile battery plus display-escaping cases. Regenerate it
 * when upstream lens.py changes:
 *
 *   python3 test/gen_lens_parity.py path/to/lens.py test/lens-parity.json --label "..."
 *
 * The oracle is test/lens.py (upstream 6132595) with the pending upstream
 * display-escaping patch applied (safe() escapes bidi controls and unpaired
 * surrogates). Two cases depend on that patch: on test/lens.py as committed,
 * x-dup-key-surrogate crashes (UnicodeEncodeError, so the generator stops) and
 * x-dup-key-bidi-ansi leaves U+202E raw in its reason. Until the patch lands,
 * regenerate from a lens.py with it applied.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verify, LensResult } from "../src/lens-core";

interface LensReport {
  state: string;
  computed: string | null;
  stored: unknown;
  body_verified: string | null;
  conformance: string;
  conformance_issues: string[];
  multiple_blocks: boolean;
  block_count: number;
  reason: string | null;
}
interface Case { name: string; file_b64: string; exit: number; lens: LensReport }

const fixture: { oracle: string; cases: Case[] } = JSON.parse(
  readFileSync(join(process.cwd(), "test", "lens-parity.json"), "utf-8"),
);

const SPEC_3_1 = "spec §3.1: the frontmatter must declare spec_version (lens.py does not check)";
const CRLF = "CR-tolerant block markers (lens.py matches LF only and finds no block)";
const RECURSION = "lens.py reaches CPython's recursion limit and reports a verifier error with no block count";

/** Where lens-core deliberately reports something else, and what it reports.
 *  Each entry must still differ from lens.py, so a stale entry is caught. */
const DIFFERS: Record<string, { why: string; state: string; conformance: string }> = {
  "fm-crlf-with-body": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "fm-double-cr": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "fm-bom": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "fm-spec-empty": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "fm-spec-after-close-ignored": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "fm-spec-not-prefix": { why: SPEC_3_1, state: "verified", conformance: "invalid" },
  "block-crlf-markers": { why: CRLF, state: "verified", conformance: "valid" },
  "x-depth-2000": { why: RECURSION, state: "unreadable", conformance: "invalid" },
};

/** The plugin reads notes as text, so files that are not UTF-8 never reach it. */
const NOT_TEXT = new Set(["file-not-utf8"]);

/** Two spellings the protocol treats as the same, so the comparison does too:
 *  - ERRATA E11: in machine output, body_verified `null` and "omitted" are
 *    equivalent (lens.py writes null for unreadable files).
 *  - Spec §3.3 asks the multi-block warning for the index of the block evaluated
 *    ("e.g., evaluated block 2 of 2"); lens.py writes "evaluated the last block". */
const bodyVerified = (v: string | null) => v ?? "omitted";
const issueText = (s: string) =>
  s.replace(/^(multiple payload blocks present \((\d+)\); )evaluated block \2 of \2 (per spec §3\.3)$/,
    "$1evaluated the last block $3");

const exitOf = (r: LensResult) =>
  r.state === "unreadable" ? 2
    : (r.state === "verified" || r.state === "verified-body-modified")
      && (r.conformance === "valid" || r.conformance === "warnings") ? 0 : 1;

const gate = (r: LensResult) => ({
  state: r.state, conformance: r.conformance, body_verified: bodyVerified(r.bodyVerified),
  computed: r.computed, stored: r.stored, block_count: r.blockCount,
  multiple_blocks: r.multipleBlocks, exit: exitOf(r), reason: r.reason,
  issues: r.conformanceIssues.map(issueText),
});

const expected = (c: Case) => ({
  state: c.lens.state, conformance: c.lens.conformance, body_verified: bodyVerified(c.lens.body_verified),
  computed: c.lens.computed,
  // LensResult.stored is a string: a number is shown as Python's str() of it.
  stored: typeof c.lens.stored === "number" ? String(c.lens.stored) : c.lens.stored,
  block_count: c.lens.block_count, multiple_blocks: c.lens.multiple_blocks, exit: c.exit,
  reason: c.lens.reason, issues: c.lens.conformance_issues,
});

// Keep a leading BOM: lens.py sees it, and so does a note read from disk.
const decode = (b64: string) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(b64, "base64"));

describe(`lens-core matches ${fixture.oracle}`, () => {
  it("covers the whole battery", () => {
    expect(fixture.cases).toHaveLength(156);
    for (const name of [...Object.keys(DIFFERS), ...NOT_TEXT]) {
      expect(fixture.cases.some((c) => c.name === name), name).toBe(true);
    }
  });

  for (const c of fixture.cases) {
    if (NOT_TEXT.has(c.name)) {
      it(`${c.name}: is not UTF-8 text`, () => expect(() => decode(c.file_b64)).toThrow());
      continue;
    }
    const differs = DIFFERS[c.name];
    it(differs ? `${c.name}: differs on purpose (${differs.why})` : c.name, async () => {
      const got = gate(await verify(decode(c.file_b64)));
      if (differs) {
        expect({ state: got.state, conformance: got.conformance }).toEqual(
          { state: differs.state, conformance: differs.conformance });
        expect(got, "lens.py now agrees: remove this entry from DIFFERS").not.toEqual(expected(c));
      } else {
        expect(got).toEqual(expected(c));
      }
    });
  }
});
