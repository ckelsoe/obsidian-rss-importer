// Downloads remote images referenced by converted Markdown into the vault and
// rewrites the references to point at the local copies.
//
// This is the "download" half of the images-mode setting (the other mode,
// "link", leaves remote URLs untouched and never calls this module). It runs
// after HTML-to-Markdown conversion: every `![alt](url)` whose url is an
// absolute http(s) link is downloaded once, written under a per-feed image
// folder, and its reference rewritten to the vault-relative path.
//
// Robustness contract:
//   - Best effort. A single image that fails to download (transport error,
//     non-2xx, empty body, write error) leaves its ORIGINAL url in place and the
//     conversion continues. One broken image never sinks the note.
//   - Deterministic, deduplicated filenames. The same url within one call maps
//     to one downloaded file; distinct urls that sanitize to the same base name
//     are disambiguated with a numeric suffix.
//   - downloadAndRewrite never throws. Folder-creation failure degrades to
//     returning the markdown unchanged.
//
// No `obsidian` import and no DOM use: the vault surface is a structural
// interface so tests inject a plain object and main.ts passes app.vault.

import type { FeedItem, HttpFetcher } from "./feed-source";

/** A vault file/folder handle the downloader only needs a path from. */
export interface BinaryFileLike {
	readonly path: string;
}

/**
 * The minimal vault surface the downloader needs. Obsidian's Vault satisfies
 * this structurally (getFileByPath / getFolderByPath / createFolder return the
 * concrete TFile/TFolder, which carry a `path`; createBinary writes bytes).
 */
export interface VaultBinaryLike {
	getFileByPath(path: string): BinaryFileLike | null;
	getFolderByPath(path: string): BinaryFileLike | null;
	createFolder(path: string): Promise<unknown>;
	createBinary(path: string, data: ArrayBuffer): Promise<BinaryFileLike>;
}

export interface ImageDownloaderOptions {
	readonly fetcher: HttpFetcher;
	readonly vault: VaultBinaryLike;
}

// Matches a Markdown image: ![alt](url). The url group stops at the first
// closing paren or whitespace so a trailing `(width=...)` title or a following
// paren does not get swallowed. Alt text is captured but only used to rebuild
// the rewritten reference unchanged.
const IMAGE_REF = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g;

// Map common image content-types to a file extension when the URL has none.
const CONTENT_TYPE_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/svg": "svg",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
	"image/avif": "avif",
	"image/heic": "heic",
};

// Extensions we accept derived from a URL path. Anything else (or none) falls
// back to the content-type, then to a generic default.
const KNOWN_IMAGE_EXTS = new Set([
	"jpg", "jpeg", "png", "gif", "webp", "svg", "bmp",
	"tiff", "tif", "ico", "avif", "heic", "heif",
]);

const DEFAULT_EXT = "png";

export class ImageDownloader {
	private readonly fetcher: HttpFetcher;
	private readonly vault: VaultBinaryLike;

	constructor(opts: ImageDownloaderOptions) {
		this.fetcher = opts.fetcher;
		this.vault = opts.vault;
	}

	/**
	 * Download every absolute http(s) image referenced by `markdown` into
	 * `folderPath`, then return the markdown with each successfully-downloaded
	 * reference rewritten to its vault-relative local path. Never throws: a
	 * per-image failure leaves that reference untouched; a folder-creation
	 * failure returns the input markdown unchanged.
	 */
	async downloadAndRewrite(markdown: string, folderPath: string): Promise<string> {
		const folder = normalizeFolderPath(folderPath);

		// Collect the distinct downloadable urls first. Resolving each url once
		// keeps a url that appears multiple times mapped to a single download and
		// a single rewrite target.
		const urls = collectDownloadableUrls(markdown);
		if (urls.length === 0) {
			return markdown;
		}

		try {
			await this.ensureFolder(folder);
		} catch (err) {
			// Without the folder there is nowhere to write. Degrade to leaving
			// every reference as-is rather than throwing out of the conversion.
			console.error(err);
			return markdown;
		}

		// url -> vault-relative path, populated only for downloads that succeed.
		const rewrites = new Map<string, string>();
		// Track filenames used this call so distinct urls never collide on disk.
		const usedNames = new Set<string>();

		for (const url of urls) {
			try {
				const localPath = await this.downloadOne(url, folder, usedNames);
				if (localPath !== null) {
					rewrites.set(url, localPath);
				}
			} catch (err) {
				// Best effort: keep the original url and continue with the rest.
				console.error(err);
			}
		}

		if (rewrites.size === 0) {
			return markdown;
		}

		return rewriteRefs(markdown, rewrites);
	}

	/**
	 * Download one image and write it under `folder`. Returns the vault-relative
	 * path on success, or null when the image should be left as a remote url
	 * (non-2xx status, empty body). Throws only on an unexpected transport error,
	 * which the caller catches per-image.
	 */
	private async downloadOne(
		url: string,
		folder: string,
		usedNames: Set<string>,
	): Promise<string | null> {
		const response = await this.fetcher({ url, method: "GET" });
		if (response.status < 200 || response.status >= 300) {
			return null;
		}
		const bytes = response.arrayBuffer;
		if (bytes.byteLength === 0) {
			return null;
		}

		const contentType = headerValue(response.headers, "content-type");
		const ext = deriveExtension(url, contentType);
		const baseName = deriveBaseName(url);
		const fileName = uniqueFileName(baseName, ext, usedNames);
		const targetPath = folder === "" ? fileName : `${folder}/${fileName}`;

		await this.vault.createBinary(targetPath, bytes);
		return targetPath;
	}

	/**
	 * Create the folder and each missing ancestor. createFolder throws when the
	 * folder already exists, so each segment is checked first. A segment that
	 * already exists as a file is left alone (the binary write will surface a
	 * clear error if the target conflicts).
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
}

// -----------------------------------------------------------------------------
// Pure helpers (kept module-private; exercised through downloadAndRewrite).
// -----------------------------------------------------------------------------

/** Read a header case-insensitively; returns "" when absent. */
function headerValue(headers: Record<string, string>, name: string): string {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) {
			const value = headers[key];
			return value ?? "";
		}
	}
	return "";
}

/** True when a url is an absolute http(s) link we should try to download. */
function isAbsoluteHttp(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * Scan the markdown for image references and return the distinct absolute
 * http(s) urls in first-seen order. First-seen order makes a multi-image note's
 * download sequence deterministic, which keeps disambiguation suffixes stable.
 */
function collectDownloadableUrls(markdown: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	IMAGE_REF.lastIndex = 0;
	let match: RegExpExecArray | null = IMAGE_REF.exec(markdown);
	while (match !== null) {
		const url = match[2];
		if (url !== undefined && isAbsoluteHttp(url) && !seen.has(url)) {
			seen.add(url);
			out.push(url);
		}
		match = IMAGE_REF.exec(markdown);
	}
	return out;
}

/**
 * Rewrite every image reference whose url has a local replacement. The alt text
 * and any title segment are preserved by reusing the captured alt and pointing
 * the url at the local path. Urls without a replacement are left untouched.
 */
function rewriteRefs(markdown: string, rewrites: Map<string, string>): string {
	IMAGE_REF.lastIndex = 0;
	return markdown.replace(IMAGE_REF, (whole, alt: string, url: string) => {
		const local = rewrites.get(url);
		if (local === undefined) {
			return whole;
		}
		return `![${alt}](${local})`;
	});
}

/**
 * Derive a file extension. Prefer a known image extension from the URL path;
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

/** Extract a known image extension from a URL path, or null. */
function extFromUrl(url: string): string | null {
	const path = urlPath(url);
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot === path.length - 1) {
		return null;
	}
	const ext = path.slice(lastDot + 1).toLowerCase();
	return KNOWN_IMAGE_EXTS.has(ext) ? ext : null;
}

/**
 * The path portion of a url, stripped of query and fragment, without parsing
 * via URL (which is not guaranteed everywhere this runs). Strips the scheme and
 * authority so only the path text remains.
 */
function urlPath(url: string): string {
	let rest = url.replace(/^https?:\/\//i, "");
	rest = rest.split("#")[0] ?? rest;
	rest = rest.split("?")[0] ?? rest;
	const slash = rest.indexOf("/");
	return slash === -1 ? "" : rest.slice(slash);
}

/**
 * Derive a sanitized base filename (without extension) from a url. Uses the last
 * path segment when it has usable content, else a short hash of the url so two
 * distinct extensionless urls do not both fall back to the same literal name.
 */
function deriveBaseName(url: string): string {
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
		base = `image-${shortHash(url)}`;
	}
	return base;
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
 * Produce a filename unique within this call. Tries `base.ext` first, then
 * `base-1.ext`, `base-2.ext`, ... The chosen name is recorded so the next
 * distinct url cannot reuse it.
 */
function uniqueFileName(base: string, ext: string, used: Set<string>): string {
	const candidate = `${base}.${ext}`;
	if (!used.has(candidate.toLowerCase())) {
		used.add(candidate.toLowerCase());
		return candidate;
	}
	for (let n = 1; ; n++) {
		const next = `${base}-${n}.${ext}`;
		if (!used.has(next.toLowerCase())) {
			used.add(next.toLowerCase());
			return next;
		}
	}
}

/**
 * A short, stable, filesystem-safe hash of a string. Not cryptographic: it only
 * needs to keep two distinct extensionless urls from colliding on the same
 * fallback name. djb2 rendered base36.
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

/** Re-export FeedItem for callers that type a processImages adapter inline. */
export type { FeedItem };
