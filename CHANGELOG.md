# Changelog

All notable changes to KNOBE Lens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-29

### Added

- **Live dashboard auto-refresh.** The KNOBE Lens view now rescans automatically
  when vault files change — `create`, `modify`, `rename`, and `delete` — so
  sealing, importing, moving, or deleting a note updates the list without
  pressing **Re-verify**. Rescans are debounced (400 ms) to coalesce bursts
  (bulk moves, reseal-on-save), and a re-entrancy guard collapses overlapping
  scans into a single trailing pass. Auto-refreshes are **silent**: the
  `aria-live` summary only re-announces when the counts actually change, so
  screen-reader users aren't spammed on every keystroke. Listeners are bound via
  `registerEvent`, so they're removed automatically when the view closes.

### Fixed

- **A KNOBE is identified by its seal marker, not its filename.** *"Submit a
  document for verification"* previously filtered candidates by a `.knobe.md`
  filename and so could never find a note you had actually sealed — sealing
  appends the seal block in place and never renames the file — reporting
  *"No .knobe.md documents found"*. It now detects the active KNOBE by its seal
  block and lists candidates from the same vault scan the dashboard uses.
  `.knobe.md` remains an optional naming convention, never a requirement.

### Changed

- Wording across the document picker, plugin manifest, and README now refers to
  "sealed KNOBE notes" rather than implying a required `.knobe.md` extension.

## [0.1.0] - 2026-06-29

### Added

- Initial release: verify, inspect, and seal KNOBE Protocol v1 knowledge objects
  directly in an Obsidian vault — integrity status, conformance, declared
  quarantine status, local trust verdicts (never written to the file), a break
  inspector with diff/restore, and an adaptation-lineage graph with a text
  fallback. Sealing is keyless (SHA-256 integrity only), with an optional
  re-seal-on-save toggle.

[0.2.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.2.0
[0.1.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.1.0
