/** @jest-environment jsdom */

import { readFileSync } from "fs";
import { join } from "path";

import type { HttpFetcher, HttpRequest, HttpResponse } from "../feed-source";
import { parseFeed } from "../feed-xml";
import type { RawFeedItem } from "../feed-xml";
import type { ResolverResult } from "../feed-resolver";
import {
	applyLimit,
	buildResolvedFeed,
	fetchAndParseFeed,
	FeedFetchError,
	mapRawItemToFeedItem,
} from "../source-common";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

/**
 * A scripted fetcher: returns a fixed body+status for a single expected URL, and
 * records every request it receives so tests can assert on method and URL.
 */
function scriptedFetcher(
	body: string,
	status = 200,
	headers: Record<string, string> = {},
): { fetcher: HttpFetcher; calls: HttpRequest[] } {
	const calls: HttpRequest[] = [];
	const fetcher: HttpFetcher = (req) => {
		calls.push(req);
		const response: HttpResponse = {
			status,
			headers,
			json: null,
			text: body,
			arrayBuffer: new ArrayBuffer(0),
		};
		return Promise.resolve(response);
	};
	return { fetcher, calls };
}

function firstRawItem(name: string): RawFeedItem {
	const parsed = parseFeed(fixture(name));
	const item = parsed.items[0];
	if (item === undefined) {
		throw new Error(`fixture ${name} produced no items`);
	}
	return item;
}

describe("fetchAndParseFeed", () => {
	it("GETs the feed URL and parses the body", async () => {
		const { fetcher, calls } = scriptedFetcher(fixture("substack-item.xml"));
		const parsed = await fetchAndParseFeed(fetcher, "https://host.example/feed");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://host.example/feed");
		expect(calls[0]?.method).toBe("GET");
		expect(parsed.feedTitle).toBe("Coach Jon McLernon");
		expect(parsed.items).toHaveLength(1);
	});

	it("throws FeedFetchError surfacing the status on a non-2xx response", async () => {
		const { fetcher } = scriptedFetcher("nope", 503);
		let caught: unknown;
		try {
			await fetchAndParseFeed(fetcher, "https://host.example/feed");
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(FeedFetchError);
		expect(caught).toBeInstanceOf(Error);
		const fetchErr = caught as FeedFetchError;
		expect(fetchErr.status).toBe(503);
		expect(fetchErr.message).toContain("503");
	});

	it("wraps a transport failure and preserves the original error as cause", async () => {
		const original = new Error("socket hang up");
		const fetcher: HttpFetcher = () => Promise.reject(original);
		let caught: unknown;
		try {
			await fetchAndParseFeed(fetcher, "https://host.example/feed");
		} catch (err: unknown) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(FeedFetchError);
		expect((caught as FeedFetchError).status).toBeNull();
		expect((caught as FeedFetchError).cause).toBe(original);
	});
});

describe("mapRawItemToFeedItem", () => {
	it("maps a podcast item (audio enclosure) to kind 'podcast' with media fields", () => {
		const raw = firstRawItem("podcast-item.xml");
		const item = mapRawItemToFeedItem(raw, "www.thegodjourney.com");

		expect(item.kind).toBe("podcast");
		expect(item.mediaUrl).toBe(
			"https://media.blubrry.com/the_god_journey/www.thegodjourney.com/audio/2026/260612.mp3",
		);
		expect(item.mediaType).toBe("audio/mpeg");
		expect(item.mediaBytes).toBe(43990159);
		expect(item.sourceId).toBe("www.thegodjourney.com");
	});

	it("falls back to description for the body when content:encoded is absent", () => {
		const raw = firstRawItem("podcast-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		// The podcast fixture carries its body in <description>, not content:encoded.
		expect(item.contentHtml).toBe(
			"<p>Wayne, Kyle, and Joni continue their conversation about patriarchy.</p>",
		);
	});

	it("prefers content:encoded over description for the body", () => {
		const raw = firstRawItem("substack-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		expect(item.contentHtml).toContain("deeply personal and hard to write articles");
		expect(item.contentHtml).not.toBe(
			"How I came to understand salvation apart from institutional belonging.",
		);
	});

	it("classifies a non-audio/video enclosure (a cover image) as an article", () => {
		const raw = firstRawItem("substack-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		// The Substack item ships an image/jpeg cover enclosure, which is NOT media.
		expect(item.kind).toBe("article");
		expect(item.mediaType).toBe("image/jpeg");
	});

	it("treats an enclosure length of 0 as a real value, not absent", () => {
		const raw = firstRawItem("substack-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		expect(item.mediaBytes).toBe(0);
		expect(item.mediaBytes).not.toBeNull();
	});

	it("uses the guid as id and the link as url", () => {
		const raw = firstRawItem("substack-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		expect(item.id).toBe(
			"https://jonathanmclernon.substack.com/p/if-im-not-saved-by-the-system-then",
		);
		expect(item.url).toBe(
			"https://jonathanmclernon.substack.com/p/if-im-not-saved-by-the-system-then",
		);
	});

	it("falls back to link for id when guid is absent", () => {
		const raw: RawFeedItem = {
			guid: null,
			link: "https://host.example/post",
			title: "T",
			author: null,
			pubDateIso: null,
			contentHtml: null,
			description: null,
			categories: [],
			enclosure: null,
		};
		expect(mapRawItemToFeedItem(raw, "host").id).toBe("https://host.example/post");
	});

	it("derives a stable non-empty id from title+date when guid and link are both null", () => {
		const raw: RawFeedItem = {
			guid: null,
			link: null,
			title: "Untitled-ish post",
			author: null,
			pubDateIso: "2026-06-14T00:00:00.000Z",
			contentHtml: null,
			description: null,
			categories: [],
			enclosure: null,
		};
		const id = mapRawItemToFeedItem(raw, "host").id;
		expect(id.length).toBeGreaterThan(0);
		expect(id).toContain("Untitled-ish post");
		expect(id).toContain("2026-06-14T00:00:00.000Z");
		// Deterministic: same input -> same id.
		expect(mapRawItemToFeedItem(raw, "host").id).toBe(id);
	});

	it("never yields an empty id even with no title and no date", () => {
		const raw: RawFeedItem = {
			guid: null,
			link: null,
			title: "",
			author: null,
			pubDateIso: null,
			contentHtml: null,
			description: null,
			categories: [],
			enclosure: null,
		};
		expect(mapRawItemToFeedItem(raw, "host").id.length).toBeGreaterThan(0);
	});

	it("sets the conservative defaults a source may refine", () => {
		const raw = firstRawItem("substack-item.xml");
		const item = mapRawItemToFeedItem(raw, "host");
		expect(item.audience).toBe("unknown");
		expect(item.isTruncated).toBe(false);
		expect(item.section).toBeNull();
		expect(item.tags).toEqual(["Faith", "Salvation"]);
	});
});

describe("buildResolvedFeed", () => {
	const resolved: ResolverResult = {
		sourceType: "generic",
		canonicalHost: "www.thegodjourney.com",
		feedUrl: "https://www.thegodjourney.com/feed/podcast",
		handle: null,
	};

	it("builds a ResolvedFeed with publicationTitle, feedId, and sampleTitles", () => {
		const parsed = parseFeed(fixture("generic-multi.xml"));
		const feed = buildResolvedFeed(resolved, parsed);

		expect(feed.publicationTitle).toBe("The God Journey");
		expect(feed.feedId).toBe("www.thegodjourney.com");
		expect(feed.canonicalHost).toBe("www.thegodjourney.com");
		expect(feed.feedUrl).toBe("https://www.thegodjourney.com/feed/podcast");
		expect(feed.sourceType).toBe("generic");
		expect(feed.sampleTitles).toEqual([
			"Patriarchy diminishes us all (#1039)",
			"A plain article with no enclosure",
		]);
		expect(feed.author).toBe("Wayne Jacobsen");
	});

	it("caps sampleTitles at five", () => {
		const items: RawFeedItem[] = [];
		for (let i = 0; i < 9; i += 1) {
			items.push({
				guid: `g${i}`,
				link: null,
				title: `Title ${i}`,
				author: null,
				pubDateIso: null,
				contentHtml: null,
				description: null,
				categories: [],
				enclosure: null,
			});
		}
		const feed = buildResolvedFeed(resolved, {
			feedTitle: "Many",
			feedLink: null,
			items,
		});
		expect(feed.sampleTitles).toHaveLength(5);
		expect(feed.sampleTitles[0]).toBe("Title 0");
		expect(feed.sampleTitles[4]).toBe("Title 4");
	});

	it("handles an empty feed without throwing", () => {
		const feed = buildResolvedFeed(resolved, {
			feedTitle: "Empty",
			feedLink: null,
			items: [],
		});
		expect(feed.sampleTitles).toEqual([]);
		expect(feed.author).toBeNull();
	});
});

describe("applyLimit", () => {
	it("returns the list unchanged when no limit is given", () => {
		expect(applyLimit([1, 2, 3], undefined)).toEqual([1, 2, 3]);
	});

	it("returns the list unchanged for a non-positive limit", () => {
		expect(applyLimit([1, 2, 3], 0)).toEqual([1, 2, 3]);
	});

	it("keeps only the first N items for a positive limit", () => {
		expect(applyLimit([1, 2, 3, 4], 2)).toEqual([1, 2]);
	});
});
