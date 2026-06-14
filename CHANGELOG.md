# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-14

### Added
- Per-feed media download: save podcast audio and video enclosures into a vault subfolder, or to a folder outside the vault (desktop only) for large media you do not want syncing. Global defaults plus per-feed overrides. Notes record a `media-file` property and link to the local file.

### Changed
- Feed tags now write to a `feed-tags` note property by default instead of the global Obsidian `tags`, so they no longer flood the tag pane, search, and graph. A "Tag destination" setting switches back to Obsidian tags. A leading `#` is stripped from tags.

### Fixed
- Imported items show the imported badge immediately after an import, instead of only after closing and reopening the import window.
- The import result summary is a one-line count plus any failures, instead of listing every item (which overflowed the window).

## [0.1.2] - 2026-06-14

### Fixed
- In the import window, dismissing or undismissing an item (and the refresh after an import) no longer clears the other items you had checked. Selection is preserved across re-renders.

### Changed
- The Markdown converter now strips Substack's email-truncation and "read in the app" notices, subscribe forms, CTA buttons, and related-post embeds, matched by Substack's structural component markers (never by body text). Images, captions, and article prose are kept. Author-written prose (including a hand-typed support paragraph) is left untouched.

## [0.1.1] - 2026-06-14

### Fixed
- Plugin failed to load on enable. The settings tab declared a getter-only `plugin` accessor, which collided with the base class assigning `this.plugin` during construction, so the plugin was disabled before any commands or UI registered. The settings tab now uses a plain typed field.
- The Add feed dialog's Save button did nothing. It mixed two ways of toggling the disabled state and required a separate Resolve click first. Save now resolves the feed on demand and saves it, and is never stuck disabled.
- A failure during load now shows a Notice instead of failing silently, so a future load error is visible without opening the developer console.

### Added
- Initial release: import articles and podcasts from RSS, Atom, and Substack feeds into the vault as Markdown notes.
- Multi-source support behind one feed contract. Substack publications are first-class: add a `@handle`, subdomain, custom domain, or post URL and the plugin resolves it to the feed. Any other RSS, Atom, or podcast feed imports as a generic source.
- One destination folder per feed, with recursive deduplication by a stable `feed-item-id` stored in each note's frontmatter, so moving or renaming notes never causes a re-import.
- Add-feed flow with live resolve and preview (publication title, host, recent item titles, source type, free or paid hint).
- Import window with a three-state item list (imported, dismissed, available), reversible dismiss, live progress, and a per-item result summary that never aborts the run on a single bad item.
- HTML to Markdown conversion with feed-specific rules (figure captions, code-fence language, footnotes, subscribe and share widget stripping) and deterministic output.
- Images: link to the original URL (default) or download into the vault.
- Podcast items import as a note from the show notes with a link to the episode media.
- Sequential request pacing with 429 and Retry-After backoff, and a secret-free, exportable debug log.
- Desktop only for this release.
