import { ItemView, WorkspaceLeaf, TFile, TAbstractFile, Notice, debounce, setIcon } from "obsidian";
import type KnobeLensPlugin from "./main";
import { scanVault, ScanRow, findUnindexedKnobeFiles } from "./scanner";
import { Status, extractBodyText } from "./lens-core";
import { diagnoseBreak } from "./diagnose";
import { lineDiff } from "./diff";
import { buildLineage } from "./lineage";
import { renderLineage } from "./lineage-render";
import { getVerdict } from "./trust";
import { NEW_FOLDER_VALUE, NO_FOLDER_VALUE, isFiledUnder } from "./portfolio";
import { NewFolderModal } from "./new-folder-modal";

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
  private portfoliosEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  // Persistent notice for KNOBE files found on disk but not in Obsidian's index
  // (populated only by an explicit deep Rescan).
  private noticeEl!: HTMLElement;
  // Dedicated polite live region for the result of explicit actions (a move, a
  // folder creation). Kept separate from summaryEl so a transient "Moved…" never
  // clobbers the persistent vault tally and is never re-announced on a silent
  // background rescan.
  private actionStatusEl!: HTMLElement;

  // Re-entrancy guard: a scan triggered while one is running coalesces into a
  // single trailing rescan instead of interleaving two passes over the vault.
  private refreshing = false;
  private refreshQueued = false;
  private refreshQueuedDeep = false;
  // True between onOpen and onClose, so a deferred onLayoutReady callback can't
  // touch detached DOM after the view is closed.
  private mounted = false;

  // Coalesce bursts of vault events (bulk move, save storms, reseal-on-save)
  // into a single silent rescan ~400ms after the burst begins, capping rescan
  // frequency during sustained activity.
  private scheduleRefresh = debounce(() => void this.refresh(false), 400, false);

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
    this.mounted = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("knobe-lens");

    const header = root.createDiv({ cls: "knobe-lens-header" });
    header.createEl("h3", { text: "KNOBE Lens" });
    const refresh = header.createEl("button", { text: "Rescan" });
    refresh.setAttr("aria-label", "Rescan the vault for KNOBE documents and re-verify all of them");
    refresh.onclick = () => void this.refresh(true, true); // explicit Rescan = deep disk reconcile

    const report = header.createEl("button", { text: "Verify a document…" });
    report.setAttr("aria-label", "Submit a document for verification and create a report");
    report.onclick = () => void this.plugin.verifyAndReport();

    root.createEl("p", {
      cls: "knobe-lens-note",
      text: "A verified seal proves the payload is intact, not that it is true or safe. Inspect quarantined objects before trusting.",
    });

    this.summaryEl = root.createEl("p", { cls: "knobe-lens-summary", attr: { role: "status", "aria-live": "polite" } });
    this.noticeEl = root.createDiv({ cls: "knobe-lens-notice" });
    this.actionStatusEl = root.createEl("p", {
      cls: "knobe-lens-action-status knobe-lens-sr-only",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });

    const table = root.createEl("table", { cls: "knobe-lens-table" });
    table.createEl("caption", { text: "KNOBE objects in this vault", cls: "knobe-lens-sr-only" });
    const headRow = table.createEl("thead").createEl("tr");
    for (const h of ["Object", "Status", "Conformance", "Declared", "Your verdict", "Portfolio"]) {
      headRow.createEl("th", { text: h, attr: { scope: "col" } });
    }
    this.tableBody = table.createEl("tbody");

    this.detailEl = root.createDiv({ cls: "knobe-lens-detail", attr: { role: "region", tabindex: "-1", "aria-label": "Object detail" } });

    root.createEl("h4", { text: "Adaptation lineage" });
    this.lineageEl = root.createDiv({ cls: "knobe-lens-lineage" });

    root.createEl("h4", { text: "Portfolios" });
    this.portfoliosEl = root.createDiv({ cls: "knobe-lens-portfolios" });

    this.registerVaultAutoRefresh();
    // Defer the first scan to layout-ready. A view restored at Obsidian startup
    // can run onOpen before the vault finishes indexing, so getMarkdownFiles()
    // would miss documents added while the app was closed — and no vault event
    // fires afterward to correct it. onLayoutReady runs immediately when the
    // workspace is already ready (manual open) or once indexing completes.
    // onLayoutReady isn't a registerEvent ref; guard against firing post-close.
    this.app.workspace.onLayoutReady(() => {
      if (this.mounted) void this.refresh();
    });
  }

  /**
   * Keep the dashboard live: rescan when vault files change. registerEvent ties
   * these listeners to the view's lifecycle, so they're removed when it closes.
   * Markdown content can flip a seal; folder moves/renames/deletes can
   * reorganize or remove KNOBEs — both warrant a rescan. Non-markdown file
   * noise (images, etc.) is ignored. The rescan is debounced and silent so the
   * aria-live summary isn't announced on every keystroke.
   */
  private registerVaultAutoRefresh(): void {
    const structural = (f: TAbstractFile): void => {
      // Folders (not TFile) always matter; files only when markdown.
      if (!(f instanceof TFile) || f.extension === "md") this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("create", structural));
    this.registerEvent(this.app.vault.on("delete", structural));
    this.registerEvent(this.app.vault.on("rename", structural));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && f.extension === "md") this.scheduleRefresh();
      }),
    );
  }

  /**
   * Full rescan + redraw. `announce` shows the "Scanning vault…" status (used
   * for explicit user actions: opening the view, the Rescan button); auto
   * refreshes pass false to stay silent. `deep` additionally reconciles against
   * the filesystem to surface KNOBE files Obsidian's index missed — only the
   * explicit Rescan button sets it, since it reads the disk directly. Re-entrant
   * calls coalesce into one trailing rescan.
   */
  async refresh(announce = true, deep = false): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      if (deep) this.refreshQueuedDeep = true; // don't lose a Rescan behind a running scan
      return;
    }
    this.refreshing = true;
    try {
      await this.runRefresh(announce, deep);
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        const pendingDeep = this.refreshQueuedDeep;
        this.refreshQueuedDeep = false;
        void this.refresh(false, pendingDeep);
      }
    }
  }

  private async runRefresh(announce: boolean, deep = false): Promise<void> {
    this.noticeEl.empty(); // clear any stale disk-reconcile notice; re-filled only on a deep scan
    if (announce) this.setSummary("Scanning vault…");
    try {
      this.rows = await scanVault(this.app);
    } catch (e) {
      console.error("[knobe-lens] scan failed:", e);
      this.setSummary("Scan failed — see the developer console.");
      return;
    }

    if (deep) await this.renderDiskNotice();

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
    this.renderPortfolios();

    const sel = this.rows.find((r) => r.file.path === this.selectedPath);
    if (sel) await this.renderDetail(sel);
    else this.detailEl.empty();
  }

  /** Update the live-region summary only when the text actually changes, so a
   *  silent auto-refresh to an unchanged vault doesn't re-announce to AT. */
  private setSummary(text: string): void {
    if (this.summaryEl.textContent !== text) this.summaryEl.setText(text);
  }

  /** Announce the result of an explicit user action (move / create). Call only
   *  from user-initiated handlers — never from a background rescan. */
  private setActionStatus(text: string): void {
    if (this.actionStatusEl.textContent !== text) this.actionStatusEl.setText(text);
  }

  /** Reconcile against the filesystem and warn about KNOBE files Obsidian hasn't
   *  indexed (e.g. added by another app). Only runs on an explicit deep Rescan. */
  private async renderDiskNotice(): Promise<void> {
    this.noticeEl.empty();
    let found;
    try {
      found = await findUnindexedKnobeFiles(this.app);
    } catch (e) {
      console.error("[knobe-lens] disk reconcile failed:", e);
      return;
    }
    if (found.paths.length === 0) return;

    const n = found.paths.length;
    const box = this.noticeEl.createDiv({ cls: "knobe-lens-warn", attr: { role: "status" } });
    box.createEl("strong", {
      text: `${n}${found.capped ? "+" : ""} KNOBE file(s) on disk aren’t loaded by Obsidian yet.`,
    });
    box.createEl("div", {
      cls: "knobe-lens-muted",
      text: "Likely added outside Obsidian. Open each once, or reopen the vault to load them, then Rescan.",
    });
    const ul = box.createEl("ul", { cls: "knobe-lens-notice-list" });
    for (const p of found.paths.slice(0, 10)) ul.createEl("li", { text: p });
    if (n > 10) box.createEl("div", { cls: "knobe-lens-muted", text: `…and ${n - 10} more.` });
  }

  /** A file filed under the portfolio root — shown in the Portfolios section, not
   *  the main list. */
  private isFiled(row: ScanRow): boolean {
    return isFiledUnder(row.file.path, this.plugin.settings.portfolioRoot);
  }

  private renderSummary(): void {
    if (this.rows.length === 0) {
      this.setSummary("No sealed KNOBE notes found in this vault yet.");
      return;
    }
    const unfiled = this.rows.filter((r) => !this.isFiled(r));
    const filed = this.rows.length - unfiled.length;
    if (unfiled.length === 0) {
      this.setSummary(`All ${this.rows.length} KNOBE${this.rows.length === 1 ? "" : "s"} filed in portfolios.`);
      return;
    }
    const counts: Record<Status, number> = { verified: 0, "verified-body-modified": 0, failed: 0, unreadable: 0 };
    let quarantined = 0;
    for (const r of unfiled) {
      counts[r.result.state]++;
      if (r.quarantine === "quarantine") quarantined++;
    }
    this.setSummary(
      `${counts.verified} verified · ${counts["verified-body-modified"]} body-modified · ` +
        `${counts.failed} failed · ${counts.unreadable} unreadable · ${quarantined} quarantined` +
        (filed ? ` · ${filed} filed` : ""),
    );
  }

  private renderTable(): void {
    this.tableBody.empty();
    this.rowTriggers.clear();
    const rows = this.rows.filter((r) => !this.isFiled(r)); // filed objects live in the Portfolios section
    if (rows.length === 0) {
      const tr = this.tableBody.createEl("tr");
      tr.createEl("td", {
        attr: { colspan: "6" },
        cls: "knobe-lens-muted",
        text: this.rows.length ? "All KNOBEs are filed in portfolios (below)." : "No KNOBEs yet.",
      });
      return;
    }
    rows.forEach((row, index) => {
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

      this.renderMoveControl(tr.createEl("td"), row, `t${index}`);

      tr.toggleClass("is-selected", row.file.path === this.selectedPath);
    });
  }

  /**
   * Per-row "Move to portfolio" control. A native <select> (free keyboard/AT
   * semantics, change = up-event for SC 2.5.2). Enabled only once the user has
   * locally marked the object "trusted" — otherwise it is truly disabled with a
   * visible, programmatically-associated reason (never colour alone, SC 1.4.1).
   */
  private renderMoveControl(td: HTMLElement, row: ScanRow, idSuffix: string): void {
    const selId = `kl-move-${idSuffix}`;
    const helpId = `kl-move-help-${idSuffix}`;

    // Hidden label carries the object title so each row's control is
    // distinguishable and voice-addressable ("Move '<title>' to portfolio").
    td.createEl("label", { cls: "knobe-lens-sr-only", text: `Move "${row.title}" to portfolio`, attr: { for: selId } });
    const select = td.createEl("select", { cls: "knobe-lens-move", attr: { id: selId } });

    const trusted = getVerdict(this.plugin.trust, row.payloadHash)?.verdict === "trusted";
    if (!trusted) {
      select.createEl("option", { text: "Move to portfolio…", attr: { value: NO_FOLDER_VALUE } });
      select.setAttr("disabled", "true");
      select.setAttr("aria-describedby", helpId);
      td.createEl("div", { cls: "knobe-lens-move-help", text: "Trust to file", attr: { id: helpId } });
      return;
    }

    const currentPath = row.file.parent?.path ?? "";
    const folders = this.plugin.portfolioFolders();
    select.createEl("option", { text: `Move "${row.title}" to…`, attr: { value: NO_FOLDER_VALUE } });
    for (const f of folders) {
      const opt = select.createEl("option", { text: f.name, attr: { value: f.path } });
      if (f.path === currentPath) opt.setAttr("selected", "true");
    }
    select.createEl("option", { text: "+ New folder…", attr: { value: NEW_FOLDER_VALUE } });

    let prevValue = select.value;
    select.addEventListener("change", () => {
      const value = select.value;
      if (value === NO_FOLDER_VALUE) { prevValue = value; return; }
      if (value === NEW_FOLDER_VALUE) {
        select.value = prevValue; // don't leave the control stuck on the sentinel
        new NewFolderModal(this.app, {
          onSubmit: async (name) => {
            try {
              const path = await this.plugin.createPortfolioFolder(name);
              await this.plugin.moveToPortfolio(row.file, path);
              await this.afterMove(row, path.split("/").pop() ?? name);
              return null;
            } catch (e) {
              return errorMessage(e);
            }
          },
        }).open();
        return;
      }
      // A concrete folder path.
      const folderName = select.options[select.selectedIndex]?.text ?? value;
      void (async () => {
        try {
          await this.plugin.moveToPortfolio(row.file, value);
          prevValue = value;
          await this.afterMove(row, folderName);
        } catch (e) {
          new Notice(errorMessage(e));
          select.value = prevValue; // revert the UI; nothing moved
        }
      })();
    });
  }

  /** After a successful move: announce, rescan, and restore focus to the moved
   *  object's detail so focus never falls to <body>. The TFile is mutated in
   *  place by the rename, so row.file.path is already the new path. */
  private async afterMove(row: ScanRow, folderName: string): Promise<void> {
    this.setActionStatus(`Moved "${row.title}" to "${folderName}".`);
    // The rename already queued a debounced rescan; cancel it and rescan once now.
    this.scheduleRefresh.cancel();
    await this.refresh(false);
    const moved = this.rows.find((r) => r.file.path === row.file.path);
    if (moved) { await this.select(moved); return; }
    // The moved object left the scan scope — keep focus in the view, not on <body>.
    this.detailEl.setAttr("aria-label", `Moved "${row.title}" to "${folderName}".`);
    this.detailEl.focus();
  }

  private renderPortfolios(): void {
    const c = this.portfoliosEl;
    c.empty();
    const folders = this.plugin.portfolioFolders();
    if (folders.length === 0) {
      c.createEl("p", {
        cls: "knobe-lens-muted",
        text: "No portfolios yet. Trust an object, then use its “Move to portfolio” control to file it under a subject folder.",
      });
      return;
    }
    const list = c.createEl("ul", { cls: "knobe-lens-portfolio-list" });
    folders.forEach((folder, fi) => {
      const li = list.createEl("li", { cls: "knobe-lens-portfolio" });
      const members = this.rows.filter((r) => r.file.parent?.path === folder.path);
      li.createEl("h5", { text: `${folder.name} (${members.length})`, cls: "knobe-lens-section" });
      if (members.length === 0) {
        li.createEl("p", { cls: "knobe-lens-muted", text: "No KNOBEs filed here yet." });
        return;
      }
      const inner = li.createEl("ul", { cls: "knobe-lens-portfolio-members" });
      members.forEach((r, mi) => {
        const mli = inner.createEl("li", { cls: "knobe-lens-portfolio-member" });
        this.stateBadge(mli.createSpan({ cls: "knobe-lens-member-badge" }), r.result.state);
        const trigger = mli.createEl("button", { cls: "knobe-lens-row-trigger knobe-lens-member-title", text: r.title });
        trigger.onclick = () => void this.select(r);
        this.renderMoveControl(mli.createDiv({ cls: "knobe-lens-member-move" }), r, `p${fi}-${mi}`);
      });
    });
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

    const p = row.result.payload ?? {};
    // 0.1 envelopes store the hash in integrity.sha256, not a payload_hash field.
    const hashField = "integrity" in p && !("payload_hash" in p) ? "integrity.sha256" : "payload_hash";
    const hashLine = d.createDiv({ cls: "knobe-lens-hash" });
    if (row.result.state === "failed") {
      hashLine.createSpan({ text: `${hashField} mismatch: `, cls: "knobe-lens-bad" });
      hashLine.createSpan({ text: `computed ${short(row.result.computed)} != stored ${short(row.result.stored)}` });
    } else {
      hashLine.createSpan({ text: `${hashField} ${short(row.result.stored)}` });
    }

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
    this.mounted = false;
  }
}

function short(h: string | null): string {
  return h ? h.slice(0, 12) + "…" : "—";
}

/** User-facing message from a thrown value (portfolio ops throw Error). */
function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Could not complete the move — see the developer console.";
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
