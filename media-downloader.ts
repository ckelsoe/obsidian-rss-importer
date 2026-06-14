// Downloads a feed item's media enclosure (podcast audio, attached audio/video)
// either into the vault or to an absolute filesystem path outside the vault.
//
// This mirrors image-downloader's robustness contract: best effort, never throw
// out of the import. A media failure (transport error, non-2xx, empty body,
// write error, non-desktop for the outside path) logs a one-line reason and
// returns null so the note is still written with the remote media-url intact.
//
// The vault path reuses image-downloader's VaultBinaryLike surface so Obsidian's
// Vault satisfies it structurally and tests inject a plain object. The outside
// path uses Node fs/path, which on a marketplace plugin must be require()'d
// behind a Platform.isDesktop guard (see CLAUDE.md). To keep the module unit
// testable without touching the real filesystem, the constructor accepts an
// optional fileWriter the outside path prefers over the Node fallback.

import { Platform } from "obsidian";
import type { FeedItem, HttpFetcher } from "./feed-source";
import type { BinaryFileLike, VaultBinaryLike } from "./image-downloader";

export type { BinaryFileLike, VaultBinaryLike };

/** Where the media for one item should be written. */
export type MediaLocation = "vault" | "outside";

/**
 * Writes raw bytes to an absolute filesystem path. Injected for tests so the
 * outside-vault path can be exercised without touching the real disk; when
 * absent, downloadToOutside falls back to Node fs behind a desktop guard.
 */
export type FileWriter = (absPath: string, data: ArrayBuffer) => void;

export interface MediaDownloaderOptions {
	readonly fetcher: HttpFetcher;
	readonly vault: VaultBinaryLike;
	readonly fileWriter?: FileWriter;
}

export interface MediaDownloadOptions {
	readonly location: MediaLocation;
	/** Vault-relative folder for the "vault" location. */
	readonly vaultFolder: string;
	/** Absolute filesystem folder for the "outside" location. */
	readonly outsideFolder: string;
}

// Map common enclosure content-types to a file extension. Audio and video MIME
// types the URL path may not carry. Anything unmapped falls back to the URL
// extension, then to a generic default.
const CONTENT_TYPE_EXT: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/x-m4a": "m4a",
	"audio/aac": "aac",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/flac": "flac",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"video/x-matroska": "mkv",
};

// Extensions accepted from a URL path. Anything else (or none) falls back to the
// content-type, then to a generic default.
const KNOWN_MEDIA_EXTS = new Set([
	"mp3", "m4a", "aac", "ogg", "opus", "wav", "flac",
	"mp4", "webm", "mov", "mkv", "m4v", "oga",
]);

const DEFAULT_EXT = "bin";

export class MediaDownloader {
	private readonly fetcher: HttpFetcher;
	private readonly vault: VaultBinaryLike;
	private readonly fileWriter?: FileWriter;

	constructor(opts: MediaDownloaderOptions) {
		this.fetcher = opts.fetcher;
		this.vault = opts.vault;
		this.fileWriter = opts.fileWriter;
	}

	/**
	 * Dispatch by location. Returns the written path (vault-relative or absolute)
	 * on success, or null when there is no media or the download/write failed.
	 */
	async download(item: FeedItem, opts: MediaDownloadOptions): Promise<string | null> {
		if (opts.location === "outside") {
			return this.downloadToOutside(item, opts.outsideFolder);
		}
		return this.downloadToVault(item, opts.vaultFolder);
	}

	/**
	 * Fetch the item's media and write it under `folderPath` in the vault. Returns
	 * the vault-relative path on success. Returns null (never throws) when there
	 * is no media url, the fetch is non-2xx or empty, or any write step fails.
	 */
	async downloadToVault(item: FeedItem, folderPath: string): Promise<string | null> {
		const mediaUrl = item.mediaUrl;
		if (mediaUrl === null || mediaUrl.length === 0) {
			return null;
		}

		const fetched = await this.fetchMedia(mediaUrl);
		if (fetched === null) {
			return null;
		}

		const folder = normalizeFolderPath(folderPath);
		try {
			await this.ensureFolder(folder);
		} catch (err) {
			console.error(`RSS Importer: media download skipped for ${mediaUrl}: ${describe(err)}`);
			return null;
		}

		const fileName = deriveFileName(item, mediaUrl, fetched.contentType);
		const targetPath = folder === "" ? fileName : `${folder}/${fileName}`;
		const uniquePath = await this.uniqueVaultPath(targetPath);

		try {
			await this.vault.createBinary(uniquePath, fetched.bytes);
		} catch (err) {
			console.error(`RSS Importer: media write failed for ${mediaUrl}: ${describe(err)}`);
			return null;
		}
		return uniquePath;
	}

	/**
	 * Fetch the item's media and write it to an absolute path under `absFolder`.
	 * Desktop only. Uses the injected fileWriter when present (tests); otherwise
	 * Node fs/path behind a Platform.isDesktop guard. Returns the absolute path on
	 * success, or null (never throws) on non-desktop, no media, or any failure.
	 */
	async downloadToOutside(item: FeedItem, absFolder: string): Promise<string | null> {
		const mediaUrl = item.mediaUrl;
		if (mediaUrl === null || mediaUrl.length === 0) {
			return null;
		}
		if (this.fileWriter === undefined && !Platform.isDesktop) {
			console.error(`RSS Importer: media download skipped for ${mediaUrl}: outside-vault writes need a desktop app`);
			return null;
		}
		if (absFolder.length === 0) {
			console.error(`RSS Importer: media download skipped for ${mediaUrl}: no outside folder configured`);
			return null;
		}

		const fetched = await this.fetchMedia(mediaUrl);
		if (fetched === null) {
			return null;
		}

		const fileName = deriveFileName(item, mediaUrl, fetched.contentType);

		try {
			return this.writeOutside(absFolder, fileName, fetched.bytes);
		} catch (err) {
			console.error(`RSS Importer: media write failed for ${mediaUrl}: ${describe(err)}`);
			return null;
		}
	}

	/**
	 * Write bytes to absFolder/fileName, preferring the injected fileWriter. When
	 * none is injected, use Node fs/path behind a desktop guard: require() rather
	 * than a top-level import keeps the bundle clean of Node built-ins on mobile,
	 * per the marketplace scorecard. Returns the absolute path written.
	 */
	private writeOutside(absFolder: string, fileName: string, bytes: ArrayBuffer): string {
		if (this.fileWriter !== undefined) {
			const joined = joinPosix(absFolder, fileName);
			this.fileWriter(joined, bytes);
			return joined;
		}
		const { fs, path } = getNodeFsPath();
		fs.mkdirSync(absFolder, { recursive: true });
		const target = path.join(absFolder, fileName);
		fs.writeFileSync(target, Buffer.from(bytes));
		return target;
	}

	/**
	 * GET the media url and validate the response. Returns the bytes and the
	 * content-type on success, or null (logged) on non-2xx, empty body, or a
	 * transport error.
	 */
	private async fetchMedia(
		url: string,
	): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
		let response;
		try {
			response = await this.fetcher({ url, method: "GET" });
		} catch (err) {
			console.error(`RSS Importer: media download failed for ${url}: ${describe(err)}`);
			return null;
		}
		if (response.status < 200 || response.status >= 300) {
			console.error(`RSS Importer: media download skipped for ${url}: status ${response.status}`);
			return null;
		}
		const bytes = response.arrayBuffer;
		if (bytes.byteLength === 0) {
			console.error(`RSS Importer: media download skipped for ${url}: empty body`);
			return null;
		}
		return { bytes, contentType: headerValue(response.headers, "content-type") };
	}

	/**
	 * Create the folder and each missing ancestor. createFolder throws when the
	 * folder already exists, so each segment is checked first.
	 */
	private async ensureFolder(folder: string): Promise<void> {
		if (folder === "") {
			return;
		}
		const segments = folder.split("/");
		for (let i = 1; i <= segments.length; i++) {
			const partial = segments.slice(0, i).join("/");
			if (this.vault.getFolderByPath(partial) === null) {
				await this.vault.createFolder(partial);
			}
		}
	}

	/**
	 * Resolve a non-colliding vault path. If the target already exists, append a
	 * numeric suffix before the extension (name-1.ext, name-2.ext, ...).
	 */
	private async uniqueVaultPath(targetPath: string): Promise<string> {
		if (this.vault.getFileByPath(targetPath) === null) {
			return targetPath;
		}
		const { dir, base, ext } = splitPath(targetPath);
		for (let n = 1; ; n++) {
			const candidate = dir === "" ? `${base}-${n}${ext}` : `${dir}/${base}-${n}${ext}`;
			if (this.vault.getFileByPath(candidate) === null) {
				return candidate;
			}
		}
	}
}

// -----------------------------------------------------------------------------
// Pure helpers (kept module-private; exercised through the public methods).
// -----------------------------------------------------------------------------

/**
 * Resolve Node's fs and path modules. Obsidian's guidelines require Node
 * built-ins to be loaded via a Platform.isDesktop-guarded require() so the
 * mobile bundle never references them; callers must gate on Platform.isDesktop
 * before reaching here. The require, the unsafe cast, and the node-module import
 * are the unavoidable consequences of that guidance.
 */
function getNodeFsPath(): { fs: typeof import("fs"); path: typeof import("path") } {
	if (!Platform.isDesktop) {
		throw new Error("Node fs/path modules are not available on this platform.");
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Obsidian docs require a Platform.isDesktop-guarded require() for Node built-ins so mobile builds do not pull them in; the require is the unavoidable consequence of that guidance.
	const fs = require("fs") as typeof import("fs");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Obsidian docs require a Platform.isDesktop-guarded require() for Node built-ins so mobile builds do not pull them in; the require is the unavoidable consequence of that guidance.
	const path = require("path") as typeof import("path");
	return { fs, path };
}

/** Read a header case-insensitively; returns "" when absent. */
function headerValue(headers: Record<string, string>, name: string): string {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) {
			return headers[key] ?? "";
		}
	}
	return "";
}

/** Render a caught unknown into a one-line message. */
function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Derive the media filename: a sanitized item title (preferred) or the URL
 * basename, plus an extension from the content-type, then the URL, then a
 * generic default.
 */
function deriveFileName(item: FeedItem, url: string, contentType: string): string {
	const ext = deriveExtension(url, contentType);
	const base = deriveBaseName(item, url);
	return `${base}.${ext}`;
}

/**
 * Derive a file extension. Prefer a known media extension from the URL path;
 * otherwise map the content-type; otherwise fall back to a generic default so a
 * file always gets a usable extension.
 */
function deriveExtension(url: string, contentType: string): string {
	const fromUrl = extFromUrl(url);
	if (fromUrl !== null) {
		return fromUrl;
	}
	const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	const mapped = CONTENT_TYPE_EXT[ct];
	if (mapped !== undefined) {
		return mapped;
	}
	return DEFAULT_EXT;
}

/** Extract a known media extension from a URL path, or null. */
function extFromUrl(url: string): string | null {
	const path = urlPath(url);
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot === path.length - 1) {
		return null;
	}
	const ext = path.slice(lastDot + 1).toLowerCase();
	return KNOWN_MEDIA_EXTS.has(ext) ? ext : null;
}

/**
 * Derive a sanitized base filename (without extension). Prefer the item title;
 * fall back to the URL's last path segment; fall back to a short hash of the url
 * so two distinct extensionless urls do not collide on the same literal name.
 */
function deriveBaseName(item: FeedItem, url: string): string {
	const fromTitle = sanitizeBaseName(item.title);
	if (fromTitle.length > 0) {
		return fromTitle;
	}
	const path = urlPath(url);
	const segments = path.split("/").filter((s) => s.length > 0);
	const last = segments.length > 0 ? segments[segments.length - 1] : undefined;
	let base = last ?? "";
	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		base = base.slice(0, dot);
	}
	base = sanitizeBaseName(base);
	if (base.length === 0) {
		base = `media-${shortHash(url)}`;
	}
	return base;
}

/**
 * The path portion of a url, stripped of query and fragment, without parsing via
 * URL (not guaranteed everywhere this runs). Strips the scheme and authority so
 * only the path text remains.
 */
function urlPath(url: string): string {
	let rest = url.replace(/^https?:\/\//i, "");
	rest = rest.split("#")[0] ?? rest;
	rest = rest.split("?")[0] ?? rest;
	const slash = rest.indexOf("/");
	return slash === -1 ? "" : rest.slice(slash);
}

/**
 * Sanitize a filename base: drop characters illegal on Windows/macOS/Linux and
 * Obsidian's wikilink brackets, collapse whitespace and dot/space runs, clamp
 * length. Returns "" when nothing usable remains so the caller can fall back.
 */
function sanitizeBaseName(name: string): string {
	let out = name.trim().replace(/\s+/g, "-");
	// eslint-disable-next-line no-control-regex -- strip NUL and other non-whitespace control codes from the filename
	out = out.replace(/[<>:"/\\|?*\x00-\x1f[\]]/g, "-");
	out = out.replace(/-+/g, "-");
	out = out.replace(/^[.\- ]+/, "").replace(/[.\- ]+$/, "");
	if (out.length > 100) {
		out = out.slice(0, 100).replace(/[.\- ]+$/, "");
	}
	return out;
}

/**
 * Split a path into its directory, base name (no extension), and extension
 * (including the leading dot, or empty). Path separator is the vault "/".
 */
function splitPath(p: string): { dir: string; base: string; ext: string } {
	const slash = p.lastIndexOf("/");
	const dir = slash === -1 ? "" : p.slice(0, slash);
	const file = slash === -1 ? p : p.slice(slash + 1);
	const dot = file.lastIndexOf(".");
	if (dot <= 0) {
		return { dir, base: file, ext: "" };
	}
	return { dir, base: file.slice(0, dot), ext: file.slice(dot) };
}

/** Join a folder and a file name with a single forward slash. */
function joinPosix(folder: string, fileName: string): string {
	const trimmed = folder.replace(/[/\\]+$/, "");
	return trimmed.length === 0 ? fileName : `${trimmed}/${fileName}`;
}

/**
 * A short, stable, filesystem-safe hash. Not cryptographic: it only needs to
 * keep two distinct extensionless urls from colliding on the same fallback name.
 * djb2 rendered base36.
 */
function shortHash(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
	}
	return hash.toString(36);
}

/**
 * Normalize a vault folder path: trim, drop leading/trailing slashes, collapse
 * doubled slashes, drop `.` and `..` segments. `..` is dropped (not thrown on)
 * because this is an internal best-effort path, not a user-facing destination.
 */
function normalizeFolderPath(folder: string): string {
	const cleaned = folder
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	const segments = cleaned
		.split("/")
		.filter((s) => s !== "" && s !== "." && s !== "..");
	return segments.join("/");
}
