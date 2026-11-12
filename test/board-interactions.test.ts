import { describe, expect, it } from "vitest";
import {
  DEFAULT_PORTFOLIO_COLORS,
  portfolioColor,
  shouldMovePortfolioCard,
  trustToFilePolicy,
  boardSummary,
  type SummaryEntry,
} from "../src/board-interactions";
import type { Status } from "../src/lens-core";

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

describe("trustToFilePolicy", () => {
  it("uses normal trust styling without a warning for verified objects", () => {
    expect(trustToFilePolicy("verified")).toEqual({
      tone: "trust",
      warning: null,
    });
  });

  it("uses orange styling and asks for payload confirmation when the body changed", () => {
    const policy = trustToFilePolicy("verified-body-modified");
    expect(policy.tone).toBe("promote");
    expect(policy.warning).toContain("checked the payload");
    expect(policy.warning).toContain("body has changed");
  });

  it("uses red styling and asks for payload confirmation when verification failed", () => {
    const policy = trustToFilePolicy("failed");
    expect(policy.tone).toBe("reject");
    expect(policy.warning).toContain("checked the payload");
    expect(policy.warning).toContain("verification failed");
  });
});

describe("trustToFilePolicy says what trusting does not do", () => {
  it("tells the user a trusted verdict will not file a failed or edited object", () => {
    for (const state of ["failed", "verified-body-modified"] as const) {
      expect(trustToFilePolicy(state).warning, state).toContain("can't be filed in a portfolio until its seal verifies");
    }
  });
});

describe("boardSummary", () => {
  const entry = (state: Status, filed = false, quarantined = false): SummaryEntry => ({ state, filed, quarantined });

  it("says when the vault has no sealed notes", () => {
    expect(boardSummary([])).toBe("No sealed KNOBE notes found in this vault yet.");
  });

  it("counts unfiled objects by state, then the filed ones", () => {
    expect(boardSummary([entry("verified"), entry("failed", false, true), entry("verified", true)])).toBe(
      "1 verified · 0 body-modified · 1 failed · 0 unreadable · 1 quarantined · 1 filed",
    );
  });

  it("keeps a filed object with a broken seal visible as failed or unreadable", () => {
    expect(boardSummary([entry("verified"), entry("failed", true), entry("unreadable", true), entry("verified", true)])).toBe(
      "1 verified · 0 body-modified · 0 failed · 0 unreadable · 0 quarantined · 3 filed (1 failed, 1 unreadable)",
    );
  });

  it("counts dismissed cards alongside filed objects with broken seals", () => {
    expect(boardSummary([], 2)).toBe("2 hidden from Recognition.");
    expect(boardSummary([entry("failed", true)], 1)).toContain("1 filed (1 failed) · 1 hidden");
  });

  it("names broken filed objects when everything is filed", () => {
    expect(boardSummary([entry("verified", true), entry("failed", true)])).toBe("All 2 KNOBEs filed in portfolios (1 failed).");
    expect(boardSummary([entry("verified", true)])).toBe("All 1 KNOBE filed in portfolios.");
  });
});
