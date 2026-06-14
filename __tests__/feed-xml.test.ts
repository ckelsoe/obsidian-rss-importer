/** @jest-environment jsdom */

import { readFileSync } from "fs";
import { join } from "path";

import { parseFeed, FeedParseError } from "../feed-xml";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

describe("parseFeed", () => {
	describe("RSS Substack item", () => {
		const parsed = parseFeed(fixture("substack-item.xml"));
		const item = parsed.items[0];

		it("reads the channel title and link", () => {
			expect(parsed.feedTitle).toBe("Coach Jon McLernon");
			expect(parsed.feedLink).toBe("https://jonathanmclernon.substack.com");
		});

		it("yields exactly one item", () => {
			expect(parsed.items).toHaveLength(1);
		});

		it("reads guid, link, and title", () => {
			expect(item).toBeDefined();
			if (item === undefined) {
				throw new Error("expected an item");
			}
			expect(item.guid).toBe("https://jonathanmclernon.substack.com/p/if-im-not-saved-by-the-system-then");
			expect(item.link).toBe("https://jonathanmclernon.substack.com/p/if-im-not-saved-by-the-system-then");
			expect(item.title).toBe("If I am not saved by the system, then how am I saved?");
		});

		it("reads dc:creator as the author", () => {
			expect(item?.author).toBe("Jonathan McLernon");
		});

		it("prefers content:encoded over description for contentHtml", () => {
			expect(item?.contentHtml).toContain("<p>This is one of those deeply personal and hard to write articles.</p>");
			expect(item?.contentHtml).toContain("Jesus, God the Father, and the Holy Spirit");
			// description is a different, shorter string.
			expect(item?.description).toBe("How I came to understand salvation apart from institutional belonging.");
			expect(item?.contentHtml).not.toBe(item?.description);
		});

		it("collects the categories", () => {
			expect(item?.categories).toEqual(["Faith", "Salvation"]);
		});

		it("reads the cover-image enclosure with type and length", () => {
			expect(item?.enclosure).toEqual({
				url: "https://substackcdn.com/image/cover.png",
				type: "image/jpeg",
				length: 0,
			});
		});

		it("normalizes the RFC 822 pubDate to ISO 8601", () => {
			expect(item?.pubDateIso).toBe("2026-06-14T14:24:30.000Z");
		});
	});

	describe("RSS podcast item", () => {
		const parsed = parseFeed(fixture("podcast-item.xml"));
		const item = parsed.items[0];

		it("reads the audio enclosure as url, type, and length", () => {
			expect(item?.enclosure).toEqual({
				url: "https://media.blubrry.com/the_god_journey/www.thegodjourney.com/audio/2026/260612.mp3",
				type: "audio/mpeg",
				length: 43990159,
			});
		});

		it("reads the WordPress non-permalink guid", () => {
			expect(item?.guid).toBe("https://www.thegodjourney.com/?p=31764");
		});

		it("leaves contentHtml null when content:encoded is absent, keeping the HTML in description", () => {
			// The podcast item ships its body in <description>, not content:encoded.
			// The parser keeps the two fields separate; the source layer chooses the
			// fallback. So contentHtml is null and description carries the HTML.
			expect(item?.contentHtml).toBeNull();
			expect(item?.description).toBe("<p>Wayne, Kyle, and Joni continue their conversation about patriarchy.</p>");
		});

		it("collects categories including the namespaced-feed values", () => {
			expect(item?.categories).toEqual(["Show content", "patriarchy"]);
		});

		it("normalizes a +0000 offset pubDate to ISO 8601", () => {
			expect(item?.pubDateIso).toBe("2026-06-12T13:30:16.000Z");
		});
	});

	describe("Atom entry", () => {
		const parsed = parseFeed(fixture("atom-entry.xml"));
		const item = parsed.items[0];

		it("reads the feed title and alternate link", () => {
			expect(parsed.feedTitle).toBe("Example Atom feed");
			expect(parsed.feedLink).toBe("https://example.com/");
		});

		it("reads the entry id as guid and the alternate link as link", () => {
			expect(item?.guid).toBe("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a");
			expect(item?.link).toBe("https://example.com/posts/first");
		});

		it("reads the author name from the nested <author><name>", () => {
			expect(item?.author).toBe("Ada Lovelace");
		});

		it("reads <content> as contentHtml and <summary> as description", () => {
			expect(item?.contentHtml).toBe("<p>The full Atom body content lives here.</p>");
			expect(item?.description).toBe("A short Atom summary line.");
		});

		it("reads categories from the term attribute", () => {
			expect(item?.categories).toEqual(["essays", "history"]);
		});

		it("reads the rel=enclosure link as the enclosure", () => {
			expect(item?.enclosure).toEqual({
				url: "https://example.com/audio/first.mp3",
				type: "audio/mpeg",
				length: 12345,
			});
		});

		it("prefers <published> over <updated> and normalizes to ISO", () => {
			expect(item?.pubDateIso).toBe("2026-06-10T09:00:00.000Z");
		});
	});

	describe("date normalization edge cases", () => {
		it("returns null for an unparseable pubDate rather than throwing", () => {
			const xml =
				'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
				"<item><title>x</title><pubDate>not a date</pubDate></item></channel></rss>";
			const parsed = parseFeed(xml);
			expect(parsed.items[0]?.pubDateIso).toBeNull();
		});

		it("returns null for an absent pubDate", () => {
			const xml =
				'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
				"<item><title>x</title></item></channel></rss>";
			const parsed = parseFeed(xml);
			expect(parsed.items[0]?.pubDateIso).toBeNull();
		});
	});

	describe("malformed and rootless input", () => {
		it("throws FeedParseError on malformed XML", () => {
			expect(() => parseFeed("<rss><channel><title>oops</rss>")).toThrow(FeedParseError);
		});

		it("throws FeedParseError on empty input", () => {
			expect(() => parseFeed("   ")).toThrow(FeedParseError);
		});

		it("throws FeedParseError when there is no channel or feed root", () => {
			const xml = '<?xml version="1.0"?><html><body><p>not a feed</p></body></html>';
			expect(() => parseFeed(xml)).toThrow(FeedParseError);
		});

		it("surfaces a reason in the FeedParseError message", () => {
			let caught: unknown;
			try {
				parseFeed("<rss><channel><title>oops</rss>");
			} catch (err: unknown) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(FeedParseError);
			expect((caught as Error).message.length).toBeGreaterThan(0);
		});
	});

	describe("enclosure resolution", () => {
		it("returns null when an enclosure has no url", () => {
			const xml =
				'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
				'<item><title>x</title><enclosure type="audio/mpeg" length="10"/></item></channel></rss>';
			expect(parseFeed(xml).items[0]?.enclosure).toBeNull();
		});

		it("returns null length when the length attribute is non-numeric", () => {
			const xml =
				'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
				'<item><title>x</title><enclosure url="https://a/b.mp3" type="audio/mpeg" length="abc"/></item></channel></rss>';
			expect(parseFeed(xml).items[0]?.enclosure).toEqual({
				url: "https://a/b.mp3",
				type: "audio/mpeg",
				length: null,
			});
		});
	});
});
