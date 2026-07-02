import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORTFOLIO_COLORS,
  portfolioColor,
  shouldMovePortfolioCard,
} from "../src/board-interactions";

describe("portfolioColor", () => {
  it("assigns distinct default lane colors and cycles safely", () => {
    const firstPass = DEFAULT_PORTFOLIO_COLORS.map((_, index) =>
      portfolioColor("KNOBE Portfolios/Test", index, {}),
    );

    expect(new Set(firstPass).size).toBe(DEFAULT_PORTFOLIO_COLORS.length);
    expect(portfolioColor("KNOBE Portfolios/Test", DEFAULT_PORTFOLIO_COLORS.length, {}))
      .toBe(DEFAULT_PORTFOLIO_COLORS[0]);
  });

  it("uses a saved six-digit hex color and normalizes its case", () => {
    expect(portfolioColor("KNOBE Portfolios/Research", 0, {
      "KNOBE Portfolios/Research": "#A1B2C3",
    })).toBe("#a1b2c3");
  });

  it("rejects malformed persisted colors instead of injecting them into CSS", () => {
    expect(portfolioColor("KNOBE Portfolios/Research", 1, {
      "KNOBE Portfolios/Research": "red; display:none",
    })).toBe(DEFAULT_PORTFOLIO_COLORS[1]);
  });
});

describe("shouldMovePortfolioCard", () => {
  it("moves only when the destination portfolio differs", () => {
    expect(shouldMovePortfolioCard(
      "KNOBE Portfolios/Research",
      "KNOBE Portfolios/Archive",
    )).toBe(true);
    expect(shouldMovePortfolioCard(
      "KNOBE Portfolios/Research",
      "KNOBE Portfolios/Research",
    )).toBe(false);
  });
});
