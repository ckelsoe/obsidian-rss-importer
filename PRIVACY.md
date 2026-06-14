# Privacy Policy

_Last updated: 2026-06-14_

This policy explains what the **RSS Importer** Obsidian plugin ("the plugin") does and does not do with your data. It applies to the plugin as distributed through the Obsidian Community Plugins marketplace, GitHub releases, and BRAT.

## Summary

The plugin runs entirely on your device. It makes network requests only to the feed hosts you configure and to the image or media URLs those feeds reference, and only when you ask it to. It has no telemetry, no analytics, and no maintainer server. It never sends your data to the maintainer or to any third party beyond the feed and asset hosts you chose.

## What the plugin does

RSS Importer reads feeds you add and writes their items into your vault as Markdown notes.

- When you add a feed, the plugin fetches the URL you entered (and, for a Substack handle, the public Substack profile API) to resolve and preview the feed.
- When you import, the plugin fetches the feed and the selected items, converts each to Markdown, and writes a note into the destination folder you chose. If you turn on image download, it also fetches the images referenced by those items and saves them into your vault.
- To avoid re-importing, the plugin scans the frontmatter of notes under your destination folder (through Obsidian's metadata cache) and reads an existing note at a target path before overwriting it. It does not read other files in your vault.

Every fetch is triggered by an explicit action of yours (adding a feed, or running an import). The plugin does no background polling.

## Network use

The plugin makes outbound HTTP requests through Obsidian's `requestUrl` API. It contacts only:

- the feed hosts you configure (the publications and podcasts you add), and the redirect targets those hosts return;
- `substack.com` public profile API, only when you add a Substack `@handle`, to resolve it to its publication;
- the image and media URLs contained in the items you import (for example `substackcdn.com` for Substack images), and only when you have enabled image or media download.

It contacts no other servers. There is no maintainer endpoint, no analytics host, and no third-party SDK.

## Data collection

- **No personal data is collected.** The plugin does not collect names, email addresses, file contents, or usage statistics.
- **No telemetry or analytics.** There is no tracking, crash reporting, or phone-home behavior of any kind.
- **No automatic background activity.** The plugin acts only when you explicitly add a feed or run an import.

## Data storage

- The plugin's settings (your feed list, destination folders, and per-feed options) and the dismissed-item list are stored by Obsidian in your vault's local `data.json` file, on your own device.
- Imported notes and any downloaded images are written into your vault, on your own device.
- Nothing is stored outside your vault.

## Third parties

The plugin shares no data with any third party. The only outbound traffic is the feed and asset requests described above, which go to the hosts you chose by adding those feeds.

## Disclaimer of liability

The plugin is provided free of charge, "AS IS", without warranty of any kind, as set out in the [MIT License](./LICENSE). To the maximum extent permitted by law, the maintainer is not liable for any loss, damage, or claim arising from use of the plugin.

## Information you choose to share

If you open a GitHub issue, discussion, or pull request, anything you paste there (note contents, screenshots, vault structure, system details) becomes **public**. The maintainer does not request this information and is not responsible for content you choose to post. Review and redact anything sensitive before submitting. To report a security vulnerability privately instead, see [SECURITY.md](./SECURITY.md).

## Changes to this policy

This policy may be updated as the plugin evolves. Material changes will be noted in [CHANGELOG.md](./CHANGELOG.md). The "last updated" date above reflects the current version.

## Contact

Questions about this policy: open an issue at [github.com/ckelsoe/obsidian-rss-importer/issues](https://github.com/ckelsoe/obsidian-rss-importer/issues). Do not use a public issue for security vulnerabilities; see [SECURITY.md](./SECURITY.md) for the private reporting channel.
