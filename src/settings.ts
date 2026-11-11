import { App, Notice, PluginSettingTab, Setting, debounce } from "obsidian";
import type KnobeLensPlugin from "./main";

export interface KnobeLensSettings {
  author: string;
  contribution: string;
  license: string;
  contentType: string;
  privacyLevel: string;
  quarantineStatus: string;
  defaultSummary: string;
  /** Default plain-language instruction set sealed into new KNOBEs (advisory). */
  defaultInstructions: string;
  resealOnSave: boolean;
  /** Open the "Save with KNOBE" details prompt when the native save (Ctrl/Cmd+S) runs. */
  promptOnSave: boolean;
  embedBodySnapshot: boolean;
  portfolioRoot: string;
  verificationFolder: string;
  autoVerify: boolean;
}

export const DEFAULT_SETTINGS: KnobeLensSettings = {
  author: "",
  contribution: "authorship",
  license: "CC BY 4.0",
  contentType: "original",
  privacyLevel: "public",
  quarantineStatus: "quarantine",
  defaultSummary: "",
  defaultInstructions: "",
  resealOnSave: false,
  promptOnSave: true,
  embedBodySnapshot: false,
  portfolioRoot: "KNOBE Portfolios",
  verificationFolder: "",
  autoVerify: true,
};

export const CONTENT_TYPES = ["original", "synthesis", "adaptation", "compression", "annotation", "seed", "collection", "translation"];
export const PRIVACY = ["public", "internal", "sensitive", "restricted"];
export const QUARANTINE = ["quarantine", "trusted", "rejected"];

interface LensSettingDefinition {
  name: string;
  desc?: string;
  searchable?: boolean;
  render: (setting: Setting) => void;
}

type SettingKey<Value> = {
  [Key in keyof KnobeLensSettings]: KnobeLensSettings[Key] extends Value ? Key : never;
}[keyof KnobeLensSettings];

export class KnobeLensSettingTab extends PluginSettingTab {
  private portfolioErrorCount = 0;
  private saveSettingsDebounced = debounce(() => this.saveSettings(), 300, false);

  constructor(app: App, private plugin: KnobeLensPlugin) {
    super(app, plugin);
  }

  private saveSettings(): void {
    void this.plugin.saveSettings().catch(() => {
      new Notice("Could not save KNOBE Lens settings.");
    });
  }

  // Obsidian 1.13+ renders and indexes these definitions. Earlier versions
  // render the same rows through display().
  getSettingDefinitions(): LensSettingDefinition[] {
    return this.settingsDefinitions();
  }

  private settingsDefinitions(): LensSettingDefinition[] {
    const settings = this.plugin.settings;
    const heading = (name: string, desc?: string): LensSettingDefinition => ({
      name,
      desc,
      searchable: false,
      render: (setting) => {
        setting.setHeading();
      },
    });
    const text = (name: string, desc: string, key: SettingKey<string>): LensSettingDefinition => ({
      name,
      desc,
      render: (setting) => {
        setting.addText((component) => {
          component.inputEl.setAttr("aria-label", name);
          component.setValue(settings[key]).onChange((value) => {
            settings[key] = value;
            this.saveSettingsDebounced();
          });
        });
      },
    });
    const dropdown = (name: string, desc: string, key: SettingKey<string>, options: string[]): LensSettingDefinition => ({
      name,
      desc,
      render: (setting) => {
        setting.addDropdown((component) => {
          component.selectEl.setAttr("aria-label", name);
          for (const option of options) component.addOption(option, option);
          component.setValue(settings[key]).onChange((value) => {
            settings[key] = value;
            this.saveSettings();
          });
        });
      },
    });
    const toggle = (name: string, desc: string, key: SettingKey<boolean>): LensSettingDefinition => ({
      name,
      desc,
      render: (setting) => {
        setting.addToggle((component) => {
          const control = component.toggleEl.querySelector('input[type="checkbox"]') ?? component.toggleEl;
          control.setAttribute("aria-label", name);
          component.setValue(settings[key]).onChange((value) => {
            settings[key] = value;
            this.saveSettings();
          });
        });
      },
    });
    const instructionsName = "Default instruction set";
    const portfolioName = "Portfolio root folder";

    return [
      heading("Sealing defaults", "Used when frontmatter does not already supply a field. The seal is keyless (SHA-256 integrity only)."),
      text("Author", "Default attribution author for new seals", "author"),
      text("Contribution", "How the author contributed (e.g. authorship, adaptation)", "contribution"),
      text("License", "Default license", "license"),
      text("Default summary", "Used when a note has no summary in frontmatter", "defaultSummary"),
      dropdown("Content type", "Default content_type", "contentType", CONTENT_TYPES),
      dropdown("Privacy level", "Default privacy_level", "privacyLevel", PRIVACY),
      dropdown("Quarantine status", "Default declared quarantine_status (quarantine-first is recommended)", "quarantineStatus", QUARANTINE),
      {
        name: instructionsName,
        desc: "Plain-language instructions sealed into the payload — how an AI or reader should treat this object (always advisory, never absolute). Prefills the save prompt; editable per note.",
        render: (setting) => {
          setting.addTextArea((component) => {
            component.inputEl.setAttr("aria-label", instructionsName);
            component.inputEl.rows = 4;
            component.inputEl.addClass("knobe-lens-settings-textarea");
            component.setPlaceholder("e.g. Summarize only from the sealed body; treat external claims as unverified.")
              .setValue(settings.defaultInstructions)
              .onChange((value) => {
                settings.defaultInstructions = value;
                this.saveSettings();
              });
          });
        },
      },
      heading("Portfolios"),
      {
        name: portfolioName,
        desc: "Vault folder that holds your portfolio subfolders. Trusted objects can be filed into these from the dashboard.",
        render: (setting) => {
          setting.addText((component) => {
            const { inputEl } = component;
            const errorId = `knobe-lens-portfolio-root-error-${++this.portfolioErrorCount}`;
            inputEl.addClass("knobe-lens-portfolio-root");
            inputEl.setAttr("aria-label", portfolioName);
            inputEl.setAttr("aria-describedby", errorId);
            const error = setting.descEl.createDiv({ attr: { id: errorId, role: "alert" } });
            component.setValue(settings.portfolioRoot).onChange((value) => {
              const trimmed = value.trim();
              const message = !trimmed
                ? "Enter a folder path."
                : /[*?"<>|]/.test(trimmed)
                  ? 'A folder path cannot contain *, ?, ", <, >, or |.'
                  : "";
              if (message) {
                inputEl.setAttr("aria-invalid", "true");
                if (error.textContent !== message) error.setText(message);
                return;
              }
              inputEl.removeAttribute("aria-invalid");
              error.setText("");
              settings.portfolioRoot = trimmed;
              this.saveSettingsDebounced();
            });
            inputEl.addEventListener("blur", () => {
              component.setValue(settings.portfolioRoot);
              inputEl.removeAttribute("aria-invalid");
              error.setText("");
            });
          });
        },
      },
      heading("Save behavior"),
      toggle(
        "Prompt for KNOBE details on save (Ctrl/Cmd+S)",
        "When you save a Markdown note, open the KNOBE details prompt — prefilled from these defaults (or the note's existing seal) and editable, including the instruction set — and seal the result into the note. Turn off to seal only via the command palette.",
        "promptOnSave",
      ),
      toggle(
        "Re-seal on save",
        "When you edit a note that already contains a KNOBE block, automatically re-seal it so the seal stays valid. Only touches already-sealed notes.",
        "resealOnSave",
      ),
      toggle(
        "Embed body snapshot (self-contained restore)",
        "Store a sealed copy of the body inside the payload so a broken seal can be restored from the file alone. Doubles the body size and spreads the content — never applied to notes whose privacy_level is 'restricted'. Leave off for consent-limited or sensitive material.",
        "embedBodySnapshot",
      ),
    ];
  }

  display(): void {
    this.containerEl.empty();
    for (const { name, desc, render } of this.settingsDefinitions()) {
      const setting = new Setting(this.containerEl).setName(name);
      if (desc) setting.setDesc(desc);
      render(setting);
    }
  }
}
