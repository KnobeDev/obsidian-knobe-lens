/**
 * new-folder-modal.ts — accessible "+ New folder" prompt. Obsidian ships no
 * prompt primitive, so this is a small Modal: a labelled text input, Create /
 * Cancel, Enter-to-submit, Escape-to-cancel, and an assertive error region.
 *
 * onSubmit does the real work (create folder + move the file) and returns an
 * error message string to display inline, or null on success (which closes the
 * modal). This keeps validation feedback in the dialog without losing the user's
 * typed name on a recoverable error (e.g. duplicate name).
 */

import { App, Modal } from "obsidian";
import { sanitizePortfolioName } from "./portfolio";

interface NewFolderModalOptions {
  /** Returns an error message to show inline, or null on success. */
  onSubmit: (name: string) => Promise<string | null>;
}

export class NewFolderModal extends Modal {
  constructor(app: App, private opts: NewFolderModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("New portfolio folder");

    const inputId = "kl-newfolder-name";
    const errId = "kl-newfolder-err";

    contentEl.createEl("label", {
      text: "Folder name",
      cls: "knobe-lens-field-label",
      attr: { for: inputId },
    });
    const input = contentEl.createEl("input", {
      cls: "knobe-lens-newfolder-input",
      attr: { id: inputId, type: "text", placeholder: "e.g. Spring 2026 portfolio" },
    });

    // role="alert" => assertive live region: announces when its text is set.
    const err = contentEl.createEl("p", { cls: "knobe-lens-error", attr: { id: errId, role: "alert" } });
    input.setAttr("aria-describedby", errId);

    let busy = false;
    const showError = (msg: string): void => {
      err.setText(msg);
      input.setAttr("aria-invalid", "true");
      input.focus();
    };
    const submit = async (): Promise<void> => {
      if (busy) return;
      const name = sanitizePortfolioName(input.value);
      if (!name) {
        showError('Enter a folder name without \\ / : * ? " < > | characters.');
        return;
      }
      busy = true;
      try {
        const problem = await this.opts.onSubmit(name);
        if (problem) { showError(problem); return; }
        this.close();
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
    };

    // Clear the error state as the user corrects the name.
    input.addEventListener("input", () => {
      if (err.textContent) err.setText("");
      input.removeAttribute("aria-invalid");
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void submit(); }
    });

    const actions = contentEl.createDiv({ cls: "knobe-lens-actions" });
    const create = actions.createEl("button", { text: "Create", cls: "mod-cta" });
    create.onclick = () => void submit(); // click = up-event (SC 2.5.2)
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    // Initial focus on the input, after the modal mounts.
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
