# RSS Importer

[![CI](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/ci.yml/badge.svg)](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/ci.yml) [![Release](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/release.yml/badge.svg)](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/release.yml) [![Downloads](https://badgen.net/github/assets-dl/ckelsoe/obsidian-rss-importer?label=downloads)](https://github.com/ckelsoe/obsidian-rss-importer/releases) [![Stars](https://badgen.net/github/stars/ckelsoe/obsidian-rss-importer)](https://github.com/ckelsoe/obsidian-rss-importer) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License: MIT](https://img.shields.io/badge/License-MIT-blue)](https://github.com/ckelsoe/obsidian-rss-importer/blob/main/LICENSE) [![Latest](https://badgen.net/github/release/ckelsoe/obsidian-rss-importer?label=latest)](https://github.com/ckelsoe/obsidian-rss-importer/releases/latest)

Import articles and podcasts from RSS, Atom, and Substack feeds into your vault as Markdown notes, organized by source feed and deduplicated by note identity.

It is an importer, not a reader. It writes notes you own and then gets out of the way.

> [!NOTE]
> RSS Importer writes (and, with the cleanup command, rewrites) notes in your vault. As with any tool that creates files on your behalf, **keep backups** and try it on a test vault first. Provided "as is", without warranty, under the MIT License.

## Requirements

- Obsidian **v1.13.0** or newer.
- **Desktop only** (Windows, macOS, Linux). It is not available on mobile.

## Features

- **Multiple sources.** Add any RSS, Atom, or podcast feed. Substack publications are first-class: paste an `@handle`, a subdomain, a custom domain, or a post URL and the plugin resolves it to the right feed.
- **One folder per feed, never re-imports.** Each feed imports into its own destination folder, and every note carries a stable identity in its frontmatter, so moving or renaming notes never causes duplicates on the next import. Reorganize into subfolders freely.
- **Add-feed preview.** Paste a feed and resolve it to preview the publication title, host, recent item titles, and source type before you commit.
- **Three-state import window.** Each item shows as imported, dismissed, or available, with checkboxes, live progress, and a result summary. Dismissing is reversible, and imported items update immediately. A **Select all** toggle checks every available item at once, and counts show how many items are loaded and how many are selected.
- **Archive backfill with endless scroll.** For Substack feeds, older posts load automatically as you scroll the import list, paging back through the publication's archive well beyond the recent RSS window and fetching bodies on demand. A "Load older" button is also there as a fallback and end-of-archive indicator.
- **Re-detect source.** A custom-domain Substack is recognized as Substack on add. If one was added before that detection existed, a per-feed **Re-detect** button upgrades it in place so it gains archive backfill, without removing and re-adding the feed.
- **Clean Markdown.** Article HTML is converted to tidy Markdown (headings, lists, tables, code blocks with language, captions, footnotes), with Substack subscribe/app/share widgets stripped.
- **Per-feed cleanup rules.** Remove promotional clutter by link target (for example a "buy me a coffee" or subscribe block) or trim a trailing footer, applied on import and re-runnable over existing notes with the **Clean up imported notes** command. Matching is by link and structure, not wording, so rules keep working when the text changes.
- **Images.** Link to the original image URLs, or download images into your vault.
- **Media.** Download podcast/audio/video enclosures into a vault subfolder or to a folder outside the vault, per feed.
- **Tidy tags.** Feed tags are written to a `feed-tags` note property by default so they do not flood the global tag pane, or to Obsidian `tags` if you prefer.
- **Per-feed overrides.** Most defaults (destination, note name, images, media, cleanup, tags) can be set globally and overridden per feed.

## Usage

1. Open **Settings → RSS Importer → Feeds → Add feed**. Paste a feed URL or Substack handle, click **Resolve** to preview, choose a destination folder, optionally add tags and cleanup rules, and save.
2. Run the **Import from a feed** command (or the ribbon icon) to open the import window. Tick items (or use **Select all**) and import; for Substack, scroll the list to load older archived posts automatically. The summary reports what was created, skipped, or failed.
3. Optionally run **Clean up imported notes** to re-apply a feed's cleanup rules to notes you already imported.

## Installation

### Obsidian Community plugins (recommended)

In Obsidian, go to **Settings → Community plugins → Browse**, search for **RSS Importer**, then install and enable it. This is the recommended way to install and to receive updates.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ckelsoe/obsidian-rss-importer/releases/latest).
2. Create a folder named `rss-importer` in your vault's `.obsidian/plugins/` directory.
3. Copy the downloaded files into this folder.
4. Reload Obsidian, then enable **RSS Importer** in **Settings → Community plugins**.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
