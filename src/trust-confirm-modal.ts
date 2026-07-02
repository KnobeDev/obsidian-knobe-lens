import { App, Modal, Notice } from "obsidian";

interface TrustConfirmModalOptions {
  message: string;
  tone: "promote" | "reject";
  onReview: () => void;
  onConfirm: () => Promise<void>;
}

/** Confirmation gate for trusting a modified or failed object. The safe
 * "Review payload" action receives initial focus; trust still requires a
 * separate pointer-up/keyboard activation. */
export class TrustConfirmModal extends Modal {
  constructor(app: App, private opts: TrustConfirmModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Check the payload before trusting");

    contentEl.createEl("p", {
      cls: "knobe-lens-trust-warning",
      text: this.opts.message,
    });

    const actions = contentEl.createDiv({ cls: "knobe-lens-actions" });
    const review = actions.createEl("button", {
      cls: "knobe-lens-primary-action",
      text: "Review payload",
    });
    review.onclick = () => {
      this.close();
      this.opts.onReview();
    };

    const confirm = actions.createEl("button", {
      cls: `knobe-lens-action-button is-${this.opts.tone}`,
      text: "Trust to file",
    });
    let busy = false;
    confirm.onclick = () => void (async () => {
      if (busy) return;
      busy = true;
      confirm.setAttr("disabled", "true");
      try {
        await this.opts.onConfirm();
        this.close();
      } catch (error) {
        console.error("[knobe-lens] trust confirmation failed:", error);
        new Notice("Could not record the trust decision — see the developer console.");
        confirm.removeAttribute("disabled");
      } finally {
        busy = false;
      }
    })();

    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    window.setTimeout(() => review.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
