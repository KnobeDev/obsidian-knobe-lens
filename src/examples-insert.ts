/**
 * examples-insert.ts — write bundled example KNOBEs into the vault and pick
 * which to insert. Inserting an example is a plain vault write of verbatim
 * protocol content; the dashboard's own auto-refresh then picks it up.
 */

import { App, Modal, TFile, normalizePath, setIcon } from "obsidian";
import { KnobeExample, KNOBE_EXAMPLES, decodeExample } from "./examples";

export const EXAMPLES_DIR = "KNOBE Examples";

/** A collision-free path under the examples folder for `name`. */
function uniquePath(app: App, name: string): string {
  const base = name.replace(/\.md$/i, "");
  let candidate = normalizePath(`${EXAMPLES_DIR}/${base}.md`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = normalizePath(`${EXAMPLES_DIR}/${base} (${i}).md`);
    i++;
  }
  return candidate;
}

/** Write one example into the examples folder (created lazily) and return the
 *  new note. Never overwrites an existing file — a second insert is a new copy. */
export async function writeExample(app: App, ex: KnobeExample): Promise<TFile> {
  if (!app.vault.getAbstractFileByPath(EXAMPLES_DIR)) {
    await app.vault.createFolder(EXAMPLES_DIR);
  }
  const path = uniquePath(app, ex.suggestedName);
  return app.vault.create(path, decodeExample(ex));
}

/** Accessible picker: each example is a labelled row with an Insert button,
 *  plus an "Insert all" that seeds the whole set (including the lineage pair).
 *  Insertion happens on the up-event of a real button (SC 2.5.2). */
export class ExamplePickerModal extends Modal {
  constructor(app: App, private onInsert: (examples: KnobeExample[]) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const c = this.contentEl;
    c.addClass("knobe-lens-example-modal");
    this.setTitle("Insert an example KNOBE");
    c.createEl("p", {
      cls: "knobe-lens-muted",
      text: "Real, verifiable KNOBE Protocol v1 documents. Inserting one drops a sealed note into a “KNOBE Examples” folder so you can see it verified in the dashboard.",
    });

    const list = c.createEl("ul", { cls: "knobe-lens-example-list", attr: { "aria-label": "Example KNOBE documents" } });
    let firstBtn: HTMLButtonElement | null = null;
    for (const ex of KNOBE_EXAMPLES) {
      const li = list.createEl("li", { cls: "knobe-lens-example-item" });
      const info = li.createDiv({ cls: "knobe-lens-example-info" });
      info.createEl("div", { cls: "knobe-lens-example-title", text: ex.title });
      const badges = info.createDiv({ cls: "knobe-lens-example-badges" });
      badges.createSpan({ cls: "knobe-lens-example-badge", text: ex.kind });
      badges.createSpan({ cls: "knobe-lens-example-badge is-muted", text: ex.quarantine });
      info.createEl("div", { cls: "knobe-lens-example-desc", text: ex.description });

      const insert = li.createEl("button", { cls: "knobe-lens-action-button is-trust knobe-lens-icon-button" });
      setIcon(insert.createSpan({ cls: "knobe-lens-btn-icon" }), "file-plus");
      insert.createSpan({ text: "Insert" });
      insert.setAttr("aria-label", `Insert example: ${ex.title}`);
      insert.onclick = () => void this.run([ex]);
      firstBtn = firstBtn ?? insert;
    }

    const actions = c.createDiv({ cls: "knobe-lens-actions" });
    const all = actions.createEl("button", { cls: "knobe-lens-primary-action", text: "Insert all" });
    all.setAttr("aria-label", "Insert all example KNOBE documents, including the linked source and synthesis pair");
    all.onclick = () => void this.run(KNOBE_EXAMPLES.slice());
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    window.setTimeout(() => firstBtn?.focus(), 0);
  }

  private async run(examples: KnobeExample[]): Promise<void> {
    this.close();
    await this.onInsert(examples);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
