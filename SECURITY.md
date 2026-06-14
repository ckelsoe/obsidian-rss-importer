# Security Policy

## Supported Versions

Only the latest published version of RSS Importer receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in RSS Importer, please report it **privately** so it can be fixed before public disclosure:

1. **DO NOT** open a public GitHub issue for security vulnerabilities.
2. Open the repository's **Security** tab and click **Report a vulnerability**, or use this direct link: <https://github.com/ckelsoe/obsidian-rss-importer/security/advisories/new>
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

Reports submitted through GitHub private vulnerability reporting are visible only to you and the maintainer until an advisory is published.

### What to expect:

- Acknowledgment within 48 hours
- Assessment and response within 7 days
- Security patch released as soon as possible
- Credit given to reporter (unless you prefer to remain anonymous)

## Security Considerations

What RSS Importer does and does not do, relevant to security:

- **Network access.** The plugin makes outbound HTTP requests through Obsidian's `requestUrl` API. It contacts only the feed hosts you configure, the redirect targets those hosts return, the `substack.com` public profile API (when you add a Substack handle), and the image or media URLs referenced by the items you import (when you enable downloads). It contacts no maintainer server and includes no analytics or telemetry.
- **File reads.** It reads note frontmatter under your destination folder through Obsidian's metadata cache (for deduplication) and reads an existing note at a target path before overwriting it (collision check). It does not read other files in your vault.
- **File writes.** It writes imported notes and, optionally, downloaded images into your vault using the Obsidian vault API (`vault.create`, `vault.process`, `vault.createBinary`). Overwrites use `vault.process` rather than `vault.modify`. It writes nothing outside your vault.
- **No code execution.** The plugin runs no external commands, spawns no processes, and does not use `eval`. Remote HTML is converted to Markdown text; it is never executed. DOM is built with the Obsidian element API, never `innerHTML`.
- **Desktop only.** The plugin is marked desktop-only.
- **No credentials in this version.** Importing free and public feeds requires no login or token. (A later release adds optional Substack paid-post access using your own session cookie, stored in Obsidian's `SecretStorage` and sent only to your configured Substack hosts; this section will be expanded when that ships.)
