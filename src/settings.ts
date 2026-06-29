import { App, PluginSettingTab, Setting } from "obsidian";
import type KnobeLensPlugin from "./main";

export interface KnobeLensSettings {
  author: string;
  contribution: string;
  license: string;
  contentType: string;
  privacyLevel: string;
  quarantineStatus: string;
  defaultSummary: string;
  resealOnSave: boolean;
  embedBodySnapshot: boolean;
}

export const DEFAULT_SETTINGS: KnobeLensSettings = {
  author: "",
  contribution: "authorship",
  license: "CC BY 4.0",
  contentType: "original",
  privacyLevel: "public",
  quarantineStatus: "quarantine",
  defaultSummary: "",
  resealOnSave: false,
  embedBodySnapshot: false,
};

const CONTENT_TYPES = ["original", "synthesis", "adaptation", "compression", "annotation", "seed", "collection", "translation"];
const PRIVACY = ["public", "internal", "sensitive", "restricted"];
const QUARANTINE = ["quarantine", "trusted", "rejected"];

export class KnobeLensSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: KnobeLensPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h3", { text: "Sealing defaults" });
    containerEl.createEl("p", {
      text: "Used when frontmatter does not already supply a field. The seal is keyless (SHA-256 integrity only).",
      cls: "setting-item-description",
    });

    const text = (name: string, desc: string, get: () => string, set: (v: string) => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(get()).onChange(async (v) => {
          set(v);
          await this.plugin.saveSettings();
        }),
      );

    const dropdown = (name: string, desc: string, opts: string[], get: () => string, set: (v: string) => void) =>
      new Setting(containerEl).setName(name).setDesc(desc).addDropdown((d) => {
        opts.forEach((o) => d.addOption(o, o));
        d.setValue(get()).onChange(async (v) => {
          set(v);
          await this.plugin.saveSettings();
        });
      });

    const s = this.plugin.settings;
    text("Author", "Default attribution author for new seals", () => s.author, (v) => (s.author = v));
    text("Contribution", "How the author contributed (e.g. authorship, adaptation)", () => s.contribution, (v) => (s.contribution = v));
    text("License", "Default license", () => s.license, (v) => (s.license = v));
    text("Default summary", "Used when a note has no summary in frontmatter", () => s.defaultSummary, (v) => (s.defaultSummary = v));
    dropdown("Content type", "Default content_type", CONTENT_TYPES, () => s.contentType, (v) => (s.contentType = v));
    dropdown("Privacy level", "Default privacy_level", PRIVACY, () => s.privacyLevel, (v) => (s.privacyLevel = v));
    dropdown("Quarantine status", "Default declared quarantine_status (quarantine-first is recommended)", QUARANTINE, () => s.quarantineStatus, (v) => (s.quarantineStatus = v));

    containerEl.createEl("h3", { text: "Save behavior" });
    new Setting(containerEl)
      .setName("Re-seal on save")
      .setDesc("When you edit a note that already contains a KNOBE block, automatically re-seal it so the seal stays valid. Only touches already-sealed notes.")
      .addToggle((t) =>
        t.setValue(s.resealOnSave).onChange(async (v) => {
          s.resealOnSave = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Embed body snapshot (self-contained restore)")
      .setDesc("Store a sealed copy of the body inside the payload so a broken seal can be restored from the file alone. Doubles the body size and spreads the content — never applied to notes whose privacy_level is 'restricted'. Leave off for consent-limited or sensitive material.")
      .addToggle((t) =>
        t.setValue(s.embedBodySnapshot).onChange(async (v) => {
          s.embedBodySnapshot = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
