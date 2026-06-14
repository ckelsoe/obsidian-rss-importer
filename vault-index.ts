// Vault scanner that surfaces which feed items already have a note in the
// configured destination folder. The import modal uses this to render an
// "imported" badge on each item row. Re-importing remains possible: the badge
// is purely informational and never blocks the existing duplicate-policy flow.
//
// Implementation notes:
// - We rely on Obsidian's `metadataCache`, which keeps a parsed YAML
//   frontmatter view of every markdown file in the vault. This is far cheaper
//   than reading file bytes ourselves, and the cache is already warm by the
//   time the import modal opens. This module NEVER reads file bytes.
// - The scan is limited to files under the configured destination folder.
//   Notes that live elsewhere (older imports written to a different folder,
//   hand-moved files) are intentionally NOT discovered. Scanning every
//   markdown file in the vault would bloat the badge logic and surface stale
//   matches the writer would not actually clash with anyway.
// - Returned data is a flat Map keyed by feed-item id. If the same
//   `feed-item-id` appears in multiple files (a legacy duplication bug or a
//   user copy-paste), the LAST entry wins; this is fine for the badge use-case
//   because the writer's collision check already refuses to silently overwrite
//   a note that belongs to a different item.
//
// This module takes plain structural interfaces (`AppLike`, `FileLike`) rather
// than importing Obsidian's runtime classes, so it can be unit-tested in the
// node jest environment with plain-object fakes.

import { FRONTMATTER_KEYS } from "./feed-source";

/** Minimal view of a markdown file: only the vault-relative path is needed. */
export interface FileLike {
	readonly path: string;
}

/** Minimal view of a cached file's parsed frontmatter. */
export interface FileCacheLike {
	readonly frontmatter?: unknown;
}

/**
 * Minimal view of the Obsidian `App` surface this scanner needs. The real
 * `App` satisfies this structurally, so callers pass the live app; tests pass
 * a plain fake. Keeping the surface this narrow keeps the module pure.
 */
export interface AppLike {
	readonly vault: {
		getMarkdownFiles(): FileLike[];
	};
	readonly metadataCache: {
		getFileCache(file: FileLike): FileCacheLike | null;
	};
}

/**
 * Lightweight pointer back to an imported note. The path is the only
 * load-bearing field: click-through uses it. `feedSource` is captured for
 * future "which feed wrote this" disambiguation but is optional.
 */
export interface ImportedRecord {
	readonly path: string;
	readonly feedSource?: string;
}

/**
 * Build a map of `feed-item-id` to existing note location by scanning the
 * configured destination folder. Caller invokes this once per modal open (and
 * again after every successful import) so the badge state stays in sync without
 * re-reading files.
 *
 * Folder filter rules:
 * - `''` (vault root) matches every markdown file at depth 0 and below.
 * - A nested folder matches itself and all descendants (`folder/sub/...`).
 * - Files outside the folder are skipped.
 *
 * Never throws: a malformed or absent frontmatter entry is silently skipped so
 * a single bad note can never prevent the rest of the index from building.
 * Returns an empty map when the cache has not warmed yet, in which case the
 * modal can call again later if it needs.
 */
export function buildFeedItemIndex(
	app: AppLike,
	destinationFolder: string,
): Map<string, ImportedRecord> {
	const normalized = normalizeFolder(destinationFolder);
	const out = new Map<string, ImportedRecord>();
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		if (!fileIsUnder(file, normalized)) continue;
		const cache = app.metadataCache.getFileCache(file);
		const rawFm: unknown = cache?.frontmatter;
		if (!isRecord(rawFm)) continue;
		const id = pickFrontmatterString(rawFm[FRONTMATTER_KEYS.feedItemId]);
		if (id === undefined) continue;
		const record: ImportedRecord = {
			path: file.path,
			feedSource: pickFrontmatterString(rawFm[FRONTMATTER_KEYS.feedSource]),
		};
		out.set(id, record);
	}
	return out;
}

// Strip surrounding whitespace and any leading/trailing slashes so the prefix
// match below is unambiguous regardless of how the folder was configured.
function normalizeFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, "");
}

function fileIsUnder(file: FileLike, folder: string): boolean {
	if (folder === "") {
		return true;
	}
	const prefix = `${folder}/`;
	return file.path.startsWith(prefix);
}

// YAML frontmatter values can be parsed as strings or as numbers depending on
// shape. Only accept strings (after trim plus non-empty check); reject
// everything else so badge state never depends on an ambiguous coercion.
function pickFrontmatterString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
