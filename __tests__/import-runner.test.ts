import type { FeedItem } from "../feed-source";
import type { NoteWriter, WriteOutcome } from "../note-writer";
import { NoteWriterCancelledError } from "../note-writer";
import {
	ImportRunner,
	formatImportNotice,
	type FeedSourceLike,
	type ImportProgress,
	type ImportTally,
} from "../import-runner";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		sourceId: "feed-1",
		id: "item-1",
		url: "https://example.com/p/one",
		title: "Item One",
		author: "Author",
		publishedAt: "2026-01-02T00:00:00.000Z",
		kind: "article",
		contentHtml: null,
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

/** Source stub: fetchBody fills contentHtml from a per-id map, or throws. */
function makeSource(
	bodies: Record<string, string | Error>,
): { source: FeedSourceLike; fetched: string[] } {
	const fetched: string[] = [];
	const source: FeedSourceLike = {
		fetchBody(item: FeedItem): Promise<FeedItem> {
			fetched.push(item.id);
			const entry = bodies[item.id];
			if (entry instanceof Error) {
				return Promise.reject(entry);
			}
			return Promise.resolve({ ...item, contentHtml: entry ?? "<p>x</p>" });
		},
	};
	return { source, fetched };
}

/**
 * NoteWriter stub. Casts a plain object to NoteWriter because the runner only
 * ever calls writeNote; the structural shape is all that is exercised.
 */
function makeWriter(
	behavior: (item: FeedItem, body: string) => Promise<WriteOutcome>,
): { writer: NoteWriter; calls: Array<{ id: string; body: string }> } {
	const calls: Array<{ id: string; body: string }> = [];
	const stub = {
		writeNote(item: FeedItem, body: string): Promise<WriteOutcome> {
			calls.push({ id: item.id, body });
			return behavior(item, body);
		},
	};
	return { writer: stub as unknown as NoteWriter, calls };
}

const identityConvert = (html: string): string => `MD:${html}`;

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("ImportRunner.run", () => {
	let errorSpy: jest.SpyInstance;
	beforeEach(() => {
		errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("tallies created/overwritten/skipped across a clean batch", async () => {
		const items = [
			makeItem({ id: "a" }),
			makeItem({ id: "b" }),
			makeItem({ id: "c" }),
		];
		const { source } = makeSource({ a: "<p>A</p>", b: "<p>B</p>", c: "<p>C</p>" });
		const statuses: Record<string, WriteOutcome> = {
			a: { status: "created", path: "Feeds/a.md" },
			b: { status: "overwritten", path: "Feeds/b.md" },
			c: { status: "skipped", path: "Feeds/c.md" },
		};
		const { writer } = makeWriter((item) => {
			const out = statuses[item.id];
			if (out === undefined) throw new Error("unexpected item");
			return Promise.resolve(out);
		});

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		const tally = await runner.run(items, {});

		expect(tally.total).toBe(3);
		expect(tally.created).toBe(1);
		expect(tally.overwritten).toBe(1);
		expect(tally.skipped).toBe(1);
		expect(tally.failed).toBe(0);
		expect(tally.results.map((r) => r.status)).toEqual([
			"created",
			"overwritten",
			"skipped",
		]);
		expect(tally.results[0]?.path).toBe("Feeds/a.md");
		expect(tally.results[0]?.reason).toBeNull();
	});

	it("passes the converted body and feedTags to the writer", async () => {
		const items = [makeItem({ id: "a" })];
		const { source } = makeSource({ a: "<p>hello</p>" });
		const { writer, calls } = makeWriter(() =>
			Promise.resolve({ status: "created", path: "Feeds/a.md" }),
		);

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		await runner.run(items, { feedTags: ["news"] });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toBe("MD:<p>hello</p>");
	});

	it("records a failed item without aborting the rest of the batch", async () => {
		const items = [
			makeItem({ id: "a" }),
			makeItem({ id: "boom" }),
			makeItem({ id: "c" }),
		];
		// 'boom' throws at fetch time; a and c succeed.
		const { source, fetched } = makeSource({
			a: "<p>A</p>",
			boom: new Error("fetch exploded"),
			c: "<p>C</p>",
		});
		const { writer } = makeWriter((item) =>
			Promise.resolve({ status: "created", path: `Feeds/${item.id}.md` }),
		);

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		const tally = await runner.run(items, {});

		// All three were attempted; the batch did not stop on the bad item.
		expect(fetched).toEqual(["a", "boom", "c"]);
		expect(tally.failed).toBe(1);
		expect(tally.created).toBe(2);
		const failed = tally.results.find((r) => r.item.id === "boom");
		expect(failed?.status).toBe("failed");
		expect(failed?.reason).toBe("fetch exploded");
		expect(failed?.path).toBeNull();
		expect(errorSpy).toHaveBeenCalled();
	});

	it("records a write failure as failed with the writer's message", async () => {
		const items = [makeItem({ id: "a" })];
		const { source } = makeSource({ a: "<p>A</p>" });
		const { writer } = makeWriter(() =>
			Promise.reject(new Error("disk full")),
		);

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		const tally = await runner.run(items, {});

		expect(tally.failed).toBe(1);
		expect(tally.results[0]?.reason).toBe("disk full");
	});

	it("aborts the whole run when the writer reports a user cancel", async () => {
		const items = [
			makeItem({ id: "a" }),
			makeItem({ id: "b" }),
			makeItem({ id: "c" }),
		];
		const { source, fetched } = makeSource({ a: "<p>A</p>", b: "<p>B</p>", c: "<p>C</p>" });
		const { writer } = makeWriter((item) => {
			if (item.id === "b") {
				return Promise.reject(new NoteWriterCancelledError());
			}
			return Promise.resolve({ status: "created", path: `Feeds/${item.id}.md` });
		});

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });

		await expect(runner.run(items, {})).rejects.toBeInstanceOf(NoteWriterCancelledError);
		// 'c' was never fetched: the cancel unwound the loop at 'b'.
		expect(fetched).toEqual(["a", "b"]);
	});

	it("stops early when isAborted() returns true and returns work done so far", async () => {
		const items = [
			makeItem({ id: "a" }),
			makeItem({ id: "b" }),
			makeItem({ id: "c" }),
		];
		const { source, fetched } = makeSource({ a: "<p>A</p>", b: "<p>B</p>", c: "<p>C</p>" });
		const { writer } = makeWriter((item) =>
			Promise.resolve({ status: "created", path: `Feeds/${item.id}.md` }),
		);

		// Abort before the 2nd item (index 1): allow index 0, then stop.
		let calls = 0;
		const isAborted = (): boolean => {
			const abort = calls >= 1;
			calls++;
			return abort;
		};

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		const tally = await runner.run(items, { isAborted });

		expect(fetched).toEqual(["a"]);
		expect(tally.created).toBe(1);
		expect(tally.results).toHaveLength(1);
	});

	it("invokes onProgress once per processed item with the fetched item", async () => {
		const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
		const { source } = makeSource({ a: "<p>A</p>", b: "<p>B</p>" });
		const { writer } = makeWriter((item) =>
			Promise.resolve({ status: "created", path: `Feeds/${item.id}.md` }),
		);
		const progress: ImportProgress[] = [];

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		await runner.run(items, { onProgress: (p) => progress.push(p) });

		expect(progress).toHaveLength(2);
		expect(progress[0]?.index).toBe(0);
		expect(progress[0]?.total).toBe(2);
		// The progress item carries the fetched body, not the bare input.
		expect(progress[0]?.item.contentHtml).toBe("<p>A</p>");
		expect(progress[1]?.index).toBe(1);
	});

	it("keeps converted markdown when processImages throws (best effort)", async () => {
		const items = [makeItem({ id: "a" })];
		const { source } = makeSource({ a: "<p>A</p>" });
		const { writer, calls } = makeWriter(() =>
			Promise.resolve({ status: "created", path: "Feeds/a.md" }),
		);
		const processImages = (): Promise<string> =>
			Promise.reject(new Error("image host down"));

		const runner = new ImportRunner({
			source,
			noteWriter: writer,
			convert: identityConvert,
			processImages,
		});
		const tally = await runner.run(items, {});

		// Item still succeeds; the body is the un-rewritten converted markdown.
		expect(tally.created).toBe(1);
		expect(tally.failed).toBe(0);
		expect(calls[0]?.body).toBe("MD:<p>A</p>");
	});

	it("uses the processImages result when it succeeds", async () => {
		const items = [makeItem({ id: "a" })];
		const { source } = makeSource({ a: "<p>A</p>" });
		const { writer, calls } = makeWriter(() =>
			Promise.resolve({ status: "created", path: "Feeds/a.md" }),
		);
		const processImages = (md: string): Promise<string> =>
			Promise.resolve(`${md} +imgs`);

		const runner = new ImportRunner({
			source,
			noteWriter: writer,
			convert: identityConvert,
			processImages,
		});
		await runner.run(items, {});

		expect(calls[0]?.body).toBe("MD:<p>A</p> +imgs");
	});

	it("treats null contentHtml as an empty body", async () => {
		const items = [makeItem({ id: "a" })];
		const source: FeedSourceLike = {
			fetchBody: (item) => Promise.resolve({ ...item, contentHtml: null }),
		};
		const { writer, calls } = makeWriter(() =>
			Promise.resolve({ status: "created", path: "Feeds/a.md" }),
		);

		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		await runner.run(items, {});

		expect(calls[0]?.body).toBe("MD:");
	});

	it("returns a zeroed tally for an empty item list", async () => {
		const { source } = makeSource({});
		const { writer, calls } = makeWriter(() =>
			Promise.resolve({ status: "created", path: "x" }),
		);
		const runner = new ImportRunner({ source, noteWriter: writer, convert: identityConvert });
		const tally = await runner.run([], {});

		expect(tally).toEqual<ImportTally>({
			total: 0,
			created: 0,
			overwritten: 0,
			skipped: 0,
			failed: 0,
			results: [],
		});
		expect(calls).toHaveLength(0);
	});
});

describe("formatImportNotice", () => {
	it("folds created and overwritten into one imported count", () => {
		const tally: ImportTally = {
			total: 5,
			created: 2,
			overwritten: 1,
			skipped: 1,
			failed: 1,
			results: [],
		};
		expect(formatImportNotice(tally)).toBe("Imported 3, skipped 1, failed 1");
	});

	it("reads exactly as the documented summary for a 3/1/0 run", () => {
		const tally: ImportTally = {
			total: 4,
			created: 3,
			overwritten: 0,
			skipped: 1,
			failed: 0,
			results: [],
		};
		expect(formatImportNotice(tally)).toBe("Imported 3, skipped 1, failed 0");
	});

	it("shows zeros explicitly", () => {
		const tally: ImportTally = {
			total: 0,
			created: 0,
			overwritten: 0,
			skipped: 0,
			failed: 0,
			results: [],
		};
		expect(formatImportNotice(tally)).toBe("Imported 0, skipped 0, failed 0");
	});
});
