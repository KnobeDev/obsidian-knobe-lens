/**
 * Listing guard (KnobeOne/knobe-protocol#17): the manifest must say whose plugin this is
 * and must not look like the steward's browser Lens at knobe.org/lens. The repository has
 * no ESLint, so this also mirrors the name rule of Obsidian's own manifest lint
 * (eslint-plugin-obsidianmd `validate-manifest`: no "obsidian" or "plugin" in the name).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => JSON.parse(readFileSync(join(process.cwd(), f), "utf-8"));
const manifest = read("manifest.json");
const pkg = read("package.json");

describe("manifest.json identifies the maintainer", () => {
  it("keeps the plugin id, so existing installs and settings carry over", () => {
    expect(manifest.id).toBe("knobe-lens");
  });

  it("names the maintainer in the plugin name", () => {
    expect(manifest.name).toBe("KNOBE Lens (KnobeDev)");
  });

  it("passes Obsidian's forbidden-word rule for the name", () => {
    for (const word of ["obsidian", "plugin"]) {
      expect(manifest.name.toLowerCase()).not.toContain(word);
    }
  });

  it("credits the maintainer, not the protocol, as author", () => {
    expect(manifest.author).toBe("KnobeDev");
    expect(manifest.authorUrl).toBe("https://github.com/KnobeDev");
  });

  it("agrees with package.json on the author", () => {
    expect(pkg.author).toBe(`${manifest.author} (${manifest.authorUrl})`);
  });
});
