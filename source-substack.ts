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
 * Archive backfill: the public RSS `/feed` only carries the ~20 most recent
 * items. To load older items the source pages the undocumented JSON archive at
 * `/api/v1/archive?sort=new&limit=<N>&offset=<M>`. That archive list omits the
 * body, so `fetchBody` then fetches the single post at `/api/v1/posts/<slug>` to
 * fill `contentHtml` on demand. RSS items (offset 0) keep their inline body and
 * skip that extra fetch.
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
	hostAndSlugFromPostUrl,
	mapArchivePayload,
	mapRawItemToFeedItem,
	readPostBodyHtml,
} from "./source-common";

/** Constructor dependencies. `resolver` defaults to one wrapping `fetcher`. */
export interface SubstackFeedSourceDeps {
	fetcher: HttpFetcher;
	resolver?: FeedResolver;
}

/** Default archive page size when a backfill call does not specify `limit`. */
const DEFAULT_ARCHIVE_LIMIT = 12;

/**
 * Run the structural paywall pass over an item's body and return a copy with
 * `audience` and `isTruncated` resolved. The rest of the item is preserved.
 *
 * `audienceField` is the source-reported audience token. RSS carries none, so
 * the RSS path passes null and lets the detector key off body structure alone (a
 * paywall wrapper present means the body is a teaser). The archive path already
 * knows the tier from the archive list and passes it through (the detector's own
 * token sets accept "paid"/"free"), so a paid post whose fetched body is only a
 * teaser still resolves to truncated, and a free post stays free.
 */
function applyPaywallPass(item: FeedItem, audienceField: string | null): FeedItem {
	const verdict = detectPaywall({ audienceField, bodyHtml: item.contentHtml });
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
	 * Enumerate items. With no offset (or offset 0) this reads the recent RSS
	 * window: fetch `/feed`, map each item onto the normalized shape, and run the
	 * paywall pass so free posts read as complete bodies and paid teasers come
	 * back with `isTruncated` true. With a positive offset this pages the JSON
	 * archive instead, for backfilling items older than the RSS window. Honors
	 * `opts.limit` in both modes.
	 */
	async listItems(feed: ResolvedFeed, opts?: ListItemsOptions): Promise<FeedItem[]> {
		const offset = opts?.offset ?? 0;
		if (offset > 0) {
			return this.listArchiveItems(feed, offset, opts?.limit);
		}

		const parsed = await fetchAndParseFeed(this.fetcher, feed.feedUrl);
		const items = parsed.items.map((raw) => {
			const base = mapRawItemToFeedItem(raw, feed.feedId);
			return applyPaywallPass(base, null);
		});
		return applyLimit(items, opts?.limit);
	}

	/**
	 * Page the undocumented JSON archive for items older than the RSS window. The
	 * archive list omits each post's body, so the mapped items carry
	 * `contentHtml` null; `fetchBody` fills it on demand. Parsing is defensive:
	 * a non-array or malformed payload yields no items rather than throwing, and
	 * malformed entries are skipped. Honors `limit` (defaulting to a small page).
	 */
	private async listArchiveItems(
		feed: ResolvedFeed,
		offset: number,
		limit: number | undefined,
	): Promise<FeedItem[]> {
		const pageSize = limit !== undefined && limit > 0 ? limit : DEFAULT_ARCHIVE_LIMIT;
		const url = `https://${feed.canonicalHost}/api/v1/archive?sort=new&limit=${pageSize}&offset=${offset}`;
		const response = await this.fetcher({ url, method: "GET" });
		const items = mapArchivePayload(response.json, feed.feedId, feed.canonicalHost);
		return applyLimit(items, limit);
	}

	/**
	 * Populate an item's body. An RSS item already carries its body inline (the
	 * content:encoded text), so we just re-run the idempotent paywall pass and
	 * return it without a network call. An archive item has `contentHtml` null,
	 * so we fetch the single post at `/api/v1/posts/<slug>`, read `body_html`,
	 * and run the paywall pass over the fetched body to resolve
	 * `audience`/`isTruncated`. On any fetch or parse failure we log and return
	 * the item unchanged (body stays null; the runner treats null as empty).
	 */
	async fetchBody(item: FeedItem): Promise<FeedItem> {
		if (item.contentHtml !== null) {
			// An RSS item: body already inline. RSS carries no source audience
			// field, so the paywall pass keys off body structure (null field).
			return applyPaywallPass(item, null);
		}

		const parts = hostAndSlugFromPostUrl(item.url);
		if (parts === null) {
			// No `/p/<slug>` to fetch from; nothing more we can do.
			return item;
		}

		const url = `https://${parts.host}/api/v1/posts/${encodeURIComponent(parts.slug)}`;
		try {
			const response = await this.fetcher({ url, method: "GET" });
			const bodyHtml = readPostBodyHtml(response.json);
			if (bodyHtml === null) {
				return item;
			}
			// The archive list already reported the tier on the item; pass it
			// through so a paid post whose fetched body is only a teaser still
			// resolves to truncated.
			return applyPaywallPass({ ...item, contentHtml: bodyHtml }, item.audience);
		} catch (err) {
			console.error(err);
			return item;
		}
	}
}
