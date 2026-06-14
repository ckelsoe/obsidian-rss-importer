/**
 * The central contract for RSS Importer.
 *
 * Every source produces a normalized `FeedItem`. Everything downstream (the
 * HTML converter, note writer, dedup index, import modal, dismissed state)
 * consumes the normalized item and behaves the same regardless of where the
 * item came from. Source-specific behavior lives behind the `FeedSource`
 * interface.
 *
 * This file is the conceptual anchor: keep it small, keep it stable, and let
 * the rest of the plugin key off these types rather than re-deriving them.
 */

/** Whether an item reads as an article (text body) or a podcast (audio enclosure). */
export type FeedItemKind = "article" | "podcast";

/** Access tier for an item. `unknown` is the honest default for generic feeds. */
export type FeedAudience = "free" | "paid" | "unknown";

/** Which source implementation handles a feed. */
export type SourceType = "substack" | "generic";

/**
 * A single feed item, normalized across all sources.
 *
 * A generic source fills what it can (`section` null, `audience` "free" or
 * "unknown", `id` from the item guid or link). The Substack source fills
 * `audience`/`section` from the JSON API and `id` from the numeric post id.
 * `contentHtml` is null until `fetchBody` populates it.
 */
export interface FeedItem {
	/** The configured feed this item came from (its stable feed id). */
	sourceId: string;
	/**
	 * Stable identity used for dedup. Substack: numeric post id, else the
	 * canonical `/p/<slug>` URL. Generic: item `<guid>`, else `<link>`.
	 */
	id: string;
	/** Canonical permalink. */
	url: string;
	title: string;
	author: string | null;
	/** ISO 8601 timestamp, or null when the feed omits a date. */
	publishedAt: string | null;
	kind: FeedItemKind;
	/**
	 * Full body (free) or teaser (paid). Null until `fetchBody` runs, and may
	 * still be null afterwards when the feed provides no body for the item.
	 * Callers must handle null (treat it as an empty body).
	 */
	contentHtml: string | null;
	/** True when the body is a paywalled teaser rather than a complete post. */
	isTruncated: boolean;
	audience: FeedAudience;
	/** Tags carried by the item itself (Substack postTags, RSS `<category>`). */
	tags: string[];
	/** Substack `section_name`; null for generic sources. */
	section: string | null;
	/** Podcast/audio/video enclosure URL, when present. */
	mediaUrl: string | null;
	/** Enclosure MIME type (audio/mpeg, audio/mp4, video/mp4, ...). Not assumed. */
	mediaType: string | null;
	/** Enclosure size in bytes when advertised. */
	mediaBytes: number | null;
}

/**
 * The result of resolving a user-supplied input (handle, subdomain, custom
 * domain, post URL, or a plain feed URL) to a canonical, fetchable feed plus
 * the metadata needed to preview it before commit and to store the feed record.
 */
export interface ResolvedFeed {
	sourceType: SourceType;
	/** Stable feed id derived from the canonical host. */
	feedId: string;
	/** Canonical host the feed and any API calls resolve to. */
	canonicalHost: string;
	/** Canonical feed URL items are enumerated from. */
	feedUrl: string;
	publicationTitle: string;
	author: string | null;
	/** A few recent item titles for the add-feed preview card. */
	sampleTitles: string[];
	/** Best-effort free/paid hint for the preview; not authoritative. */
	audienceHint: FeedAudience;
}

/** Options for enumerating items. The MVP uses the RSS window (~20 items). */
export interface ListItemsOptions {
	/** Soft cap on items to enumerate. Sources may return fewer. */
	limit?: number;
	/**
	 * Soft paging offset for archive backfill. `undefined` or 0 means the recent
	 * RSS window (the default current behavior). A value > 0 asks the source to
	 * page back into older items beyond the RSS window. Only sources with an
	 * archive API (Substack) honor this; sources without one return no items for
	 * a positive offset.
	 */
	offset?: number;
}

/**
 * A feed source. `resolve` classifies and canonicalizes an input; `listItems`
 * enumerates available items (bodies may be absent); `fetchBody` attempts to
 * populate the item's `contentHtml` (full body when entitled, teaser otherwise).
 * `contentHtml` may still be null after `fetchBody` when the feed provides no
 * body for the item, so callers must handle a null body.
 */
export interface FeedSource {
	readonly type: SourceType;
	resolve(input: string): Promise<ResolvedFeed>;
	listItems(feed: ResolvedFeed, opts?: ListItemsOptions): Promise<FeedItem[]>;
	fetchBody(item: FeedItem): Promise<FeedItem>;
}

/**
 * HTTP abstraction over Obsidian's `requestUrl`. Sources, the resolver, and the
 * pacer depend on this rather than on `requestUrl` directly, so they can be
 * unit-tested with a stub fetcher. The concrete adapter (in main.ts) calls
 * `requestUrl` with `throw:false` and a SyntaxError-only `safeJson` guard.
 */
export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	/** Response headers, lowercased keys not guaranteed; match case-insensitively. */
	headers: Record<string, string>;
	/** Parsed JSON, or null when the body is not valid JSON (SyntaxError-guarded). */
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
}

export type HttpFetcher = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * Frontmatter keys written on every imported note. The dedup index and the note
 * writer share these constants so identity matching never drifts between the
 * reader and the writer. `feedItemId` is the dedup key.
 */
export const FRONTMATTER_KEYS = {
	feedSource: "feed-source",
	feedItemId: "feed-item-id",
	url: "url",
	title: "title",
	author: "author",
	date: "date",
	tags: "tags",
} as const;
