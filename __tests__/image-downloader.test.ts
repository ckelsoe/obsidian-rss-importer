import type { HttpFetcher, HttpRequest, HttpResponse } from "../feed-source";
import {
	ImageDownloader,
	type BinaryFileLike,
	type VaultBinaryLike,
} from "../image-downloader";

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
			arrayBuffer: entry.body ?? bytes("IMG"),
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

describe("ImageDownloader.downloadAndRewrite", () => {
	let errorSpy: jest.SpyInstance;
	beforeEach(() => {
		errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("downloads an image, writes binary, and rewrites the reference", async () => {
		const url = "https://cdn.example.com/pics/photo.png";
		const { fetcher, requested } = makeFetcher({ [url]: { body: bytes("PNGDATA") } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const md = `Before\n\n![a cat](${url})\n\nAfter`;
		const out = await dl.downloadAndRewrite(md, "Feeds/images");

		expect(requested).toEqual([url]);
		expect(vault.binaries).toHaveLength(1);
		expect(vault.binaries[0]?.path).toBe("Feeds/images/photo.png");
		expect(vault.binaries[0]?.size).toBe("PNGDATA".length);
		// Reference rewritten to the local path; alt preserved.
		expect(out).toContain("![a cat](Feeds/images/photo.png)");
		expect(out).not.toContain(url);
		// Surrounding prose is untouched.
		expect(out).toContain("Before");
		expect(out).toContain("After");
	});

	it("creates the destination folder and its ancestors", async () => {
		const url = "https://x.test/a.jpg";
		const { fetcher } = makeFetcher({ [url]: { body: bytes("J") } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		await dl.downloadAndRewrite(`![](${url})`, "Feeds/Blog/images");

		expect(vault.createdFolders).toEqual(["Feeds", "Feeds/Blog", "Feeds/Blog/images"]);
	});

	it("leaves the original url in place when a download fails (transport error)", async () => {
		const ok = "https://x.test/ok.png";
		const bad = "https://x.test/bad.png";
		const { fetcher } = makeFetcher({
			[ok]: { body: bytes("OK") },
			[bad]: { throws: new Error("connection reset") },
		});
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const md = `![one](${ok})\n\n![two](${bad})`;
		const out = await dl.downloadAndRewrite(md, "images");

		// Good one is rewritten; bad one keeps its remote url verbatim.
		expect(out).toContain("![one](images/ok.png)");
		expect(out).toContain(`![two](${bad})`);
		// Only the good image was written.
		expect(vault.binaries.map((b) => b.path)).toEqual(["images/ok.png"]);
		expect(errorSpy).toHaveBeenCalled();
	});

	it("leaves the url in place on a non-2xx status", async () => {
		const url = "https://x.test/missing.png";
		const { fetcher } = makeFetcher({ [url]: { status: 404, body: bytes("nope") } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const out = await dl.downloadAndRewrite(`![x](${url})`, "images");

		expect(out).toBe(`![x](${url})`);
		expect(vault.binaries).toHaveLength(0);
	});

	it("leaves the url in place on an empty response body", async () => {
		const url = "https://x.test/empty.png";
		const { fetcher } = makeFetcher({ [url]: { body: new ArrayBuffer(0) } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const out = await dl.downloadAndRewrite(`![x](${url})`, "images");

		expect(out).toBe(`![x](${url})`);
		expect(vault.binaries).toHaveLength(0);
	});

	it("derives the extension from the content-type when the url has none", async () => {
		const url = "https://x.test/image";
		const { fetcher } = makeFetcher({
			[url]: { headers: { "Content-Type": "image/webp" }, body: bytes("W") },
		});
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		await dl.downloadAndRewrite(`![](${url})`, "images");

		expect(vault.binaries[0]?.path).toMatch(/^images\/.+\.webp$/);
	});

	it("downloads a repeated url only once and rewrites every occurrence", async () => {
		const url = "https://x.test/dup.png";
		const { fetcher, requested } = makeFetcher({ [url]: { body: bytes("D") } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const md = `![first](${url})\n\n![second](${url})`;
		const out = await dl.downloadAndRewrite(md, "images");

		expect(requested).toEqual([url]);
		expect(vault.binaries).toHaveLength(1);
		expect(out).toContain("![first](images/dup.png)");
		expect(out).toContain("![second](images/dup.png)");
	});

	it("disambiguates distinct urls that share a base filename", async () => {
		const a = "https://a.test/photo.png";
		const b = "https://b.test/photo.png";
		const { fetcher } = makeFetcher({
			[a]: { body: bytes("A") },
			[b]: { body: bytes("B") },
		});
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const out = await dl.downloadAndRewrite(`![](${a}) ![](${b})`, "images");

		const paths = vault.binaries.map((x) => x.path);
		expect(paths).toContain("images/photo.png");
		expect(paths).toContain("images/photo-1.png");
		expect(new Set(paths).size).toBe(2);
		expect(out).toContain("images/photo.png");
		expect(out).toContain("images/photo-1.png");
	});

	it("ignores non-http(s) image references (data: and relative)", async () => {
		const remote = "https://x.test/keep.png";
		const { fetcher, requested } = makeFetcher({ [remote]: { body: bytes("K") } });
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const md = [
			"![data](data:image/png;base64,AAAA)",
			"![rel](./local/pic.png)",
			`![remote](${remote})`,
		].join("\n\n");
		const out = await dl.downloadAndRewrite(md, "images");

		// Only the remote image was fetched.
		expect(requested).toEqual([remote]);
		// Non-http refs are left exactly as written.
		expect(out).toContain("![data](data:image/png;base64,AAAA)");
		expect(out).toContain("![rel](./local/pic.png)");
		expect(out).toContain("![remote](images/keep.png)");
	});

	it("returns markdown unchanged when there are no image references", async () => {
		const { fetcher, requested } = makeFetcher({});
		const vault = new FakeVault();
		const dl = new ImageDownloader({ fetcher, vault });

		const md = "Just text, [a link](https://x.test/page) but no images.";
		const out = await dl.downloadAndRewrite(md, "images");

		expect(out).toBe(md);
		expect(requested).toHaveLength(0);
		expect(vault.createdFolders).toHaveLength(0);
	});

	it("returns markdown unchanged when folder creation fails", async () => {
		const url = "https://x.test/a.png";
		const { fetcher, requested } = makeFetcher({ [url]: { body: bytes("A") } });
		const vault = new FakeVault();
		vault.createFolder = (): Promise<unknown> =>
			Promise.reject(new Error("cannot create folder"));
		const dl = new ImageDownloader({ fetcher, vault });

		const md = `![x](${url})`;
		const out = await dl.downloadAndRewrite(md, "images");

		expect(out).toBe(md);
		// We never attempted the download once the folder failed.
		expect(requested).toHaveLength(0);
		expect(errorSpy).toHaveBeenCalled();
	});
});
