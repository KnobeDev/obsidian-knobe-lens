import { describe, it, expect } from "vitest";
import {
  sanitizePortfolioName, isFolder, listPortfolioFolders,
  currentPortfolioName, portfolioPath, targetPathFor,
} from "../src/portfolio";

// Minimal structural stand-ins for Obsidian's TFolder / TFile (the helpers only
// touch path/name/parent/children), so no Obsidian runtime mock is needed.
const folder = (path: string, name: string, parent: any = null, children: any[] = []) =>
  ({ path, name, parent, children });
const file = (path: string, name: string, parent: any = null) => ({ path, name, parent });

describe("sanitizePortfolioName", () => {
  it("keeps a clean name", () => expect(sanitizePortfolioName("  Drafts ")).toBe("Drafts"));
  it("rejects empty / whitespace", () => {
    expect(sanitizePortfolioName("")).toBeNull();
    expect(sanitizePortfolioName("   ")).toBeNull();
  });
  it("rejects path-illegal characters", () => {
    for (const n of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(sanitizePortfolioName(n)).toBeNull();
    }
  });
  it("strips leading dots and trailing dots/spaces", () => {
    expect(sanitizePortfolioName("..hidden")).toBe("hidden");
    expect(sanitizePortfolioName("trail. ")).toBe("trail");
  });
});

describe("isFolder", () => {
  it("treats a node with a children array as a folder", () => {
    expect(isFolder(folder("p", "p") as any)).toBe(true);
    expect(isFolder(file("p/f.md", "f.md") as any)).toBe(false);
    expect(isFolder(null)).toBe(false);
  });
});

describe("listPortfolioFolders", () => {
  it("returns immediate subfolders sorted by name, ignoring files", () => {
    const root = folder("Portfolios", "Portfolios", null, [
      folder("Portfolios/Zeta", "Zeta"),
      file("Portfolios/loose.md", "loose.md"),
      folder("Portfolios/Alpha", "Alpha"),
    ]);
    expect(listPortfolioFolders(root as any).map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  });
  it("returns [] when the root is missing", () => expect(listPortfolioFolders(null)).toEqual([]));
});

describe("currentPortfolioName", () => {
  const root = "Portfolios";
  it("names the portfolio when the file is an immediate child of a subfolder", () => {
    const sub = folder("Portfolios/Drafts", "Drafts", folder("Portfolios", "Portfolios"));
    const f = file("Portfolios/Drafts/n.md", "n.md", sub);
    expect(currentPortfolioName(f as any, root)).toBe("Drafts");
  });
  it("returns null for a file directly in the root or outside it", () => {
    const inRoot = file("Portfolios/n.md", "n.md", folder("Portfolios", "Portfolios", folder("/", "/")));
    expect(currentPortfolioName(inRoot as any, root)).toBeNull();
    const outside = file("Other/n.md", "n.md", folder("Other", "Other", folder("/", "/")));
    expect(currentPortfolioName(outside as any, root)).toBeNull();
  });
});

describe("path builders", () => {
  it("portfolioPath joins root + name", () => expect(portfolioPath("Portfolios", "Drafts")).toBe("Portfolios/Drafts"));
  it("targetPathFor joins folder path + file name", () => {
    expect(targetPathFor(folder("Portfolios/Drafts", "Drafts") as any, file("x/n.md", "n.md") as any))
      .toBe("Portfolios/Drafts/n.md");
  });
});
