import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "../src/report-render";
import { LensResult } from "../src/lens-core";

const verified: LensResult = {
  state: "verified",
  computed: "a".repeat(64),
  stored: "a".repeat(64),
  payload: {
    title: "Sample",
    content_type: "original",
    quarantine_status: "quarantine",
    privacy_level: "public",
    license: "CC-BY-4.0",
    created_date: "2026-06-29",
    attribution: { sources: [{ author: "Joshua Hori", contribution: "authorship" }] },
  },
  missing: [],
  body: null,
  bodyVerified: "omitted",
  conformance: "valid",
  conformanceIssues: [],
  multipleBlocks: false,
  blockCount: 1,
  reason: null,
};

describe("buildReportMarkdown", () => {
  it("renders a verified report with metadata, attribution, and match=yes", () => {
    const md = buildReportMarkdown({
      file: { basename: "Sample", path: "KNOBE samples/Sample.knobe.md" },
      result: verified,
      verdict: null,
      generatedAt: "2026-06-29T12:00:00.000Z",
    });
    expect(md).toContain("# KNOBE verification report — Sample");
    expect(md).toContain("Verified — seal intact");
    expect(md).toContain("✅ yes");
    expect(md).toContain("| Title | Sample |");
    expect(md).toContain("- Joshua Hori — authorship");
    expect(md).toContain("_No local verdict recorded._");
    expect(md).toContain("Integrity is not truth");
  });

  it("flags a failed seal, lists conformance issues + missing fields, and shows the local verdict", () => {
    const failed: LensResult = {
      ...verified,
      state: "failed",
      stored: "b".repeat(64),
      conformance: "invalid",
      conformanceIssues: ["required field missing: title"],
      missing: ["title"],
    };
    const md = buildReportMarkdown({
      file: { basename: "Bad", path: "Bad.knobe.md" },
      result: failed,
      verdict: { verdict: "rejected", note: "tampered", at: "2026-06-29T00:00:00Z" },
      generatedAt: "2026-06-29T12:00:00.000Z",
    });
    expect(md).toContain("Failed — seal does not match");
    expect(md).toContain("❌ no");
    expect(md).toContain("- required field missing\\: title");
    expect(md).toContain("**rejected** — tampered");
  });

  it("renders hostile payload strings as inert single-line text", () => {
    const hostile: LensResult = {
      ...verified,
      payload: {
        ...verified.payload,
        title: "ALERT\u001b[31m\n## SPOOFED | ![[Private note]]",
        attribution: {
          sources: [{ author: "Mallory\n- **verified**", contribution: "source|owner" }],
        },
      },
      conformanceIssues: ["custom value\n## forged section"],
    };
    const md = buildReportMarkdown({
      file: { basename: "Hostile", path: "Hostile.knobe.md" },
      result: hostile,
      verdict: { verdict: "rejected", note: "review\n![[Secret]]", at: "2026-06-29T00:00:00Z" },
      generatedAt: "2026-06-29T12:00:00.000Z",
    });

    expect(md).not.toContain("\u001b");
    expect(md).not.toContain("\n## SPOOFED");
    expect(md).not.toContain("![[Private note]]");
    expect(md).not.toContain("\n- **verified**");
    expect(md).not.toContain("\n## forged section");
    expect(md).not.toContain("\n![[Secret]]");
    expect(md).toContain("\\x1b");
    expect(md).toContain("\\!\\[\\[Private note\\]\\]");
  });

  const render = (result: LensResult) => buildReportMarkdown({
    file: { basename: "Hostile", path: "Hostile.knobe.md" },
    result, verdict: null, generatedAt: "2026-11-04T12:00:00.000Z",
  });
  const RLO = String.fromCharCode(0x202e);
  const ESC = String.fromCharCode(0x1b);
  // An unescaped `![` starts an image (a remote fetch when the note is opened).
  const IMAGE = /(^|[^\\])!\[/m;

  it("keeps a crafted payload_hash inside its own table cell", () => {
    // The survey's string: it closed the code span and the row, forged a
    // "Match ✅ yes" row and embedded a remote image.
    const stored = "x` |\n| Match | ✅ yes |\n\n![](https://example.invalid/track.png)";
    const md = render({ ...verified, state: "failed", stored, conformance: "invalid" });

    const integrity = md.split("## Integrity")[1].split("## Conformance issues")[0];
    const rows = integrity.trim().split("\n").filter((l) => l.startsWith("|"));
    expect(rows).toHaveLength(5); // header, rule, stored, computed, match
    expect(rows.filter((l) => l.startsWith("| Match |"))).toEqual(["| Match | ❌ no |"]);
    expect(md).not.toMatch(IMAGE);
    expect(rows[2]).not.toContain("`x");
    expect(rows[2]).toContain("x\\` \\|\\\\x0a\\| Match \\| ✅ yes \\|");
    expect(rows[2]).toContain("not a 64-character lowercase hex hash");
  });

  it("shows a well-formed stored hash in a code span", () => {
    const md = render({ ...verified, state: "failed", stored: "b".repeat(64) });
    expect(md).toContain(`| Stored \`payload_hash\` | \`${"b".repeat(64)}\` |`);
  });

  it("escapes bidi controls in the Title row and in conformance issues", () => {
    const md = render({
      ...verified,
      payload: { ...verified.payload, title: `evil${RLO}gnp.exe` },
      conformanceIssues: [`payload contains duplicate JSON key: a${RLO}${ESC}[31mX`],
    });
    expect(md).not.toContain(RLO);
    expect(md).not.toContain(ESC);
    expect(md).toContain("| Title | evil\\\\u202egnp\\.exe |");
    expect(md).toContain("a\\\\u202e\\\\x1b\\[31mX");
  });

  it("neutralises Obsidian syntax that CommonMark does not cover", () => {
    const md = render({
      ...verified,
      payload: { ...verified.payload, title: "a %%hidden%% $x$ ==hi== [^1] #tag &amp;" },
    });
    const title = md.split("\n").find((l) => l.startsWith("| Title |")) as string;
    expect(title).not.toContain("%%");
    expect(title).toContain("&#37;&#37;hidden&#37;&#37;");
    expect(title).toContain("\\$x\\$");
    expect(title).toContain("\\=\\=hi\\=\\=");
    expect(title).toContain("\\[\\^1\\]");
    expect(title).toContain("\\#tag");
    expect(title).toContain("\\&amp\\;");
  });

  it("bounds a long payload value to 300 characters", () => {
    const md = render({ ...verified, payload: { ...verified.payload, title: "t".repeat(5000) } });
    const title = md.split("\n").find((l) => l.startsWith("| Title |")) as string;
    expect(title).toBe(`| Title | ${"t".repeat(300)}… |`);
  });
});
