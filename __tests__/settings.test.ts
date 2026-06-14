import {
	DEFAULT_SETTINGS,
	buildCleanupConfig,
	cleanupHasRules,
	effectiveCleanupLinkHosts,
	effectiveCleanupTrimAfterLastRule,
	type FeedConfig,
	type RssImporterSettings,
} from "../settings";

function makeFeed(overrides: Partial<FeedConfig> = {}): FeedConfig {
	return {
		feedId: "feed-1",
		sourceType: "generic",
		feedUrl: "https://example.com/feed.xml",
		canonicalHost: "example.com",
		publicationTitle: "Example",
		author: null,
		destinationFolder: "Feeds/Example",
		tags: [],
		tagNamespace: "",
		importSourceTags: false,
		enabled: true,
		addedAt: "2026-01-01T00:00:00.000Z",
		lastImportedAt: null,
		...overrides,
	};
}

function makeSettings(overrides: Partial<RssImporterSettings> = {}): RssImporterSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("effectiveCleanupLinkHosts", () => {
	it("returns the global default when the feed has no override", () => {
		const settings = makeSettings({ cleanupLinkHosts: ["buymeacoffee.com"] });
		expect(effectiveCleanupLinkHosts(makeFeed(), settings)).toEqual(["buymeacoffee.com"]);
	});

	it("returns the per-feed override when present", () => {
		const settings = makeSettings({ cleanupLinkHosts: ["buymeacoffee.com"] });
		const feed = makeFeed({ cleanupLinkHosts: ["substack.com/app"] });
		expect(effectiveCleanupLinkHosts(feed, settings)).toEqual(["substack.com/app"]);
	});

	it("lets an explicit empty array override a non-empty default", () => {
		const settings = makeSettings({ cleanupLinkHosts: ["buymeacoffee.com"] });
		const feed = makeFeed({ cleanupLinkHosts: [] });
		expect(effectiveCleanupLinkHosts(feed, settings)).toEqual([]);
	});
});

describe("effectiveCleanupTrimAfterLastRule", () => {
	it("returns the global default when the feed has no override", () => {
		const settings = makeSettings({ cleanupTrimAfterLastRule: true });
		expect(effectiveCleanupTrimAfterLastRule(makeFeed(), settings)).toBe(true);
	});

	it("returns the per-feed override when present", () => {
		const settings = makeSettings({ cleanupTrimAfterLastRule: true });
		const feed = makeFeed({ cleanupTrimAfterLastRule: false });
		expect(effectiveCleanupTrimAfterLastRule(feed, settings)).toBe(false);
	});
});

describe("buildCleanupConfig", () => {
	it("composes the effective host list and trim flag for a feed", () => {
		const settings = makeSettings({
			cleanupLinkHosts: ["default-host.com"],
			cleanupTrimAfterLastRule: false,
		});
		const feed = makeFeed({
			cleanupLinkHosts: ["feed-host.com"],
			cleanupTrimAfterLastRule: true,
		});
		expect(buildCleanupConfig(feed, settings)).toEqual({
			linkHosts: ["feed-host.com"],
			trimAfterLastRule: true,
		});
	});
});

describe("cleanupHasRules", () => {
	it("is false for the default empty config", () => {
		expect(cleanupHasRules({ linkHosts: [], trimAfterLastRule: false })).toBe(false);
	});

	it("is true when a host is configured", () => {
		expect(cleanupHasRules({ linkHosts: ["x.com"], trimAfterLastRule: false })).toBe(true);
	});

	it("is true when only the trim flag is on", () => {
		expect(cleanupHasRules({ linkHosts: [], trimAfterLastRule: true })).toBe(true);
	});

	it("is false when the host list holds only blank entries", () => {
		expect(cleanupHasRules({ linkHosts: ["  ", ""], trimAfterLastRule: false })).toBe(false);
	});
});
