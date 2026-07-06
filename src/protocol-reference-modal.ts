/**
 * protocol-reference-modal.ts — renders the in-app KNOBE Protocol v1 reference
 * (see protocol-info.ts) as an accessible modal: a heading per section, term
 * definitions in description lists, and outbound links to the spec.
 */

import { App, Modal } from "obsidian";
import { PROTOCOL_REFERENCE, KNOBE_LINKS, RefSection } from "./protocol-info";

export class ProtocolReferenceModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const c = this.contentEl;
    c.addClass("knobe-lens-reference");
    this.setTitle("KNOBE Protocol v1 — reference");

    for (const section of PROTOCOL_REFERENCE) this.renderSection(c, section);

    const links = c.createDiv({ cls: "knobe-lens-reference-links" });
    links.createEl("h3", { text: "Learn more" });
    const ul = links.createEl("ul");
    this.link(ul, "The v1 specification", KNOBE_LINKS.spec);
    this.link(ul, "Try the browser Lens", KNOBE_LINKS.lens);
    this.link(ul, "Threat model & honest limits", KNOBE_LINKS.threatModel);
    this.link(ul, "knobe.org", KNOBE_LINKS.home);
  }

  private renderSection(parent: HTMLElement, section: RefSection): void {
    const wrap = parent.createDiv({ cls: "knobe-lens-reference-section" });
    wrap.createEl("h3", { text: section.heading });
    if (section.intro) wrap.createEl("p", { cls: "knobe-lens-reference-intro", text: section.intro });
    if (section.list) {
      const ul = wrap.createEl("ul", { cls: "knobe-lens-reference-fields" });
      for (const item of section.list) ul.createEl("li", { text: item });
    }
    if (section.terms && section.terms.length) {
      const dl = wrap.createEl("dl", { cls: "knobe-lens-reference-terms" });
      for (const t of section.terms) {
        dl.createEl("dt", { text: t.term });
        dl.createEl("dd", { text: t.def });
      }
    }
  }

  private link(parent: HTMLElement, text: string, href: string): void {
    const li = parent.createEl("li");
    li.createEl("a", {
      text,
      href,
      attr: { target: "_blank", rel: "noopener noreferrer" },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
