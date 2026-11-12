import { ItemView, WorkspaceLeaf, TFile, TAbstractFile, Notice, debounce, setIcon } from "obsidian";
import Sortable from "sortablejs";
import type KnobeLensPlugin from "./main";
import { scanVault, ScanRow, findUnindexedKnobeFiles } from "./scanner";
import { Status, extractBodyText, safe, safeLines, verify } from "./lens-core";
import { savedState } from "./saved-state";
import type { ResealComment } from "./seal";
import { diagnoseBreak } from "./diagnose";
import { lineDiff } from "./diff";
import { buildLineage } from "./lineage";
import { renderLineage } from "./lineage-render";
import { WorldGlobe, WorldDatum, WorldEdge, WorldRenderData } from "./world-render";
import { getVerdict, Verdict } from "./trust";
import { NEW_FOLDER_VALUE, NO_FOLDER_VALUE, isFiledUnder, isFolder } from "./portfolio";
import { NewFolderModal } from "./new-folder-modal";
import { groupPortfolioRows, groupRecognitionRows } from "./board";
import {
  boardSummary,
  shouldMovePortfolioCard,
  trustToFilePolicy,
} from "./board-interactions";
import { TrustConfirmModal } from "./trust-confirm-modal";
import { SealCommentModal } from "./seal-comment-modal";

import { BulkMoveConfirmModal } from "./bulk-move-confirm-modal";
import { canFileRow, canTrustAndFileRow, pruneSelected, selectAllState, setAllSelected, toggleSelected } from "./selection";
import { withinFolder } from "./verification-scope";

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

interface BulkTarget {
  readonly file: TFile;
  readonly path: string;
  readonly hash: string;
  readonly raw: string;
  readonly title: string;
  readonly needsTrust: boolean;
}

let controlIdSeq = 0;

export class KnobeLensView extends ItemView {
  private rows: ScanRow[] = [];
  private portfolioRows: ScanRow[] = [];
  private selectedPath: string | null = null;
  private rowTriggers = new Map<string, HTMLElement>();
  private recognitionEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private onboardEl!: HTMLElement;
  private worldEl!: HTMLElement;
  private world: WorldGlobe | null = null;
  private lineageEl!: HTMLElement;
  private portfoliosEl!: HTMLElement;
  private folderSelect!: HTMLSelectElement;
  private summaryEl!: HTMLElement;
  // Persistent notice for KNOBE files found on disk but not in Obsidian's index
  // (populated only by an explicit deep Rescan).
  private noticeEl!: HTMLElement;
  // Dedicated polite live region for the result of explicit actions (a move, a
  // folder creation). Kept separate from summaryEl so a transient "Moved…" never
  // clobbers the persistent vault tally and is never re-announced on a silent
  // background rescan.
  private actionStatusEl!: HTMLElement;
  private portfolioSortables: Sortable[] = [];
  private recognitionHeading!: HTMLElement;
  private bulkToolbar!: HTMLElement;
  private bulkAll!: HTMLInputElement;
  private bulkDestination!: HTMLSelectElement;
  private bulkMove!: HTMLButtonElement;
  private bulkClear!: HTMLButtonElement;
  private bulkCount!: HTMLElement;
  private bulkSelection = new Set<string>();
  private pendingDismissals = new Set<string>();
  private dismissButtons = new Map<string, HTMLButtonElement>();
  private bulkCheckboxes = new Map<string, HTMLInputElement>();
  private bulkPending = false;
  private bulkMoving = false;

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
    const headerActions = header.createDiv({ cls: "knobe-lens-header-actions" });
    const refresh = headerActions.createEl("button", {
      cls: "knobe-lens-primary-action",
      text: "Rescan",
    });
    refresh.setAttr("aria-label", "Rescan the vault for KNOBE documents and re-verify all of them");
    refresh.onclick = () => void this.refresh(true, true); // explicit Rescan = deep disk reconcile

    const report = headerActions.createEl("button", {
      cls: "knobe-lens-primary-action",
      text: "Verify a document…",
    });
    report.setAttr("aria-label", "Verify a document and create a report");
    report.onclick = () => void this.plugin.verifyAndReport();

    const guide = headerActions.createEl("button", {
      cls: "knobe-lens-primary-action",
      text: "Protocol guide",
    });
    guide.setAttr("aria-label", "Protocol guide: Open the KNOBE Protocol reference");
    guide.onclick = () => this.plugin.openProtocolReference();

    // Per-instance ids: two dashboard leaves must not share label/description targets.
    const uid = ++controlIdSeq;
    const folderId = `kl-scan-folder-${uid}`, autoHelpId = `kl-auto-help-${uid}`;
    const controls = root.createDiv({ cls: "knobe-lens-actions" });
    controls.createEl("label", { text: "Scan folder", attr: { for: folderId } });
    const folder = controls.createEl("select", { attr: { id: folderId } });
    this.folderSelect = folder;
    this.updateFolderOptions();
    folder.onchange = async () => {
      this.plugin.settings.verificationFolder = folder.value;
      await this.plugin.saveSettings();
      await this.refresh();
      this.setActionStatus(`Scan folder: ${folder.value || "Entire vault"}.`);
    };
    const autoLabel = controls.createEl("label");
    const auto = autoLabel.createEl("input", { attr: { type: "checkbox", "aria-describedby": autoHelpId } });
    auto.checked = this.plugin.settings.autoVerify;
    autoLabel.createSpan({ text: "Automatically verify changes" });
    auto.onchange = async () => {
      this.plugin.settings.autoVerify = auto.checked;
      await this.plugin.saveSettings();
      this.scheduleRefresh.cancel();
      if (auto.checked) await this.refresh(false);
      this.setActionStatus(`Automatic verification ${auto.checked ? "enabled" : "paused"}.`);
    };
    root.createEl("p", { cls: "knobe-lens-note", text: "Verifies sealed notes in the selected folder and its subfolders, including while the dashboard is closed. Review and filing remain your decision.", attr: { id: autoHelpId } });

    root.createEl("p", {
      cls: "knobe-lens-note",
      text: "A verified seal proves the payload is intact, not that it is true or safe. Inspect quarantined objects before trusting.",
    });

    this.summaryEl = root.createEl("p", { cls: "knobe-lens-summary", attr: { role: "status", "aria-live": "polite" } });
    this.onboardEl = root.createDiv({ cls: "knobe-lens-onboard-wrap" });
    this.noticeEl = root.createDiv({ cls: "knobe-lens-notice" });
    this.actionStatusEl = root.createEl("p", {
      cls: "knobe-lens-action-status knobe-lens-sr-only",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });

    this.recognitionHeading = root.createEl("h4", { text: "Recognition", attr: { tabindex: "-1" } });
    this.buildBulkToolbar(root, uid);
    this.recognitionEl = root.createDiv({
      cls: "knobe-lens-kanban-board",
      attr: {
        role: "group",
        // Recognition status is a derived cryptographic result, so these columns
        // are read-only; filing happens through each card's Move control.
        "aria-label": "KNOBE objects grouped by recognition result",
      },
    });

    this.detailEl = root.createDiv({ cls: "knobe-lens-detail", attr: { role: "region", tabindex: "-1", "aria-label": "Object detail" } });

    root.createEl("h4", { text: "Knowledge world" });
    root.createEl("p", {
      cls: "knobe-lens-note",
      text: "Every sealed object as a 3D globe: continents group by kind, recognition, or portfolio, and adaptation lineage arcs across the world. Drag to rotate, scroll to zoom — or use the keyboard-navigable list beneath it.",
    });
    this.worldEl = root.createDiv({ cls: "knobe-lens-world" });

    root.createEl("h4", { text: "Adaptation lineage" });
    this.lineageEl = root.createDiv({ cls: "knobe-lens-lineage" });

    root.createEl("h4", { text: "Portfolios" });
    const createPortfolio = root.createEl("button", { text: "Create portfolio" });
    createPortfolio.onclick = () => {
      new NewFolderModal(this.app, {
        onClose: () => createPortfolio.focus(),
        onSubmit: async (name) => {
          try {
            await this.plugin.createPortfolioFolder(name);
            await this.refresh(false);
            this.setActionStatus(`Created portfolio "${name}".`);
            return null;
          } catch (e) { return errorMessage(e); }
        },
      }).open();
    };
    this.portfoliosEl = root.createDiv({ cls: "knobe-lens-portfolios" });

    this.registerVaultAutoRefresh();
    // Repaint the globe with the new palette when Obsidian's theme/CSS changes.
    // One workspace listener (auto-removed on close) instead of a per-globe
    // MutationObserver on document.body.
    this.registerEvent(this.app.workspace.on("css-change", () => this.world?.repaint()));
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
      if (!(f instanceof TFile)) this.updateFolderOptions();
      if (this.plugin.settings.autoVerify && (!(f instanceof TFile) || f.extension === "md")) this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on("create", structural));
    this.registerEvent(this.app.vault.on("delete", structural));
    this.registerEvent(this.app.vault.on("rename", structural));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.plugin.settings.autoVerify && f instanceof TFile && f.extension === "md") this.scheduleRefresh();
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
    if (!this.mounted) return;
    if (this.refreshing || this.bulkMoving) {
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

  private updateFolderOptions(): void {
    const select = this.folderSelect;
    if (!select) return;
    const scope = this.plugin.settings.verificationFolder;
    const paths = this.app.vault.getAllLoadedFiles().filter(isFolder)
      .map(f => f.path).filter(path => path !== "/").sort((a, b) => a.localeCompare(b));
    const entries = [["", "Entire vault"], ...paths.map(path => [path, path])];
    if (scope && !paths.includes(scope)) entries.push([scope, `${scope} (missing folder)`]);
    const signature = JSON.stringify(entries);
    if (select.dataset.options !== signature) {
      select.empty();
      for (const [value, text] of entries) select.createEl("option", { text, attr: { value } });
      select.dataset.options = signature;
    }
    select.value = scope;
  }

  private async runRefresh(announce: boolean, deep = false): Promise<void> {
    this.updateFolderOptions();
    this.noticeEl.empty(); // clear any stale disk-reconcile notice; re-filled only on a deep scan
    if (announce) this.setSummary("Scanning vault…");
    try {
      const { verificationFolder, portfolioRoot } = this.plugin.settings;
      const rows = await scanVault(this.app, verificationFolder, portfolioRoot);
      this.rows = rows.filter((row) => withinFolder(row.file.path, verificationFolder));
      this.portfolioRows = rows.filter((row) => isFiledUnder(row.file.path, portfolioRoot));
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
    if (dirty) {
      try {
        await this.plugin.persist();
      } catch (error) {
        console.error("[knobe-lens] Could not save verification snapshots:", error);
      }
    }

    this.renderSummary();
    this.renderOnboarding();
    this.renderRecognitionBoard();
    this.renderWorld();
    this.renderLineage();
    this.renderPortfolios();

    const sel = this.portfolioRows.find((row) => row.file.path === this.selectedPath)
      ?? this.rows.find((row) => row.file.path === this.selectedPath);
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
    box.createDiv({
      cls: "knobe-lens-muted",
      text: "Likely added outside Obsidian. Open each once, or reopen the vault to load them, then Rescan.",
    });
    const ul = box.createEl("ul", { cls: "knobe-lens-notice-list" });
    for (const p of found.paths.slice(0, 10)) ul.createEl("li", { text: p });
    if (n > 10) box.createDiv({ cls: "knobe-lens-muted", text: `…and ${n - 10} more.` });
  }

  /** A file filed under the portfolio root — shown in the Portfolios section, not
   *  the main list. */
  private isFiled(row: ScanRow): boolean {
    return isFiledUnder(row.file.path, this.plugin.settings.portfolioRoot);
  }

  private isDismissed(row: ScanRow): boolean {
    return row.result.state === "verified"
      && this.plugin.isRecognitionDismissed(row.file.path, row.payloadHash);
  }

  private renderSummary(): void {
    const entries = this.rows.flatMap((row) => {
      const filed = this.isFiled(row);
      if (!filed && this.isDismissed(row)) return [];
      return [{ state: row.result.state, filed, quarantined: row.quarantine === "quarantine" }];
    });
    this.setSummary(boardSummary(entries, this.rows.length - entries.length));
  }

  /** Empty-state onboarding: when the vault has no sealed objects yet, offer a
   *  one-click path to insert a real example or read the protocol reference. */
  private renderOnboarding(): void {
    this.onboardEl.empty();
    if (this.rows.length > 0) return;
    const box = this.onboardEl.createDiv({ cls: "knobe-lens-onboard" });
    box.createEl("p", {
      cls: "knobe-lens-onboard-text",
      text: "New to KNOBE? Insert a real, verifiable example document to watch sealing, verification, and lineage come to life — or read the protocol reference.",
    });
    const actions = box.createDiv({ cls: "knobe-lens-actions" });
    const insert = actions.createEl("button", { cls: "knobe-lens-primary-action", text: "Insert an example KNOBE" });
    insert.onclick = () => this.plugin.openExamplePicker();
    const guide = actions.createEl("button", { text: "Protocol reference" });
    guide.onclick = () => this.plugin.openProtocolReference();
  }

  private renderRecognitionBoard(): void {
    const active = this.recognitionEl.ownerDocument.activeElement;
    const focusedPath = [...this.bulkCheckboxes].find(([, input]) => input === active)?.[0];
    const focusedDismissal = [...this.dismissButtons].find(([, button]) => button === active)?.[0];
    this.recognitionEl.empty();
    this.dismissButtons.clear();
    this.rowTriggers.clear();
    this.bulkCheckboxes.clear();
    const columns = groupRecognitionRows(this.rows, (row) => this.isFiled(row) || this.isDismissed(row));
    columns.forEach((column) => {
      const headingId = `knobe-recognition-${column.state}`;
      const section = this.recognitionEl.createEl("section", {
        cls: `knobe-lens-kanban-column state-border-${column.state}`,
        attr: { "aria-labelledby": headingId },
      });
      const heading = section.createDiv({ cls: "knobe-lens-kanban-heading" });
      const title = heading.createEl("h5", { attr: { id: headingId } });
      this.stateBadge(title, column.state);
      heading.createSpan({
        cls: "knobe-lens-count",
        text: String(column.rows.length),
        attr: { "aria-label": `${column.rows.length} object${column.rows.length === 1 ? "" : "s"}` },
      });

      if (column.rows.length === 0) {
        section.createEl("p", { cls: "knobe-lens-empty", text: "No objects" });
        return;
      }
      const list = section.createEl("ul", { cls: "knobe-lens-card-list" });
      column.rows.forEach((row, index) => this.renderCard(list, row, `r-${column.state}-${index}`, false, true));
    });
    this.renderBulkToolbar();
    if (focusedPath) (this.bulkCheckboxes.get(focusedPath) ?? this.recognitionHeading).focus();
    if (focusedDismissal) (this.dismissButtons.get(focusedDismissal) ?? this.recognitionHeading).focus();
  }

  /** Render one kanban card. The final row always contains the folder control,
   * providing a keyboard/voice alternative to drag-and-drop folder movement. */
  private renderCard(list: HTMLElement, row: ScanRow, idSuffix: string, showState: boolean, selectable = false): void {
    const card = list.createEl("li", { cls: "knobe-lens-card" });
    card.dataset.path = row.file.path;
    card.toggleClass("is-selected", row.file.path === this.selectedPath);

    if (selectable && canTrustAndFileRow(row, this.plugin.trust)) {
      const path = row.file.path;
      const label = card.createEl("label", { cls: "knobe-lens-card-select" });
      const checkbox = label.createEl("input", {
        attr: { type: "checkbox", "aria-label": `Select ${row.title}` },
      });
      checkbox.onchange = () => {
        if (!this.bulkPending && !this.bulkMoving) {
          this.bulkSelection = toggleSelected(this.bulkSelection, path);
        }
        this.syncBulkToolbar();
      };
      this.bulkCheckboxes.set(path, checkbox);
    }

    if (showState) {
      const status = card.createDiv({ cls: "knobe-lens-card-status" });
      this.stateBadge(status, row.result.state);
      const handle = status.createSpan({
        cls: "knobe-lens-drag-handle",
        attr: {
          title: `Drag "${row.title}" to another portfolio`,
          "aria-hidden": "true",
        },
      });
      setIcon(handle, "grip-vertical");

      // Filed objects with an intact seal carry the checkmark badge; the footer
      // action button expresses the confirmed / edited-reconfirm states.
      if (savedState(true, row.result.state, row.result.conformance) === "saved-verified") {
        this.savedVerifiedBadge(card);
      }
    }

    const trigger = card.createEl("button", { cls: "knobe-lens-row-trigger knobe-lens-card-title" });
    trigger.setAttr("aria-pressed", String(row.file.path === this.selectedPath));
    trigger.createSpan({ text: row.title, cls: "knobe-lens-title" });
    trigger.onclick = () => void this.select(row);
    this.rowTriggers.set(row.file.path, trigger);

    card.createDiv({ text: row.file.path, cls: "knobe-lens-path" });
    const facts = card.createEl("dl", { cls: "knobe-lens-card-facts" });
    this.cardFact(facts, "Conformance", row.result.conformance);
    this.cardFact(facts, "Declared", row.quarantine);
    const verdict = getVerdict(this.plugin.trust, row.payloadHash);
    this.cardFact(facts, "Your verdict", verdict?.verdict ?? "Unreviewed");

    const footer = card.createDiv({ cls: "knobe-lens-card-footer" });
    this.renderMoveControl(footer, row, idSuffix);
    const path = row.file.path;
    const hash = row.payloadHash;
    if (selectable && hash && row.result.state === "verified") {
      const remove = footer.createEl("button", {
        text: "Remove from Recognition",
        attr: { type: "button", "aria-label": `Remove from Recognition: ${row.title}` },
      });
      if (this.pendingDismissals.has(path)) remove.setAttr("aria-disabled", "true");
      this.dismissButtons.set(path, remove);
      remove.onclick = () => void this.dismissRecognitionCard(row, path, hash, remove);
    }
  }

  private async dismissRecognitionCard(row: ScanRow, path: string, hash: string, button: HTMLButtonElement): Promise<void> {
    if (this.bulkMoving || this.bulkPending || this.pendingDismissals.has(path)
      || row.file.path !== path || this.isFiled(row)) return;
    this.pendingDismissals.add(path);
    button.setAttr("aria-disabled", "true");
    try {
      await this.plugin.dismissRecognition(path, hash);
    } catch (error) {
      this.dismissButtons.get(path)?.removeAttribute("aria-disabled");
      new Notice(`Could not remove the card: ${errorMessage(error)}`);
      return;
    } finally {
      this.pendingDismissals.delete(path);
    }
    if (!this.mounted) return;
    this.bulkSelection.delete(path);
    this.renderSummary();
    this.renderRecognitionBoard();
    this.reportBulkMove(`Removed “${row.title}” from Recognition. The note was kept.`);
  }

  private cardFact(parent: HTMLElement, label: string, value: string): void {
    parent.createEl("dt", { text: label });
    parent.createEl("dd", { text: value });
  }

  /**
   * Per-row "Move to portfolio" control. A native <select> (free keyboard/AT
   * semantics, change = up-event for SC 2.5.2). Enabled only for an object
   * whose seal verifies and that the user has locally marked "trusted"
   * (canFileRow), or one already in a portfolio — otherwise it is truly
   * disabled beside the card's action button and its help text. The select
   * remains visible and becomes the keyboard/voice alternative to
   * drag-and-drop once filing is allowed.
   */
  private renderMoveControl(td: HTMLElement, row: ScanRow, idSuffix: string): void {
    const selId = `kl-move-${idSuffix}`;
    const helpId = `kl-move-help-${idSuffix}`;

    td.createEl("label", {
      cls: "knobe-lens-move-label",
      text: "Move to portfolio",
      attr: { for: selId },
    });
    const select = td.createEl("select", {
      cls: "knobe-lens-move",
      attr: {
        id: selId,
        "aria-label": `Move to portfolio: "${row.title}"`,
      },
    });

    const trusted = getVerdict(this.plugin.trust, row.payloadHash)?.verdict === "trusted";
    const filed = this.isFiled(row);
    const saved = savedState(filed, row.result.state, row.result.conformance);
    // Filing needs a verified seal and the user's trusted verdict (the same rule
    // as bulk filing); a trusted verdict alone never files a failed or edited
    // object. An object already in a portfolio may move to another one.
    const canFile = canFileRow(row, this.plugin.trust, filed);

    /* ---- card action button: label + behavior by recognition state ---- */
    const state = row.result.state;
    if (state === "verified") {
      // A verified object the user has already confirmed (trusted verdict, or a
      // saved-and-verified filed object) reads as "Confirmed"; a verified object
      // not yet confirmed prompts the user to comment and verify it.
      const confirmed = trusted || saved === "saved-verified";
      if (confirmed) {
        const btn = this.iconTextButton(td, ["badge-check"], "Confirmed",
          "knobe-lens-action-button is-confirmed knobe-lens-card-action");
        btn.setAttr("aria-label", `"${row.title}" is confirmed — saved and verified. Open it to review or add to its history.`);
        btn.onclick = () => void this.select(row);
        td.createDiv({
          cls: "knobe-lens-move-help",
          text: "Saved and verified. Open it to review or add another comment.",
          attr: { id: helpId },
        });
      } else {
        const label = filed ? "Make Comment & Reseal" : "Make Comment & Verify";
        const btn = this.iconTextButton(td, ["message-square-plus"], label,
          "knobe-lens-action-button is-trust knobe-lens-card-action");
        btn.setAttr("aria-label", `${label} "${row.title}" — record your thoughts and seal them into its history`);
        btn.onclick = () => this.requestCommentReseal(row);
        td.createDiv({
          cls: "knobe-lens-move-help",
          text: "Add your thoughts and seal them into this object's history.",
          attr: { id: helpId },
        });
      }
    } else {
      // Body modified / failed / unreadable — review before it can be verified.
      const tone = state === "failed" ? "reject" : state === "verified-body-modified" ? "promote" : "muted";
      const icons =
        state === "verified-body-modified" ? ["alert-triangle", "search"] :
        state === "failed" ? ["shield-x", "search"] :
        ["help-circle", "search"];
      const btn = this.iconTextButton(td, icons, "Review Before Verifying",
        `knobe-lens-action-button is-${tone} knobe-lens-card-action`);
      if (state === "verified-body-modified" && row.payloadHash) {
        // Edited since sealing (e.g. by an AI tool): open the note with the
        // changed lines highlighted, then comment & reseal from the detail pane.
        // The accessible name starts with the visible label (SC 2.5.3).
        btn.setAttr("aria-label",
          `Review Before Verifying: "${row.title}" changed since sealing; open it with the changes highlighted, then comment and reseal`);
        btn.onclick = async () => {
          await this.select(row);
          await this.plugin.openWithEditedHighlights(row.file);
        };
        td.createDiv({
          cls: "knobe-lens-move-help",
          text: "Changed since it was sealed — review the highlighted lines, then comment and reseal.",
          attr: { id: helpId },
        });
      } else {
        // Failed or unreadable: open the detail / break inspector to review.
        // A trusted failed object still can't be filed (canFileRow), so say so.
        const why = state !== "failed"
          ? "Unreadable object — it cannot be sealed until it can be read."
          : trusted
            ? "Trusted locally, but the seal is broken — it can't be filed until its seal verifies."
            : "The seal is broken — inspect it before verifying.";
        btn.setAttr("aria-label", `Review Before Verifying: "${row.title}" — ${why}`);
        btn.onclick = () => void this.select(row);
        td.createDiv({ cls: "knobe-lens-move-help", text: why, attr: { id: helpId } });
      }
    }

    /* ---- the move select ---- */
    if (!canFile) {
      select.createEl("option", { text: "Move to portfolio…", attr: { value: NO_FOLDER_VALUE } });
      select.setAttr("disabled", "true");
      select.setAttr("aria-describedby", helpId);
      return;
    }

    const currentPath = row.file.parent?.path ?? "";
    const folders = this.plugin.portfolioFolders();
    select.createEl("option", { text: "Move to portfolio…", attr: { value: NO_FOLDER_VALUE } });
    for (const f of folders) {
      const opt = select.createEl("option", { text: f.name, attr: { value: f.path } });
      if (f.path === currentPath) opt.setAttr("selected", "true");
    }
    select.createEl("option", { text: "+ New folder…", attr: { value: NEW_FOLDER_VALUE } });

    let prevValue = select.value;
    select.addEventListener("change", () => {
      if (this.pendingDismissals.has(row.file.path)) {
        select.value = prevValue;
        return;
      }
      const value = select.value;
      if (value === NO_FOLDER_VALUE) { prevValue = value; return; }
      if (value === NEW_FOLDER_VALUE) {
        select.value = prevValue; // don't leave the control stuck on the sentinel
        new NewFolderModal(this.app, {
          onSubmit: async (name) => {
            try {
              select.setAttr("disabled", "true");
              await this.assertStillFileable(row); // before creating the folder
              const path = await this.plugin.createPortfolioFolder(name);
              await this.plugin.moveToPortfolio(row.file, path);
              await this.afterMove(row, path.split("/").pop() ?? name);
              return null;
            } catch (e) {
              select.removeAttribute("disabled");
              return errorMessage(e);
            }
          },
        }).open();
        return;
      }
      // A concrete folder path.
      const folderName = select.options[select.selectedIndex]?.text ?? value;
      select.setAttr("disabled", "true");
      void (async () => {
        try {
          this.assertBulkDestination(value, this.plugin.settings.portfolioRoot);
          await this.assertStillFileable(row);
          await this.plugin.moveToPortfolio(row.file, value);
          prevValue = value;
          await this.afterMove(row, folderName);
        } catch (e) {
          new Notice(errorMessage(e));
          select.value = prevValue; // revert the UI; nothing moved
          select.removeAttribute("disabled");
          // Focus left the select while it was disabled. Rebuild the board with
          // the current state now (instead of the queued rescan), then put focus
          // back on this object's card and say why nothing moved.
          this.scheduleRefresh.cancel();
          await this.refresh(false);
          if (!this.mounted) return;
          (this.rowTriggers.get(row.file.path) ?? select).focus();
          this.announceAction(errorMessage(e));
        }
      })();
    });
  }

  /** Re-check an unfiled object just before filing it, as bulk filing does
   *  (verifyBulkTarget). The board's state comes from the last scan, and an
   *  edit on disk inside the refresh window can keep the payload hash, so the
   *  trusted verdict would still match. Moving an object between portfolios
   *  recognizes nothing new and is not re-checked. */
  private async assertStillFileable(row: ScanRow): Promise<void> {
    if (this.isFiled(row)) return;
    const hash = row.payloadHash;
    const ok = hash !== null
      && getVerdict(this.plugin.trust, hash)?.verdict === "trusted"
      && await this.verifyBulkTarget(
        { file: row.file, path: row.file.path, hash, raw: row.raw, title: row.title, needsTrust: false },
        this.plugin.settings.portfolioRoot,
      );
    if (ok) return;
    this.scheduleRefresh();
    throw new Error(`"${row.title}" changed since the board was last checked. Review it again before filing it.`);
  }

  /** A button with one or more Lucide icons before its label. */
  private iconTextButton(parent: HTMLElement, icons: string[], label: string, cls: string): HTMLButtonElement {
    const btn = parent.createEl("button", { cls: `${cls} knobe-lens-icon-button` });
    for (const icon of icons) setIcon(btn.createSpan({ cls: "knobe-lens-btn-icon" }), icon);
    btn.createSpan({ text: label });
    return btn;
  }

  /** "Make Comment & Verify / Reseal" on a verified card: collect the user's
   *  thoughts, then reseal (which also records a local trusted verdict). Only
   *  verified objects offer it; failed and edited ones go to "Review Before
   *  Verifying", and trusting those from the detail pane warns first
   *  (requestVerdict). */
  private requestCommentReseal(row: ScanRow): void {
    new SealCommentModal(this.app, {
      title: row.title,
      onSubmit: async (comment) => {
        try {
          await this.plugin.resealWithComment(row.file, comment);
          this.setActionStatus(`Sealed "${row.title}". Choose a portfolio to file it.`);
          this.scheduleRefresh.cancel();
          await this.refresh(false);
          this.rowTriggers.get(row.file.path)?.focus();
          return null;
        } catch (e) {
          return errorMessage(e);
        }
      },
    }).open();
  }

  /** The detail pane's Trust and Reject buttons. Trusting a failed or edited
   *  object shows the "Check the payload before trusting" warning first; its
   *  safe default ("Review payload") opens the decoded payload instead. A
   *  verdict is local only: canFileRow still keeps a failed or edited object
   *  out of portfolios. */
  private requestVerdict(row: ScanRow, hash: string, verdict: Verdict, note: () => string): void {
    const policy = verdict === "trusted" ? trustToFilePolicy(row.result.state) : null;
    const message = verdict === "rejected"
      ? `Rejected "${row.title}" locally.`
      : policy?.warning
        ? `Trusted "${row.title}" locally. It can't be filed in a portfolio until its seal verifies.`
        : `Trusted "${row.title}".`;
    const record = (): Promise<void> => this.changeVerdict(() => this.plugin.setVerdict(hash, verdict, note()), message);
    if (!policy?.warning) {
      record().catch(reportVerdictError);
      return;
    }
    new TrustConfirmModal(this.app, {
      message: policy.warning,
      tone: policy.tone === "reject" ? "reject" : "promote",
      onReview: () => this.revealDecodedPayload(),
      onConfirm: record,
    }).open();
  }

  /** Record, change or clear a local verdict, then re-render. The detail
   *  pane's buttons are rebuilt, so move focus into the pane first and then
   *  announce, so the focus announcement can't cut the message off. */
  private async changeVerdict(change: () => Promise<void>, message: string): Promise<void> {
    await change();
    await this.refresh(false);
    window.setTimeout(() => {
      if (!this.mounted) return;
      this.detailEl.focus();
      this.announceAction(message);
    }, 0);
  }

  /** Open the detail pane's decoded payload and move focus to it. */
  private revealDecodedPayload(): void {
    const payload = this.detailEl.querySelector<HTMLDetailsElement>("details.knobe-lens-decoded-payload");
    if (!payload) {
      this.detailEl.focus();
      return;
    }
    payload.open = true;
    payload.querySelector<HTMLElement>("summary")?.focus();
  }

  /** After a successful move: announce, rescan, and restore focus to the moved
   *  object's detail so focus never falls to <body>. The TFile is mutated in
   *  place by the rename, so row.file.path is already the new path. */
  private async afterMove(row: ScanRow, folderName: string): Promise<void> {
    if (!this.mounted) return;
    this.setActionStatus(`Moved "${row.title}" to "${folderName}".`);
    // The rename already queued a debounced rescan; cancel it and rescan once now.
    this.scheduleRefresh.cancel();
    await this.refresh(false);
    if (!this.mounted) return;
    const moved = this.portfolioRows.find((candidate) => candidate.file.path === row.file.path);
    if (moved) { await this.select(moved); return; }
    // Keep focus in the view if the moved object could not be indexed.
    this.detailEl.setAttr("aria-label", `Moved "${row.title}" to "${folderName}".`);
    this.detailEl.focus();
  }

  private buildBulkToolbar(root: HTMLElement, uid: number): void {
    const toolbar = root.createDiv({
      cls: "knobe-lens-select-toolbar",
      attr: { role: "group", "aria-label": "File selected objects", hidden: "" },
    });
    this.bulkToolbar = toolbar;
    const countId = `kl-bulk-count-${uid}`;
    const destinationId = `kl-bulk-destination-${uid}`;

    const selectAll = toolbar.createEl("label", { cls: "knobe-lens-select-all" });
    this.bulkAll = selectAll.createEl("input", {
      attr: { type: "checkbox", "aria-describedby": countId },
    });
    selectAll.createSpan({ text: "Select all" });
    this.bulkAll.onchange = () => {
      if (!this.bulkPending && !this.bulkMoving) {
        this.bulkSelection = setAllSelected(this.bulkSelection, [...this.bulkCheckboxes.keys()], this.bulkAll.checked);
      }
      this.syncBulkToolbar();
    };

    this.bulkCount = toolbar.createSpan({ text: "0 selected", attr: { id: countId } });
    const destination = toolbar.createEl("label", { cls: "knobe-lens-select-destination" });
    destination.createSpan({ text: "Destination portfolio" });
    this.bulkDestination = destination.createEl("select", {
      cls: "knobe-lens-move",
      attr: { id: destinationId },
    });
    this.bulkDestination.onchange = () => this.syncBulkToolbar();
    this.bulkMove = toolbar.createEl("button", {
      text: "Move selected",
      attr: { type: "button", "aria-describedby": countId },
    });
    this.bulkMove.onclick = () => this.beginBulkMove();
    this.bulkClear = toolbar.createEl("button", { text: "Clear selection", attr: { type: "button" } });
    this.bulkClear.onclick = () => {
      if (this.bulkPending || this.bulkMoving) return;
      this.bulkSelection.clear();
      this.syncBulkToolbar();
    };
    toolbar.createEl("p", {
      cls: "knobe-lens-select-hint",
      text: "Select verified objects to file them together. Filing an unreviewed object requires confirmation of a reversible local trust verdict.",
    });
  }

  private renderBulkToolbar(): void {
    const selectable = [...this.bulkCheckboxes.keys()];
    this.bulkSelection = pruneSelected(this.bulkSelection, selectable);
    const folders = this.plugin.portfolioFolders();
    const signature = JSON.stringify(folders.map(({ path, name }) => [path, name]));
    const picker = this.bulkDestination;
    if (picker.dataset.options !== signature) {
      const previous = picker.value;
      picker.empty();
      picker.createEl("option", { text: "Choose a portfolio…", attr: { value: NO_FOLDER_VALUE } });
      for (const folder of folders) {
        picker.createEl("option", { text: safe(folder.name), attr: { value: folder.path } });
      }
      picker.createEl("option", { text: "New folder…", attr: { value: NEW_FOLDER_VALUE } });
      picker.dataset.options = signature;
      picker.value = folders.some(({ path }) => path === previous) || previous === NEW_FOLDER_VALUE
        ? previous : NO_FOLDER_VALUE;
    }
    if (selectable.length === 0 && this.bulkToolbar.contains(this.bulkToolbar.ownerDocument.activeElement)) {
      this.recognitionHeading.focus();
    }
    this.bulkToolbar.hidden = selectable.length === 0;
    this.syncBulkToolbar();
  }

  private syncBulkToolbar(): void {
    const paths = [...this.bulkCheckboxes.keys()];
    const state = selectAllState(this.bulkSelection, paths);
    for (const [path, checkbox] of this.bulkCheckboxes) checkbox.checked = this.bulkSelection.has(path);
    this.bulkAll.checked = state === "all";
    this.bulkAll.indeterminate = state === "partial";
    const count = paths.filter((path) => this.bulkSelection.has(path)).length;
    this.bulkCount.setText(`${count} of ${paths.length} selected`);
    const noDestination = this.bulkDestination.value === NO_FOLDER_VALUE;
    const active = this.bulkToolbar.ownerDocument.activeElement;
    if ((active === this.bulkMove && (count === 0 || noDestination)) || (active === this.bulkClear && count === 0)) {
      this.focusBulkControl(count > 0 ? this.bulkDestination : this.bulkAll);
    }
    this.bulkMove.disabled = count === 0 || noDestination;
    this.bulkClear.disabled = count === 0;
  }

  private focusBulkControl(preferred: HTMLButtonElement | HTMLInputElement | HTMLSelectElement): void {
    if (!this.mounted) return;
    if (this.bulkToolbar.hidden) this.recognitionHeading.focus();
    else (preferred.disabled ? this.bulkAll : preferred).focus();
  }

  private beginBulkMove(): void {
    if (this.bulkMoving || this.bulkPending || this.bulkMove.disabled) return;
    const root = this.plugin.settings.portfolioRoot;
    const targets: BulkTarget[] = [];
    for (const row of this.rows) {
      const path = row.file.path;
      const hash = row.payloadHash;
      if (!hash || this.pendingDismissals.has(path) || !this.bulkSelection.has(path)
        || !this.bulkCheckboxes.has(path)) continue;
      if (row.result.state !== "verified" || !canTrustAndFileRow(row, this.plugin.trust)) continue;
      targets.push({
        file: row.file, path, hash, raw: row.raw, title: row.title,
        needsTrust: !getVerdict(this.plugin.trust, hash),
      });
    }
    if (targets.length === 0) {
      this.reportBulkMove("No selected objects are still eligible.");
      return;
    }
    const value = this.bulkDestination.value;
    if (value !== NEW_FOLDER_VALUE) {
      const folderName = this.bulkDestination.selectedOptions[0]?.text ?? safe(value);
      this.confirmBulkMove(targets, value, folderName, root);
      return;
    }

    this.bulkPending = true;
    let created: { path: string; name: string } | undefined;
    new NewFolderModal(this.app, {
      onSubmit: async (name) => {
        if (root !== this.plugin.settings.portfolioRoot) return "The portfolio root changed. Choose a destination again.";
        try {
          const path = await this.plugin.createPortfolioFolder(name);
          created = { path, name: safe(path.split("/").pop() ?? name) };
          return null;
        } catch (error) {
          return errorMessage(error);
        }
      },
      onClose: () => {
        this.bulkPending = false;
        if (!this.mounted) return;
        if (created) this.confirmBulkMove(targets, created.path, created.name, root);
        else this.focusBulkControl(this.bulkMove);
      },
    }).open();
  }

  private confirmBulkMove(targets: readonly BulkTarget[], folderPath: string, folderName: string, root: string): void {
    const trustCount = targets.filter(({ needsTrust }) => needsTrust).length;
    const run = () => {
      this.focusBulkControl(this.bulkMove);
      void this.runBulkMove(targets, folderPath, folderName, root);
    };
    if (trustCount === 0) {
      run();
      return;
    }
    this.bulkPending = true;
    new BulkMoveConfirmModal(this.app, {
      trustCount,
      readyCount: targets.length - trustCount,
      folderName,
      onConfirm: run,
      onClosed: (confirmed) => {
        this.bulkPending = false;
        if (!confirmed) this.focusBulkControl(this.bulkMove);
      },
    }).open();
  }

  private assertBulkDestination(folderPath: string, root: string): void {
    const currentRoot = this.plugin.portfolioRootFolder();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (root !== this.plugin.settings.portfolioRoot || !currentRoot || !isFolder(folder)
      || folder.parent?.path !== currentRoot.path || folder.path !== folderPath) {
      throw new Error("The destination is no longer in the current portfolio root.");
    }
  }

  private async verifyBulkTarget(target: BulkTarget, root: string): Promise<boolean> {
    const isCurrent = () => target.file.path === target.path
      && !this.pendingDismissals.has(target.path)
      && !this.plugin.isRecognitionDismissed(target.path, target.hash)
      && this.app.vault.getAbstractFileByPath(target.path) === target.file
      && withinFolder(target.path, this.plugin.settings.verificationFolder)
      && !isFiledUnder(target.path, root);
    if (!isCurrent()) return false;
    const raw = await this.app.vault.read(target.file);
    if (raw !== target.raw) return false;
    const result = await verify(raw);
    return result.state === "verified" && result.computed === target.hash && isCurrent()
      && await this.app.vault.read(target.file) === raw && isCurrent();
  }

  private async runBulkMove(
    targets: readonly BulkTarget[], folderPath: string, folderName: string, root: string,
  ): Promise<void> {
    if (!this.mounted || this.bulkMoving) return;
    this.bulkMoving = true;
    this.bulkToolbar.setAttr("aria-busy", "true");
    this.bulkMove.setAttr("aria-disabled", "true");
    this.scheduleRefresh.cancel();
    const failed = new Map<string, string>();
    let moved = 0;
    let skipped = 0;
    let problem: string | undefined;
    try {
      this.assertBulkDestination(folderPath, root);
      const eligible: BulkTarget[] = [];
      const trustHashes = new Set<string>();
      for (const target of targets) {
        try {
          const current = await this.verifyBulkTarget(target, root);
          const verdict = getVerdict(this.plugin.trust, target.hash)?.verdict;
          if (!current || verdict === "rejected" || (!verdict && !target.needsTrust)) {
            skipped++;
            continue;
          }
          eligible.push(target);
          if (!verdict) trustHashes.add(target.hash);
        } catch (error) {
          failed.set(target.path, `${target.title}: ${errorMessage(error)}`);
        }
      }
      this.assertBulkDestination(folderPath, root);
      if (trustHashes.size > 0) {
        await this.plugin.setVerdicts([...trustHashes], "trusted", `Bulk trust and file: ${folderName}`);
      }
      for (const target of eligible) {
        try {
          const current = await this.verifyBulkTarget(target, root);
          this.assertBulkDestination(folderPath, root);
          if (!current || getVerdict(this.plugin.trust, target.hash)?.verdict !== "trusted") {
            skipped++;
            continue;
          }
          await this.plugin.moveToPortfolio(target.file, folderPath);
          moved++;
        } catch (error) {
          failed.set(target.path, `${target.title}: ${errorMessage(error)}`);
        }
      }
      this.bulkSelection = new Set(failed.keys());
    } catch (error) {
      problem = errorMessage(error);
    } finally {
      this.bulkMoving = false;
      this.bulkToolbar.removeAttribute("aria-busy");
      this.bulkMove.removeAttribute("aria-disabled");
      this.scheduleRefresh.cancel();
    }

    if (this.mounted && moved > 0) {
      try {
        // Obsidian updates the existing TFiles on rename. Reuse their scanned
        // rows so both boards reflect the move while the vault rescan runs.
        const { verificationFolder, portfolioRoot } = this.plugin.settings;
        const rows = new Map([...this.portfolioRows, ...this.rows].map((row) => [row.file.path, row]));
        this.portfolioRows = [...rows.values()].filter((row) => isFiledUnder(row.file.path, portfolioRoot));
        this.rows = this.rows.filter((row) => withinFolder(row.file.path, verificationFolder));
        this.renderSummary();
        this.renderRecognitionBoard();
        this.renderPortfolios();
      } catch (error) {
        console.error("[knobe-lens] Could not redraw after filing:", error);
      }
    }

    const result = problem
      ? `Could not complete filing: ${problem}`
      : `Moved ${moved} ${moved === 1 ? "object" : "objects"} to “${folderName}”.`
        + (skipped ? ` Skipped ${skipped} that were no longer eligible.` : "")
        + (failed.size ? ` Could not move ${failed.size}. ${[...failed.values()].join("; ")}.` : "");
    this.reportBulkMove(result);
    if (problem || failed.size) new Notice(result);
    await this.refresh(false).catch((error: unknown) => {
      console.error("[knobe-lens] Could not refresh after filing:", error);
      new Notice("Could not refresh the dashboard after filing. Use Rescan to update the board.");
    });
  }

  private reportBulkMove(result: string): void {
    this.announceAction(result);
  }

  /** Clear the status region, then set it on the next frame, so the message is
   *  announced even when it repeats the last one. */
  private announceAction(message: string): void {
    if (!this.mounted) return;
    this.actionStatusEl.setText("");
    this.actionStatusEl.win.requestAnimationFrame(() => {
      if (this.mounted) this.setActionStatus(message);
    });
  }

  private renderPortfolios(): void {
    this.destroyPortfolioSortables();
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
    const lanes = groupPortfolioRows(folders, this.portfolioRows);
    lanes.forEach((lane, laneIndex) => {
      const details = c.createEl("details", { cls: "knobe-lens-portfolio-lane", attr: { open: "" } });
      const color = this.plugin.portfolioColor(lane.folder.path, laneIndex);
      details.style.setProperty("--knobe-portfolio-color", color);
      const summary = details.createEl("summary", { cls: "knobe-lens-portfolio-heading" });
      summary.createSpan({ text: lane.folder.name });
      summary.createSpan({
        cls: "knobe-lens-count",
        text: String(lane.rows.length),
        attr: { "aria-label": `${lane.rows.length} object${lane.rows.length === 1 ? "" : "s"}` },
      });
      const controls = details.createDiv({ cls: "knobe-lens-portfolio-controls" });
      const colorId = `knobe-portfolio-color-${laneIndex}`;
      controls.createEl("label", { text: "Background", attr: { for: colorId } });
      const colorInput = controls.createEl("input", {
        cls: "knobe-lens-color-input",
        attr: {
          id: colorId,
          type: "color",
          value: color,
          "aria-label": `Background color for ${lane.folder.name} portfolio`,
        },
      });
      colorInput.addEventListener("input", () => {
        details.style.setProperty("--knobe-portfolio-color", colorInput.value);
      });
      colorInput.addEventListener("change", () => {
        void this.plugin.setPortfolioColor(lane.folder.path, colorInput.value);
      });

      const list = details.createEl("ul", {
        cls: "knobe-lens-card-list knobe-lens-portfolio-cards",
        attr: { "aria-label": `${lane.folder.name} portfolio documents` },
      });
      list.dataset.folderPath = lane.folder.path;
      if (lane.rows.length === 0) {
        details.createEl("p", { cls: "knobe-lens-empty", text: "No KNOBEs filed here yet." });
      } else {
        lane.rows.forEach((row, cardIndex) => this.renderCard(list, row, `p-${laneIndex}-${cardIndex}`, true));
      }
      this.portfolioSortables.push(Sortable.create(list, {
        group: "knobe-portfolios",
        sort: false,
        draggable: ".knobe-lens-card",
        handle: ".knobe-lens-drag-handle",
        animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 150,
        chosenClass: "is-drag-chosen",
        ghostClass: "is-drag-ghost",
        dragClass: "is-dragging",
        onEnd: (event) => void this.finishPortfolioDrop(event.item, event.to),
      }));
    });
  }

  private async finishPortfolioDrop(card: HTMLElement, destinationList: HTMLElement): Promise<void> {
    const path = card.dataset.path;
    const destination = destinationList.dataset.folderPath;
    const row = this.portfolioRows.find((candidate) => candidate.file.path === path);
    if (!row || !destination) {
      this.renderPortfolios();
      return;
    }
    if (!shouldMovePortfolioCard(row.file.parent?.path ?? "", destination)) {
      this.renderPortfolios();
      return;
    }
    try {
      await this.plugin.moveToPortfolio(row.file, destination);
      await this.afterMove(row, destination.split("/").pop() ?? destination);
    } catch (e) {
      new Notice(errorMessage(e));
      this.setActionStatus(`Could not move "${row.title}".`);
      this.renderPortfolios();
    }
  }

  private destroyPortfolioSortables(): void {
    for (const sortable of this.portfolioSortables) sortable.destroy();
    this.portfolioSortables = [];
  }

  private stateBadge(parent: HTMLElement, state: Status): void {
    const badge = parent.createSpan({ cls: `knobe-lens-badge state-${state}` });
    setIcon(badge.createSpan({ cls: "knobe-lens-badge-icon" }), STATE_ICON[state]);
    badge.createSpan({ text: STATE_LABEL[state] });
  }

  /** Checkmark shown on a filed card whose seal is intact. role="img" + a single
   *  aria-label so AT announces it atomically; never colour-only (icon + text). */
  private savedVerifiedBadge(parent: HTMLElement): void {
    const badge = parent.createSpan({
      cls: "knobe-lens-saved-badge",
      attr: { role: "img", "aria-label": "Saved and verified" },
    });
    setIcon(badge.createSpan({ cls: "knobe-lens-badge-icon" }), "badge-check");
    badge.createSpan({ text: "Saved & verified" });
  }

  /** Build the globe dataset from the scanned rows: every sealed object is a
   *  node, adaptation lineage supplies the arcs, and each node carries the
   *  fields the globe needs to re-cluster by kind / recognition / portfolio.
   *  Reuses buildLineage so the world and the flat lineage chart never diverge. */
  private buildWorldData(): WorldRenderData {
    const graph = buildLineage(
      this.rows.map((r) => ({
        hash: r.payloadHash,
        title: r.title,
        state: r.result.state,
        contentType: r.contentType,
        parents: r.parents,
      })),
    );
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    const rowByHash = new Map<string, ScanRow>();
    for (const r of this.rows) if (r.payloadHash) rowByHash.set(r.payloadHash, r);

    const nodes: WorldDatum[] = graph.nodes.map((n) => {
      const row = rowByHash.get(n.hash);
      const filed = row ? this.isFiled(row) : false;
      return {
        hash: n.hash,
        title: n.title,
        state: n.state,
        contentType: n.contentType,
        present: n.present,
        path: row?.file.path ?? null,
        portfolio: filed ? row?.file.parent?.name ?? "Portfolio" : null,
        degree: degree.get(n.hash) ?? 0,
      };
    });
    const edges: WorldEdge[] = graph.edges.map((e) => ({ from: e.from, to: e.to }));
    return { nodes, edges };
  }

  /** Create the globe once (so its listeners/observers persist across rescans),
   *  then feed it the current dataset and reflect any active selection. */
  private renderWorld(): void {
    if (!this.world) {
      this.world = new WorldGlobe(this.worldEl, {
        groupBy: "kind",
        onSelect: (d: WorldDatum) => {
          if (!d.path) return; // external placeholder: nothing to open
          const row = this.rows.find((r) => r.file.path === d.path);
          if (row) void this.select(row);
        },
      });
    }
    this.world.render(this.buildWorldData());
    const sel = this.rows.find((r) => r.file.path === this.selectedPath);
    this.world.setSelected(sel?.payloadHash ?? null);
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
      trigger.closest(".knobe-lens-card")?.toggleClass("is-selected", isSel);
    }
  }

  private async select(row: ScanRow): Promise<void> {
    this.selectedPath = row.file.path;
    this.updateRowSelection(); // no full rebuild — preserves focus
    this.world?.setSelected(row.payloadHash ?? null); // mirror the highlight on the globe
    await this.renderDetail(row);
    this.detailEl.setAttr("aria-label", `Detail: ${row.title}`);
    this.detailEl.focus(); // tabindex=-1: programmatic focus + announce, no double-scroll
  }

  private async renderDetail(row: ScanRow): Promise<void> {
    const d = this.detailEl;
    d.empty();

    const head = d.createDiv({ cls: "knobe-lens-detail-head" });
    const titleWrap = head.createDiv({ cls: "knobe-lens-detail-title-wrap" });
    titleWrap.createEl("h4", { text: row.title, cls: "knobe-lens-detail-title" });
    titleWrap.createDiv({ text: `${row.file.path} · ${row.contentType}`, cls: "knobe-lens-path" });
    const headActions = head.createDiv({ cls: "knobe-lens-detail-head-actions" });
    this.stateBadge(headActions.createDiv(), row.result.state);
    const minimize = headActions.createEl("button", { text: "Minimize" });
    minimize.setAttr("aria-expanded", "true");
    minimize.onclick = () => {
      const minimized = !d.hasClass("is-minimized");
      d.toggleClass("is-minimized", minimized);
      minimize.setText(minimized ? "Expand" : "Minimize");
      minimize.setAttr("aria-expanded", String(!minimized));
    };
    const clear = headActions.createEl("button", { text: "Clear results" });
    clear.onclick = () => {
      const restoreFocus = this.rowTriggers.get(row.file.path);
      this.selectedPath = null;
      this.updateRowSelection();
      this.world?.setSelected(null);
      d.empty();
      this.setActionStatus(`Cleared verification details for "${row.title}".`);
      restoreFocus?.focus();
    };

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
      tr.createEl("td", { text: renderValue(p[key]) });
    }

    const det = d.createEl("details", { cls: "knobe-lens-decoded-payload" });
    det.createEl("summary", { text: "Decoded payload (JSON)" });
    det.createEl("pre", { cls: "knobe-lens-pre", text: safeLines(JSON.stringify(p, null, 2)) });

    const bodyText = extractBodyText(row.raw);
    const bodyWrap = d.createDiv({ cls: "knobe-lens-bodywrap" });
    const openBtn = bodyWrap.createEl("button", { text: "Open note" });
    openBtn.onclick = () => void this.app.workspace.getLeaf(false).openFile(row.file);
    if (bodyText) {
      const preview = bodyText.trim().split("\n").slice(0, BODY_PREVIEW_LINES).join("\n");
      bodyWrap.createEl("pre", { cls: "knobe-lens-pre knobe-lens-body", text: preview });
    }

    const filed = this.isFiled(row);
    const filedBodyModified = filed && row.result.state === "verified-body-modified";
    if (filed) this.renderReverifySection(d, row);
    // The Break inspector still handles genuinely broken seals and every unfiled
    // object; for a filed body-modified object the reverify section above already
    // shows the change diff + reseal, so don't render the inspector's duplicate diff.
    if (row.result.state !== "verified" && !filedBodyModified) await this.renderBreakInspector(d, row);
    this.renderTrustControls(d, row);
  }

  /** Detail-pane block for a filed (portfolio) object: a "saved & verified"
   *  confirmation when the seal is intact, or the reverify flow (change diff +
   *  comment + reseal) when the body was edited. Always shows the seal history. */
  private renderReverifySection(parent: HTMLElement, row: ScanRow): void {
    const saved = savedState(true, row.result.state, row.result.conformance);
    const box = parent.createDiv({ cls: "knobe-lens-seal" });

    if (saved === "saved-verified") {
      box.createEl("h5", { text: "Saved & verified", cls: "knobe-lens-section" });
      const ok = box.createDiv({ cls: "knobe-lens-saved-badge", attr: { role: "img", "aria-label": "Saved and verified" } });
      setIcon(ok.createSpan({ cls: "knobe-lens-badge-icon" }), "badge-check");
      ok.createSpan({ text: "Filed in a portfolio and the seal is intact." });
      this.renderCommentLog(box, row);
      return;
    }

    if (saved === "needs-reverify") {
      box.createEl("h5", { text: "Reverify", cls: "knobe-lens-section" });
      box.createDiv({
        cls: "knobe-lens-muted",
        text: "This filed object was edited after it was sealed. Review the changes, add a note about what changed, and reseal to reverify it.",
      });
      this.renderSealChanges(box, row);
      this.renderResealForm(box, row);
      this.renderCommentLog(box, row);
      return;
    }

    // Filed but the seal is broken — the Break inspector diagnoses it; show history only.
    this.renderCommentLog(box, row);
  }

  /** The body changes since the last verified seal, red + underlined (added) and
   *  red + struck-through (removed). Off-screen "Added:"/"Removed:" prefixes keep
   *  the meaning off colour/decoration alone (SC 1.4.1). */
  private renderSealChanges(parent: HTMLElement, row: ScanRow): void {
    const wrap = parent.createDiv({ cls: "knobe-lens-seal-changes" });
    wrap.createDiv({ cls: "knobe-lens-muted", text: "Changes since the last verified seal:" });
    const snap = this.plugin.snapshotFor(row.file.path);
    if (!snap) {
      wrap.createSpan({ cls: "knobe-lens-muted", text: "No last-verified snapshot available — cannot show a diff." });
      return;
    }
    const cur = extractBodyText(row.raw) ?? "";
    const old = extractBodyText(snap.content) ?? "";
    const ops = lineDiff(old, cur).filter((op) => op.type !== "same");
    if (ops.length === 0) {
      wrap.createSpan({ cls: "knobe-lens-muted", text: "No line-level differences in the body." });
      return;
    }
    const pre = wrap.createEl("pre", {
      cls: "knobe-lens-pre knobe-lens-seal-diff",
      attr: { role: "group", "aria-label": `${ops.length} changed line(s) since the last verified seal` },
    });
    for (const op of ops) {
      const line = pre.createDiv({ cls: op.type === "add" ? "seal-add" : "seal-del" });
      line.createSpan({ cls: "knobe-lens-sr-only", text: op.type === "add" ? "Added: " : "Removed: " });
      line.createSpan({ text: op.line });
    }
  }

  /** Comment field + "Reverify & reseal" for an edited filed object. Enter is left
   *  free for newlines (a textarea) — submit is via the button only. */
  private renderResealForm(parent: HTMLElement, row: ScanRow): void {
    const box = parent.createDiv({ cls: "knobe-lens-reseal-form" });
    const commentId = `kl-seal-comment-${(row.payloadHash ?? row.file.path).slice(0, 8)}`;
    box.createEl("label", {
      text: "Comment about these changes (optional)",
      cls: "knobe-lens-muted",
      attr: { for: commentId },
    });
    const comment = box.createEl("textarea", {
      cls: "knobe-lens-seal-comment",
      attr: { id: commentId, rows: "2", placeholder: "e.g. fixed the citation in §2, reworded the summary" },
    });

    const actions = box.createDiv({ cls: "knobe-lens-actions" });
    const reseal = actions.createEl("button", { cls: "knobe-lens-action-button is-reverify", text: "Reverify & reseal" });
    reseal.onclick = async () => {
      await this.plugin.resealWithComment(row.file, comment.value);
      this.setActionStatus(`Reverified "${row.title}".`);
      this.scheduleRefresh.cancel();
      await this.refresh(false);
    };
    if (this.plugin.snapshotFor(row.file.path)) {
      const restore = actions.createEl("button", { text: "Restore last-verified" });
      restore.onclick = async () => {
        await this.plugin.restoreSnapshot(row.file);
        this.scheduleRefresh.cancel();
        await this.refresh(false);
      };
    }
  }

  /** Append-only reseal history, read from the sealed payload's reseal_log. */
  private renderCommentLog(parent: HTMLElement, row: ScanRow): void {
    const p = row.result.payload as Record<string, unknown> | undefined;
    const log = p && Array.isArray(p.reseal_log) ? (p.reseal_log as ResealComment[]) : [];
    const entries = log.filter((e) => e && typeof e === "object" && typeof e.comment === "string" && e.comment.trim());
    if (entries.length === 0) return;
    const box = parent.createDiv({ cls: "knobe-lens-comment-log" });
    box.createEl("h5", { text: "Seal history", cls: "knobe-lens-section" });
    const ul = box.createEl("ul", {
      cls: "knobe-lens-comment-list",
      attr: { "aria-label": `${entries.length} seal comment${entries.length === 1 ? "" : "s"}` },
    });
    for (const c of [...entries].reverse()) {
      const li = ul.createEl("li", { cls: "knobe-lens-comment-item" });
      if (typeof c.at === "string" && c.at) {
        li.createEl("time", { cls: "knobe-lens-comment-when", text: c.at, attr: { datetime: c.at } });
      }
      li.createDiv({ cls: "knobe-lens-comment-text", text: c.comment });
    }
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
      && typeof row.result.payload.ext_body_snapshot === "string";
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
    box.createDiv({
      cls: "knobe-lens-muted",
      text: `Declared: ${row.quarantine}. Your local verdict: ${verdict ? verdict.verdict : "unreviewed"}. (Local only — never written to the file.)`,
    });

    if (!row.payloadHash) {
      box.createDiv({ cls: "knobe-lens-muted", text: "Unreadable object — no verdict can be recorded." });
      return;
    }
    const hash = row.payloadHash;

    const noteId = `kl-note-${hash.slice(0, 8)}`;
    box.createEl("label", { text: "Reason for your decision (optional)", attr: { for: noteId }, cls: "knobe-lens-muted" });
    const noteInput = box.createEl("input", { attr: { id: noteId, type: "text", placeholder: "e.g. confirmed against source" } });
    noteInput.addClass("knobe-lens-note-input");

    const actions = box.createDiv({ cls: "knobe-lens-actions" });
    const trustBtn = actions.createEl("button", {
      cls: "knobe-lens-action-button is-trust",
      text: "Trust",
    });
    trustBtn.onclick = () => this.requestVerdict(row, hash, "trusted", () => noteInput.value);
    const rejectBtn = actions.createEl("button", {
      cls: "knobe-lens-action-button is-reject",
      text: "Reject",
    });
    rejectBtn.onclick = () => this.requestVerdict(row, hash, "rejected", () => noteInput.value);
    if (verdict) {
      const clearBtn = actions.createEl("button", {
        cls: "knobe-lens-action-button is-clear",
        text: "Clear verdict",
      });
      clearBtn.onclick = () => {
        this.changeVerdict(() => this.plugin.clearVerdict(hash), `Cleared your verdict on "${row.title}".`)
          .catch(reportVerdictError);
      };
    }

    if (row.result.state === "verified" && row.quarantine !== "trusted") {
      const promote = actions.createEl("button", {
        cls: "knobe-lens-action-button is-promote",
        text: "Promote to trusted (re-seal)",
      });
      promote.setAttr("aria-label", "Promote to trusted (re-seal): records the prior version as a parent in the lineage");
      promote.onclick = async () => { await this.plugin.promote(row.file); await this.refresh(); };
    }
  }

  async onClose(): Promise<void> {
    this.mounted = false;
    this.destroyPortfolioSortables();
    this.world?.destroy();
    this.world = null;
  }
}

/** First 12 characters of a hash for display. A stored hash is payload text. */
function short(h: string | null): string {
  return h ? safe(h, 12) : "—";
}

/** User-facing message from a thrown value (portfolio ops throw Error). */

/** Report a verdict that could not be recorded (no dialog to show it in). */
function reportVerdictError(error: unknown): void {
  console.error("[knobe-lens] recording the verdict failed:", error);
  new Notice("Could not record your verdict — see the developer console.");
}

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Could not complete the move — see the developer console.";
}

/** A payload field for the detail pane. Payload text: escaped like everywhere else. */
function renderValue(v: unknown): string {
  return safeLines(typeof v === "string" ? v : JSON.stringify(v));
}

function chip(parent: HTMLElement, label: string, value: string, ok: boolean): void {
  const c = parent.createSpan({ cls: `knobe-lens-chip ${ok ? "chip-ok" : "chip-warn"}` });
  c.createSpan({ text: label, cls: "knobe-lens-chip-label" });
  c.createSpan({ text: value });
}
