/** @jest-environment jsdom */

import { readFileSync } from "fs";
import { join } from "path";

import type { HttpFetcher, HttpResponse, ResolvedFeed } from "../feed-source";
import { FeedResolver } from "../feed-resolver";
import { GenericRssFeedSource } from "../source-generic";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * A fetcher that returns the same feed XML body for every request, with a feed
 * content-type so the resolver's probe accepts it. Records the URLs requested.
 */
function feedFetcher(body: string): { fetcher: HttpFetcher; urls: string[] } {
	const urls: string[] = [];
	const fetcher: HttpFetcher = (req) => {
		urls.push(req.url);
		const response: HttpResponse = {
			status: 200,
			headers: { "Content-Type": "application/rss+xml" },
			json: null,
			text: body,
			arrayBuffer: new ArrayBuffer(0),
		};
		return Promise.resolve(response);
	};
	return { fetcher, urls };
}

function buildSource(body: string): GenericRssFeedSource {
	const { fetcher } = feedFetcher(body);
	return new GenericRssFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
}

describe("GenericRssFeedSource", () => {
	it("declares its source type", () => {
		expect(buildSource(fixture("generic-multi.xml")).type).toBe("generic");
	});

	it("resolve() builds a ResolvedFeed with publicationTitle and sampleTitles", async () => {
		const source = buildSource(fixture("generic-multi.xml"));
		const feed = await source.resolve("https://www.thegodjourney.com/feed");

		expect(feed.sourceType).toBe("generic");
		expect(feed.publicationTitle).toBe("The God Journey");
		expect(feed.feedId).toBe("www.thegodjourney.com");
		expect(feed.sampleTitles).toContain("Patriarchy diminishes us all (#1039)");
		expect(feed.sampleTitles).toContain("A plain article with no enclosure");
	});

	it("listItems() maps a podcast item to kind 'podcast' with a mediaUrl", async () => {
		const source = buildSource(fixture("generic-multi.xml"));
		const feed: ResolvedFeed = {
			sourceType: "generic",
			feedId: "www.thegodjourney.com",
			canonicalHost: "www.thegodjourney.com",
			feedUrl: "https://www.thegodjourney.com/feed",
			publicationTitle: "The God Journey",
			author: "Wayne Jacobsen",
			sampleTitles: [],
			audienceHint: "unknown",
		};
		const items = await source.listItems(feed);

		expect(items).toHaveLength(2);
		const podcast = items[0];
		expect(podcast?.kind).toBe("podcast");
		expect(podcast?.mediaUrl).toBe(
			"https://media.blubrry.com/the_god_journey/www.thegodjourney.com/audio/2026/260612.mp3",
		);
		expect(podcast?.mediaType).toBe("audio/mpeg");
		expect(podcast?.sourceId).toBe("www.thegodjourney.com");

		const article = items[1];
		expect(article?.kind).toBe("article");
		expect(article?.mediaUrl).toBeNull();
		// content:encoded wins over description for the article body.
		expect(article?.contentHtml).toContain("full article body lives in content:encoded");
	});

	it("listItems() respects opts.limit", async () => {
		const source = buildSource(fixture("generic-multi.xml"));
		const feed: ResolvedFeed = {
			sourceType: "generic",
			feedId: "www.thegodjourney.com",
			canonicalHost: "www.thegodjourney.com",
			feedUrl: "https://www.thegodjourney.com/feed",
			publicationTitle: "The God Journey",
			author: null,
			sampleTitles: [],
			audienceHint: "unknown",
		};
		const items = await source.listItems(feed, { limit: 1 });
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("Patriarchy diminishes us all (#1039)");
	});

	it("listItems() with a positive offset returns no items (no archive paging)", async () => {
		const { fetcher, urls } = feedFetcher(fixture("generic-multi.xml"));
		const source = new GenericRssFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const feed: ResolvedFeed = {
			sourceType: "generic",
			feedId: "www.thegodjourney.com",
			canonicalHost: "www.thegodjourney.com",
			feedUrl: "https://www.thegodjourney.com/feed",
			publicationTitle: "The God Journey",
			author: null,
			sampleTitles: [],
			audienceHint: "unknown",
		};
		const items = await source.listItems(feed, { offset: 20, limit: 12 });
		// Generic feeds expose no archive, so a backfill request yields nothing and
		// makes no fetch (it short-circuits before touching the feed URL).
		expect(items).toEqual([]);
		expect(urls).toHaveLength(0);
	});

	it("fetchBody() returns the already-populated item unchanged", async () => {
		const source = buildSource(fixture("generic-multi.xml"));
		const feed: ResolvedFeed = {
			sourceType: "generic",
			feedId: "www.thegodjourney.com",
			canonicalHost: "www.thegodjourney.com",
			feedUrl: "https://www.thegodjourney.com/feed",
			publicationTitle: "The God Journey",
			author: null,
			sampleTitles: [],
			audienceHint: "unknown",
		};
		const items = await source.listItems(feed);
		const article = items[1];
		if (article === undefined) {
			throw new Error("expected an article item");
		}
		const fetched = await source.fetchBody(article);
		expect(fetched).toBe(article);
		expect(fetched.contentHtml).toBe(article.contentHtml);
	});

	it("does not refetch a remote article URL in fetchBody()", async () => {
		const { fetcher, urls } = feedFetcher(fixture("generic-multi.xml"));
		const source = new GenericRssFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const feed: ResolvedFeed = {
			sourceType: "generic",
			feedId: "www.thegodjourney.com",
			canonicalHost: "www.thegodjourney.com",
			feedUrl: "https://www.thegodjourney.com/feed",
			publicationTitle: "The God Journey",
			author: null,
			sampleTitles: [],
			audienceHint: "unknown",
		};
		const items = await source.listItems(feed);
		const before = urls.length;
		const article = items[1];
		if (article === undefined) {
			throw new Error("expected an article item");
		}
		await source.fetchBody(article);
		// fetchBody made no additional network call.
		expect(urls.length).toBe(before);
	});
});
