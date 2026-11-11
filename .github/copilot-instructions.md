# Copilot instructions for obsidian-rss-importer

## What this repository is

An [Obsidian](https://obsidian.md) community plugin (TypeScript, esbuild bundle) that imports items from RSS, Atom, podcast and Substack feeds as Markdown notes. Each feed has its own destination folder. It is an importer, not a feed reader. It is desktop only (`isDesktopOnly` is true).

Key facts for a reviewer:

- `feed-source.ts` is the central contract: the normalized `FeedItem`, the `FeedSource` interface, the `HttpFetcher` type and `FRONTMATTER_KEYS`. `source-substack.ts` and `source-generic.ts` implement it.
- All HTTP goes through `HttpFetcher`. Only `main.ts` calls Obsidian's `requestUrl`. Sources, the resolver and the downloaders take the fetcher by injection.
- `FetchPacer` (`fetch-pacer.ts`) runs one request at a time, with a delay between requests and `Retry-After` backoff on HTTP 429.
- Dedup uses the `feed-item-id` frontmatter key. `vault-index.ts` reads it from `metadataCache` under the destination folder and never reads file bytes.
- `note-writer.ts`, `cleanup.ts`, `feed-xml.ts`, `paywall-detector.ts` and `vault-index.ts` do not import `obsidian`. They take structural interfaces so tests can pass plain objects.
- `ImportRunner` (`import-runner.ts`) imports item by item. One bad item is reported in the tally and never aborts the run.

## Build, lint, test

```bash
npm run build   # tsc type-check + esbuild bundle
npm run lint    # eslint (zero warnings), prettier --check, submission pre-check, marketplace type-check
npm test        # Vitest (node environment; obsidian is aliased to __tests__/__mocks__/obsidian.ts)
```

All three must pass. `npm run knip`, `npm run type-coverage` (at least 99%) and `npm run test:mutation` (Stryker) are extra checks.

## Hard rules

- Never `eslint-disable` an `obsidianmd/*` rule. Any other allowed disable carries a `-- reason`.
- No `as any`. No non-null assertions (`x!`). Missing types go in `types.d.ts`.
- No regex lookbehind (`(?<=`, `(?<!`). It stops the plugin loading on iOS before 16.4.
- No bare `moment` imported from `obsidian`. Use `Date` or `Intl`.
- No `!important` in `styles.css`, no inline styles, no `innerHTML` or `outerHTML` writes, no `document.createElement`.
- Use popout-safe DOM: `activeDocument`, `activeWindow`, or the element's own document.
- No `fetch()` for network calls. Use the injected `HttpFetcher`, which wraps `requestUrl`.
- Node built-ins load only through a platform-guarded `require()`, as `media-downloader.ts` does. Never at module top level.
- Writes to an existing note use `vault.process`, never `read` then `modify`.
- Every value read from `data.json` is validated. `loadSettings` in `main.ts` filters feeds with `isValidFeedConfig` and coerces literal-union fields.
- UI strings in sentence case. No "command" in command ids or names. Settings headings never contain "settings", "options", "general" or the plugin name.
- No em dashes in prose or comments.
- Never remove, skip or weaken a test to make CI pass.

## Plugin-specific pitfalls

- Keep `FRONTMATTER_KEYS` the single source for frontmatter key names. The writer and the dedup index must never drift apart.
- Moving or renaming notes inside the destination folder must never cause a re-import.
- `NoteWriter` refuses to overwrite a note whose `feed-item-id` belongs to a different item. Do not weaken that collision check.
- A truncated (paywalled) teaser never overwrites a complete note of the same item.
- Paywall detection and cleanup rules use structural signals only: class names, link hosts, horizontal rules. Never match body prose.
- `applyCleanup` never touches frontmatter and must stay idempotent.
- HTML to Markdown output must be deterministic, so re-importing an unchanged item produces no diff.
- Construct `DOMParser` lazily inside functions, never at module load, so modules load in the node test environment.
- Use `trimChars` and `trimTrailingChars` from `text-trim.ts` instead of anchored `+`/`*` trim regexes.
- The debug logger never records auth headers, cookies or other secrets.
- Writing media outside the vault happens only when the user turns on that setting, and only to the folder they choose.
- README is public: no CI or release internals, no links to private repos.
