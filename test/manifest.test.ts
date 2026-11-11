/**
 * Listing guard (KnobeOne/knobe-protocol#17): the manifest must say whose plugin this is
 * and must not look like the steward's browser Lens at knobe.org/lens. The repository has
 * no ESLint, so this also mirrors Obsidian's own manifest lint (eslint-plugin-obsidianmd
 * `validate-manifest`) and, further down, the developer docs' manifest reference.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const text = (f: string) => readFileSync(join(process.cwd(), f), "utf-8");
const read = (f: string) => JSON.parse(text(f));
const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json") as Record<string, string>;

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

/**
 * Obsidian's manifest reference (https://docs.obsidian.md/Reference/Manifest): every
 * required field with its type, an id of lowercase letters and hyphens, a name in Basic
 * Latin, x.y.z versions, a minAppVersion that is really the oldest Obsidian the code runs
 * on, and isDesktopOnly false only while no source file needs Node.js or Electron.
 */
const REQUIRED: Record<string, string> = {
  id: "string",
  name: "string",
  version: "string",
  minAppVersion: "string",
  description: "string",
  author: "string",
  isDesktopOnly: "boolean",
};
const OPTIONAL = ["authorUrl", "fundingUrl", "helpUrl"];
const XYZ = /^\d+\.\d+\.\d+$/;

/** Compares two x.y.z versions: negative, zero or positive, like a sort comparator. */
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/**
 * Obsidian APIs newer than 1.4.0 (the minAppVersion before 0.11.2) that the code calls. A
 * file that defines a modal and calls `.setTitle(` calls Modal.setTitle; MenuItem.setTitle,
 * used for file-menu items, is far older. If no file calls one any more, drop its entry.
 */
const NEWER_APIS = [
  // Modal.setTitle arrived in Obsidian 1.5.1; KNOBE Lens 0.3.0 (5566dd1) was the first to call it.
  {
    api: "Modal.setTitle",
    since: "1.5.1",
    firstRelease: "0.3.0",
    calls: (source: string) => /extends\s+\w*Modal\b/.test(source) && /\.setTitle\(/.test(source),
  },
];

const sourceFiles = (readdirSync(join(process.cwd(), "src"), { recursive: true }) as string[])
  .filter((f) => /\.(ts|js)$/.test(f))
  .map((f) => join("src", f));

describe("manifest.json follows Obsidian's manifest reference", () => {
  it("has every required field with its type, and no field the directory does not know", () => {
    for (const [key, type] of Object.entries(REQUIRED)) expect(typeof manifest[key], key).toBe(type);
    const unknown = Object.keys(manifest).filter((k) => !(k in REQUIRED) && !OPTIONAL.includes(k));
    expect(unknown).toEqual([]);
  });

  it("has an id of lowercase letters and hyphens that does not end with 'plugin'", () => {
    expect(manifest.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(manifest.id).not.toMatch(/obsidian|plugin$/);
  });

  it("has a name in Basic Latin, with no punctuation but hyphens, plus signs and parentheses", () => {
    expect(manifest.name).toMatch(/^[A-Za-z0-9 ()+-]+$/);
    // Like Obsidian's linter, this rejects a leading "ob" as well as "obsi" and "sidian".
    // "plugin" in the name is the forbidden-word test above.
    expect(manifest.name.toLowerCase()).not.toMatch(/^ob|obsi|sidian/);
  });

  it("has a description of 10 to 250 characters that ends a sentence and does not start with the name", () => {
    expect(manifest.description.length).toBeGreaterThanOrEqual(10);
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description).toMatch(/[.!?]$/);
    expect(manifest.description.toLowerCase().startsWith(manifest.name.toLowerCase())).toBe(false);
    expect(manifest.description).not.toMatch(/obsidian|this plugin|an? plugin (that|for|to|which)/i);
  });

  it("links the author over https", () => {
    expect(manifest.authorUrl).toMatch(/^https:\/\//);
  });

  it("uses x.y.z versions, and package.json and versions.json agree with it", () => {
    expect(manifest.version).toMatch(XYZ);
    expect(manifest.minAppVersion).toMatch(XYZ);
    expect(pkg.version).toBe(manifest.version);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    for (const [release, app] of Object.entries(versions)) {
      expect(release, "versions.json key").toMatch(XYZ);
      expect(app, `versions.json ${release}`).toMatch(XYZ);
    }
  });

  it.each(NEWER_APIS)("asks for Obsidian $since or newer while the code calls $api", ({ calls, since }) => {
    const callers = sourceFiles.filter((f) => calls(text(f)));
    expect(callers.length, "files that call it (none: drop this entry)").toBeGreaterThan(0);
    expect(compareVersions(manifest.minAppVersion, since), callers.join(", ")).toBeGreaterThanOrEqual(0);
  });

  it.each(NEWER_APIS)("never offers a release that calls $api to Obsidian older than $since", ({ since, firstRelease }) => {
    const tooLow = Object.entries(versions).filter(
      ([release, app]) => compareVersions(release, firstRelease) >= 0 && compareVersions(app, since) < 0
    );
    expect(tooLow).toEqual([]);
  });

  it("is not desktop-only, and no source file loads a Node.js or Electron module", () => {
    expect(sourceFiles.length, "src/ was scanned").toBeGreaterThan(10);
    expect(manifest.isDesktopOnly).toBe(false);
    // A heuristic, not proof: static, side-effect and dynamic imports of Node.js built-ins
    // or Electron, require(), and the Node globals a plugin would reach for.
    const nodeOnly =
      /(\bfrom\s+|\bimport\s*\(?\s*)["'](node:[^"']+|electron|fs|path|os|child_process|crypto|buffer|stream|zlib|url|util|https?|http2|net|tls|dns|worker_threads)["']|\brequire\s*\(|\bprocess\.(env|platform|versions)\b|\bBuffer\./;
    expect(sourceFiles.filter((f) => nodeOnly.test(text(f)))).toEqual([]);
  });
});
