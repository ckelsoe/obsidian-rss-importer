/**
 * Settings shape for RSS Importer, shared by the plugin class and the settings
 * tab. Persisted via Obsidian's loadData/saveData into the vault's data.json.
 *
 * Per-feed values default from the global defaults and can be overridden per
 * feed (the optional fields on FeedConfig). The dismissed map lives here too
 * because dismissed items have no note to carry the state.
 */

import type { SourceType } from "./feed-source";

export type ImagesMode = "link" | "download";
export type DuplicatePolicy = "skip" | "overwrite" | "prompt";

/** A configured feed and the resolved metadata captured when it was added. */
export interface FeedConfig {
	/** Stable id derived from the canonical host; also the note sourceId. */
	feedId: string;
	sourceType: SourceType;
	/** Canonical feed URL items are enumerated from. */
	feedUrl: string;
	canonicalHost: string;
	publicationTitle: string;
	author: string | null;
	/** Destination folder for this feed's notes. */
	destinationFolder: string;
	/** Feed-level tags applied to every note (plain tags by default). */
	tags: string[];
	/** Optional namespace prefix for tags (empty by default), e.g. "feed/". */
	tagNamespace: string;
	/** Also pull each item's own tags (Substack postTags, RSS categories). */
	importSourceTags: boolean;
	enabled: boolean;
	/** ISO timestamp when the feed was added. */
	addedAt: string;
	/** ISO timestamp of the last successful import, or null. */
	lastImportedAt: string | null;
	// Per-feed overrides (Advanced). Each falls back to the global default.
	imagesMode?: ImagesMode;
	imageSubfolder?: string;
	noteNameTemplate?: string;
}

export interface RssImporterSettings {
	feeds: FeedConfig[];
	// Global defaults (the "Defaults" settings area).
	defaultParentFolder: string;
	noteNameTemplate: string;
	duplicatePolicy: DuplicatePolicy;
	requestDelayMs: number;
	imagesMode: ImagesMode;
	imageSubfolder: string;
	debug: boolean;
	showRibbonIcon: boolean;
	ribbonIcon: string;
	/** Dismissed items per feed: feedId -> array of feed-item-id. */
	dismissed: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: RssImporterSettings = {
	feeds: [],
	defaultParentFolder: "Feeds",
	noteNameTemplate: "{{date}} {{title}}",
	duplicatePolicy: "skip",
	requestDelayMs: 1200,
	imagesMode: "link",
	imageSubfolder: "images",
	debug: false,
	showRibbonIcon: true,
	ribbonIcon: "rss",
	dismissed: {},
};

/** Minimum and maximum for the inter-request delay (ms). */
export const REQUEST_DELAY_MIN = 500;
export const REQUEST_DELAY_MAX = 5000;

/** Resolves the effective images mode for a feed (per-feed override or default). */
export function effectiveImagesMode(feed: FeedConfig, settings: RssImporterSettings): ImagesMode {
	return feed.imagesMode ?? settings.imagesMode;
}

/** Resolves the effective note-name template for a feed. */
export function effectiveNoteNameTemplate(feed: FeedConfig, settings: RssImporterSettings): string {
	return feed.noteNameTemplate ?? settings.noteNameTemplate;
}

/** Resolves the effective image subfolder name for a feed. */
export function effectiveImageSubfolder(feed: FeedConfig, settings: RssImporterSettings): string {
	return feed.imageSubfolder ?? settings.imageSubfolder;
}
