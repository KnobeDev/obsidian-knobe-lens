# KNOBE Lens

An Obsidian plugin to **verify, inspect, and seal** [KNOBE Protocol v1](https://knobe.org) knowledge objects (`.knobe.md`) directly in your vault.

KNOBE keeps a document's interpretive context — attribution, transformations, fidelity limits, use conditions, and accessibility lineage — inside the file, in plain text, hash-sealed. This plugin is both halves of the toolchain:

- **Lens (read):** a dashboard of every KNOBE in the vault with integrity status, conformance, declared quarantine status, and your local trust verdict; a detail pane with the decoded payload; and an adaptation-lineage graph.
- **Sealer (write):** a "Seal current note as KNOBE" command and an optional "re-seal on save" toggle. Keyless (SHA-256 integrity only — no signature, no secret).

## Features

| Area | What it does |
|---|---|
| Verify | Faithful port of the reference `lens.py`, gated against the 9 published conformance vectors. Reports `verified` / `verified-body-modified` / `failed` / `unreadable` and a conformance level. |
| Seal | Appends a hash-sealed payload built from frontmatter + settings defaults. Idempotent, so "re-seal on save" never loops. |
| Trust verdicts | Record a **local** trusted/rejected decision per object, keyed by payload hash. Never written to the file; auto-stale if the file changes. |
| Break inspector | Classifies a broken seal as benign Unicode normalization vs. a real edit; shows a diff against the last-verified snapshot; offers restore / re-seal. |
| Lineage | Graphs `parents[]` links between sources and their adaptations, with an accessible text fallback. |

## Design principles

- **Integrity, not truth.** A verified seal proves the payload is intact — not that it is true, safe, or cleared. The UI keeps `quarantine_status` visible and defaults to quarantine-first.
- **Read-only by default; writes are explicit.** Sealing, promoting, and restoring are deliberate actions. "Unquarantine" is a *local verdict*, not a file edit — promoting to a trusted *declaration* is a separate re-seal that records the prior object as a lineage parent.
- **Accessible.** Status uses icon + text (never colour alone), themes off Obsidian's own CSS variables, and the lineage graph has a text fallback.

## Development

```bash
npm install
npm test        # vitest: 28 tests (verifier vectors, sealer round-trip/idempotency, trust, diagnosis, diff, lineage, security)
npm run dev     # esbuild watch
npm run build   # tsc type-check + production bundle -> main.js
```

Source is organized as small modules: `lens-core` (verify + hashing primitives), `seal`, `scanner`, `trust`, `diagnose`, `diff`, `lineage` (+ `lineage-render`), `view`, `settings`, `main`.

## License

MIT (plugin code). KNOBE Protocol content: CC BY 4.0.
