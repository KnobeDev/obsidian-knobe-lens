import { describe, it, expect } from "vitest";
import { findUnindexedKnobeFiles } from "../src/scanner";

const SEAL = "-----BEGIN KNOBE B64-----\nZm9v\n-----END KNOBE B64-----\n";

// Minimal App stand-in: getMarkdownFiles (the index) + adapter.list/read (disk).
function mockApp(opts: {
  indexed: string[];
  dirs: Record<string, { files: string[]; folders: string[] }>;
  contents: Record<string, string>;
}) {
  return {
    vault: {
      getMarkdownFiles: () => opts.indexed.map((path) => ({ path })),
      adapter: {
        list: async (dir: string) => opts.dirs[dir] ?? { files: [], folders: [] },
        read: async (p: string) => opts.contents[p] ?? "",
      },
    },
  } as any;
}

describe("findUnindexedKnobeFiles", () => {
  it("returns sealed .md files on disk that are missing from the index", async () => {
    const app = mockApp({
      indexed: ["Indexed.md"],
      dirs: { "": { files: ["Indexed.md", "New.md", "Plain.md"], folders: [] } },
      contents: { "New.md": `body\n\n${SEAL}`, "Plain.md": "just notes" },
    });
    const r = await findUnindexedKnobeFiles(app);
    expect(r.paths).toEqual(["New.md"]); // indexed + non-sealed excluded
    expect(r.capped).toBe(false);
  });

  it("recurses into subfolders but skips dot-folders", async () => {
    const app = mockApp({
      indexed: [],
      dirs: {
        "": { files: [], folders: ["Notes", ".obsidian"] },
        "Notes": { files: ["Notes/Deep.md"], folders: [] },
        ".obsidian": { files: [".obsidian/Hidden.md"], folders: [] },
      },
      contents: { "Notes/Deep.md": SEAL, ".obsidian/Hidden.md": SEAL },
    });
    const r = await findUnindexedKnobeFiles(app);
    expect(r.paths).toEqual(["Notes/Deep.md"]); // .obsidian never read
  });

  it("caps reads on a large unindexed tree and flags capped", async () => {
    const files = Array.from({ length: 400 }, (_, i) => `big/f${i}.md`);
    const contents: Record<string, string> = {};
    for (const f of files) contents[f] = SEAL;
    const app = mockApp({
      indexed: [],
      dirs: { "": { files: [], folders: ["big"] }, "big": { files, folders: [] } },
      contents,
    });
    const r = await findUnindexedKnobeFiles(app);
    expect(r.capped).toBe(true);
    expect(r.paths.length).toBe(300); // MAX_DISK_READS
  });
});
