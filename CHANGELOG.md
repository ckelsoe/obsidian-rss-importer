# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-14

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
