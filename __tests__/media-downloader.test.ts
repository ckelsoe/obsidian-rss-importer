import type { FeedItem, HttpFetcher, HttpRequest, HttpResponse } from "../feed-source";
import {
	MediaDownloader,
	type BinaryFileLike,
	type VaultBinaryLike,
} from "../media-downloader";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** Turn an ASCII string into an ArrayBuffer for a fake response body. */
function bytes(text: string): ArrayBuffer {
	const arr = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		arr[i] = text.charCodeAt(i);
	}
	return arr.buffer;
}

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
	return {
		sourceId: "feed-1",
		id: "item-1",
		url: "https://example.com/p/one",
		title: "Episode One",
		author: "Author",
		publishedAt: "2026-01-02T00:00:00.000Z",
		kind: "podcast",
		contentHtml: null,
		isTruncated: false,
		audience: "free",
		tags: [],
		section: null,
		mediaUrl: "https://media.example.com/ep/one.mp3",
		mediaType: "audio/mpeg",
		mediaBytes: null,
		...overrides,
	};
}

interface FetchEntry {
	status?: number;
	headers?: Record<string, string>;
	body?: ArrayBuffer;
	throws?: Error;
}

/** Fetcher stub keyed by url; records the urls it was asked for. */
function makeFetcher(map: Record<string, FetchEntry>): {
	fetcher: HttpFetcher;
	requested: string[];
} {
	const requested: string[] = [];
	const fetcher: HttpFetcher = (req: HttpRequest) => {
		requested.push(req.url);
		const entry = map[req.url];
		if (entry === undefined) {
			return Promise.reject(new Error(`no stub for ${req.url}`));
		}
		if (entry.throws !== undefined) {
			return Promise.reject(entry.throws);
		}
		const response: HttpResponse = {
			status: entry.status ?? 200,
			headers: entry.headers ?? {},
			json: null,
			text: "",
			arrayBuffer: entry.body ?? bytes("MEDIA"),
		};
		return Promise.resolve(response);
	};
	return { fetcher, requested };
}

/** In-memory vault that records createBinary / createFolder calls. */
class FakeVault implements VaultBinaryLike {
	files = new Set<string>();
	folders = new Set<string>();
	binaries: Array<{ path: string; size: number }> = [];
	createdFolders: string[] = [];

	getFileByPath(path: string): BinaryFileLike | null {
		return this.files.has(path) ? { path } : null;
	}
	getFolderByPath(path: string): BinaryFileLike | null {
		return this.folders.has(path) ? { path } : null;
	}
	createFolder(path: string): Promise<unknown> {
		this.folders.add(path);
		this.createdFolders.push(path);
		return Promise.resolve({ path });
	}
	createBinary(path: string, data: ArrayBuffer): Promise<BinaryFileLike> {
		this.files.add(path);
		this.binaries.push({ path, size: data.byteLength });
		return Promise.resolve({ path });
	}
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("MediaDownloader.downloadToVault", () => {
	let errorSpy: jest.SpyInstance;
	beforeEach(() => {
		errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("writes the media binary at the folder/<title>.<ext> path and returns it", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher, requested } = makeFetcher({ [url]: { body: bytes("AUDIO") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Episode One", mediaUrl: url, mediaType: "audio/mpeg" });
		const out = await dl.downloadToVault(item, "Feeds/Podcast/media");

		expect(requested).toEqual([url]);
		expect(vault.binaries).toHaveLength(1);
		expect(vault.binaries[0]?.path).toBe("Feeds/Podcast/media/Episode-One.mp3");
		expect(vault.binaries[0]?.size).toBe("AUDIO".length);
		expect(out).toBe("Feeds/Podcast/media/Episode-One.mp3");
		// Ancestors created.
		expect(vault.createdFolders).toEqual(["Feeds", "Feeds/Podcast", "Feeds/Podcast/media"]);
	});

	it("derives the extension from the URL path when present", async () => {
		const url = "https://media.example.com/ep/one.m4a";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: null });
		await dl.downloadToVault(item, "media");

		expect(vault.binaries[0]?.path).toBe("media/Show.m4a");
	});

	it("derives the extension from the content-type when the URL has none", async () => {
		const url = "https://media.example.com/stream/123";
		const { fetcher } = makeFetcher({
			[url]: { headers: { "Content-Type": "audio/mp4" }, body: bytes("A") },
		});
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: "audio/mp4" });
		await dl.downloadToVault(item, "media");

		expect(vault.binaries[0]?.path).toBe("media/Show.m4a");
	});

	it("falls back to a bin extension when neither URL nor content-type gives one", async () => {
		const url = "https://media.example.com/stream/123";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: null });
		await dl.downloadToVault(item, "media");

		expect(vault.binaries[0]?.path).toBe("media/Show.bin");
	});

	it("dedupes a collision by appending a numeric suffix before the extension", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		// A file already exists at the natural target path.
		vault.files.add("media/Show.mp3");
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: "audio/mpeg" });
		const out = await dl.downloadToVault(item, "media");

		expect(out).toBe("media/Show-1.mp3");
		expect(vault.binaries[0]?.path).toBe("media/Show-1.mp3");
	});

	it("returns null on a non-2xx status and writes nothing", async () => {
		const url = "https://media.example.com/ep/missing.mp3";
		const { fetcher } = makeFetcher({ [url]: { status: 404, body: bytes("nope") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ mediaUrl: url });
		const out = await dl.downloadToVault(item, "media");

		expect(out).toBeNull();
		expect(vault.binaries).toHaveLength(0);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("returns null on an empty response body and writes nothing", async () => {
		const url = "https://media.example.com/ep/empty.mp3";
		const { fetcher } = makeFetcher({ [url]: { body: new ArrayBuffer(0) } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ mediaUrl: url });
		const out = await dl.downloadToVault(item, "media");

		expect(out).toBeNull();
		expect(vault.binaries).toHaveLength(0);
	});

	it("returns null on a transport error without throwing", async () => {
		const url = "https://media.example.com/ep/boom.mp3";
		const { fetcher } = makeFetcher({ [url]: { throws: new Error("connection reset") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ mediaUrl: url });
		const out = await dl.downloadToVault(item, "media");

		expect(out).toBeNull();
		expect(errorSpy).toHaveBeenCalled();
	});

	it("returns null without fetching when the item has no media url", async () => {
		const { fetcher, requested } = makeFetcher({});
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const out = await dl.downloadToVault(makeItem({ mediaUrl: null }), "media");

		expect(out).toBeNull();
		expect(requested).toHaveLength(0);
		expect(vault.binaries).toHaveLength(0);
	});

	it("returns null without fetching when the item has an empty media url", async () => {
		const { fetcher, requested } = makeFetcher({});
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const out = await dl.downloadToVault(makeItem({ mediaUrl: "" }), "media");

		expect(out).toBeNull();
		expect(requested).toHaveLength(0);
	});
});

describe("MediaDownloader.downloadToOutside", () => {
	let errorSpy: jest.SpyInstance;
	beforeEach(() => {
		errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("writes via the injected fileWriter and returns the absolute path", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("AUDIO") } });
		const vault = new FakeVault();
		const written: Array<{ path: string; size: number }> = [];
		const fileWriter = (absPath: string, data: ArrayBuffer): void => {
			written.push({ path: absPath, size: data.byteLength });
		};
		const dl = new MediaDownloader({ fetcher, vault, fileWriter });

		const item = makeItem({ title: "Episode One", mediaUrl: url, mediaType: "audio/mpeg" });
		const out = await dl.downloadToOutside(item, "/Users/me/Podcasts");

		expect(out).toBe("/Users/me/Podcasts/Episode-One.mp3");
		expect(written).toHaveLength(1);
		expect(written[0]?.path).toBe("/Users/me/Podcasts/Episode-One.mp3");
		expect(written[0]?.size).toBe("AUDIO".length);
		// The vault is never touched for an outside write.
		expect(vault.binaries).toHaveLength(0);
	});

	it("returns null when no outside folder is configured", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher, requested } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		const fileWriter = (): void => {};
		const dl = new MediaDownloader({ fetcher, vault, fileWriter });

		const out = await dl.downloadToOutside(makeItem({ mediaUrl: url }), "");

		expect(out).toBeNull();
		expect(requested).toHaveLength(0);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("returns null without fetching when the item has no media url", async () => {
		const { fetcher, requested } = makeFetcher({});
		const vault = new FakeVault();
		const fileWriter = (): void => {};
		const dl = new MediaDownloader({ fetcher, vault, fileWriter });

		const out = await dl.downloadToOutside(makeItem({ mediaUrl: null }), "/Users/me/Podcasts");

		expect(out).toBeNull();
		expect(requested).toHaveLength(0);
	});
});

describe("MediaDownloader.download", () => {
	let errorSpy: jest.SpyInstance;
	beforeEach(() => {
		errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("dispatches to the vault path for location 'vault'", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		const dl = new MediaDownloader({ fetcher, vault });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: "audio/mpeg" });
		const out = await dl.download(item, {
			location: "vault",
			vaultFolder: "Feeds/media",
			outsideFolder: "/abs",
		});

		expect(out).toBe("Feeds/media/Show.mp3");
		expect(vault.binaries).toHaveLength(1);
	});

	it("dispatches to the outside path for location 'outside'", async () => {
		const url = "https://media.example.com/ep/one.mp3";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		const written: string[] = [];
		const fileWriter = (absPath: string): void => {
			written.push(absPath);
		};
		const dl = new MediaDownloader({ fetcher, vault, fileWriter });

		const item = makeItem({ title: "Show", mediaUrl: url, mediaType: "audio/mpeg" });
		const out = await dl.download(item, {
			location: "outside",
			vaultFolder: "Feeds/media",
			outsideFolder: "/abs/podcasts",
		});

		expect(out).toBe("/abs/podcasts/Show.mp3");
		expect(written).toEqual(["/abs/podcasts/Show.mp3"]);
		expect(vault.binaries).toHaveLength(0);
	});
});
