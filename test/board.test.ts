import { describe, expect, it } from "vitest";
import { groupOtherFormatRows, groupPortfolioRows, groupRecognitionRows, otherFormatLabel, RECOGNITION_ORDER } from "../src/board";

type State = "verified" | "verified-body-modified" | "failed" | "unreadable" | "not-v1";
type Row = {
  file: { path: string };
  result: { state: State };
  title: string;
};

const row = (path: string, state: State, title = path): Row => ({
  file: { path },
  result: { state },
  title,
});

describe("groupRecognitionRows", () => {
  it("always returns the four recognition columns in a stable order", () => {
    const columns = groupRecognitionRows<Row>([
      row("broken.md", "failed"),
      row("good.md", "verified"),
    ]);

    expect(columns.map((column) => column.state)).toEqual(RECOGNITION_ORDER);
    expect(columns.map((column) => column.rows.length)).toEqual([1, 0, 1, 0]);
  });

  it("excludes filed rows from the recognition inbox", () => {
    const columns = groupRecognitionRows<Row>(
      [
        row("Inbox/good.md", "verified"),
        row("KNOBE Portfolios/Research/filed.md", "verified"),
      ],
      (candidate) => candidate.file.path.startsWith("KNOBE Portfolios/"),
    );

    expect(columns.flatMap((column) => column.rows).map((candidate) => candidate.file.path))
      .toEqual(["Inbox/good.md"]);
  });
});

describe("groupPortfolioRows", () => {
  const folders = [
    { name: "Archive", path: "KNOBE Portfolios/Archive" },
    { name: "Research", path: "KNOBE Portfolios/Research" },
  ];

  it("creates one lane per folder, including empty folders", () => {
    const lanes = groupPortfolioRows<Row>(folders, [
      row("KNOBE Portfolios/Research/alpha.md", "verified"),
    ]);

    expect(lanes.map((lane) => [lane.folder.name, lane.rows.length])).toEqual([
      ["Archive", 0],
      ["Research", 1],
    ]);
  });

  it("includes files in nested subfolders beneath a portfolio", () => {
    const lanes = groupPortfolioRows<Row>(folders, [
      row("KNOBE Portfolios/Research/2026/alpha.md", "verified"),
      row("KNOBE Portfolios Archive/not-filed.md", "failed"),
    ]);

    expect(lanes[1].rows.map((candidate) => candidate.title)).toEqual([
      "KNOBE Portfolios/Research/2026/alpha.md",
    ]);
  });
});

describe("objects that are not KNOBE v1", () => {
  const folders = [{ name: "Research", path: "KNOBE Portfolios/Research" }];

  it("never appear in a Recognition column", () => {
    const columns = groupRecognitionRows<Row>([
      row("Inbox/grove.md", "not-v1"),
      row("Inbox/good.md", "verified"),
    ]);
    expect(RECOGNITION_ORDER).not.toContain("not-v1");
    expect(columns.flatMap((column) => column.rows).map((r) => r.file.path)).toEqual(["Inbox/good.md"]);
  });

  it("never appear in a portfolio lane, even when the file sits in the portfolio folder", () => {
    const [lane] = groupPortfolioRows<Row>(folders, [
      row("KNOBE Portfolios/Research/grove.md", "not-v1"),
      row("KNOBE Portfolios/Research/alpha.md", "verified"),
    ]);
    expect(lane.rows.map((r) => r.file.path)).toEqual(["KNOBE Portfolios/Research/alpha.md"]);
  });

  it("are listed on their own, once each, from the scan and the portfolios", () => {
    const inbox = row("Inbox/grove.md", "not-v1");
    const filed = row("KNOBE Portfolios/Research/journey.md", "not-v1");
    const other = groupOtherFormatRows<Row>(
      [inbox, row("Inbox/good.md", "verified"), filed],
      [filed, row("KNOBE Portfolios/Research/alpha.md", "verified")],
    );
    expect(other.map((r) => r.file.path)).toEqual(["Inbox/grove.md", "KNOBE Portfolios/Research/journey.md"]);
  });

  it("include one that sits only in a portfolio, outside the scan folder", () => {
    const filed = row("KNOBE Portfolios/Research/journey.md", "not-v1");
    expect(groupOtherFormatRows<Row>([row("Inbox/good.md", "verified")], [filed])).toEqual([filed]);
  });
});

describe("otherFormatLabel", () => {
  const check = (hashMatches: boolean | null, coveredFields = ["a", "b"]) =>
    ({ format: "KNOBE.AI 0.1", hashMatches, coveredFields });

  it("says what the file's own hash covers, without a KNOBE v1 verdict word", () => {
    const labels = [otherFormatLabel(check(true)), otherFormatLabel(check(false, ["a"])), otherFormatLabel(check(null))];
    expect(labels).toEqual([
      "KNOBE.AI 0.1 · its hash matches the 2 fields it lists, and only those",
      "KNOBE.AI 0.1 · its hash does not match the 1 field it lists",
      "KNOBE.AI 0.1 · hash not checked",
    ]);
    for (const label of labels) expect(label).not.toMatch(/\b(verified|valid|failed)\b/i);
  });
});
