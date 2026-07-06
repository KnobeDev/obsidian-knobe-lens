import { describe, it, expect, vi } from "vitest";
import { installSaveHook, SaveCommand } from "../src/save-hook";

describe("installSaveHook", () => {
  it("returns null when there is no callable command to wrap", () => {
    expect(installSaveHook(undefined, () => {})).toBeNull();
    expect(installSaveHook({}, () => {})).toBeNull();
    expect(installSaveHook({ callback: 123 as unknown as () => unknown }, () => {})).toBeNull();
  });

  it("runs the original save first, then afterSave, returning the original result", () => {
    const order: string[] = [];
    const cmd: SaveCommand = { callback: () => { order.push("save"); return "R"; } };
    const restore = installSaveHook(cmd, () => order.push("after"));
    expect(restore).not.toBeNull();
    const result = cmd.callback!();
    expect(order).toEqual(["save", "after"]);
    expect(result).toBe("R");
  });

  it("still runs afterSave when the native save returns undefined", () => {
    const after = vi.fn();
    const cmd: SaveCommand = { callback: () => undefined };
    installSaveHook(cmd, after);
    cmd.callback!();
    expect(after).toHaveBeenCalledOnce();
  });

  it("never lets an afterSave error break the native save", () => {
    const cmd: SaveCommand = { callback: () => "saved" };
    installSaveHook(cmd, () => { throw new Error("boom"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: unknown;
    expect(() => { result = cmd.callback!(); }).not.toThrow();
    expect(result).toBe("saved");
    err.mockRestore();
  });

  it("restore reverts to the original callback", () => {
    const original = () => "orig";
    const cmd: SaveCommand = { callback: original };
    const restore = installSaveHook(cmd, () => {})!;
    expect(cmd.callback).not.toBe(original);
    restore();
    expect(cmd.callback).toBe(original);
  });

  it("restore is a no-op if another plugin wrapped the callback after us", () => {
    const original = () => "orig";
    const cmd: SaveCommand = { callback: original };
    const restore = installSaveHook(cmd, () => {})!;
    const foreign = () => "foreign"; // a later plugin wraps on top of ours
    cmd.callback = foreign;
    restore();
    expect(cmd.callback).toBe(foreign); // preserved, not stripped back to original
  });
});
