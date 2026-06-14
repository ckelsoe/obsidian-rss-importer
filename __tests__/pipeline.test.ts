/** @jest-environment jsdom */
//
// End-to-end pipeline test: wires the REAL modules together (feed-xml parse via
// the sources, html-converter, note-writer, vault-index) against the real
// captured fixtures. The per-module unit tests cover each stage in isolation;
// this test proves the stages compose correctly and that a written note round
// trips back through the dedup index (so a re-import is a no-op).

import { readFileSync } from "fs";
import { join } from "path";

import { GenericRssFeedSource } from "../source-generic";
import { SubstackFeedSource } from "../source-substack";
import { convertHtmlToMarkdown } from "../html-converter";
import {
	NoteWriter,
	composeNote,
	extractFeedItemId,
	type FileLike,
	type FolderLike,
	type VaultLike,
} from "../note-writer";
import { buildFeedItemIndex, type AppLike } from "../vault-index";
import { buildResolvedFeedFromConfig } from "../import-modal";
import { FRONTMATTER_KEYS, type HttpFetcher, type HttpResponse } from "../feed-source";
import type { FeedConfig } from "../settings";

function fixture(name: string): string {
	return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

function must<T>(value: T | undefined, label: string): T {
	if (value === undefined) {
		throw new Error(`expected ${label} to be defined`);
	}
	return value;
}

// A fetcher that answers a fixed URL with fixture XML and rejects anything else.
function stubFetcher(byUrl: Record<string, string>): HttpFetcher {
	return (req): Promise<HttpResponse> => {
		const text = byUrl[req.url];
		if (text === undefined) {
			return Promise.reject(new Error(`no stub for ${req.url}`));
		}
		return Promise.resolve({
			status: 200,
			headers: { "content-type": "application/xml" },
			json: null,
			text,
			arrayBuffer: new ArrayBuffer(0),
		});
	};
}

function feedConfig(over: Partial<FeedConfig>): FeedConfig {
	return {
		feedId: "example.com",
		sourceType: "generic",
		feedUrl: "https://example.com/feed",
		canonicalHost: "example.com",
		publicationTitle: "Example",
		author: null,
		destinationFolder: "Feeds/Example",
		tags: [],
		tagNamespace: "",
		importSourceTags: false,
		enabled: true,
		addedAt: "2026-06-14T00:00:00.000Z",
		lastImportedAt: null,
		...over,
	};
}

// Minimal in-memory vault satisfying NoteWriter's VaultLike. The same store is
// projected into an AppLike for the dedup index so the round-trip is exercised.
class FakeVault implements VaultLike {
	readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();

	getFileByPath(path: string): FileLike | null {
		return this.files.has(path) ? { path } : null;
	}
	getFolderByPath(path: string): FolderLike | null {
		return this.folders.has(path) ? { path } : null;
	}
	createFolder(path: string): Promise<unknown> {
		this.folders.add(path);
		return Promise.resolve({ path });
	}
	create(path: string, data: string): Promise<FileLike> {
		this.files.set(path, data);
		return Promise.resolve({ path });
	}
	read(file: FileLike): Promise<string> {
		const content = this.files.get(file.path);
		if (content === undefined) {
			return Promise.reject(new Error(`not found: ${file.path}`));
		}
		return Promise.resolve(content);
	}
	process(file: FileLike, fn: (data: string) => string): Promise<string> {
		const next = fn(this.files.get(file.path) ?? "");
		this.files.set(file.path, next);
		return Promise.resolve(next);
	}
}

function appFrom(vault: FakeVault): AppLike {
	return {
		vault: {
			getMarkdownFiles: () => Array.from(vault.files.keys()).map((path) => ({ path })),
		},
		metadataCache: {
			getFileCache: (file) => {
				const content = vault.files.get(file.path);
				if (content === undefined) {
					return null;
				}
				const id = extractFeedItemId(content);
				return { frontmatter: id === null ? {} : { [FRONTMATTER_KEYS.feedItemId]: id } };
			},
		},
	};
}

describe("end-to-end import pipeline", () => {
	const GENERIC_URL = "https://www.thegodjourney.com/feed/podcast";
	const genericCfg = feedConfig({
		sourceType: "generic",
		feedUrl: GENERIC_URL,
		feedId: "www.thegodjourney.com",
		canonicalHost: "www.thegodjourney.com",
		publicationTitle: "The God Journey",
		destinationFolder: "Feeds/The God Journey",
	});

	function genericSource(): GenericRssFeedSource {
		return new GenericRssFeedSource({
			fetcher: stubFetcher({ [GENERIC_URL]: fixture("generic-multi.xml") }),
		});
	}

	it("maps a generic feed: podcast item keeps its enclosure, article prefers content:encoded", async () => {
		const items = await genericSource().listItems(buildResolvedFeedFromConfig(genericCfg));
		expect(items).toHaveLength(2);

		const podcast = must(
			items.find((i) => i.kind === "podcast"),
			"podcast item",
		);
		expect(podcast.mediaUrl).toContain(".mp3");
		expect(podcast.mediaType).toBe("audio/mpeg");
		expect(podcast.mediaBytes).toBe(43990159);

		const article = must(
			items.find((i) => i.title.includes("plain article")),
			"article item",
		);
		expect(article.kind).toBe("article");
		// content:encoded must win over the shorter <description>.
		expect(article.contentHtml).toContain("full article body");
		expect(article.contentHtml).not.toContain("should be overridden");
	});

	it("writes a real note and finds it again through the dedup index (re-import is a no-op)", async () => {
		const items = await genericSource().listItems(buildResolvedFeedFromConfig(genericCfg));
		const article = must(
			items.find((i) => i.title.includes("plain article")),
			"article item",
		);
		const full = await genericSource().fetchBody(article);
		const body = convertHtmlToMarkdown(full.contentHtml ?? "");

		const vault = new FakeVault();
		const writer = new NoteWriter({
			vault,
			destinationFolder: genericCfg.destinationFolder,
			noteNameTemplate: "{{date}} {{title}}",
			onDuplicate: "skip",
		});

		const outcome = await writer.writeNote(full, body, { feedTags: genericCfg.tags });
		expect(outcome.status).toBe("created");

		const noteContent = must(vault.files.get(outcome.path), "written note");
		// Identity round-trips: the id we wrote is the id the reader extracts.
		expect(extractFeedItemId(noteContent)).toBe(full.id);
		// url is force-quoted.
		expect(noteContent).toMatch(/^url: ".+"$/m);
		expect(noteContent).toContain("full article body");

		// The dedup index built from the written note contains the item.
		const index = buildFeedItemIndex(appFrom(vault), genericCfg.destinationFolder);
		expect(index.has(full.id)).toBe(true);

		// Re-importing the same item is a no-op under the skip policy.
		const second = await writer.writeNote(full, body, { feedTags: genericCfg.tags });
		expect(second.status).toBe("skipped");
	});

	it("flags a Substack paid teaser as truncated and writes the warning note shape", async () => {
		const SUBSTACK_URL = "https://jonathanmclernon.substack.com/feed";
		const substackCfg = feedConfig({
			sourceType: "substack",
			feedUrl: SUBSTACK_URL,
			feedId: "jonathanmclernon.substack.com",
			canonicalHost: "jonathanmclernon.substack.com",
			publicationTitle: "Coach Jon McLernon",
			destinationFolder: "Feeds/Coach Jon McLernon",
		});
		const source = new SubstackFeedSource({
			fetcher: stubFetcher({ [SUBSTACK_URL]: fixture("substack-multi.xml") }),
		});

		const items = await source.listItems(buildResolvedFeedFromConfig(substackCfg));
		const free = must(items.find((i) => i.title.includes("free post")), "free post");
		const paid = must(items.find((i) => i.title.includes("paid post")), "paid post");

		expect(free.isTruncated).toBe(false);
		expect(paid.isTruncated).toBe(true);

		const note = composeNote(paid, convertHtmlToMarkdown(paid.contentHtml ?? ""), {});
		expect(note).toContain("substack-truncated: true");
		expect(note).toContain("> [!warning]");
	});

	it("converts a real Substack body deterministically", () => {
		const html = fixture("substack-content-encoded.html");
		expect(convertHtmlToMarkdown(html)).toBe(convertHtmlToMarkdown(html));
	});
});
