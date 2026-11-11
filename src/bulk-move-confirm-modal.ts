import { App, Modal } from "obsidian";

interface BulkMoveConfirmOptions {
  /** How many selected objects will be TRUSTED (a local verdict) before filing. */
  trustCount: number;
  /** How many selected objects are already trusted and only move. */
  readyCount: number;
  /** Destination portfolio name, shown in the prompt. */
  folderName: string;
  /** Run the trust-and-move. Called AFTER the modal closes (so it can manage
   *  focus on the view behind it); it owns its own error reporting. */
  onConfirm: () => void;
  /** Called once the modal has closed, with whether the user confirmed. Lets the
   *  caller clear its pending-confirm guard and, when NOT confirmed, return focus. */
  onClosed: (confirmed: boolean) => void;
}

let nextDialogId = 0;

/**
 * Confirmation gate for bulk trust-and-file: trusting several objects at once is
 * the user's decision, so it is never silent. Cancel receives initial focus (the
 * safe default) and trusting requires a separate pointer-up/keyboard activation.
 * The verdict is local and reversible, which the copy states plainly.
 */
export class BulkMoveConfirmModal extends Modal {
  private confirmed = false;

  constructor(app: App, private opts: BulkMoveConfirmOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    this.setTitle("Trust and file selected objects");

    // Name/role/description for the dialog — do not assume the Obsidian version
    // labels .modal for us (SC 4.1.2).
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    const titleId = `kl-bulk-confirm-${++nextDialogId}`;
    const trustDescriptionId = `${titleId}-trust`;
    const destinationDescriptionId = `${titleId}-destination`;
    this.titleEl.id = titleId;
    this.modalEl.setAttr("aria-labelledby", titleId);
    this.modalEl.setAttr("aria-describedby", `${trustDescriptionId} ${destinationDescriptionId}`);

    const n = opts.trustCount;
    contentEl.createEl("p", {
      attr: { id: trustDescriptionId },
      text:
        `${n} selected object${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} not yet trusted. ` +
        `Filing ${n === 1 ? "it" : "them"} records a local “trusted” verdict for each — your decision only, ` +
        "never written to the file, and reversible from the object's detail view." +
        (opts.readyCount > 0
          ? ` ${opts.readyCount} already-trusted object${opts.readyCount === 1 ? "" : "s"} will also move.`
          : ""),
    });
    contentEl.createEl("p", {
      cls: "knobe-lens-muted",
      attr: { id: destinationDescriptionId },
      text: `Move all to “${opts.folderName}”?`,
    });

    const actions = contentEl.createDiv({ cls: "knobe-lens-actions" });
    const cancel = actions.createEl("button", { cls: "knobe-lens-primary-action", text: "Cancel" });
    cancel.onclick = () => this.close(); // click = up-event (SC 2.5.2)

    const confirm = actions.createEl("button", {
      cls: "knobe-lens-action-button is-trust",
      text: "Trust & file",
    });
    confirm.onclick = () => { // click = up-event (SC 2.5.2)
      this.confirmed = true;
      // Close first (so the move can manage focus on the view behind us), then run.
      this.close();
      this.opts.onConfirm();
    };

    // Safe action (Cancel) takes initial focus; trusting needs deliberate action.
    cancel.win.setTimeout(() => {
      if (cancel.isConnected) cancel.focus();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    // Fires for every dismissal (Cancel, Escape, click-outside, and confirm).
    this.opts.onClosed(this.confirmed);
  }
}
