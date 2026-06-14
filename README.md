# RSS Importer

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-rss-importer/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-rss-importer/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-rss-importer/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-rss-importer/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-rss-importer/releases) [![GitHub Stars](https://img.shields.io/github/stars/ckelsoe/obsidian-rss-importer?style=flat&logo=github&label=Stars)](https://github.com/ckelsoe/obsidian-rss-importer) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/github/license/ckelsoe/obsidian-rss-importer)](https://github.com/ckelsoe/obsidian-rss-importer/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-rss-importer?label=Latest)](https://github.com/ckelsoe/obsidian-rss-importer/releases/latest)

Import articles and podcasts from RSS, Atom, and Substack feeds into your vault as Markdown notes, organized by source feed and deduplicated by note identity.

It is an importer, not a reader. It writes notes you own and then gets out of the way.

## Features

- **Multiple sources.** Add any RSS, Atom, or podcast feed. Substack publications are first-class: paste a `@handle`, a subdomain, a custom domain, or a post URL and the plugin resolves it to the right feed.
- **One folder per feed.** Each feed imports into its own destination folder. Reorganize the notes into subfolders however you like; the plugin still finds them.
- **Never re-imports.** Each note carries a stable identity in its frontmatter. Moving or renaming a note does not cause a duplicate on the next import.
- **Three-state item list.** Every item shows as imported, dismissed, or available. Dismiss items you are not interested in; dismissing is reversible.
- **Clean Markdown.** Article HTML is converted to tidy Markdown (headings, lists, tables, code blocks, captions), with subscribe and share widgets stripped.
- **Images your way.** Link to the original image URLs, or download images into your vault.
- **Podcasts.** Podcast items import as notes from the show notes with a link to the episode audio.

## Usage

1. Open **Settings → RSS Importer** and add a feed under **Feeds**. Paste a feed URL or a Substack handle, click **Resolve** to preview it, pick a destination folder, and save.
2. Run the **Import** command (or the ribbon icon) to open the import window.
3. Select the items you want and import them. A summary reports what was created, skipped, or failed.

## Installation

### From Obsidian Community Plugins (recommended)

1. Open Obsidian settings.
2. Navigate to **Community plugins**.
3. Click **Browse**.
4. Search for **RSS Importer**.
5. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ckelsoe/obsidian-rss-importer/releases/latest).
2. Create a folder named `rss-importer` in your vault's `.obsidian/plugins/` directory.
3. Copy the downloaded files into this folder.
4. Reload Obsidian.
5. Enable **RSS Importer** in Settings → Community plugins.

### BRAT (optional, for pre-release testing)

BRAT lets power users install pre-release builds before they reach the marketplace.

1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings and click **Add Beta Plugin**.
3. Enter: `https://github.com/ckelsoe/obsidian-rss-importer`
4. Enable **RSS Importer** in Settings → Community plugins.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
