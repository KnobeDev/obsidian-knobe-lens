# KNOBE Lens

An Obsidian plugin to **verify, inspect, and seal** [KNOBE Protocol v1](https://knobe.org) knowledge objects directly in your vault.

KNOBE keeps a document's interpretive context — attribution, transformations, fidelity limits, use conditions, and accessibility lineage — inside the file, in plain text, hash-sealed. This plugin is both halves of the toolchain:

### What counts as a KNOBE

A KNOBE is **any Markdown note carrying a seal block** (`-----BEGIN KNOBE B64-----`) — identified by that marker, not by its filename. You create one by running *"Seal current note as KNOBE"* on an existing note (it appends the seal in place; it does not move or rename the file) or by dropping a sealed `.md` someone shared into your vault. They live inline among your normal notes — no separate vault or database. `.knobe.md` is a recommended **naming convention** for discoverability, never a requirement: every command (dashboard, verify, report) finds a note by its seal wherever it sits. Because the seal is keyless SHA-256 over plain text, the same file verifies outside Obsidian too — via the reference `lens.py`, or by reading the shareable report the plugin writes to `KNOBE Reports/`.

- **Lens (read):** a dashboard of every KNOBE in the vault with integrity status, conformance, declared quarantine status, and your local trust verdict; a detail pane with the decoded payload; an adaptation-lineage graph; and a **Knowledge world** — a 3D globe of every sealed object, clustered into continents with lineage arcing across it.
- **Sealer (write):** a "Seal current note as KNOBE" command and an optional "re-seal on save" toggle. Keyless (SHA-256 integrity only — no signature, no secret).
- **Learn:** an in-app **Protocol guide** (states, conformance, the field vocabulary, honest limits) and an **Insert an example KNOBE** command that drops real, verifiable protocol documents into your vault to explore.

## Install

### Requirements

- Obsidian 1.4.0 or newer with Community plugins enabled.
- **No additional Obsidian plugins are required at runtime.**
- SortableJS, which powers portfolio drag-and-drop, is bundled inside KNOBE Lens.
- BRAT is optional: it is only a convenient way to install and update beta releases.

### Via BRAT (recommended)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin.
2. BRAT → **Add beta plugin** → `https://github.com/PersonalProjects/obsidian-knobe-lens`.
3. Enable **KNOBE Lens** under Settings → Community plugins.

BRAT installs the latest GitHub release and keeps it updated.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/PersonalProjects/obsidian-knobe-lens/releases/latest)
into `<vault>/.obsidian/plugins/knobe-lens/`, then enable the plugin.

### From source

```bash
git clone https://github.com/PersonalProjects/obsidian-knobe-lens
cd obsidian-knobe-lens && npm install && npm run build
# copy main.js, manifest.json, styles.css into <vault>/.obsidian/plugins/knobe-lens/
```

## Features

| Area | What it does |
|---|---|
| Verify | Faithful port of the reference `lens.py`, gated against the 9 published conformance vectors. Reports `verified` / `verified-body-modified` / `failed` / `unreadable` and a conformance level. |
| Seal | Appends a hash-sealed payload built from frontmatter + settings defaults. Idempotent, so "re-seal on save" never loops. |
| Save with KNOBE | Ctrl/Cmd+S opens a prompt prefilled from your defaults (or the note's existing seal) — every field editable, including a plain-language **instruction set** for AI/readers — then seals it into the document. Skippable per save, or disable the prompt in Settings → Save behavior. |
| Trust verdicts | Record a **local** trusted/rejected decision per object, keyed by payload hash. Risk-aware filing warns before trusting body-modified or failed objects. Never written to the file; auto-stale if the file changes. |
| Portfolios | File trusted objects into colored portfolio folders, move them by accessible folder selector, or drag them between folders. SortableJS is bundled—no extra plugin is needed. |
| Break inspector | Classifies a broken seal as benign Unicode normalization vs. a real edit; shows a diff against the last-verified snapshot; offers restore / re-seal. |
| Lineage | Graphs `parents[]` links between sources and their adaptations, with an accessible text fallback. |
| Knowledge world | A 3D globe of every sealed object. Regroup continents by kind, recognition, or portfolio; adaptation lineage arcs across the world. Canvas is `role="img"`; a keyboard-navigable list mirror is the real substrate (radiogroup grouping, selection faces the globe, static under reduced motion). |
| Examples | *Insert an example KNOBE* drops real, verifiable KNOBE Protocol v1 documents (including a linked source → agent-synthesis pair) into `KNOBE Examples/`. |
| Protocol guide | An in-app reference: the three verdicts, recognition states, conformance levels, the field vocabulary (generated from the verifier so it can't drift), required fields, honest limits, and links to knobe.org. |

## Design principles

- **Integrity, not truth.** A verified seal proves the payload is intact — not that it is true, safe, or cleared. The UI keeps `quarantine_status` visible and defaults to quarantine-first.
- **Read-only by default; writes are explicit.** Sealing, promoting, and restoring are deliberate actions. "Unquarantine" is a *local verdict*, not a file edit — promoting to a trusted *declaration* is a separate re-seal that records the prior object as a lineage parent.
- **Accessible.** Status uses icon + text (never colour alone), themes off Obsidian's own CSS variables, and the lineage graph has a text fallback.

## Development

```bash
npm install
npm test        # vitest: verifier vectors, sealer, trust, boards, diagnosis, diff, lineage, security
npm run dev     # esbuild watch
npm run build   # tsc type-check + production bundle -> main.js
```

The conformance suite requires a sibling clone at `../knobe-protocol`, or set
`KNOBE_PROTOCOL_DIR` to a protocol repository/test-vectors directory. CI checks
out the canonical repository automatically; the suite fails instead of silently
skipping protocol drift checks when it is unavailable.

Source is organized as small modules: `lens-core` (verify + hashing primitives), `seal`, `scanner`, `trust`, `diagnose`, `diff`, `lineage` (+ `lineage-render`), `view`, `settings`, `main`.

## License

MIT (plugin code). KNOBE Protocol content: CC BY 4.0.
