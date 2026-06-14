// Tests for the pure helpers extracted from the UI shell, plus smoke checks
// that the DOM-wiring classes load. The Modal / SettingTab / FolderSuggest
// classes themselves are DOM wiring exercised by Obsidian at runtime; here we
// only assert they are defined (the `obsidian` import is stubbed by the jest
// mock). The real coverage is on the pure functions.

import { defaultDestinationFolder, parseTagsInput, AddFeedModal } from "../add-feed-modal";
import {
	buildResolvedFeedFromConfig,
	badgeStateForItem,
	ImportModal,
} from "../import-modal";
import { RssImporterSettingTab } from "../settings-tab";
import { FolderSuggest } from "../folder-suggest";
import { createStackedRow } from "../ui-helpers";
import type { FeedConfig } from "../settings";
import type { FeedItem } from "../feed-source";
import type { ImportedRecord } from "../vault-index";

function makeFeed(overrides: Partial<FeedConfig> = {}): FeedConfig {
	return {
		feedId: "example.com",
		sourceType: "generic",
		feedUrl: "https://example.com/feed",
		canonicalHost: "example.com",
		publicationTitle: "Example",
		author: "Jane",
		destinationFolder: "Feeds/Example",
		tags: ["news"],
		tagNamespace: "",
		importSourceTags: true,
		enabled: true,
		addedAt: "2026-06-14T00:00:00.000Z",
		lastImportedAt: null,
		...overrides,
	};
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		sourceId: "example.com",
		id: "item-1",
		url: "https://example.com/p/item-1",
		title: "First post",
		author: "Jane",
		publishedAt: "2026-06-01T00:00:00.000Z",
		kind: "article",
		contentHtml: "<p>body</p>",
		isTruncated: false,
		audience: "free",
		tags: [],
		section: null,
		mediaUrl: null,
		mediaType: null,
		mediaBytes: null,
		...overrides,
	};
}

describe("defaultDestinationFolder", () => {
	test("joins parent and title with a single slash", () => {
		expect(defaultDestinationFolder("Feeds", "My Blog")).toBe("Feeds/My Blog");
	});

	test("trims surrounding slashes on both segments", () => {
		expect(defaultDestinationFolder("/Feeds/", "/My Blog/")).toBe("Feeds/My Blog");
	});

	test("collapses path separators in the title into spaces", () => {
		expect(defaultDestinationFolder("Feeds", "a/b\\c")).toBe("Feeds/a b c");
	});

	test("empty parent returns just the title", () => {
		expect(defaultDestinationFolder("", "My Blog")).toBe("My Blog");
	});

	test("empty title returns just the parent", () => {
		expect(defaultDestinationFolder("Feeds", "   ")).toBe("Feeds");
	});
});

describe("parseTagsInput", () => {
	test("splits, trims, and drops empties", () => {
		expect(parseTagsInput(" a , b ,, c ")).toEqual(["a", "b", "c"]);
	});

	test("dedupes while preserving first-seen order", () => {
		expect(parseTagsInput("a, b, a, c, b")).toEqual(["a", "b", "c"]);
	});

	test("empty input yields an empty list", () => {
		expect(parseTagsInput("")).toEqual([]);
	});
});

describe("buildResolvedFeedFromConfig", () => {
	test("projects the config's canonical metadata onto a ResolvedFeed", () => {
		const feed = makeFeed();
		const resolved = buildResolvedFeedFromConfig(feed);
		expect(resolved.feedId).toBe("example.com");
		expect(resolved.feedUrl).toBe("https://example.com/feed");
		expect(resolved.canonicalHost).toBe("example.com");
		expect(resolved.sourceType).toBe("generic");
		expect(resolved.publicationTitle).toBe("Example");
		expect(resolved.author).toBe("Jane");
		// Preview-only fields default to empty/unknown for listing.
		expect(resolved.sampleTitles).toEqual([]);
		expect(resolved.audienceHint).toBe("unknown");
	});
});

describe("badgeStateForItem", () => {
	const dismissedSet = new Set<string>();
	const dismissStore = {
		isDismissed: (_feedId: string, itemId: string): boolean => dismissedSet.has(itemId),
	};

	beforeEach(() => {
		dismissedSet.clear();
	});

	test("returns imported when the item is in the vault index", () => {
		const item = makeItem({ id: "in-vault" });
		const index = new Map<string, ImportedRecord>([["in-vault", { path: "Feeds/Example/x.md" }]]);
		expect(badgeStateForItem(item, "example.com", index, dismissStore)).toBe("imported");
	});

	test("imported wins over dismissed", () => {
		const item = makeItem({ id: "both" });
		dismissedSet.add("both");
		const index = new Map<string, ImportedRecord>([["both", { path: "Feeds/Example/x.md" }]]);
		expect(badgeStateForItem(item, "example.com", index, dismissStore)).toBe("imported");
	});

	test("returns dismissed when dismissed and not imported", () => {
		const item = makeItem({ id: "skip-me" });
		dismissedSet.add("skip-me");
		const index = new Map<string, ImportedRecord>();
		expect(badgeStateForItem(item, "example.com", index, dismissStore)).toBe("dismissed");
	});

	test("returns available when neither imported nor dismissed", () => {
		const item = makeItem({ id: "fresh" });
		const index = new Map<string, ImportedRecord>();
		expect(badgeStateForItem(item, "example.com", index, dismissStore)).toBe("available");
	});
});

describe("UI shell classes are defined", () => {
	test("modal and tab classes load under the obsidian stub", () => {
		expect(typeof AddFeedModal).toBe("function");
		expect(typeof ImportModal).toBe("function");
		expect(typeof RssImporterSettingTab).toBe("function");
		expect(typeof FolderSuggest).toBe("function");
		expect(typeof createStackedRow).toBe("function");
	});
});
