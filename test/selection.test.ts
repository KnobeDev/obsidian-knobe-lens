import { describe, it, expect } from "vitest";
import {
  selectAllState,
  toggleSelected, setAllSelected, pruneSelected,
  canTrustAndFileRow,
} from "../src/selection";
import type { ScanRow } from "../src/scanner";
import { setVerdict, TrustLedger } from "../src/trust";

const row = (
  path: string,
  state: ScanRow["result"]["state"] = "verified",
  conformance: ScanRow["result"]["conformance"] = "valid",
  payloadHash: string | null = `${path}-hash`,
): ScanRow =>
  ({
    file: { path },
    result: { state, conformance },
    title: path,
    quarantine: "quarantine",
    contentType: "original",
    raw: "",
    parents: [],
    payloadHash,
  } as unknown as ScanRow);

const trustedOn = (hash: string): TrustLedger =>
  setVerdict({}, hash, "trusted", "ok", "2026-11-08T00:00:00Z");

const rejectedOn = (hash: string): TrustLedger =>
  setVerdict({}, hash, "rejected", "no", "2026-11-08T00:00:00Z");

describe("canTrustAndFileRow (bulk trust-and-file gate)", () => {
  it("includes an already-trusted object", () => {
    expect(canTrustAndFileRow(row("a.md"), trustedOn("a.md-hash"))).toBe(true);
  });
  it("includes a verified, unreviewed object (it can be trusted on file)", () => {
    expect(canTrustAndFileRow(row("a.md", "verified"), {})).toBe(true);
  });
  it("excludes a verified object the user has rejected", () => {
    expect(canTrustAndFileRow(row("a.md", "verified"), rejectedOn("a.md-hash"))).toBe(false);
  });
  it("requires review after body edits even when the old payload hash is still trusted", () => {
    const edited = row("a.md", "verified-body-modified");
    expect(canTrustAndFileRow(edited, trustedOn("a.md-hash"))).toBe(false);
  });
  it("excludes body-modified, failed, and unreadable objects (must be reviewed)", () => {
    expect(canTrustAndFileRow(row("a.md", "verified-body-modified"), {})).toBe(false);
    expect(canTrustAndFileRow(row("a.md", "failed"), {})).toBe(false);
    expect(canTrustAndFileRow(row("a.md", "unreadable", "invalid", null), {})).toBe(false);
  });
});

describe("additional bulk eligibility cases", () => {
  it("permits a verified object with invalid conformance, matching individual Trust", () => {
    expect(canTrustAndFileRow(row("a.md", "verified", "invalid"), {})).toBe(true);
  });

  it("excludes a verified object with no payload identity", () => {
    expect(canTrustAndFileRow(row("a.md", "verified", "valid", null), {})).toBe(false);
  });
});

describe("selectAllState", () => {
  it("is 'none' when nothing is selectable", () => {
    expect(selectAllState(new Set(), [])).toBe("none");
  });
  it("is 'none' when none of the selectable paths are selected", () => {
    expect(selectAllState(new Set(["z"]), ["a", "b"])).toBe("none");
  });
  it("is 'partial' when some but not all selectable paths are selected", () => {
    expect(selectAllState(new Set(["a"]), ["a", "b"])).toBe("partial");
  });
  it("is 'all' when every selectable path is selected", () => {
    expect(selectAllState(new Set(["a", "b"]), ["a", "b"])).toBe("all");
  });
});

describe("toggleSelected (immutable)", () => {
  it("adds a path and returns a new set, leaving the original unchanged", () => {
    const before = new Set(["a"]);
    const after = toggleSelected(before, "b");
    expect([...after].sort()).toEqual(["a", "b"]);
    expect([...before]).toEqual(["a"]); // not mutated
    expect(after).not.toBe(before);
  });
  it("removes a path that was already selected", () => {
    expect([...toggleSelected(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });
});

describe("setAllSelected (immutable)", () => {
  it("adds every selectable path, preserving unrelated selections", () => {
    const after = setAllSelected(new Set(["keep"]), ["a", "b"], true);
    expect([...after].sort()).toEqual(["a", "b", "keep"]);
  });
  it("removes every selectable path, preserving unrelated selections", () => {
    const after = setAllSelected(new Set(["a", "b", "keep"]), ["a", "b"], false);
    expect([...after]).toEqual(["keep"]);
  });
});

describe("pruneSelected", () => {
  it("drops selected paths that are no longer selectable (after a refresh)", () => {
    const after = pruneSelected(new Set(["a", "gone", "b"]), ["a", "b", "c"]);
    expect([...after].sort()).toEqual(["a", "b"]);
  });
});
