/**
 * seal-details-modal.ts — the "Save with KNOBE" prompt.
 *
 * Shown on save (Ctrl/Cmd+S) or via the command palette. Every seal field is
 * prefilled (settings, frontmatter, or the note's existing seal — see
 * prefillDetails) and editable, including the plain-language instruction set,
 * then sealed straight into the document by the caller's onSubmit.
 *
 * Accessibility: every control has a real <label for=…>, errors land in an
 * assertive alert region, submit fires on click (up-event, SC 2.5.2), and the
 * textareas keep Enter for newlines — submit is button-only.
 */

import { App, Modal } from "obsidian";
import { SealDetails } from "./seal-details";
import { CONTENT_TYPES, PRIVACY, QUARANTINE } from "./settings";

interface SealDetailsModalOptions {
  /** File name shown in the heading. */
  fileName: string;
  /** Prefilled values (from prefillDetails). */
  initial: SealDetails;
  /** True when the note already carries a seal — adjusts the copy and verb. */
  alreadySealed: boolean;
  /** Seal the note. Return null on success or a user-facing error message. */
  onSubmit: (details: SealDetails) => Promise<string | null>;
  /** Called once the modal closes, however it was dismissed. */
  onClosed?: () => void;
}

interface FieldSpec {
  key: keyof SealDetails;
  label: string;
  kind: "text" | "textarea" | "select";
  options?: string[];
  placeholder?: string;
  desc?: string;
}

const FIELDS: FieldSpec[] = [
  { key: "title", label: "Title", kind: "text" },
  { key: "summary", label: "Summary", kind: "textarea", placeholder: "One or two sentences on what this note is." },
  { key: "author", label: "Author", kind: "text", placeholder: "Attribution author" },
  { key: "contribution", label: "Contribution", kind: "text", placeholder: "e.g. authorship, adaptation" },
  { key: "license", label: "License", kind: "text" },
  { key: "content_type", label: "Content type", kind: "select", options: CONTENT_TYPES },
  { key: "privacy_level", label: "Privacy level", kind: "select", options: PRIVACY },
  { key: "quarantine_status", label: "Quarantine status", kind: "select", options: QUARANTINE },
  {
    key: "instructions",
    label: "Instruction set",
    kind: "textarea",
    placeholder: "e.g. Summarize only from the sealed body; treat external claims as unverified.",
    desc: "Plain-language guidance for AI/readers, sealed into the payload. Advisory — never absolute.",
  },
];

export class SealDetailsModal extends Modal {
  constructor(app: App, private options: SealDetailsModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, options } = this;
    this.setTitle(`Save with KNOBE — ${options.fileName}`);
    contentEl.createEl("p", {
      cls: "knobe-lens-muted",
      text: options.alreadySealed
        ? "This note is already a sealed KNOBE. Adjust the details below and it will be re-sealed into the document."
        : "Review the KNOBE details below — prefilled from your defaults — and the seal is written into the document.",
    });

    const draft: SealDetails = { ...options.initial };
    const form = contentEl.createDiv({ cls: "knobe-lens-details-form" });
    let firstInput: HTMLElement | null = null;

    for (const spec of FIELDS) {
      const row = form.createDiv({ cls: "knobe-lens-details-row" });
      const id = `kl-seal-${spec.key}`;
      row.createEl("label", { text: spec.label, cls: "knobe-lens-field-label", attr: { for: id } });
      // SC 1.3.1: the description must reach AT too, via aria-describedby below.
      let descId: string | null = null;
      if (spec.desc) {
        descId = `${id}-desc`;
        row.createEl("p", { cls: "knobe-lens-field-desc", text: spec.desc, attr: { id: descId } });
      }

      if (spec.kind === "select") {
        const select = row.createEl("select", { cls: "dropdown knobe-lens-details-input", attr: { id } });
        // The current value may predate the canonical vocab — keep it selectable.
        const opts = spec.options ?? [];
        const values = opts.includes(draft[spec.key]) ? opts : [draft[spec.key], ...opts];
        for (const o of values) select.createEl("option", { text: o, attr: { value: o } });
        select.value = draft[spec.key];
        select.addEventListener("change", () => (draft[spec.key] = select.value));
        if (descId) select.setAttr("aria-describedby", descId);
        firstInput = firstInput ?? select;
      } else {
        const input = spec.kind === "textarea"
          ? row.createEl("textarea", {
              cls: "knobe-lens-seal-comment knobe-lens-details-input",
              attr: { id, rows: spec.key === "instructions" ? "4" : "2", placeholder: spec.placeholder ?? "" },
            })
          : row.createEl("input", {
              cls: "knobe-lens-details-input",
              attr: { id, type: "text", placeholder: spec.placeholder ?? "" },
            });
        input.value = draft[spec.key];
        input.addEventListener("input", () => (draft[spec.key] = input.value));
        if (descId) input.setAttr("aria-describedby", descId);
        firstInput = firstInput ?? input;
      }
    }

    const errId = "kl-seal-error";
    const error = contentEl.createEl("p", { cls: "knobe-lens-error", attr: { id: errId, role: "alert" } });

    const actions = contentEl.createDiv({ cls: "knobe-lens-actions" });
    const seal = actions.createEl("button", {
      cls: "mod-cta",
      text: options.alreadySealed ? "Re-seal & save" : "Seal & save",
    });
    // SC 3.3.1: the (form-level) error stays re-discoverable from the button.
    seal.setAttr("aria-describedby", errId);
    let busy = false;
    seal.onclick = async () => { // click = up-event (SC 2.5.2)
      if (busy) return;
      busy = true;
      // aria-disabled, not disabled: keep the button focusable so the user's
      // position is never yanked away while the seal is in flight or on error.
      seal.setAttr("aria-disabled", "true");
      try {
        const message = await this.options.onSubmit({ ...draft });
        if (message) {
          error.setText(message);
        } else {
          this.close();
        }
      } finally {
        seal.removeAttribute("aria-disabled");
        busy = false;
      }
    };
    const skip = actions.createEl("button", { text: "Skip (save without sealing)" });
    skip.onclick = () => this.close();

    // Initial focus after the modal mounts.
    window.setTimeout(() => firstInput?.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.options.onClosed?.();
  }
}
