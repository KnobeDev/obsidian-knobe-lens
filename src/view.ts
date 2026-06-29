import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type KnobeLensPlugin from "./main";
import { scanVault, ScanRow } from "./scanner";
import { Status, extractBodyText } from "./lens-core";
import { diagnoseBreak } from "./diagnose";
import { lineDiff } from "./diff";
import { buildLineage } from "./lineage";
import { renderLineage } from "./lineage-render";
import { getVerdict } from "./trust";

export const KNOBE_LENS_VIEW = "knobe-lens-view";
const BODY_PREVIEW_LINES = 10;

export const STATE_LABEL: Record<Status, string> = {
  verified: "Verified",
  "verified-body-modified": "Body modified",
  failed: "Failed",
  unreadable: "Unreadable",
};
const STATE_ICON: Record<Status, string> = {
  verified: "shield-check",
  "verified-body-modified": "file-warning",
  failed: "shield-x",
  unreadable: "help-circle",
};

export class KnobeLensView extends ItemView {
  private rows: ScanRow[] = [];
  private selectedPath: string | null = null;
  private rowTriggers = new Map<string, HTMLElement>();
  private tableBody!: HTMLElement;
  private detailEl!: HTMLElement;
  private lineageEl!: HTMLElement;
  private summaryEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: KnobeLensPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return KNOBE_LENS_VIEW;
  }
  getDisplayText(): string {
    return "KNOBE Lens";
  }
  getIcon(): string {
    return "eye";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("knobe-lens");

    const header = root.createDiv({ cls: "knobe-lens-header" });
    header.createEl("h3", { text: "KNOBE Lens" });
    const refresh = header.createEl("button", { text: "Re-verify" });
    refresh.setAttr("aria-label", "Re-verify all KNOBEs in the vault");
    refresh.onclick = () => void this.refresh();

    const report = header.createEl("button", { text: "Verify a document…" });
    report.setAttr("aria-label", "Submit a document for verification and create a report");
    report.onclick = () => void this.plugin.verifyAndReport();

    root.createEl("p", {
      cls: "knobe-lens-note",
      text: "A verified seal proves the payload is intact, not that it is true or safe. Inspect quarantined objects before trusting.",
    });

    this.summaryEl = root.createEl("p", { cls: "knobe-lens-summary", attr: { role: "status", "aria-live": "polite" } });

    const table = root.createEl("table", { cls: "knobe-lens-table" });
    table.createEl("caption", { text: "KNOBE objects in this vault", cls: "knobe-lens-sr-only" });
    const headRow = table.createEl("thead").createEl("tr");
    for (const h of ["Object", "Status", "Conformance", "Declared", "Your verdict"]) {
      headRow.createEl("th", { text: h, attr: { scope: "col" } });
    }
    this.tableBody = table.createEl("tbody");

    this.detailEl = root.createDiv({ cls: "knobe-lens-detail", attr: { role: "region", tabindex: "-1", "aria-label": "Object detail" } });

    root.createEl("h4", { text: "Adaptation lineage" });
    this.lineageEl = root.createDiv({ cls: "knobe-lens-lineage" });

    await this.refresh();
  }

  /** Full rescan + redraw. Used on open and after any file-mutating action. */
  async refresh(): Promise<void> {
    this.summaryEl.setText("Scanning vault…");
    try {
      this.rows = await scanVault(this.app);
    } catch (e) {
      console.error("[knobe-lens] scan failed:", e);
      this.summaryEl.setText("Scan failed — see the developer console.");
      return;
    }

    // Stage last-verified snapshots, then persist once (not per file).
    let dirty = false;
    for (const r of this.rows) {
      if (r.result.state === "verified" && r.payloadHash) {
        dirty = this.plugin.stageSnapshot(r.file.path, r.payloadHash, r.raw) || dirty;
      }
    }
    if (dirty) await this.plugin.persist();

    this.renderSummary();
    this.renderTable();
    this.renderLineage();

    const sel = this.rows.find((r) => r.file.path === this.selectedPath);
    if (sel) await this.renderDetail(sel);
    else this.detailEl.empty();
  }

  private renderSummary(): void {
    if (this.rows.length === 0) {
      this.summaryEl.setText("No .knobe.md objects found in this vault yet.");
      return;
    }
    const counts: Record<Status, number> = { verified: 0, "verified-body-modified": 0, failed: 0, unreadable: 0 };
    let quarantined = 0;
    for (const r of this.rows) {
      counts[r.result.state]++;
      if (r.quarantine === "quarantine") quarantined++;
    }
    this.summaryEl.setText(
      `${counts.verified} verified · ${counts["verified-body-modified"]} body-modified · ` +
        `${counts.failed} failed · ${counts.unreadable} unreadable · ${quarantined} quarantined`,
    );
  }

  private renderTable(): void {
    this.tableBody.empty();
    this.rowTriggers.clear();
    for (const row of this.rows) {
      const tr = this.tableBody.createEl("tr", { cls: "knobe-lens-row" });

      // First cell carries a real button so native keyboard semantics apply and
      // the table's row/cell structure stays intact for screen readers.
      const objTd = tr.createEl("td");
      const trigger = objTd.createEl("button", { cls: "knobe-lens-row-trigger" });
      trigger.setAttr("aria-pressed", String(row.file.path === this.selectedPath));
      trigger.createDiv({ text: row.title, cls: "knobe-lens-title" });
      trigger.createDiv({ text: row.file.path, cls: "knobe-lens-path" });
      trigger.onclick = () => void this.select(row);
      this.rowTriggers.set(row.file.path, trigger);

      const statusTd = tr.createEl("td");
      this.stateBadge(statusTd, row.result.state);
      tr.createEl("td", { text: row.result.conformance });
      tr.createEl("td", { text: row.quarantine });
      const verdict = getVerdict(this.plugin.trust, row.payloadHash);
      tr.createEl("td", { text: verdict ? `you: ${verdict.verdict}` : "—" });

      tr.toggleClass("is-selected", row.file.path === this.selectedPath);
    }
  }

  private stateBadge(parent: HTMLElement, state: Status): void {
    const badge = parent.createSpan({ cls: `knobe-lens-badge state-${state}` });
    setIcon(badge.createSpan({ cls: "knobe-lens-badge-icon" }), STATE_ICON[state]);
    badge.createSpan({ text: STATE_LABEL[state] });
  }

  private renderLineage(): void {
    const graph = buildLineage(
      this.rows.map((r) => ({
        hash: r.payloadHash,
        title: r.title,
        state: r.result.state,
        contentType: r.contentType,
        parents: r.parents,
      })),
    );
    renderLineage(this.lineageEl, graph, (hash, present) => {
      if (!present) return;
      const row = this.rows.find((r) => r.payloadHash === hash);
      if (row) void this.select(row);
    });
  }

  private updateRowSelection(): void {
    for (const [path, trigger] of this.rowTriggers) {
      const isSel = path === this.selectedPath;
      trigger.setAttr("aria-pressed", String(isSel));
      (trigger.closest("tr") as HTMLElement | null)?.toggleClass("is-selected", isSel);
    }
  }

  private async select(row: ScanRow): Promise<void> {
    this.selectedPath = row.file.path;
    this.updateRowSelection(); // no full rebuild — preserves focus
    await this.renderDetail(row);
    this.detailEl.setAttr("aria-label", `Detail: ${row.title}`);
    this.detailEl.focus(); // tabindex=-1: programmatic focus + announce, no double-scroll
  }

  private async renderDetail(row: ScanRow): Promise<void> {
    const d = this.detailEl;
    d.empty();

    const head = d.createDiv({ cls: "knobe-lens-detail-head" });
    const titleWrap = head.createDiv();
    titleWrap.createEl("h4", { text: row.title, cls: "knobe-lens-detail-title" });
    titleWrap.createDiv({ text: `${row.file.path} · ${row.contentType}`, cls: "knobe-lens-path" });
    this.stateBadge(head.createDiv(), row.result.state);

    const hashLine = d.createDiv({ cls: "knobe-lens-hash" });
    if (row.result.state === "failed") {
      hashLine.createSpan({ text: "payload_hash mismatch: ", cls: "knobe-lens-bad" });
      hashLine.createSpan({ text: `computed ${short(row.result.computed)} != stored ${short(row.result.stored)}` });
    } else {
      hashLine.createSpan({ text: `payload_hash ${short(row.result.stored)}` });
    }

    const p = row.result.payload ?? {};
    const fieldTable = d.createEl("table", { cls: "knobe-lens-fields", attr: { role: "presentation" } });
    for (const key of ["summary", "fidelity_limits", "use_conditions", "accessibility", "attribution", "parents"]) {
      if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
      const tr = fieldTable.createEl("tr");
      tr.createEl("td", { text: key, cls: "knobe-lens-fname" });
      tr.createEl("td", { text: renderValue((p as Record<string, unknown>)[key]) });
    }

    const det = d.createEl("details");
    det.createEl("summary", { text: "Decoded payload (JSON)" });
    det.createEl("pre", { cls: "knobe-lens-pre", text: JSON.stringify(p, null, 2) });

    const bodyText = extractBodyText(row.raw);
    const bodyWrap = d.createDiv({ cls: "knobe-lens-bodywrap" });
    const openBtn = bodyWrap.createEl("button", { text: "Open note" });
    openBtn.onclick = () => void this.app.workspace.getLeaf(false).openFile(row.file);
    if (bodyText) {
      const preview = bodyText.trim().split("\n").slice(0, BODY_PREVIEW_LINES).join("\n");
      bodyWrap.createEl("pre", { cls: "knobe-lens-pre knobe-lens-body", text: preview });
    }

    if (row.result.state !== "verified") await this.renderBreakInspector(d, row);
    this.renderTrustControls(d, row);
  }

  private async renderBreakInspector(parent: HTMLElement, row: ScanRow): Promise<void> {
    const box = parent.createDiv({ cls: "knobe-lens-inspector" });
    box.createEl("h5", { text: "Break inspector", cls: "knobe-lens-section" });

    const dx = await diagnoseBreak(row.raw, row.result);
    const diag = box.createDiv({ cls: `knobe-lens-diagnosis ${dx.benign ? "is-benign" : "is-serious"}` });
    diag.createSpan({ text: dx.benign ? "Likely benign: " : "Needs review: ", cls: "knobe-lens-diag-tag" });
    diag.createSpan({ text: dx.detail });

    const regions = box.createDiv({ cls: "knobe-lens-regions" });
    const hasFm = /^---\r?\n[\s\S]*?\r?\n---/.test(row.raw);
    const bodySealed = !!row.result.payload && Object.prototype.hasOwnProperty.call(row.result.payload, "body_hash");
    chip(regions, "frontmatter", hasFm ? "present" : "missing", hasFm);
    chip(regions, "body", bodySealed ? "sealed (body_hash)" : "unsealed — edits undetectable", bodySealed);
    chip(regions, "payload", `${row.result.blockCount} block(s) · do not edit`, row.result.blockCount === 1);

    const snap = this.plugin.snapshotFor(row.file.path);
    const ref = box.createDiv({ cls: "knobe-lens-ref" });
    if (!snap) {
      ref.createSpan({ text: "Reference: no last-verified snapshot available — cannot diff.", cls: "knobe-lens-muted" });
    } else {
      ref.createSpan({ text: "Reference: last-verified snapshot. Changes (minus = removed, plus = added):", cls: "knobe-lens-muted" });
      const cur = extractBodyText(row.raw) ?? "";
      const old = extractBodyText(snap.content) ?? "";
      const pre = box.createEl("pre", { cls: "knobe-lens-pre knobe-lens-diff" });
      for (const op of lineDiff(old, cur)) {
        if (op.type === "same") continue;
        pre.createDiv({ cls: op.type === "add" ? "diff-add" : "diff-del", text: `${op.type === "add" ? "+" : "-"} ${op.line}` });
      }
    }

    const actions = box.createDiv({ cls: "knobe-lens-actions" });
    if (snap) {
      const restore = actions.createEl("button", { text: "Restore last-verified" });
      restore.onclick = async () => { await this.plugin.restoreSnapshot(row.file); await this.refresh(); };
    }
    const hasEmbedded = !!row.result.payload
      && typeof (row.result.payload as Record<string, unknown>).ext_body_snapshot === "string";
    if (hasEmbedded && row.result.state === "verified-body-modified") {
      const re = actions.createEl("button", { text: "Restore from embedded snapshot" });
      re.setAttr("aria-label", "Restore from embedded snapshot (self-contained, sealed inside this file)");
      re.onclick = async () => { await this.plugin.restoreFromEmbedded(row.file); await this.refresh(); };
    }
    const reseal = actions.createEl("button", { text: "Re-seal current content" });
    reseal.onclick = async () => { await this.plugin.sealFile(row.file); await this.refresh(); };
  }

  private renderTrustControls(parent: HTMLElement, row: ScanRow): void {
    const box = parent.createDiv({ cls: "knobe-lens-trust" });
    box.createEl("h5", { text: "Your review", cls: "knobe-lens-section" });

    const verdict = getVerdict(this.plugin.trust, row.payloadHash);
    box.createEl("div", {
      cls: "knobe-lens-muted",
      text: `Declared: ${row.quarantine}. Your local verdict: ${verdict ? verdict.verdict : "unreviewed"}. (Local only — never written to the file.)`,
    });

    if (!row.payloadHash) {
      box.createEl("div", { cls: "knobe-lens-muted", text: "Unreadable object — no verdict can be recorded." });
      return;
    }
    const hash = row.payloadHash;

    const noteId = `kl-note-${hash.slice(0, 8)}`;
    box.createEl("label", { text: "Reason for your decision (optional)", attr: { for: noteId }, cls: "knobe-lens-muted" });
    const noteInput = box.createEl("input", { attr: { id: noteId, type: "text", placeholder: "e.g. confirmed against source" } });
    noteInput.addClass("knobe-lens-note-input");

    const actions = box.createDiv({ cls: "knobe-lens-actions" });
    const trustBtn = actions.createEl("button", { text: "Trust" });
    trustBtn.onclick = async () => { await this.plugin.setVerdict(hash, "trusted", noteInput.value); await this.refresh(); };
    const rejectBtn = actions.createEl("button", { text: "Reject" });
    rejectBtn.onclick = async () => { await this.plugin.setVerdict(hash, "rejected", noteInput.value); await this.refresh(); };
    if (verdict) {
      const clearBtn = actions.createEl("button", { text: "Clear verdict" });
      clearBtn.onclick = async () => { await this.plugin.clearVerdict(hash); await this.refresh(); };
    }

    if (row.result.state === "verified" && row.quarantine !== "trusted") {
      const promote = actions.createEl("button", { text: "Promote to trusted (re-seal)" });
      promote.setAttr("aria-label", "Promote to trusted (re-seal): records the prior version as a parent in the lineage");
      promote.onclick = async () => { await this.plugin.promote(row.file); await this.refresh(); };
    }
  }

  async onClose(): Promise<void> {
    /* nothing to clean up */
  }
}

function short(h: string | null): string {
  return h ? h.slice(0, 12) + "…" : "—";
}

function renderValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function chip(parent: HTMLElement, label: string, value: string, ok: boolean): void {
  const c = parent.createSpan({ cls: `knobe-lens-chip ${ok ? "chip-ok" : "chip-warn"}` });
  c.createSpan({ text: label, cls: "knobe-lens-chip-label" });
  c.createSpan({ text: value });
}
