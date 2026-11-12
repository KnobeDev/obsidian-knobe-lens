import { App, Modal, Notice } from "obsidian";

interface TrustConfirmModalOptions {
  message: string;
  tone: "promote" | "reject";
  onReview: () => void;
  onConfirm: () => Promise<void>;
}

let nextDialogId = 0;

/** Confirmation gate for trusting a modified or failed object from the detail
 * pane. The safe "Review payload" action receives initial focus; trust still
 * requires a separate pointer-up/keyboard activation. Trusting records a local
 * verdict only; it does not file the object (see canFileRow). */
export class TrustConfirmModal extends Modal {
  constructor(app: App, private opts: TrustConfirmModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Check the payload before trusting");

    // Name, role and description for the dialog, so the warning is read when
    // focus lands on "Review payload". Obsidian's Modal sets none (SC 4.1.2).
    const titleId = `kl-trust-confirm-${++nextDialogId}`;
    const warningId = `${titleId}-warning`;
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.titleEl.id = titleId;
    this.modalEl.setAttr("aria-labelledby", titleId);
    this.modalEl.setAttr("aria-describedby", warningId);

    contentEl.createEl("p", {
      cls: "knobe-lens-trust-warning",
      text: this.opts.message,
      attr: { id: warningId },
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
      text: "Trust anyway",
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
