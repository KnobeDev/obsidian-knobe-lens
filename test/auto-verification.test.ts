import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Plugin: class {}, TFile: class {}, TFolder: class {}, MarkdownView: class {},
  PluginSettingTab: class {}, Setting: class {}, debounce: (fn: unknown) => fn,
  Notice: class {},
}));
vi.mock("../src/view", () => ({ KNOBE_LENS_VIEW: "knobe-lens", KnobeLensView: class {} }));
vi.mock("../src/report", () => ({}));
vi.mock("../src/examples-insert", () => ({}));
vi.mock("../src/protocol-reference-modal", () => ({}));
vi.mock("../src/seal-details-modal", () => ({}));

import KnobeLensPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { sealKnobe } from "../src/seal";

async function setup(path = "Selected/Note.md") {
  const sealed = await sealKnobe("---\ntitle: Test\n---", "Original body", {
    title: "Test", summary: "Test", content_type: "original", created_date: "2026-10-10",
    license: "CC BY 4.0", privacy_level: "public", quarantine_status: "quarantine",
    attribution: { sources: [{ author: "Test", contribution: "authorship" }] },
  });
  const file = { path, extension: "md" };
  const plugin = new (KnobeLensPlugin as any)();
  plugin.settings = { ...DEFAULT_SETTINGS, verificationFolder: "Selected" };
  let raw = sealed;
  const read = vi.fn(async () => raw);
  plugin.app = { vault: {
    read, cachedRead: read, getAbstractFileByPath: (p: string) => p === file.path ? file : null,
    getMarkdownFiles: () => [file], modify: vi.fn(),
  } };
  plugin.persist = vi.fn(async () => {});
  return { plugin, file, sealed, read, setRaw: (value: string) => { raw = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("background verification without an open dashboard", () => {
  it("captures intact notes at startup without granting trust or writing notes", async () => {
    const { plugin, file, sealed } = await setup();
    await plugin.verifyScopedFiles();
    expect(plugin.snapshotFor(file.path)?.content).toBe(sealed);
    expect(plugin.trust).toEqual({});
    expect(plugin.app.vault.modify).not.toHaveBeenCalled();
    expect(plugin.persist).toHaveBeenCalledOnce();
  });

  it("preserves the verified snapshot when the body changes", async () => {
    const { plugin, file, sealed, setRaw } = await setup();
    await plugin.verifyScopedFiles();
    setRaw(sealed.replace("Original body", "Edited body"));
    await plugin.verifyScopedFiles();
    expect(plugin.snapshotFor(file.path)?.content).toBe(sealed);
    expect(plugin.persist).toHaveBeenCalledOnce();
  });

  it("does not read outside the chosen folder or when disabled", async () => {
    const { plugin, read } = await setup("Selected Archive/Note.md");
    await plugin.verifyScopedFiles();
    expect(read).not.toHaveBeenCalled();
    plugin.settings.verificationFolder = "";
    plugin.settings.autoVerify = false;
    await plugin.verifyScopedFiles();
    expect(read).not.toHaveBeenCalled();
  });

  it("debounces repeated events and reads the latest content", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const { plugin, file, read, setRaw } = await setup();
    plugin.scheduleVerification(file);
    plugin.scheduleVerification(file);
    setRaw("An ordinary note without a seal");
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledOnce();
    expect(plugin.snapshotFor(file.path)).toBeNull();
  });
});

describe("settings saves and sweep scheduling", () => {
  it("re-sweeps only when the verification scope changes", async () => {
    const { plugin } = await setup();
    plugin.lastSweptScope = plugin.verificationScopeKey();
    const sweep = vi.spyOn(plugin, "verifyScopedFiles").mockResolvedValue(undefined);
    plugin.settings.author = "Someone typing";
    await plugin.saveSettings();
    expect(sweep).not.toHaveBeenCalled();
    plugin.settings.verificationFolder = "Elsewhere";
    await plugin.saveSettings();
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("collapses overlapping sweep requests into one follow-up sweep", async () => {
    const { plugin } = await setup();
    const sweep = vi.spyOn(plugin, "sweepScopedFiles");
    await Promise.all([plugin.verifyScopedFiles(), plugin.verifyScopedFiles(), plugin.verifyScopedFiles()]);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("skips the disk read when the cached copy carries no seal", async () => {
    const { plugin, read } = await setup();
    const cachedRead = vi.fn(async () => "plain note");
    plugin.app.vault.cachedRead = cachedRead;
    await plugin.verifyScopedFiles();
    expect(cachedRead).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
