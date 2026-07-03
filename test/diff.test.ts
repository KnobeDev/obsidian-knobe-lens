import { describe, it, expect } from "vitest";
import { changedLineNumbers } from "../src/diff";

describe("changedLineNumbers — in-editor highlight targets", () => {
  it("identical texts yield no changed lines", () => {
    expect(changedLineNumbers("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("a modified line is reported at its new position", () => {
    // "b" -> "B" = del b + add B at line 2
    expect(changedLineNumbers("a\nb\nc", "a\nB\nc")).toContain(2);
  });

  it("added lines are reported directly", () => {
    expect(changedLineNumbers("a\nc", "a\nb\nc")).toEqual([2]);
  });

  it("a pure deletion marks the adjacent boundary lines", () => {
    const lines = changedLineNumbers("a\nb\nc", "a\nc");
    expect(lines).toContain(1); // boundary before
    expect(lines).toContain(2); // boundary after (the line that moved up)
  });

  it("results are sorted and unique", () => {
    const lines = changedLineNumbers("a\nb\nc\nd", "a\nX\nY\nd\nZ");
    expect(lines).toEqual([...new Set(lines)].sort((x, y) => x - y));
  });
});
