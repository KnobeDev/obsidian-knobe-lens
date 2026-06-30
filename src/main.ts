import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { verify } from "./lens-core";
import { KNOBE_LENS_VIEW, KnobeLensView } from "./view";
import { sealKnobe, splitNote, SealFields } from "./seal";
import { KnobeLensSettings, DEFAULT_SETTINGS, KnobeLensSettingTab } from "./settings";
import { TrustLedger, Verdict, setVerdict, clearVerdict, getVerdict } from "./trust";
import { buildReportMarkdown, writeReport, KnobePickModal, reportFailedNotice } from "./report";
import { scanVault } from "./scanner";

const MARKER = "-----BEGIN KNOBE B64-----";
const RESEAL_DEBOUNCE_MS = 900;
const HEX64 = /^[0-9a-f]{64}$/;
const SETTINGS_KEYS: (keyof KnobeLensSettings)[] = [
  "author", "contribution", "license", "contentType",
  "privacyLevel", "quarantineStatus", "defaultSummary", "resealOnSave",
];

interface Snapshot {
  hash: string;
  content: string;
}

interface PluginData {
  settings: KnobeLensSettings;
  trust: TrustLedger;
  snapshots: Record<string, Snapshot>;
}

export default class KnobeLensPlugin extends Plugin {
  settings: KnobeLensSettings = DEFAULT_SETTINGS;
  trust: TrustLedger = {};
  private snapshots: Record<string, Snapshot> = {};
  private resealTimers = new Map<string, number>();
  private statusBar: HTMLElement | null = null;

  private static readonly STATUS_LABEL: Record<string, string> = {
    verified: "KNOBE: verified",
    "verified-body-modified": "KNOBE: body modified",
    failed: "KNOBE: failed",
    unreadable: "KNOBE: unreadable",
  };

  async onload(): Promise<void> {
    await this.loadAll();

    this.registerView(KNOBE_LENS_VIEW, (leaf: WorkspaceLeaf) => new KnobeLensView(leaf, this));
    this.addRibbonIcon("eye", "Open KNOBE Lens", () => void this.activateView());
    this.addSettingTab(new KnobeLensSettingTab(this.app, this));

    this.addCommand({
      id: "open-knobe-lens",
      name: "Open KNOBE Lens dashboard",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "seal-knobe",
      name: "Seal current note as KNOBE",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.sealFile(file);
        return true;
      },
    });
    this.addCommand({
      id: "verify-current",
      name: "Verify current note",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.verifyCurrent(file);
        return true;
      },
    });
    this.addCommand({
      id: "verify-and-report",
      name: "Submit a document for verification (create report)",
      callback: () => void this.verifyAndReport(),
    });

    this.statusBar = this.addStatusBarItem();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.updateStatusBar()));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.updateStatusBar()));
    void this.updateStatusBar();

    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (!(f instanceof TFile) || f.extension !== "md") return;
        if (this.settings.resealOnSave) this.scheduleReseal(f);
        if (f === this.app.workspace.getActiveFile()) void this.updateStatusBar();
      }),
    );
    this.registerEvent(this.app.vault.on("delete", (f) => void this.pruneSnapshot(f.path)));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => void this.renameSnapshot(oldPath, f.path)),
    );
  }

  /* ---- sealing ---- */

  private fieldsFor(file: TFile): SealFields {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const s = this.settings;
    const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
    const today = new Date().toISOString().slice(0, 10);
    return {
      title: str(fm.title, file.basename),
      summary: str(fm.summary, s.defaultSummary || "(no summary provided)"),
      content_type: str(fm.content_type, s.contentType),
      created_date: str(fm.created_date, today),
      license: str(fm.license, s.license),
      privacy_level: str(fm.privacy_level, s.privacyLevel),
      quarantine_status: str(fm.quarantine_status, s.quarantineStatus),
      attribution: { sources: [{ author: s.author || "unknown", contribution: s.contribution || "authorship" }] },
    };
  }

  private ensureFrontmatter(frontmatter: string, fields: SealFields): string {
    if (frontmatter.trim()) return frontmatter;
    return `---\ntitle: ${JSON.stringify(fields.title)}\nspec_version: "1.0"\n---`;
  }

  private async buildSealed(file: TFile, raw: string, overrides: Partial<SealFields> = {}): Promise<string> {
    const { frontmatter, body } = splitNote(raw);
    return this.buildSealedParts(file, frontmatter, body, overrides);
  }

  private async buildSealedParts(
    file: TFile, frontmatter: string, body: string, overrides: Partial<SealFields> = {},
  ): Promise<string> {
    const fields = { ...this.fieldsFor(file), ...overrides };
    // Privacy guard: never embed a second copy of restricted content.
    const embedBody = this.settings.embedBodySnapshot && fields.privacy_level !== "restricted";
    return sealKnobe(this.ensureFrontmatter(frontmatter, fields), body, fields, { embedBody });
  }

  async sealFile(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      const sealed = await this.buildSealed(file, raw);
      const title = this.fieldsFor(file).title;
      if (sealed !== raw) {
        await this.app.vault.modify(file, sealed);
        new Notice(`Sealed "${title}" as KNOBE`);
      } else {
        new Notice(`"${title}" is already up to date.`);
      }
    } catch (e) {
      console.error("[knobe-lens] sealFile failed:", e);
      new Notice("Sealing failed — see the developer console.");
    }
  }

  /** Promote a verified, quarantined object to trusted by re-sealing, recording
   *  the prior object as a parent (lineage). An authoring action: a NEW seal.
   *  Refuses to run on a broken seal — that would launder a tampered record. */
  async promote(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      const current = await verify(raw);
      if (current.state !== "verified") {
        new Notice("Cannot promote: the seal is not intact. Inspect or re-seal first.");
        return;
      }
      const oldHash = current.computed;
      const existing = (Array.isArray(current.payload?.parents) ? (current.payload!.parents as unknown[]) : []).filter(
        (p): p is Record<string, unknown> =>
          !!p && typeof p === "object" && typeof (p as Record<string, unknown>).payload_hash === "string"
          && HEX64.test((p as Record<string, string>).payload_hash),
      );
      const parents = oldHash ? [...existing, { payload_hash: oldHash, relation: "promoted-from" }] : existing;
      const sealed = await this.buildSealed(file, raw, { quarantine_status: "trusted", parents } as Partial<SealFields>);
      if (sealed !== raw) await this.app.vault.modify(file, sealed);
      new Notice("Promoted to trusted — re-sealed; previous object recorded as parent.");
    } catch (e) {
      console.error("[knobe-lens] promote failed:", e);
      new Notice("Promote failed — see the developer console.");
    }
  }

  private scheduleReseal(file: TFile): void {
    const prev = this.resealTimers.get(file.path);
    if (prev) window.clearTimeout(prev);
    const id = window.setTimeout(() => {
      this.resealTimers.delete(file.path);
      void this.resealIfKnobe(file);
    }, RESEAL_DEBOUNCE_MS);
    this.resealTimers.set(file.path, id);
  }

  private async resealIfKnobe(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      if (!raw.includes(MARKER)) return;
      const sealed = await this.buildSealed(file, raw);
      if (sealed !== raw) await this.app.vault.modify(file, sealed); // idempotent -> no loop
    } catch (e) {
      console.error("[knobe-lens] reseal-on-save failed:", e);
    }
  }

  /* ---- last-verified snapshots ---- */

  snapshotFor(path: string): Snapshot | null {
    return this.snapshots[path] ?? null;
  }

  /** Stage a snapshot in memory; returns true if it changed. Caller persists. */
  stageSnapshot(path: string, hash: string, content: string): boolean {
    const cur = this.snapshots[path];
    if (cur && cur.hash === hash) return false;
    this.snapshots = { ...this.snapshots, [path]: { hash, content } };
    return true;
  }

  private async pruneSnapshot(path: string): Promise<void> {
    if (!(path in this.snapshots)) return;
    const next = { ...this.snapshots };
    delete next[path];
    this.snapshots = next;
    await this.persist();
  }

  private async renameSnapshot(oldPath: string, newPath: string): Promise<void> {
    if (!(oldPath in this.snapshots)) return;
    const next = { ...this.snapshots };
    next[newPath] = next[oldPath];
    delete next[oldPath];
    this.snapshots = next;
    await this.persist();
  }

  async restoreSnapshot(file: TFile): Promise<void> {
    const snap = this.snapshots[file.path];
    if (!snap) {
      new Notice("No last-verified snapshot available to restore.");
      return;
    }
    try {
      await this.app.vault.modify(file, snap.content);
      new Notice("Restored the last-verified version.");
    } catch (e) {
      console.error("[knobe-lens] restore failed:", e);
      new Notice("Restore failed — see the developer console.");
    }
  }

  /** Restore the body from a self-contained ext_body_snapshot, then re-seal.
   *  Only trustworthy when the payload itself is intact. */
  async restoreFromEmbedded(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      const r = await verify(raw);
      const snap = r.payload?.ext_body_snapshot;
      if (r.state !== "verified" && r.state !== "verified-body-modified") {
        new Notice("Cannot restore: the sealed payload is not intact.");
        return;
      }
      if (typeof snap !== "string") {
        new Notice("This object has no embedded body snapshot.");
        return;
      }
      const { frontmatter } = splitNote(raw);
      const sealed = await this.buildSealedParts(file, frontmatter, snap);
      if (sealed !== raw) await this.app.vault.modify(file, sealed);
      new Notice("Restored body from the embedded snapshot.");
    } catch (e) {
      console.error("[knobe-lens] restoreFromEmbedded failed:", e);
      new Notice("Restore failed — see the developer console.");
    }
  }

  /* ---- trust verdicts (never written to the file) ---- */

  async setVerdict(hash: string, verdict: Verdict, note: string): Promise<void> {
    this.trust = setVerdict(this.trust, hash, verdict, note, new Date().toISOString());
    await this.persist();
  }

  async clearVerdict(hash: string): Promise<void> {
    this.trust = clearVerdict(this.trust, hash);
    await this.persist();
  }

  /* ---- view ---- */

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(KNOBE_LENS_VIEW)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: KNOBE_LENS_VIEW, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /* ---- status bar + verify command ---- */

  private async updateStatusBar(): Promise<void> {
    if (!this.statusBar) return;
    try {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") { this.statusBar.setText(""); return; }
      const raw = await this.app.vault.cachedRead(file);
      if (!raw.includes(MARKER)) { this.statusBar.setText(""); return; }
      const r = await verify(raw);
      this.statusBar.setText(KnobeLensPlugin.STATUS_LABEL[r.state] ?? "");
    } catch (e) {
      console.error("[knobe-lens] status bar update failed:", e);
      this.statusBar.setText("");
    }
  }

  async verifyCurrent(file: TFile): Promise<void> {
    try {
      const r = await verify(await this.app.vault.read(file));
      new Notice(`KNOBE: ${r.state} · conformance ${r.conformance}`);
    } catch (e) {
      console.error("[knobe-lens] verify failed:", e);
      new Notice("Verify failed — see the developer console.");
    }
  }

  /** Verify a chosen document and write a shareable Markdown report. Uses the
   *  active KNOBE if there is one, otherwise prompts to pick one. Local only. */
  async verifyAndReport(file?: TFile): Promise<void> {
    const run = async (f: TFile): Promise<void> => {
      try {
        const result = await verify(await this.app.vault.read(f));
        const generatedAt = new Date().toISOString();
        const verdict = getVerdict(this.trust, result.computed);
        const md = buildReportMarkdown({ file: f, result, verdict, generatedAt });
        const note = await writeReport(this.app, f, md, generatedAt);
        await this.app.workspace.getLeaf(true).openFile(note);
        new Notice(`KNOBE report created for "${f.basename}"`);
      } catch (e) {
        console.error("[knobe-lens] verifyAndReport failed:", e);
        reportFailedNotice();
      }
    };

    // A KNOBE is identified by its seal marker — the same definition the
    // dashboard scans by — not by a `.knobe.md` filename. Sealing never renames
    // a note, so a name-based filter would miss every document a user sealed.
    const hasSeal = async (f: TFile): Promise<boolean> =>
      f.extension === "md" && (await this.app.vault.cachedRead(f)).includes(MARKER);

    const target = file ?? this.app.workspace.getActiveFile() ?? undefined;
    if (target && (await hasSeal(target))) {
      void run(target);
      return;
    }
    const candidates = (await scanVault(this.app)).map((row) => row.file);
    if (!candidates.length) {
      new Notice("No sealed KNOBE notes found in this vault.");
      return;
    }
    new KnobePickModal(this.app, candidates, (f) => void run(f)).open();
  }

  /* ---- persistence ---- */

  private async loadAll(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData> & Partial<KnobeLensSettings>;
    const rawSettings = (data.settings ?? data) as Record<string, unknown>;
    const migrated: Partial<KnobeLensSettings> = {};
    for (const k of SETTINGS_KEYS) if (k in rawSettings) (migrated as Record<string, unknown>)[k] = rawSettings[k];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
    this.trust = data.trust ?? {};
    this.snapshots = data.snapshots ?? {};
  }

  async persist(): Promise<void> {
    const data: PluginData = { settings: this.settings, trust: this.trust, snapshots: this.snapshots };
    await this.saveData(data);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  onunload(): void {
    for (const id of this.resealTimers.values()) window.clearTimeout(id);
    this.resealTimers.clear();
  }
}
