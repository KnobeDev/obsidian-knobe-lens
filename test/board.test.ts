import { describe, expect, it } from "vitest";
import { groupPortfolioRows, groupRecognitionRows, RECOGNITION_ORDER } from "../src/board";

type State = "verified" | "verified-body-modified" | "failed" | "unreadable";
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
