# Changelog

All notable changes to KNOBE Lens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-06-30

### Added

- **Portfolios organise filed work, and filed objects leave the main list.** Once
  an object is filed anywhere under the portfolio root, it moves out of the main
  verification table (the summary shows a `· N filed` tally) and into the
  **Portfolios** section, grouped by subject folder — each file shown with its
  status badge, click-to-open, and a re-file dropdown to move it between subjects.
  Filed objects stay reachable through *"Verify a document…"*, and re-seal after
  editing via the detail pane.

### Fixed

- **Filing a document into a new folder now actually moves the file.** Creating a
  portfolio folder and moving a note into it both used to re-fetch the
  just-created folder from Obsidian's index immediately after creating it, which
  races index registration and failed — leaving an empty folder and the note in
  place. Both now work off the folder path directly, so create-then-file is
  atomic and reliable.

## [0.4.0] - 2026-06-30

### Added

- **Verifies KNOBE.AI `knobe_version 0.1` objects too.** A second, fully distinct
  serialization — a JSON payload inside an HTML-comment / `<script>` envelope with
  a self-describing integrity block — is now parsed and cryptographically verified
  via its declared `claim-fields-join-v0.1` SHA-256, shown as Verified / Failed
  just like the PEM/B64 format. Titles come from `header.title`. The sealer still
  only writes the PEM/B64 format, and re-seal / promote now **refuse** to overwrite
  a 0.1 object so it can't be corrupted.
- **Deep "Rescan".** The toolbar button (renamed from "Re-verify") now also
  reconciles against the filesystem on click, surfacing KNOBE files that exist on
  disk but Obsidian hasn't indexed yet — in a notice listing them, so they're
  never silently missing. Bounded (skips dot-folders, caps disk reads) and only on
  an explicit click, never on the live auto-refresh.

### Fixed

- **New documents are recognised on open.** The first scan now waits for
  `onLayoutReady`, so KNOBE notes added while Obsidian was closed appear when the
  panel restores at startup (previously they could be missed until a manual
  rescan).
- **Security hardening (integrity-critical):** capped the verifiable file size and
  switched the 0.1 envelope to linear extraction to remove super-linear regex
  backtracking on adversarial input; the verifier now **refuses** (rather than
  asserting "verified") when a `claim-fields-join-v0.1` value contains the join
  separator, which would otherwise allow a separator-injection hash collision.
  *Note for the format authors: `claim-fields-join-v0.1` is not prefix-free —
  v0.2 should length-prefix fields or include field names in the preimage.*

### Changed

- The toolbar's verify button is now labelled **Rescan** (it both re-verifies and
  discovers new documents).

## [0.3.0] - 2026-06-29

### Added

- **Portfolios.** A new *Portfolios* section under *Adaptation lineage* lets you
  organise objects into real vault folders under a configurable root (default
  *KNOBE Portfolios*, set in settings). Each object you have locally marked
  **trusted** gains a *Move to portfolio* dropdown in the dashboard — pick an
  existing folder or **+ New folder…** to create one inline. Moves use Obsidian's
  link-aware rename, so backlinks follow. The control stays disabled (with a
  visible reason) until you trust the object, the result is announced through a
  dedicated polite live region, and focus returns to the moved object — never to
  nowhere.

### Fixed

- **Recognises KNOBEs with CRLF / mixed line endings.** Block detection now
  tolerates `\r\n` and doubled `\r\r\n` line terminators (common from Windows
  and some exporters). Previously such a note — even a perfectly valid seal —
  was reported *unreadable* ("no payload block found") because the marker line
  wasn't matched. Pure-LF files are byte-for-byte unaffected (the 9 reference
  conformance vectors still pass unchanged).
- **Surfaces objects this lens cannot verify instead of hiding them.** Notes
  using a legacy/variant marker (`-----BEGIN KNOBE B-----`) are now listed with
  their real title and an actionable reason (e.g. *"KNOBE block has no
  payload_hash (unsealed/legacy); re-seal this note to verify"*), rather than
  being silently skipped.

### Changed

- **Verifies every object under 1.0 rules, regardless of its declared version.**
  Present non-1.0 `spec_version` labels (2.9, 3.0, …) are premature — the on-disk
  format is 1.0 — so the version gate is gone and every object is checked under
  1.0 canonicalization. This is safe against false positives: a genuinely
  different canonicalization simply fails the hash, it can never produce a
  spurious *verified*. A non-1.0 label is surfaced as a conformance **warning**
  so the normalization stays visible. (The published KNOBE Seed v1.1, labelled
  2.9, now verifies — its hash reproduces exactly under 1.0 rules.)
- **Single source of truth for the seal marker.** The marker/prefilter is now
  defined once in the verifier and shared by the scanner, sealer, and plugin.
  Re-seal-on-save additionally guards on a verified state, so it can never
  rewrite an unsupported/legacy object as a 1.0 seal.

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

[0.5.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.5.0
[0.4.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.4.0
[0.3.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.3.0
[0.2.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.2.0
[0.1.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.1.0
