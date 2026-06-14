/**
 * Generic RSS / Atom / podcast feed source.
 *
 * Handles any feed that is not a Substack: a plain RSS or Atom feed, or a
 * podcast feed. Resolution defers to the shared `FeedResolver` (injected, or a
 * default one wrapping the same fetcher). Enumeration and mapping defer to the
 * shared helpers in `source-common`, so this class stays a thin source-specific
 * shell around the common machinery.
 *
 * A generic feed already carries the body for each item in the feed XML
 * (content:encoded for articles, the description for podcast show-notes), so
 * `fetchBody` is a no-op: there is nothing more to fetch. We deliberately do NOT
 * refetch and scrape arbitrary article HTML; that is out of scope and would hit
 * a different host per item.
 */

import type {
	FeedItem,
	FeedSource,
	HttpFetcher,
	ListItemsOptions,
	ResolvedFeed,
	SourceType,
} from "./feed-source";
import { FeedResolver } from "./feed-resolver";
import {
	applyLimit,
	buildResolvedFeed,
	fetchAndParseFeed,
	mapRawItemToFeedItem,
} from "./source-common";

/** Constructor dependencies. `resolver` defaults to one wrapping `fetcher`. */
export interface GenericRssFeedSourceDeps {
	fetcher: HttpFetcher;
	resolver?: FeedResolver;
}

export class GenericRssFeedSource implements FeedSource {
	readonly type: SourceType = "generic";

	private readonly fetcher: HttpFetcher;
	private readonly resolver: FeedResolver;

	constructor(deps: GenericRssFeedSourceDeps) {
		this.fetcher = deps.fetcher;
		this.resolver = deps.resolver ?? new FeedResolver(deps.fetcher);
	}

	/**
	 * Classify and canonicalize `input`, then fetch the feed once to build the
	 * preview record (publication title, sample titles, author hint).
	 */
	async resolve(input: string): Promise<ResolvedFeed> {
		const resolved = await this.resolver.resolve(input);
		const parsed = await fetchAndParseFeed(this.fetcher, resolved.feedUrl);
		return buildResolvedFeed(resolved, parsed);
	}

	/**
	 * Fetch the feed and map every item onto the normalized `FeedItem` shape,
	 * honoring `opts.limit`. The base mapping pulls the body fallback
	 * (content:encoded, else description), so generic items usually carry their
	 * `contentHtml` inline, but it stays null when the feed provides no body.
	 */
	async listItems(feed: ResolvedFeed, opts?: ListItemsOptions): Promise<FeedItem[]> {
		const parsed = await fetchAndParseFeed(this.fetcher, feed.feedUrl);
		const items = parsed.items.map((raw) => mapRawItemToFeedItem(raw, feed.feedId));
		return applyLimit(items, opts?.limit);
	}

	/**
	 * Generic feeds carry the full body inline (content:encoded or the show-notes
	 * description), so the item produced by `listItems` is already complete.
	 * Returns it unchanged rather than refetching arbitrary remote HTML.
	 */
	async fetchBody(item: FeedItem): Promise<FeedItem> {
		return item;
	}
}
