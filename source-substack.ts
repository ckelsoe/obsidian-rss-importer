/**
 * Substack feed source.
 *
 * For the MVP this reads a publication's public RSS at `/feed`. Free post bodies
 * arrive complete in content:encoded; paid posts arrive as teasers wrapped in
 * Substack's structural paywall containers. The base mapping (shared with the
 * generic source) produces the normalized item; this source then runs the
 * structural paywall detector over each item body to set `audience` and
 * `isTruncated`. `section` stays null: the RSS feed carries no section, that is
 * the JSON API, which a later release adds.
 *
 * Resolution defers to the shared `FeedResolver`, which already knows how to turn
 * a handle, subdomain, post URL, or custom domain into the canonical `/feed`
 * URL. Enumeration and base mapping defer to `source-common`.
 *
 * R2 will add the `/api/v1` plus cookie path inside `fetchBody` to fetch the
 * full body of paid posts the reader is entitled to. For the MVP `fetchBody`
 * just re-runs the paywall pass and returns the (already populated) item.
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
import { detectPaywall } from "./paywall-detector";
import {
	applyLimit,
	buildResolvedFeed,
	fetchAndParseFeed,
	mapRawItemToFeedItem,
} from "./source-common";

/** Constructor dependencies. `resolver` defaults to one wrapping `fetcher`. */
export interface SubstackFeedSourceDeps {
	fetcher: HttpFetcher;
	resolver?: FeedResolver;
}

/**
 * Run the structural paywall pass over an item's body and return a copy with
 * `audience` and `isTruncated` resolved. RSS carries no source audience field,
 * so we pass `audienceField: null` and let the detector key off body structure
 * alone (a paywall wrapper present means the body is a teaser). The rest of the
 * item is preserved.
 */
function applyPaywallPass(item: FeedItem): FeedItem {
	const verdict = detectPaywall({ audienceField: null, bodyHtml: item.contentHtml });
	return {
		...item,
		audience: verdict.audience,
		isTruncated: verdict.isTruncated,
	};
}

export class SubstackFeedSource implements FeedSource {
	readonly type: SourceType = "substack";

	private readonly fetcher: HttpFetcher;
	private readonly resolver: FeedResolver;

	constructor(deps: SubstackFeedSourceDeps) {
		this.fetcher = deps.fetcher;
		this.resolver = deps.resolver ?? new FeedResolver(deps.fetcher);
	}

	/**
	 * Classify and canonicalize `input`, then fetch the feed once to build the
	 * preview record.
	 */
	async resolve(input: string): Promise<ResolvedFeed> {
		const resolved = await this.resolver.resolve(input);
		const parsed = await fetchAndParseFeed(this.fetcher, resolved.feedUrl);
		return buildResolvedFeed(resolved, parsed);
	}

	/**
	 * Fetch the feed, map each item onto the normalized shape, then run the
	 * paywall pass so free posts read as complete bodies and paid teasers come
	 * back with `isTruncated` true. Honors `opts.limit`.
	 */
	async listItems(feed: ResolvedFeed, opts?: ListItemsOptions): Promise<FeedItem[]> {
		const parsed = await fetchAndParseFeed(this.fetcher, feed.feedUrl);
		const items = parsed.items.map((raw) => {
			const base = mapRawItemToFeedItem(raw, feed.feedId);
			return applyPaywallPass(base);
		});
		return applyLimit(items, opts?.limit);
	}

	/**
	 * For the MVP the RSS content:encoded already holds the full free body, so
	 * there is nothing more to fetch. Re-run the paywall pass (idempotent) and
	 * return the item. R2 replaces this with the `/api/v1` plus cookie path for
	 * fetching entitled paid bodies.
	 */
	async fetchBody(item: FeedItem): Promise<FeedItem> {
		return applyPaywallPass(item);
	}
}
