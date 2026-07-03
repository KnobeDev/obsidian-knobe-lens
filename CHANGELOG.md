# Changelog

All notable changes to KNOBE Lens are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.9.1] - 2026-07-02

### Changed

- **Confirmed state on the card button.** A verified object you have already
  confirmed — a saved-and-verified filed object, or any verified object with a
  trusted verdict — now shows a **✓ Confirmed** button (opens its details and
  seal history). Verified objects you haven't confirmed yet still show
  **Make Comment & Verify**.

## [0.9.0] - 2026-07-02

### Added

- **State-tinted title buttons.** The document title — the control you click to
  review/edit — is now a tinted button: pastel green (Verified), yellow (Body
  modified), red (Failed), or grey (Unreadable) on the Recognition board, and
  the **portfolio's own color** for filed objects. Tints are mode-aware.

### Changed

- **Clearer card action labels, by state.** Verified objects: **Make Comment &
  Verify** (unfiled) / **Make Comment & Reseal** (filed). Body modified / Failed
  / Unreadable: **Review Before Verifying**, which opens the object for review —
  for edited objects, the note opens with the changed lines highlighted.

### Fixed

- **Missing action button in portfolios.** Filed objects with a broken or
  unreadable seal showed no action button; every card now has one.

## [0.8.0] - 2026-07-02

### Added

- **Tri-state card actions.** The card button now states its truth:
  - **✓ Confirmed** (green) — saved & verified objects; opens the detail view.
  - **🔍 Make Comment and Reseal** (green/orange/red by risk) — objects not yet
    confirmed by the user; opens a comment dialog that collects your thoughts
    and seals them into the object's history, recording your trust.
  - **⚠🔍 EDITED, RECONFIRM** (orange) — filed objects edited after sealing
    (e.g. by an AI tool); opens the note itself with every changed line
    prominently highlighted, then comment & reseal from KNOBE Lens.
- **In-editor change highlights.** "EDITED, RECONFIRM" marks each line changed
  since the last verified seal directly in the editor — red tint, left bar,
  and underline — scrolled to the first change (CodeMirror line decorations).

### Fixed

- **Button text unreadable in light mode.** Obsidian's own
  `button:not(.clickable-icon)` rule out-specifies the plugin's single-class
  button styles, repainting labels with the theme text color (dark on dark
  green in light mode) and the Rescan/Verify surface gray. Button text and the
  primary-action surface are now pinned with `!important`.

## [0.7.0] - 2026-07-02

### Added

- **Saved & verified checkmark.** Filed (portfolio) objects whose seal is intact
  now carry a green "Saved & verified" badge on the card and in the detail pane.
- **Reverify flow.** Editing a filed object's body no longer goes unnoticed: the
  card shows an orange **Reverify?** button with an explanation, and the detail
  pane presents the changes since the last verified seal (additions in red
  underline, removals in red strikethrough), an optional comment field, and a
  **Reverify & reseal** action. Screen-reader users get "Added:"/"Removed:"
  prefixes on diff lines rather than color alone.
- **Seal comments (`reseal_log`).** Comments entered when resealing are stored
  as an append-only log *inside the sealed payload* — integrity-protected by
  `payload_hash`, they travel with the file and render as a "Seal history"
  section. Reverifies also record a `reverified-from` lineage parent.
- **Dark mode.** The panel now follows Obsidian's light/dark appearance toggle
  (including "Adapt to system"): warm parchment in light mode, neutral
  charcoal in dark mode, with status colors tuned for >=4.5:1 contrast in both.

### Changed

- **Filed objects are no longer auto-resealed on save.** With "Reseal on save"
  enabled, edits to a filed+trusted object previously re-sealed silently —
  laundering unreviewed changes back to "verified". Filed objects now surface
  as **Reverify?** and require an explicit, comment-carrying reseal.

### Fixed

- **Native dark-control chrome.** Card title buttons and the "Move to
  portfolio" select rendered as dark native macOS widgets on the warm canvas
  (dark-mode Macs) because they were never given an explicit background /
  `appearance`. All plugin controls are now explicitly styled, with a custom
  select chevron in both modes.
- **Button text contrast.** Colored action buttons ("Trust to file", "Rescan",
  "Verify a document…") relied on the theme-dependent `--text-on-accent` and
  could render near-black text on colored surfaces. Button text is now pinned
  white on AA-safe surfaces in both light and dark modes.

## [0.6.1] - 2026-07-02

### Fixed

- **Accessibility (from a WCAG 2.1 AA review of the board).**
  - The "Body modified" status badge (and the green/red status colors) now meet
    the 4.5:1 text-contrast minimum on the light "warm canvas" board — the theme
    defaults were tuned for a different background.
  - The Recognition board now identifies itself to assistive tech as **read-only**
    (`role="group"` with an explanatory label), so screen-reader users know those
    columns are derived verification results and aren't drop targets — filing is
    done with each card's *Move to portfolio* control.

## [0.6.0] - 2026-07-02

### Added

- **Board view.** Recognition and portfolios are now presented as columns.
  Recognition columns (Verified / Body modified / Failed / Unreadable) group
  objects by verification outcome and are **read-only** — those states are derived
  cryptographic results, not something you set. Portfolio columns are your subject
  folders.
- **Drag-and-drop filing.** Drag an object between portfolio columns to move it
  between subject folders (powered by SortableJS, **bundled** — no extra plugin).
  Dragging is portfolio-only; you can't drag into a recognition column, since
  verification status is computed, not assigned.
- **Risk-aware filing.** Filing warns before you trust a **body-modified** or
  **failed** object, so a broken seal isn't quietly filed as trusted. Clean,
  verified objects file without friction.

### Changed

- Portfolio and verification interactions polished (wrapped long titles, warmer
  canvas, clearer states). README documents the bundled SortableJS runtime.

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

[0.6.1]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.6.1
[0.6.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.6.0
[0.5.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.5.0
[0.4.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.4.0
[0.3.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.3.0
[0.2.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.2.0
[0.1.0]: https://github.com/jdhori/obsidian-knobe-lens/releases/tag/0.1.0
