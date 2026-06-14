import {
	buildFeedItemIndex,
	type AppLike,
	type FileCacheLike,
	type FileLike,
	type ImportedRecord,
} from "../vault-index";
import { FRONTMATTER_KEYS } from "../feed-source";

// A controllable fake of the App surface. Each markdown file maps to the
// frontmatter the metadata cache would return for it. A path absent from
// `caches` simulates a file the cache has not parsed yet (getFileCache -> null).
function makeApp(
	paths: string[],
	caches: Record<string, FileCacheLike | null>,
): AppLike {
	const files: FileLike[] = paths.map((path) => ({ path }));
	return {
		vault: {
			getMarkdownFiles(): FileLike[] {
				return files;
			},
		},
		metadataCache: {
			getFileCache(file: FileLike): FileCacheLike | null {
				return Object.prototype.hasOwnProperty.call(caches, file.path)
					? (caches[file.path] ?? null)
					: null;
			},
		},
	};
}

function fmWithId(id: string, extra: Record<string, unknown> = {}): FileCacheLike {
	return {
		frontmatter: {
			[FRONTMATTER_KEYS.feedItemId]: id,
			...extra,
		},
	};
}

describe("buildFeedItemIndex", () => {
	it("indexes only files under the destination folder, skipping outside files", () => {
		const app = makeApp(
			["Feeds/a.md", "Feeds/b.md", "Other/c.md", "d.md"],
			{
				"Feeds/a.md": fmWithId("item-a"),
				"Feeds/b.md": fmWithId("item-b"),
				"Other/c.md": fmWithId("item-c"),
				"d.md": fmWithId("item-d"),
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect([...index.keys()].sort()).toEqual(["item-a", "item-b"]);
		expect(index.get("item-a")?.path).toBe("Feeds/a.md");
		expect(index.get("item-b")?.path).toBe("Feeds/b.md");
		expect(index.has("item-c")).toBe(false);
		expect(index.has("item-d")).toBe(false);
	});

	it("includes files in subfolders of the destination folder", () => {
		const app = makeApp(
			["Feeds/sub/deep.md", "Feeds/top.md"],
			{
				"Feeds/sub/deep.md": fmWithId("deep-id"),
				"Feeds/top.md": fmWithId("top-id"),
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect(index.get("deep-id")?.path).toBe("Feeds/sub/deep.md");
		expect(index.get("top-id")?.path).toBe("Feeds/top.md");
		expect(index.size).toBe(2);
	});

	it("does not match a sibling folder that shares the name as a prefix", () => {
		const app = makeApp(
			["Feeds/a.md", "FeedsArchive/b.md"],
			{
				"Feeds/a.md": fmWithId("kept"),
				"FeedsArchive/b.md": fmWithId("dropped"),
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect(index.has("kept")).toBe(true);
		expect(index.has("dropped")).toBe(false);
	});

	it("treats an empty folder string as the vault root (all files)", () => {
		const app = makeApp(
			["a.md", "nested/b.md"],
			{
				"a.md": fmWithId("root-a"),
				"nested/b.md": fmWithId("root-b"),
			},
		);

		const index = buildFeedItemIndex(app, "");

		expect([...index.keys()].sort()).toEqual(["root-a", "root-b"]);
	});

	it("normalizes a folder with surrounding slashes and whitespace", () => {
		const app = makeApp(
			["Feeds/a.md", "Other/b.md"],
			{
				"Feeds/a.md": fmWithId("a"),
				"Other/b.md": fmWithId("b"),
			},
		);

		const index = buildFeedItemIndex(app, "  /Feeds/  ");

		expect([...index.keys()]).toEqual(["a"]);
		expect(index.get("a")?.path).toBe("Feeds/a.md");
	});

	it("skips files whose frontmatter lacks the feed-item id", () => {
		const app = makeApp(
			["Feeds/withId.md", "Feeds/noId.md", "Feeds/otherKeys.md"],
			{
				"Feeds/withId.md": fmWithId("present"),
				"Feeds/noId.md": { frontmatter: { title: "no id here" } },
				"Feeds/otherKeys.md": {
					frontmatter: { [FRONTMATTER_KEYS.url]: "https://example.com" },
				},
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect([...index.keys()]).toEqual(["present"]);
	});

	it("skips files with a missing metadata cache without throwing", () => {
		const app = makeApp(
			["Feeds/cached.md", "Feeds/uncached.md"],
			{
				"Feeds/cached.md": fmWithId("cached-id"),
				// "Feeds/uncached.md" absent: getFileCache returns null.
			},
		);

		let index: Map<string, ImportedRecord> | undefined;
		expect(() => {
			index = buildFeedItemIndex(app, "Feeds");
		}).not.toThrow();
		expect(index?.size).toBe(1);
		expect(index?.has("cached-id")).toBe(true);
	});

	it("tolerates malformed frontmatter shapes without throwing", () => {
		const app = makeApp(
			[
				"Feeds/nullFm.md",
				"Feeds/arrayFm.md",
				"Feeds/stringFm.md",
				"Feeds/numericId.md",
				"Feeds/blankId.md",
				"Feeds/good.md",
			],
			{
				"Feeds/nullFm.md": { frontmatter: null },
				"Feeds/arrayFm.md": { frontmatter: ["not", "a", "record"] },
				"Feeds/stringFm.md": { frontmatter: "totally wrong" },
				"Feeds/numericId.md": { frontmatter: { [FRONTMATTER_KEYS.feedItemId]: 12345 } },
				"Feeds/blankId.md": { frontmatter: { [FRONTMATTER_KEYS.feedItemId]: "   " } },
				"Feeds/good.md": fmWithId("good-id"),
			},
		);

		let index: Map<string, ImportedRecord> | undefined;
		expect(() => {
			index = buildFeedItemIndex(app, "Feeds");
		}).not.toThrow();
		// Only the one well-formed string id survives. Numeric and blank ids
		// are rejected; non-record frontmatter is skipped.
		expect([...(index?.keys() ?? [])]).toEqual(["good-id"]);
	});

	it("captures feed-source alongside the path and keys by the id value", () => {
		const app = makeApp(
			["Feeds/a.md"],
			{
				"Feeds/a.md": fmWithId("the-id", {
					[FRONTMATTER_KEYS.feedSource]: "example-blog",
				}),
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		const record = index.get("the-id");
		expect(record).toEqual({ path: "Feeds/a.md", feedSource: "example-blog" });
	});

	it("leaves feedSource undefined when the frontmatter omits it", () => {
		const app = makeApp(
			["Feeds/a.md"],
			{ "Feeds/a.md": fmWithId("solo-id") },
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect(index.get("solo-id")?.feedSource).toBeUndefined();
	});

	it("last write wins when the same id appears in multiple files", () => {
		const app = makeApp(
			["Feeds/first.md", "Feeds/second.md"],
			{
				"Feeds/first.md": fmWithId("dup"),
				"Feeds/second.md": fmWithId("dup"),
			},
		);

		const index = buildFeedItemIndex(app, "Feeds");

		expect(index.size).toBe(1);
		expect(index.get("dup")?.path).toBe("Feeds/second.md");
	});

	it("returns an empty map when no markdown files exist", () => {
		const app = makeApp([], {});

		const index = buildFeedItemIndex(app, "Feeds");

		expect(index.size).toBe(0);
	});
});
