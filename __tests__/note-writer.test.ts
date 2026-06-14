import type { FeedItem } from "../feed-source";
import { FRONTMATTER_KEYS } from "../feed-source";
import {
	NoteWriter,
	NoteWriterError,
	NoteWriterCancelledError,
	composeNote,
	expandNoteName,
	extractFeedItemId,
	sanitizeFilename,
	type FileLike,
	type FolderLike,
	type VaultLike,
	type WriteOutcome,
} from "../note-writer";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		sourceId: "feed-123",
		id: "item-abc",
		url: "https://example.com/p/hello-world",
		title: "Hello World",
		author: "Jane Doe",
		publishedAt: "2026-03-14T09:30:00.000Z",
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

// A scriptable in-memory vault that records the calls the writer makes.
class FakeVault implements VaultLike {
	files = new Map<string, string>();
	folders = new Set<string>();
	createdFolders: string[] = [];
	created: Array<{ path: string; data: string }> = [];
	processed: Array<{ path: string; result: string }> = [];

	getFileByPath(path: string): FileLike | null {
		if (!this.files.has(path)) {
			return null;
		}
		return { path };
	}

	getFolderByPath(path: string): FolderLike | null {
		return this.folders.has(path) ? { path } : null;
	}

	async createFolder(path: string): Promise<unknown> {
		this.folders.add(path);
		this.createdFolders.push(path);
		return { path };
	}

	async create(path: string, data: string): Promise<FileLike> {
		this.files.set(path, data);
		this.created.push({ path, data });
		return { path };
	}

	async read(file: FileLike): Promise<string> {
		const content = this.files.get(file.path);
		if (content === undefined) {
			throw new Error(`no such file: ${file.path}`);
		}
		return content;
	}

	async process(
		file: FileLike,
		fn: (data: string) => string,
	): Promise<string> {
		const prev = this.files.get(file.path) ?? "";
		const next = fn(prev);
		this.files.set(file.path, next);
		this.processed.push({ path: file.path, result: next });
		return next;
	}
}

// -----------------------------------------------------------------------------
// sanitizeFilename
// -----------------------------------------------------------------------------

describe("sanitizeFilename", () => {
	it("collapses whitespace runs to single spaces", () => {
		expect(sanitizeFilename("a   b\n\tc")).toBe("a b c");
	});

	it("replaces Windows-forbidden chars and brackets with dashes", () => {
		expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j[k]l')).toBe(
			"a-b-c-d-e-f-g-h-i-j-k-l",
		);
	});

	it("strips leading and trailing dots and spaces", () => {
		expect(sanitizeFilename("  ..name..  ")).toBe("name");
	});

	it("prefixes reserved device names with underscore (case-insensitive)", () => {
		expect(sanitizeFilename("CON")).toBe("_CON");
		expect(sanitizeFilename("com1")).toBe("_com1");
		expect(sanitizeFilename("LPT9")).toBe("_LPT9");
	});

	it("does not prefix non-reserved names that merely start like one", () => {
		expect(sanitizeFilename("CONsole")).toBe("CONsole");
		expect(sanitizeFilename("COM10")).toBe("COM10");
	});

	it("clamps to 200 characters", () => {
		const out = sanitizeFilename("x".repeat(500));
		expect(out.length).toBe(200);
	});

	it("falls back to Untitled when nothing usable remains", () => {
		expect(sanitizeFilename("   ...   ")).toBe("Untitled");
		expect(sanitizeFilename("")).toBe("Untitled");
	});

	it("strips a NUL control character", () => {
		expect(sanitizeFilename("a\x00b")).toBe("a-b");
	});
});

// -----------------------------------------------------------------------------
// expandNoteName
// -----------------------------------------------------------------------------

describe("expandNoteName", () => {
	it("expands {{date}}, {{title}}, and {{slug}}", () => {
		const item = makeItem({
			title: "My Great Post",
			publishedAt: "2026-03-14T00:00:00.000Z",
		});
		expect(expandNoteName("{{date}} {{title}}", item)).toBe(
			"2026-03-14 My Great Post",
		);
		expect(expandNoteName("{{slug}}", item)).toBe("my-great-post");
	});

	it("emits empty for {{date}} when publishedAt is null", () => {
		const item = makeItem({ title: "Dateless", publishedAt: null });
		// The template's literal text between tokens survives; the date token
		// itself contributes nothing.
		expect(expandNoteName("{{date}}{{title}}", item)).toBe("Dateless");
	});

	it("sanitizes a token so it cannot inject a path separator", () => {
		const item = makeItem({ title: "a/b/c" });
		const out = expandNoteName("{{title}}", item);
		expect(out).not.toContain("/");
		expect(out).toBe("a-b-c");
	});

	it("rejects an empty expansion with NoteWriterError", () => {
		const item = makeItem({ title: "Anything" });
		expect(() => expandNoteName("", item)).toThrow(NoteWriterError);
		// A template of nothing but whitespace also expands to empty.
		expect(() => expandNoteName("   ", item)).toThrow(NoteWriterError);
	});
});

// -----------------------------------------------------------------------------
// composeNote
// -----------------------------------------------------------------------------

describe("composeNote", () => {
	it("force-quotes the url value", () => {
		const note = composeNote(makeItem(), "BODY", {});
		expect(note).toContain(
			`${FRONTMATTER_KEYS.url}: "https://example.com/p/hello-world"`,
		);
	});

	it("writes merged tags to the feed-tags property by default (not Obsidian tags)", () => {
		const item = makeItem({ tags: ["Tech", "news"] });
		const note = composeNote(item, "BODY", { feedTags: ["news", "weekly"] });
		// feed tags first, then item tags, normalized and deduped, under feed-tags.
		expect(note).toContain("feed-tags: [news, weekly, tech]");
		// No Obsidian `tags:` line (feed-tags must not be mistaken for it).
		expect(note).not.toMatch(/^tags: /m);
	});

	it("writes Obsidian tags when tagDestination is 'tags'", () => {
		const item = makeItem({ tags: ["news"] });
		const note = composeNote(item, "BODY", { feedTags: ["weekly"], tagDestination: "tags" });
		expect(note).toContain(`${FRONTMATTER_KEYS.tags}: [weekly, news]`);
		expect(note).not.toContain("feed-tags:");
	});

	it("strips a leading # from a tag so it cannot break the YAML", () => {
		const note = composeNote(makeItem({ tags: [] }), "BODY", { feedTags: ["#Faith"] });
		expect(note).toContain("feed-tags: [faith]");
	});

	it("emits the date as YYYY-MM-DD", () => {
		const item = makeItem({ publishedAt: "2026-03-14T23:59:00.000Z" });
		const note = composeNote(item, "BODY", {});
		expect(note).toContain(`${FRONTMATTER_KEYS.date}: 2026-03-14`);
	});

	it("omits date and author when absent", () => {
		const item = makeItem({ publishedAt: null, author: null });
		const note = composeNote(item, "BODY", {});
		expect(note).not.toContain(`${FRONTMATTER_KEYS.date}:`);
		expect(note).not.toContain(`${FRONTMATTER_KEYS.author}:`);
	});

	it("writes feed-source and feed-item-id from the item", () => {
		const item = makeItem({ sourceId: "src-9", id: "post-42" });
		const note = composeNote(item, "BODY", {});
		expect(note).toContain(`${FRONTMATTER_KEYS.feedSource}: src-9`);
		expect(note).toContain(`${FRONTMATTER_KEYS.feedItemId}: post-42`);
	});

	it("prepends a callout and a truncated marker for a teaser", () => {
		const item = makeItem({ isTruncated: true });
		const note = composeNote(item, "BODY", {});
		expect(note).toContain("substack-truncated: true");
		expect(note).toContain("> [!warning] Truncated content");
		// The callout sits ahead of the body.
		const calloutIdx = note.indexOf("> [!warning]");
		const bodyIdx = note.indexOf("BODY");
		expect(calloutIdx).toBeGreaterThan(-1);
		expect(bodyIdx).toBeGreaterThan(calloutIdx);
	});

	it("does not add the truncated marker or callout for a complete note", () => {
		const note = composeNote(makeItem({ isTruncated: false }), "BODY", {});
		expect(note).not.toContain("substack-truncated");
		expect(note).not.toContain("[!warning]");
	});

	it("links the episode media and records media-url for a podcast item", () => {
		const mediaUrl = "https://media.example.com/ep/42.mp3";
		const item = makeItem({
			kind: "podcast",
			mediaUrl,
			mediaType: "audio/mpeg",
		});
		const note = composeNote(item, "BODY", {});
		// Frontmatter records the force-quoted media URL.
		expect(note).toContain(`media-url: "${mediaUrl}"`);
		// Body links the episode audio.
		expect(note).toContain(`[Episode audio](${mediaUrl})`);
	});

	it("labels non-podcast media as Media in the body link", () => {
		const mediaUrl = "https://media.example.com/clip.mp4";
		const item = makeItem({
			kind: "article",
			mediaUrl,
			mediaType: "video/mp4",
		});
		const note = composeNote(item, "BODY", {});
		expect(note).toContain(`media-url: "${mediaUrl}"`);
		expect(note).toContain(`[Media](${mediaUrl})`);
	});

	it("omits media frontmatter and body link when there is no media", () => {
		const note = composeNote(makeItem({ mediaUrl: null }), "BODY", {});
		expect(note).not.toContain("media-url:");
		expect(note).not.toContain("[Episode audio]");
		expect(note).not.toContain("[Media]");
	});
});

// -----------------------------------------------------------------------------
// extractFeedItemId
// -----------------------------------------------------------------------------

describe("extractFeedItemId", () => {
	it("round-trips a composeNote output", () => {
		const item = makeItem({ id: "round-trip-id" });
		const note = composeNote(item, "BODY", {});
		expect(extractFeedItemId(note)).toBe("round-trip-id");
	});

	it("round-trips an id that forces YAML quoting", () => {
		// An id of "null" must be quoted by composeNote; extraction must strip
		// the quotes back to the original.
		const item = makeItem({ id: "null" });
		const note = composeNote(item, "BODY", {});
		expect(note).toContain(`${FRONTMATTER_KEYS.feedItemId}: "null"`);
		expect(extractFeedItemId(note)).toBe("null");
	});

	it("round-trips an id containing a literal backslash-n (two chars)", () => {
		// The id is a backslash followed by the letter n, NOT a newline. The
		// unescape order in extractFeedItemId must turn the escaped backslash back
		// into one backslash before the \n rule runs, or this would corrupt into a
		// real newline.
		const literalBackslashN = "a\\nb";
		const item = makeItem({ id: literalBackslashN });
		const note = composeNote(item, "BODY", {});
		expect(extractFeedItemId(note)).toBe(literalBackslashN);
	});

	it("returns null when there is no frontmatter", () => {
		expect(extractFeedItemId("just a body, no frontmatter")).toBeNull();
	});

	it("returns null when the id key is absent", () => {
		const content = "---\ntitle: Something\n---\n\nbody";
		expect(extractFeedItemId(content)).toBeNull();
	});
});

// -----------------------------------------------------------------------------
// NoteWriter
// -----------------------------------------------------------------------------

describe("NoteWriter", () => {
	const baseOpts = {
		destinationFolder: "Imports",
		noteNameTemplate: "{{title}}",
		onDuplicate: "skip" as const,
	};

	it("throws when constructing a prompt policy without a callback", () => {
		const vault = new FakeVault();
		expect(
			() =>
				new NoteWriter({
					vault,
					destinationFolder: "x",
					noteNameTemplate: "{{title}}",
					onDuplicate: "prompt",
				}),
		).toThrow(NoteWriterError);
	});

	it("creates a new note and reports the path", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		const writer = new NoteWriter({ vault, ...baseOpts });
		const outcome = await writer.writeNote(
			makeItem({ title: "Fresh Post" }),
			"BODY",
		);
		const expected: WriteOutcome = {
			status: "created",
			path: "Imports/Fresh Post.md",
		};
		expect(outcome).toEqual(expected);
		expect(vault.created).toHaveLength(1);
		expect(vault.created[0]?.path).toBe("Imports/Fresh Post.md");
	});

	it("ensureFolder creates each missing ancestor", async () => {
		const vault = new FakeVault();
		const writer = new NoteWriter({
			vault,
			destinationFolder: "a/b/c",
			noteNameTemplate: "{{title}}",
			onDuplicate: "skip",
		});
		await writer.writeNote(makeItem({ title: "Deep" }), "BODY");
		expect(vault.createdFolders).toEqual(["a", "a/b", "a/b/c"]);
	});

	it("throws a collision error when an existing note has a different id", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		// Seed an existing note for a DIFFERENT item at the colliding path.
		const other = composeNote(
			makeItem({ id: "other-id", title: "Same Title" }),
			"OTHER",
			{},
		);
		vault.files.set("Imports/Same Title.md", other);

		const writer = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "overwrite",
		});
		await expect(
			writer.writeNote(makeItem({ id: "mine-id", title: "Same Title" }), "MINE"),
		).rejects.toThrow(NoteWriterError);
		// The existing file is left untouched.
		expect(vault.files.get("Imports/Same Title.md")).toBe(other);
		expect(vault.processed).toHaveLength(0);
	});

	it("skip policy returns skipped for a same-id duplicate", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		const existing = composeNote(
			makeItem({ id: "dup-id", title: "Dup" }),
			"OLD",
			{},
		);
		vault.files.set("Imports/Dup.md", existing);

		const writer = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "skip",
		});
		const outcome = await writer.writeNote(
			makeItem({ id: "dup-id", title: "Dup" }),
			"NEW",
		);
		expect(outcome.status).toBe("skipped");
		// Skip must not modify the file.
		expect(vault.files.get("Imports/Dup.md")).toBe(existing);
		expect(vault.processed).toHaveLength(0);
	});

	it("overwrite policy calls vault.process and reports overwritten", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		const existing = composeNote(
			makeItem({ id: "dup-id", title: "Dup" }),
			"OLD",
			{},
		);
		vault.files.set("Imports/Dup.md", existing);

		const writer = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "overwrite",
		});
		const outcome = await writer.writeNote(
			makeItem({ id: "dup-id", title: "Dup" }),
			"NEW BODY",
		);
		expect(outcome.status).toBe("overwritten");
		expect(vault.processed).toHaveLength(1);
		// The new body replaced the old content.
		const written = vault.files.get("Imports/Dup.md") ?? "";
		expect(written).toContain("NEW BODY");
		expect(written).not.toContain("OLD");
	});

	it("a truncated teaser does not overwrite a complete note", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		// Existing complete (non-truncated) note for the same item.
		const complete = composeNote(
			makeItem({ id: "same-id", title: "Article", isTruncated: false }),
			"FULL TEXT",
			{},
		);
		vault.files.set("Imports/Article.md", complete);

		// Even with overwrite policy, the truncated teaser must be refused.
		const writer = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "overwrite",
		});
		const outcome = await writer.writeNote(
			makeItem({ id: "same-id", title: "Article", isTruncated: true }),
			"TEASER",
		);
		expect(outcome.status).toBe("skipped");
		// The complete note survives untouched.
		expect(vault.files.get("Imports/Article.md")).toBe(complete);
		expect(vault.processed).toHaveLength(0);
	});

	it("a truncated teaser may overwrite an existing truncated note", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		const oldTeaser = composeNote(
			makeItem({ id: "same-id", title: "Article", isTruncated: true }),
			"OLD TEASER",
			{},
		);
		vault.files.set("Imports/Article.md", oldTeaser);

		const writer = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "overwrite",
		});
		const outcome = await writer.writeNote(
			makeItem({ id: "same-id", title: "Article", isTruncated: true }),
			"NEW TEASER",
		);
		expect(outcome.status).toBe("overwritten");
		expect(vault.files.get("Imports/Article.md")).toContain("NEW TEASER");
	});

	it("prompt policy honoring overwrite and cancel decisions", async () => {
		const vault = new FakeVault();
		vault.folders.add("Imports");
		const existing = composeNote(
			makeItem({ id: "p-id", title: "Prompted" }),
			"OLD",
			{},
		);
		vault.files.set("Imports/Prompted.md", existing);

		const overwriteWriter = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "prompt",
			promptOnDuplicate: async () => "overwrite",
		});
		const overwritten = await overwriteWriter.writeNote(
			makeItem({ id: "p-id", title: "Prompted" }),
			"REPLACED",
		);
		expect(overwritten.status).toBe("overwritten");
		expect(vault.files.get("Imports/Prompted.md")).toContain("REPLACED");

		const cancelWriter = new NoteWriter({
			vault,
			destinationFolder: "Imports",
			noteNameTemplate: "{{title}}",
			onDuplicate: "prompt",
			promptOnDuplicate: async () => "cancel",
		});
		await expect(
			cancelWriter.writeNote(makeItem({ id: "p-id", title: "Prompted" }), "X"),
		).rejects.toThrow(NoteWriterCancelledError);
	});

	it("throws when destinationFolder escapes the vault", () => {
		const vault = new FakeVault();
		expect(
			() =>
				new NoteWriter({
					vault,
					destinationFolder: "ok/../../escape",
					noteNameTemplate: "{{title}}",
					onDuplicate: "skip",
				}),
		).toThrow(NoteWriterError);
	});
});
