import { describe, expect, it } from "vitest";
import { withinFolder, renamedVerificationFolder } from "../src/verification-scope";

describe("verification folder scope", () => {
  it("includes the whole vault when no folder is selected", () => {
    expect(withinFolder("Note.md", "")).toBe(true);
    expect(withinFolder("Deep/Note.md", "/")).toBe(true);
  });

  it("includes nested notes but rejects similarly named sibling folders", () => {
    expect(withinFolder("Notes/Note.md", "Notes")).toBe(true);
    expect(withinFolder("Notes/Deep/Note.md", "Notes")).toBe(true);
    expect(withinFolder("Notes Archive/Note.md", "Notes")).toBe(false);
    expect(withinFolder("Other/Notes/Note.md", "Notes")).toBe(false);
    expect(withinFolder("Notes.md", "Notes")).toBe(false);
  });

  it("normalizes surrounding whitespace and root/trailing separators", () => {
    expect(withinFolder("Notes/Deep/Note.md", " /Notes/Deep/ ")).toBe(true);
  });

  it("follows a selected folder or its renamed ancestor, retaining descendants", () => {
    expect(renamedVerificationFolder("Notes", "Notes", "Archive")).toBe("Archive");
    expect(renamedVerificationFolder("Notes/Deep", "Notes", "Archive")).toBe("Archive/Deep");
    expect(renamedVerificationFolder("Notes Archive", "Notes", "Archive")).toBe("Notes Archive");
    expect(renamedVerificationFolder("", "Notes", "Archive")).toBe("");
  });
});
