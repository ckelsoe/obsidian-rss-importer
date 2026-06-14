/** @jest-environment jsdom */

import { readFileSync } from "fs";
import { join } from "path";

import type { HttpFetcher, HttpResponse, ResolvedFeed } from "../feed-source";
import { FeedResolver } from "../feed-resolver";
import { SubstackFeedSource } from "../source-substack";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/** A fetcher that returns the same feed XML for every request. */
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

function buildSource(body: string): SubstackFeedSource {
	const { fetcher } = feedFetcher(body);
	return new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
}

const SUBSTACK_FEED: ResolvedFeed = {
	sourceType: "substack",
	feedId: "jonathanmclernon.substack.com",
	canonicalHost: "jonathanmclernon.substack.com",
	feedUrl: "https://jonathanmclernon.substack.com/feed",
	publicationTitle: "Coach Jon McLernon",
	author: "Jonathan McLernon",
	sampleTitles: [],
	audienceHint: "unknown",
};

describe("SubstackFeedSource", () => {
	it("declares its source type", () => {
		expect(buildSource(fixture("substack-multi.xml")).type).toBe("substack");
	});

	it("resolve() builds a ResolvedFeed with publicationTitle and sampleTitles", async () => {
		const source = buildSource(fixture("substack-multi.xml"));
		const feed = await source.resolve("https://jonathanmclernon.substack.com/feed");

		expect(feed.sourceType).toBe("substack");
		expect(feed.publicationTitle).toBe("Coach Jon McLernon");
		expect(feed.canonicalHost).toBe("jonathanmclernon.substack.com");
		expect(feed.sampleTitles).toEqual([
			"A free post anyone can read",
			"A paid post that only shows a teaser",
		]);
	});

	it("maps a free post to a full body that is not truncated", async () => {
		const source = buildSource(fixture("substack-multi.xml"));
		const items = await source.listItems(SUBSTACK_FEED);
		const free = items[0];

		expect(free?.title).toBe("A free post anyone can read");
		expect(free?.contentHtml).toContain("complete free body of the post");
		expect(free?.isTruncated).toBe(false);
		expect(free?.section).toBeNull();
	});

	it("flags a paid teaser body as truncated via the paywall detector", async () => {
		const source = buildSource(fixture("substack-multi.xml"));
		const items = await source.listItems(SUBSTACK_FEED);
		const paid = items[1];

		expect(paid?.title).toBe("A paid post that only shows a teaser");
		// The teaser body carries the structural paywall/subscription-widget
		// container, which the detector reads as truncation.
		expect(paid?.isTruncated).toBe(true);
	});

	it("falls back to RSS /feed when the input names a subdomain", async () => {
		const { fetcher, urls } = feedFetcher(fixture("substack-multi.xml"));
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const feed = await source.resolve("jonathanmclernon.substack.com");
		expect(feed.feedUrl).toBe("https://jonathanmclernon.substack.com/feed");
		expect(urls.some((u) => u.endsWith("/feed"))).toBe(true);
	});

	it("listItems() respects opts.limit", async () => {
		const source = buildSource(fixture("substack-multi.xml"));
		const items = await source.listItems(SUBSTACK_FEED, { limit: 1 });
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("A free post anyone can read");
	});

	it("fetchBody() re-runs the paywall pass and returns the item without refetching", async () => {
		const { fetcher, urls } = feedFetcher(fixture("substack-multi.xml"));
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED);
		const before = urls.length;

		const paid = items[1];
		if (paid === undefined) {
			throw new Error("expected the paid item");
		}
		const fetched = await source.fetchBody(paid);
		expect(fetched.isTruncated).toBe(true);
		expect(fetched.contentHtml).toBe(paid.contentHtml);
		// No additional network call for the MVP body path.
		expect(urls.length).toBe(before);
	});
});
