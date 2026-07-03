import { describe, it, expect } from "vitest";
import { savedState } from "../src/saved-state";

describe("savedState — filed object presentation", () => {
  it("unfiled objects are never saved/reverify (none), whatever their state", () => {
    expect(savedState(false, "verified", "valid")).toBe("none");
    expect(savedState(false, "verified-body-modified", "valid")).toBe("none");
    expect(savedState(false, "failed", "invalid")).toBe("none");
  });

  it("filed + intact seal earns the checkmark", () => {
    expect(savedState(true, "verified", "valid")).toBe("saved-verified");
  });

  it("filed + verified but warnings still earns the checkmark (warnings != integrity failure)", () => {
    expect(savedState(true, "verified", "warnings")).toBe("saved-verified");
  });

  it("filed + verified but invalid conformance does not earn the checkmark", () => {
    expect(savedState(true, "verified", "invalid")).toBe("none");
  });

  it("filed + body edited since sealing -> needs reverify", () => {
    expect(savedState(true, "verified-body-modified", "valid")).toBe("needs-reverify");
    // conformance is irrelevant once the body was edited.
    expect(savedState(true, "verified-body-modified", "invalid")).toBe("needs-reverify");
  });

  it("filed + broken/unreadable seal is not a reverify case (routes to break inspector)", () => {
    expect(savedState(true, "failed", "invalid")).toBe("none");
    expect(savedState(true, "unreadable", "invalid")).toBe("none");
  });
});
