import { App, Modal } from "obsidian";

interface SealCommentOptions {
  /** Object title, shown in the modal heading. */
  title: string;
  /** Verb for the confirm button, e.g. "Comment & reseal". */
  action?: string;
  /** Perform the reseal. Return null on success or a user-facing error message. */
  onSubmit: (comment: string) => Promise<string | null>;
}

/**
 * Collects the user's thoughts on a document before sealing it as a KNOBE.
 * The comment is written into the sealed payload's reseal_log (append-only,
 * integrity-protected), so it travels with the file. Submit is button-only —
 * the textarea keeps Enter for newlines.
 */
export class SealCommentModal extends Modal {
  constructor(app: App, private options: SealCommentOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`Comment and reseal — ${this.options.title}`);
    contentEl.createEl("p", {
      cls: "knobe-lens-muted",
      text:
        "Record your thoughts on this document. The comment is sealed into the object's history and travels with the file.",
    });
    const input = contentEl.createEl("textarea", {
      cls: "knobe-lens-seal-comment",
      attr: {
        rows: "3",
        placeholder: "e.g. reviewed against the source; numbers check out",
        "aria-label": "Seal comment",
      },
    });
    const error = contentEl.createEl("div", { cls: "knobe-lens-error", attr: { role: "alert" } });

    const actions = contentEl.createDiv({ cls: "knobe-lens-actions" });
    const seal = actions.createEl("button", {
      cls: "knobe-lens-action-button is-trust",
      text: this.options.action ?? "Comment & reseal",
    });
    seal.onclick = async () => {
      seal.setAttr("disabled", "true");
      const message = await this.options.onSubmit(input.value);
      if (message) {
        error.setText(message);
        seal.removeAttribute("disabled");
      } else {
        this.close();
      }
    };
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
