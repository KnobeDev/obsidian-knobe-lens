import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findUnindexedKnobeFiles, scanVault } from "../src/scanner";
import { groupPortfolioRows, groupRecognitionRows } from "../src/board";
import { isFiledUnder } from "../src/portfolio";
import { withinFolder } from "../src/verification-scope";

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

describe("scanVault display fields", () => {
  // Crafted files from the lens.py parity battery (test/lens-parity.json).
  const battery: { cases: { name: string; file_b64: string }[] } = JSON.parse(
    readFileSync(join(process.cwd(), "test", "lens-parity.json"), "utf-8"));
  const note = (name: string) =>
    Buffer.from(battery.cases.find((c) => c.name === name)!.file_b64, "base64").toString("utf-8");
  const appWith = (files: Record<string, string>) => ({
    vault: {
      getMarkdownFiles: () => Object.keys(files).map((path) => ({ path, basename: path.replace(/\.md$/, "") })),
      cachedRead: async (f: { path: string }) => files[f.path],
    },
  }) as any;

  it("escapes bidi and control characters in titles and vocabulary values", async () => {
    const rows = await scanVault(appWith({
      "rlo.md": note("x-title-rlo"),
      "ctl.md": note("x-title-controls"),
      "vocab.md": note("x-vocab-hostile"),
    }));
    const by = (p: string) => rows.find((r) => r.file.path === p)!;
    expect(by("rlo.md").title).toBe("evil\\u202egnp.exe");
    expect(by("rlo.md").result.state).toBe("verified");
    expect(by("ctl.md").title).toBe("a\\x00b\\x1b[31mc\\x85d\\u2028e\\u2066f");
    expect(by("vocab.md").contentType).toBe("\\u202eevil\\x07");
  });

  it("shows batch-filed cards in an existing portfolio outside the Recognition scan folder", async () => {
    const scope = "Inbox";
    const root = "Portfolios";
    const folder = { name: "Research", path: "Portfolios/Research" };
    const sealed = readFileSync(join(process.cwd(), "test/vectors/minimal-valid.knobe.md"), "utf8");
    const files = {
      "Inbox/Third.md": sealed,
      "Portfolios/Research/First.md": sealed,
      "Portfolios/Research/Second.md": sealed,
      "Portfolios/Research/Existing.md": sealed,
      "Other/Unrelated.md": sealed,
    };
    const rows = await scanVault(appWith(files), scope, root);
    const recognition = groupRecognitionRows(
      rows.filter((row) => withinFolder(row.file.path, scope)),
      (row) => isFiledUnder(row.file.path, root),
    );
    expect(recognition.flatMap((column) => column.rows.map((row) => row.file.path)))
      .toEqual(["Inbox/Third.md"]);
    const [lane] = groupPortfolioRows([folder], rows);
    expect(lane.rows.map((row) => row.file.path)).toEqual([
      "Portfolios/Research/First.md",
      "Portfolios/Research/Second.md",
      "Portfolios/Research/Existing.md",
    ]);
    expect(rows).toHaveLength(4);
  });

  it("lists an object whose spec_version is a JSON object instead of dropping it", async () => {
    const rows = await scanVault(appWith({ "sv.md": note("x-spec-version-object") }));
    expect(rows).toHaveLength(1);
    expect(rows[0].result.state).toBe("unreadable");
  });
});
