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

/** A JSON fetcher that returns a per-URL response, recording requested URLs. */
function jsonFetcher(byUrl: Record<string, unknown>): { fetcher: HttpFetcher; urls: string[] } {
	const urls: string[] = [];
	const fetcher: HttpFetcher = (req) => {
		urls.push(req.url);
		const json = req.url in byUrl ? byUrl[req.url] : null;
		const response: HttpResponse = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			json,
			text: JSON.stringify(json),
			arrayBuffer: new ArrayBuffer(0),
		};
		return Promise.resolve(response);
	};
	return { fetcher, urls };
}

/** A minimal archive list payload: a free article and a paid podcast. */
const ARCHIVE_PAGE: unknown = [
	{
		id: 101,
		slug: "older-free-post",
		title: "An older free post",
		post_date: "2025-01-15T10:00:00.000Z",
		canonical_url: "https://jonathanmclernon.substack.com/p/older-free-post",
		audience: "everyone",
		type: "newsletter",
		section_name: "Essays",
		postTags: [{ name: "faith" }, { name: "habits" }],
		publishedBylines: [{ name: "Jonathan McLernon" }],
	},
	{
		id: 102,
		slug: "older-paid-pod",
		title: "An older paid podcast",
		post_date: "2025-01-10T10:00:00.000Z",
		canonical_url: "https://jonathanmclernon.substack.com/p/older-paid-pod",
		audience: "only_paid",
		type: "podcast",
		section_name: null,
		postTags: [],
		publishedBylines: [{ name: "Jonathan McLernon" }],
	},
];

const ARCHIVE_URL =
	"https://jonathanmclernon.substack.com/api/v1/archive?sort=new&limit=12&offset=20";

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

	it("listItems() with a positive offset pages the JSON archive", async () => {
		const { fetcher, urls } = jsonFetcher({ [ARCHIVE_URL]: ARCHIVE_PAGE });
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED, { offset: 20, limit: 12 });

		// The archive page, not the RSS /feed, was fetched.
		expect(urls).toContain(ARCHIVE_URL);
		expect(urls.some((u) => u.endsWith("/feed"))).toBe(false);
		expect(items).toHaveLength(2);
	});

	it("maps an archive post: numeric id, audience, section, null body", async () => {
		const { fetcher } = jsonFetcher({ [ARCHIVE_URL]: ARCHIVE_PAGE });
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED, { offset: 20, limit: 12 });

		const free = items[0];
		expect(free?.id).toBe("101");
		expect(free?.title).toBe("An older free post");
		expect(free?.url).toBe("https://jonathanmclernon.substack.com/p/older-free-post");
		expect(free?.author).toBe("Jonathan McLernon");
		expect(free?.publishedAt).toBe("2025-01-15T10:00:00.000Z");
		expect(free?.kind).toBe("article");
		expect(free?.audience).toBe("free");
		expect(free?.section).toBe("Essays");
		expect(free?.tags).toEqual(["faith", "habits"]);
		// The archive list omits the body; it is fetched on demand later.
		expect(free?.contentHtml).toBeNull();
		expect(free?.sourceId).toBe("jonathanmclernon.substack.com");

		const paid = items[1];
		expect(paid?.id).toBe("102");
		expect(paid?.kind).toBe("podcast");
		expect(paid?.audience).toBe("paid");
		expect(paid?.section).toBeNull();
		expect(paid?.tags).toEqual([]);
	});

	it("skips archive entries with neither an id nor a canonical url", async () => {
		const malformed: unknown = [
			{ title: "No identity at all" },
			{ id: 7, slug: "kept", title: "Kept", canonical_url: "https://x.test/p/kept" },
		];
		const { fetcher } = jsonFetcher({ [ARCHIVE_URL]: malformed });
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED, { offset: 20, limit: 12 });

		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("7");
	});

	it("fetchBody() on an archive item fetches the post and sets contentHtml", async () => {
		const postUrl = "https://jonathanmclernon.substack.com/api/v1/posts/older-free-post";
		const { fetcher, urls } = jsonFetcher({
			[ARCHIVE_URL]: ARCHIVE_PAGE,
			[postUrl]: { body_html: "<div class=\"body\"><p>The full older free body.</p></div>" },
		});
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED, { offset: 20, limit: 12 });

		const archiveItem = items[0];
		if (archiveItem === undefined) {
			throw new Error("expected an archive item");
		}
		expect(archiveItem.contentHtml).toBeNull();

		const before = urls.length;
		const fetched = await source.fetchBody(archiveItem);
		expect(urls).toContain(postUrl);
		expect(urls.length).toBe(before + 1);
		expect(fetched.contentHtml).toContain("The full older free body");
		// A free body with no paywall wrapper is not truncated.
		expect(fetched.isTruncated).toBe(false);
		expect(fetched.audience).toBe("free");
	});

	it("fetchBody() returns the archive item unchanged when the post fetch fails", async () => {
		const failing: HttpFetcher = (req) => {
			if (req.url.includes("/api/v1/archive")) {
				const response: HttpResponse = {
					status: 200,
					headers: { "Content-Type": "application/json" },
					json: ARCHIVE_PAGE,
					text: JSON.stringify(ARCHIVE_PAGE),
					arrayBuffer: new ArrayBuffer(0),
				};
				return Promise.resolve(response);
			}
			return Promise.reject(new Error("network down"));
		};
		const source = new SubstackFeedSource({ fetcher: failing, resolver: new FeedResolver(failing) });
		const items = await source.listItems(SUBSTACK_FEED, { offset: 20, limit: 12 });
		const archiveItem = items[0];
		if (archiveItem === undefined) {
			throw new Error("expected an archive item");
		}

		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const fetched = await source.fetchBody(archiveItem);
		expect(fetched.contentHtml).toBeNull();
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("fetchBody() on an RSS item makes no archive/post call", async () => {
		const { fetcher, urls } = feedFetcher(fixture("substack-multi.xml"));
		const source = new SubstackFeedSource({ fetcher, resolver: new FeedResolver(fetcher) });
		const items = await source.listItems(SUBSTACK_FEED);
		const free = items[0];
		if (free === undefined) {
			throw new Error("expected the free RSS item");
		}
		expect(free.contentHtml).not.toBeNull();

		const before = urls.length;
		await source.fetchBody(free);
		// An RSS item already carries its body; no extra fetch.
		expect(urls.length).toBe(before);
	});
});
