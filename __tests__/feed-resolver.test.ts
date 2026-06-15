import * as fs from "fs";
import * as path from "path";
import { FeedResolver, ResolveError } from "../feed-resolver";
import type { HttpFetcher, HttpRequest, HttpResponse } from "../feed-source";

/** A canned response, addressed by exact request URL. */
interface Canned {
	status: number;
	headers?: Record<string, string>;
	json?: unknown;
	text?: string;
}

/** Builds a full HttpResponse from the canned partial. */
function toResponse(c: Canned): HttpResponse {
	return {
		status: c.status,
		headers: c.headers ?? {},
		json: c.json ?? null,
		text: c.text ?? "",
		arrayBuffer: new ArrayBuffer(0),
	};
}

/**
 * A stub fetcher that answers from a URL -> response map and records every URL
 * it was asked for, in order. An unmapped URL is a test bug, so it throws.
 */
function makeFetcher(map: Record<string, Canned>): { fetcher: HttpFetcher; urls: string[] } {
	const urls: string[] = [];
	const fetcher: HttpFetcher = (req: HttpRequest) => {
		urls.push(req.url);
		const canned = map[req.url];
		if (canned === undefined) {
			return Promise.reject(new Error(`unexpected fetch: ${req.url}`));
		}
		return Promise.resolve(toResponse(canned));
	};
	return { fetcher, urls };
}

/** Loads the trimmed Substack public_profile fixture as parsed JSON. */
function loadProfileFixture(): unknown {
	const file = path.join(__dirname, "fixtures", "substack-profile.json");
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

const PROFILE_URL = "https://substack.com/api/v1/user/lxxwriter/public_profile";

describe("FeedResolver: Substack @handle", () => {
	it("resolves @handle via the profile API to the custom-domain feed", async () => {
		const profile = loadProfileFixture();
		const { fetcher, urls } = makeFetcher({
			[PROFILE_URL]: { status: 200, json: profile },
			// The custom-domain feed answers directly (already canonical).
			"https://the.lxxscrolls.com/feed": { status: 200, headers: { "Content-Type": "application/rss+xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("@lxxwriter");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("the.lxxscrolls.com");
		expect(result.feedUrl).toBe("https://the.lxxscrolls.com/feed");
		expect(result.handle).toBe("lxxwriter");
		// The profile API was actually called.
		expect(urls[0]).toBe(PROFILE_URL);
	});

	it("accepts the substack.com/@handle form and hits the same profile API", async () => {
		const profile = loadProfileFixture();
		const { fetcher, urls } = makeFetcher({
			[PROFILE_URL]: { status: 200, json: profile },
			"https://the.lxxscrolls.com/feed": { status: 200, headers: { "Content-Type": "text/xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://substack.com/@lxxwriter");

		expect(result.handle).toBe("lxxwriter");
		expect(result.canonicalHost).toBe("the.lxxscrolls.com");
		expect(urls).toContain(PROFILE_URL);
	});

	it("falls back to <subdomain>.substack.com when the profile has no custom domain", async () => {
		// Inline canned profile: subdomain only, no custom_domain.
		const profile = {
			handle: "plainpub",
			primaryPublication: { subdomain: "plainpub", custom_domain: null },
		};
		const subProfileUrl = "https://substack.com/api/v1/user/plainpub/public_profile";
		const { fetcher } = makeFetcher({
			[subProfileUrl]: { status: 200, json: profile },
			"https://plainpub.substack.com/feed": { status: 200, headers: { "Content-Type": "application/xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("@plainpub");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("plainpub.substack.com");
		expect(result.feedUrl).toBe("https://plainpub.substack.com/feed");
	});

	it("raises ResolveError when the profile has no usable publication", async () => {
		const subProfileUrl = "https://substack.com/api/v1/user/ghost/public_profile";
		const { fetcher } = makeFetcher({
			[subProfileUrl]: { status: 200, json: { handle: "ghost" } },
		});
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("@ghost")).rejects.toBeInstanceOf(ResolveError);
		await expect(resolver.resolve("@ghost")).rejects.toThrow(/no publication/i);
	});

	it("raises ResolveError when the profile API returns a non-2xx status", async () => {
		const subProfileUrl = "https://substack.com/api/v1/user/missing/public_profile";
		const { fetcher } = makeFetcher({
			[subProfileUrl]: { status: 404 },
		});
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("@missing")).rejects.toThrow(/status 404/);
	});

	it("reads the publication from publicationUsers when primaryPublication is absent", async () => {
		const profile = {
			handle: "viauser",
			publicationUsers: [
				{ is_primary: false, publication: { subdomain: "secondary" } },
				{ is_primary: true, publication: { subdomain: "primarypub", custom_domain: "blog.example.com" } },
			],
		};
		const url = "https://substack.com/api/v1/user/viauser/public_profile";
		const { fetcher } = makeFetcher({
			[url]: { status: 200, json: profile },
			"https://blog.example.com/feed": { status: 200, headers: { "Content-Type": "application/rss+xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("@viauser");

		// The is_primary entry's custom domain wins, not the first entry.
		expect(result.canonicalHost).toBe("blog.example.com");
	});
});

describe("FeedResolver: Substack subdomain and post URLs", () => {
	it("resolves a *.substack.com subdomain to host/feed", async () => {
		const { fetcher } = makeFetcher({
			"https://kevin.substack.com/feed": { status: 200, headers: { "Content-Type": "application/rss+xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("kevin.substack.com");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("kevin.substack.com");
		expect(result.feedUrl).toBe("https://kevin.substack.com/feed");
		expect(result.handle).toBeNull();
	});

	it("classifies a *.substack.com post URL (/p/<slug>) as substack with host/feed", async () => {
		const { fetcher } = makeFetcher({
			"https://kevin.substack.com/feed": { status: 200, headers: { "Content-Type": "text/xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://kevin.substack.com/p/daniel-6");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("kevin.substack.com");
		expect(result.feedUrl).toBe("https://kevin.substack.com/feed");
	});

	it("classifies a custom-domain post URL (/p/<slug>) as generic when the feed has no Substack marker", async () => {
		// A /p/<slug> path on a non-substack.com host is NOT claimed as Substack
		// from the path alone. The host's /feed probe returns plain XML with no
		// Substack generator marker, so it resolves as a generic feed.
		const { fetcher } = makeFetcher({
			"https://the.lxxscrolls.com/feed": {
				status: 200,
				headers: { "Content-Type": "text/xml" },
				text: "<?xml version=\"1.0\"?><rss></rss>",
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://the.lxxscrolls.com/p/daniel-6");

		expect(result.sourceType).toBe("generic");
		expect(result.canonicalHost).toBe("the.lxxscrolls.com");
		expect(result.feedUrl).toBe("https://the.lxxscrolls.com/feed");
	});
});

describe("FeedResolver: custom-domain Substack detection", () => {
	// A Substack feed declares <generator>Substack</generator> in its channel
	// header. That marker is the hard signal that upgrades a custom-domain feed
	// from generic to substack, so it gains archive backfill.
	const SUBSTACK_FEED_BODY =
		"<?xml version=\"1.0\"?><rss><channel><title>The LXX Scrolls</title>" +
		"<generator>Substack</generator></channel></rss>";

	it("upgrades a probed bare host to substack when the feed carries the generator marker", async () => {
		const { fetcher } = makeFetcher({
			"https://the.lxxscrolls.com/feed": {
				status: 200,
				headers: { "Content-Type": "application/rss+xml" },
				text: SUBSTACK_FEED_BODY,
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("the.lxxscrolls.com");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("the.lxxscrolls.com");
		expect(result.feedUrl).toBe("https://the.lxxscrolls.com/feed");
	});

	it("upgrades an explicit custom-domain /feed URL to substack via the generator marker", async () => {
		const { fetcher } = makeFetcher({
			"https://the.lxxscrolls.com/feed": {
				status: 200,
				headers: { "Content-Type": "application/rss+xml" },
				text: SUBSTACK_FEED_BODY,
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://the.lxxscrolls.com/feed");

		expect(result.sourceType).toBe("substack");
		expect(result.canonicalHost).toBe("the.lxxscrolls.com");
		expect(result.feedUrl).toBe("https://the.lxxscrolls.com/feed");
	});
});

describe("FeedResolver: generic feed URLs", () => {
	it("classifies a custom-domain /feed URL as generic", async () => {
		const { fetcher } = makeFetcher({
			"https://blog.example.com/feed": { status: 200, headers: { "Content-Type": "application/rss+xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://blog.example.com/feed");

		expect(result.sourceType).toBe("generic");
		expect(result.canonicalHost).toBe("blog.example.com");
		expect(result.feedUrl).toBe("https://blog.example.com/feed");
		expect(result.handle).toBeNull();
	});

	it("classifies a /feed/podcast URL as generic", async () => {
		const { fetcher } = makeFetcher({
			"https://godjourney.example/feed/podcast": { status: 200, headers: { "Content-Type": "application/rss+xml" } },
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://godjourney.example/feed/podcast");

		expect(result.sourceType).toBe("generic");
		expect(result.feedUrl).toBe("https://godjourney.example/feed/podcast");
	});

	it("probes host/feed for a bare host and accepts an XML response as generic", async () => {
		const { fetcher, urls } = makeFetcher({
			"https://news.example.org/feed": {
				status: 200,
				headers: { "Content-Type": "text/html" },
				text: "<?xml version=\"1.0\"?><rss></rss>",
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("news.example.org");

		expect(result.sourceType).toBe("generic");
		expect(result.canonicalHost).toBe("news.example.org");
		expect(result.feedUrl).toBe("https://news.example.org/feed");
		expect(urls).toEqual(["https://news.example.org/feed"]);
	});

	it("raises ResolveError when a probed host returns non-XML", async () => {
		const { fetcher } = makeFetcher({
			"https://notafeed.example/feed": {
				status: 200,
				headers: { "Content-Type": "text/html" },
				text: "<!DOCTYPE html><html><body>nope</body></html>",
			},
		});
		const resolver = new FeedResolver(fetcher);

		// A real HTML page (not XML) at /feed must not be accepted as a feed.
		await expect(resolver.resolve("notafeed.example")).rejects.toThrow(/no feed found/i);
	});
});

describe("FeedResolver: redirect walking", () => {
	it("walks a 301 chain from a subdomain to the moved custom domain", async () => {
		const { fetcher, urls } = makeFetcher({
			"https://kevin.substack.com/feed": {
				status: 301,
				headers: { Location: "https://the.kevin.com/feed" },
			},
			"https://the.kevin.com/feed": {
				status: 200,
				headers: { "Content-Type": "application/rss+xml" },
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("kevin.substack.com");

		// Canonical host is where the chain landed, not where it started.
		expect(result.canonicalHost).toBe("the.kevin.com");
		expect(result.feedUrl).toBe("https://the.kevin.com/feed");
		expect(urls).toEqual([
			"https://kevin.substack.com/feed",
			"https://the.kevin.com/feed",
		]);
	});

	it("resolves a relative Location against the current URL", async () => {
		const { fetcher } = makeFetcher({
			"https://blog.example.com/feed": {
				status: 302,
				headers: { Location: "/rss" },
			},
			"https://blog.example.com/rss": {
				status: 200,
				headers: { "Content-Type": "application/rss+xml" },
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("https://blog.example.com/feed");

		expect(result.sourceType).toBe("generic");
		expect(result.feedUrl).toBe("https://blog.example.com/rss");
		expect(result.canonicalHost).toBe("blog.example.com");
	});

	it("treats a direct 200 (auto-followed) as canonical at the requested host", async () => {
		// No Location header to walk: the requestUrl auto-follow case.
		const { fetcher, urls } = makeFetcher({
			"https://kevin.substack.com/feed": {
				status: 200,
				headers: { "Content-Type": "application/rss+xml" },
			},
		});
		const resolver = new FeedResolver(fetcher);

		const result = await resolver.resolve("kevin.substack.com");

		expect(result.canonicalHost).toBe("kevin.substack.com");
		expect(urls).toEqual(["https://kevin.substack.com/feed"]);
	});

	it("raises ResolveError when the redirect hop cap is exceeded", async () => {
		// Each hop points at the next; the chain is longer than the cap of 5.
		const map: Record<string, Canned> = {};
		for (let i = 0; i < 10; i += 1) {
			map[`https://hop${i}.example/feed`] = {
				status: 301,
				headers: { Location: `https://hop${i + 1}.example/feed` },
			};
		}
		const { fetcher } = makeFetcher(map);
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("https://hop0.example/feed")).rejects.toBeInstanceOf(ResolveError);
		await expect(resolver.resolve("https://hop0.example/feed")).rejects.toThrow(/too many redirects/i);
	});

	it("raises ResolveError on a redirect with no Location header", async () => {
		const { fetcher } = makeFetcher({
			"https://blog.example.com/feed": { status: 301, headers: {} },
		});
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("https://blog.example.com/feed")).rejects.toThrow(/no location/i);
	});
});

describe("FeedResolver: input validation and classification", () => {
	it("raises ResolveError on empty input", async () => {
		const { fetcher } = makeFetcher({});
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("   ")).rejects.toThrow(/empty input/i);
	});

	it("raises ResolveError on substack.com without a handle", async () => {
		const { fetcher } = makeFetcher({});
		const resolver = new FeedResolver(fetcher);

		await expect(resolver.resolve("https://substack.com/about")).rejects.toThrow(/not a resolvable/i);
	});

	it("attaches the original error as cause when the profile fetch throws", async () => {
		const boom = new Error("network down");
		const fetcher: HttpFetcher = () => Promise.reject(boom);
		const resolver = new FeedResolver(fetcher);

		try {
			await resolver.resolve("@anyone");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ResolveError);
			expect((err as ResolveError).cause).toBe(boom);
		}
	});
});
