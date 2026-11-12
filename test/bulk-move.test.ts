import { expect, it, vi } from "vitest";
import { groupRecognitionRows } from "../src/board";
import { KnobeLensView } from "../src/view";

vi.mock("obsidian", () => ({ ItemView: class {}, Modal: class {}, Notice: class {} }));

it.each([
  { root: "Portfolios", destination: "Portfolios/Research", scope: "Inbox" },
  { root: "/", destination: "Research", scope: "" },
])("redraws both boards before rescanning with portfolio root $root", async ({ root, destination, scope }) => {
  const rows = ["First", "Second", "Collision"].map((title) => ({
    title,
    file: { path: (scope ? scope + "/" : "") + title + ".md", basename: title },
    result: { state: "verified" as const },
    payloadHash: title,
  }));
  const targets = rows.map(({ file, title }) => ({ file, title, path: file.path, hash: title }));
  const moveToPortfolio = vi.fn(async (file: (typeof rows)[number]["file"]) => {
    if (file.basename === "Collision") throw new Error("Destination already exists");
    file.path = destination + "/" + file.basename + ".md";
  });
  const control = { setAttr: vi.fn(), removeAttribute: vi.fn() };
  const view = Object.assign(Object.create(KnobeLensView.prototype), {
    mounted: true,
    rows,
    portfolioRows: [],
    plugin: {
      settings: { portfolioRoot: root, verificationFolder: scope },
      trust: Object.fromEntries(rows.map(({ payloadHash }) => [payloadHash, { verdict: "trusted" }])),
      moveToPortfolio,
    },
    bulkToolbar: control,
    bulkMove: control,
    scheduleRefresh: { cancel: vi.fn() },
    assertBulkDestination: vi.fn(),
    verifyBulkTarget: vi.fn(async () => true),
    renderSummary: vi.fn(),
    renderRecognitionBoard: vi.fn(),
    renderPortfolios: vi.fn(),
    reportBulkMove: vi.fn(),
  });
  view.refresh = vi.fn(async () => {
    expect(view.renderRecognitionBoard).toHaveBeenCalledOnce();
    expect(view.renderPortfolios).toHaveBeenCalledOnce();
    const [verified] = groupRecognitionRows(view.rows as typeof rows, (row) => view.isFiled(row));
    expect(verified.rows.map((row) => row.title)).toEqual(["Collision"]);
    expect(view.portfolioRows.map((row: (typeof rows)[number]) => row.file.path))
      .toEqual([destination + "/First.md", destination + "/Second.md"]);
    expect([...view.bulkSelection]).toEqual([targets[2].path]);
  });

  await view.runBulkMove(targets, destination, "Research", root);

  expect(moveToPortfolio).toHaveBeenCalledTimes(3);
  expect(view.refresh).toHaveBeenCalledWith(false);
  // runBulkMove catches refresh errors, so also verify all assertions above completed.
  await view.refresh.mock.results[0].value;
});

it("dismisses a verified card without a prior bulk failure or moving the note", async () => {
  const row = { title: "Collision", file: { path: "Inbox/Collision.md" }, payloadHash: "hash" };
  const { path } = row.file;
  const button = {
    getAttribute: vi.fn(),
    setAttr: vi.fn(),
    ownerDocument: { activeElement: null },
  };
  const dismissRecognition = vi.fn(async () => {});
  const view = Object.assign(Object.create(KnobeLensView.prototype), {
    mounted: true,
    plugin: { dismissRecognition, settings: { portfolioRoot: "Portfolios" } },
    pendingDismissals: new Set(),
    bulkSelection: new Set([path]),
    renderSummary: vi.fn(),
    renderRecognitionBoard: vi.fn(),
    reportBulkMove: vi.fn(),
  });

  await view.dismissRecognitionCard(row, path, row.payloadHash, button);

  expect(dismissRecognition).toHaveBeenCalledExactlyOnceWith(path, row.payloadHash);
  expect(row.file.path).toBe(path);
  expect(view.bulkSelection.size).toBe(0);
  expect(view.renderRecognitionBoard).toHaveBeenCalledOnce();
});
