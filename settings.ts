/**
 * Settings shape for RSS Importer, shared by the plugin class and the settings
 * tab. Persisted via Obsidian's loadData/saveData into the vault's data.json.
 *
 * Per-feed values default from the global defaults and can be overridden per
 * feed (the optional fields on FeedConfig). The dismissed map lives here too
 * because dismissed items have no note to carry the state.
 */

import type { SourceType } from './feed-source';
import type { DismissedMap } from './dismiss-store';
import type { TagDestination } from './note-writer';
import type { CleanupConfig } from './cleanup';

export type ImagesMode = 'link' | 'download';
export type DuplicatePolicy = 'skip' | 'overwrite' | 'prompt';

/**
 * Where downloaded media (podcast audio/video enclosures) is written. "vault"
 * writes into a subfolder of the feed's destination folder; "outside" writes to
 * an absolute filesystem path (desktop only) so large media stays out of the
 * synced vault.
 */
export type MediaLocation = 'vault' | 'outside';

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
	downloadMedia?: boolean;
	mediaLocation?: MediaLocation;
	mediaSubfolder?: string;
	mediaOutsideFolder?: string;
	/**
	 * Promo-host substrings for this feed's deterministic cleanup. Overrides the
	 * global default outright (it is not merged) when present.
	 */
	cleanupLinkHosts?: string[];
	/** Whether this feed trims everything after the last horizontal rule. */
	cleanupTrimAfterLastRule?: boolean;
}

/**
 * True when a stored value is a usable FeedConfig. data.json is user-editable,
 * so a feed from a corrupt or hand-edited file can be null, a primitive, or
 * missing required fields; loadSettings drops the ones that fail this so a bad
 * entry cannot throw later (an `in` check on null, `publicationTitle.length`,
 * `destinationFolder.trim()`).
 */
export function isValidFeedConfig(value: unknown): value is FeedConfig {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const f = value as Record<string, unknown>;
	return (
		typeof f['feedId'] === 'string' &&
		(f['sourceType'] === 'substack' || f['sourceType'] === 'generic') &&
		typeof f['feedUrl'] === 'string' &&
		typeof f['canonicalHost'] === 'string' &&
		typeof f['publicationTitle'] === 'string' &&
		(typeof f['author'] === 'string' || f['author'] === null) &&
		typeof f['destinationFolder'] === 'string' &&
		Array.isArray(f['tags']) &&
		f['tags'].every((t: unknown) => typeof t === 'string') &&
		typeof f['tagNamespace'] === 'string' &&
		typeof f['importSourceTags'] === 'boolean' &&
		typeof f['enabled'] === 'boolean' &&
		typeof f['addedAt'] === 'string' &&
		(typeof f['lastImportedAt'] === 'string' ||
			f['lastImportedAt'] === null)
	);
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
	/** Download podcast/audio/video enclosures, not just link them. */
	downloadMedia: boolean;
	/** Where downloaded media is written: a vault subfolder or an outside path. */
	mediaLocation: MediaLocation;
	/** Subfolder (under the feed's destination) for media when mediaLocation is "vault". */
	mediaSubfolder: string;
	/** Absolute filesystem folder for media when mediaLocation is "outside" (desktop only). */
	mediaOutsideFolder: string;
	/** Where feed tags are written: a plain "feed-tags" property or Obsidian "tags". */
	tagDestination: TagDestination;
	/**
	 * Default promo-host substrings for deterministic cleanup. Empty by default;
	 * a feed with no override inherits this list.
	 */
	cleanupLinkHosts: string[];
	/** Default for trimming everything after the last horizontal rule. */
	cleanupTrimAfterLastRule: boolean;
	debug: boolean;
	showRibbonIcon: boolean;
	ribbonIcon: string;
	/** Dismissed items per feed: feedId -> array of feed-item-id. */
	dismissed: DismissedMap;
}

export const DEFAULT_SETTINGS: RssImporterSettings = {
	feeds: [],
	defaultParentFolder: 'Feeds',
	noteNameTemplate: '{{date}} {{title}}',
	duplicatePolicy: 'skip',
	requestDelayMs: 1200,
	imagesMode: 'link',
	imageSubfolder: 'images',
	downloadMedia: false,
	mediaLocation: 'vault',
	mediaSubfolder: 'media',
	mediaOutsideFolder: '',
	tagDestination: 'feed-tags',
	cleanupLinkHosts: [],
	cleanupTrimAfterLastRule: false,
	debug: false,
	showRibbonIcon: true,
	ribbonIcon: 'rss',
	dismissed: {},
};

/** Minimum and maximum for the inter-request delay (ms). */
export const REQUEST_DELAY_MIN = 500;
export const REQUEST_DELAY_MAX = 5000;

/** Resolves the effective images mode for a feed (per-feed override or default). */
export function effectiveImagesMode(
	feed: FeedConfig,
	settings: RssImporterSettings,
): ImagesMode {
	return feed.imagesMode ?? settings.imagesMode;
}

/** Resolves the effective note-name template for a feed. */
export function effectiveNoteNameTemplate(
	feed: FeedConfig,
	settings: RssImporterSettings,
): string {
	return feed.noteNameTemplate ?? settings.noteNameTemplate;
}

/** Resolves the effective image subfolder name for a feed. */
export function effectiveImageSubfolder(
	feed: FeedConfig,
	settings: RssImporterSettings,
): string {
	return feed.imageSubfolder ?? settings.imageSubfolder;
}

/** Resolves whether media is downloaded for a feed (per-feed override or default). */
export function effectiveDownloadMedia(
	feed: FeedConfig,
	settings: RssImporterSettings,
): boolean {
	return feed.downloadMedia ?? settings.downloadMedia;
}

/** Resolves the effective media location for a feed. */
export function effectiveMediaLocation(
	feed: FeedConfig,
	settings: RssImporterSettings,
): MediaLocation {
	return feed.mediaLocation ?? settings.mediaLocation;
}

/** Resolves the effective media subfolder name for a feed. */
export function effectiveMediaSubfolder(
	feed: FeedConfig,
	settings: RssImporterSettings,
): string {
	return feed.mediaSubfolder ?? settings.mediaSubfolder;
}

/** Resolves the effective outside (absolute) media folder for a feed. */
export function effectiveMediaOutsideFolder(
	feed: FeedConfig,
	settings: RssImporterSettings,
): string {
	return feed.mediaOutsideFolder ?? settings.mediaOutsideFolder;
}

/** Resolves the effective cleanup promo-host list for a feed (override or default). */
export function effectiveCleanupLinkHosts(
	feed: FeedConfig,
	settings: RssImporterSettings,
): string[] {
	return feed.cleanupLinkHosts ?? settings.cleanupLinkHosts;
}

/** Resolves whether a feed trims everything after the last horizontal rule. */
export function effectiveCleanupTrimAfterLastRule(
	feed: FeedConfig,
	settings: RssImporterSettings,
): boolean {
	return feed.cleanupTrimAfterLastRule ?? settings.cleanupTrimAfterLastRule;
}

/** Build the concrete CleanupConfig for a feed from its effective settings. */
export function buildCleanupConfig(
	feed: FeedConfig,
	settings: RssImporterSettings,
): CleanupConfig {
	return {
		linkHosts: effectiveCleanupLinkHosts(feed, settings),
		trimAfterLastRule: effectiveCleanupTrimAfterLastRule(feed, settings),
	};
}

/** True when a cleanup config has at least one active rule (worth running). */
export function cleanupHasRules(config: CleanupConfig): boolean {
	return (
		config.trimAfterLastRule ||
		config.linkHosts.some((host) => host.trim().length > 0)
	);
}
