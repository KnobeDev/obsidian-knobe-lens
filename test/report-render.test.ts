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
    expect(md).toContain("- required field missing: title");
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
});
