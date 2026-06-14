/**
 * Classifies a user-supplied feed input and resolves it to a canonical,
 * fetchable feed.
 *
 * The user can type a Substack handle (`@kevin` or `substack.com/@kevin`), a
 * Substack subdomain (`kevin.substack.com`), a Substack post URL
 * (`.../p/some-slug`), a custom domain that fronts a Substack, or a plain feed
 * URL (`.../feed`, `.../rss`). This resolver figures out which of those it is
 * and produces the one canonical feed URL the source should enumerate from.
 *
 * It does NOT parse feed items. Its only job is classification plus
 * canonicalization: pick the source type, find the canonical host, and return
 * the feed URL. The `FeedSource` reads items from that URL afterwards.
 *
 * Two host-canonicalization wrinkles it handles:
 *
 *  1. Substack handles. A handle does not name a host, so the resolver calls
 *     the public profile API to learn the publication's custom domain or
 *     `<subdomain>.substack.com`.
 *  2. Redirects. A `kevin.substack.com` publication that later moved to a
 *     custom domain answers feed requests with a 3xx to the custom domain. The
 *     resolver walks those redirects manually (hop cap 5) so the canonical host
 *     reflects where the feed actually lives. It also tolerates the
 *     `requestUrl` auto-follow case, where a request returns a direct 200 with
 *     no redirect to walk; there the requested host is treated as canonical.
 *
 * The resolver depends only on the injected `HttpFetcher`, never on Obsidian,
 * so it is unit-testable with a stub fetcher.
 */

import type { HttpFetcher, HttpResponse, SourceType } from "./feed-source";

/** Maximum number of 3xx redirects to follow before giving up. */
const MAX_REDIRECT_HOPS = 5;

/** Lowest status code that counts as a redirect. */
const HTTP_REDIRECT_MIN = 300;

/** One past the highest status code that counts as a redirect. */
const HTTP_REDIRECT_MAX = 400;

/** The host all Substack handle and profile-API requests go through. */
const SUBSTACK_HOST = "substack.com";

/** Suffix that marks a Substack-hosted subdomain. */
const SUBSTACK_SUFFIX = ".substack.com";

/** Path suffixes that unambiguously name a feed without probing. */
const FEED_PATH_SUFFIXES = ["/feed", "/rss", "/feed/podcast"];

/** The result of resolving an input to a canonical, fetchable feed. */
export interface ResolverResult {
	/** Which source implementation should handle this feed. */
	sourceType: SourceType;
	/** Canonical host the feed (and any API calls) resolve to. */
	canonicalHost: string;
	/** Canonical feed URL items are enumerated from. */
	feedUrl: string;
	/** Substack handle when the input named one, else null. */
	handle: string | null;
}

/**
 * Raised when an input cannot be resolved to a feed: malformed input, a profile
 * lookup that returned nothing usable, or a redirect chain that exceeded the
 * hop cap. The message states the specific reason; the original cause (when
 * there is one) is attached so callers can surface it.
 */
export class ResolveError extends Error {
	/** The underlying error, when this wraps one. */
	readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "ResolveError";
		this.cause = cause;
	}
}

/** Shape of the Substack public profile fields the resolver reads. */
interface ProfilePublication {
	subdomain?: unknown;
	custom_domain?: unknown;
}

/** Looks up a header case-insensitively; headers may use any casing. */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) {
			return headers[key];
		}
	}
	return undefined;
}

/** True when a status code is in the 3xx redirect range. */
function isRedirect(status: number): boolean {
	return status >= HTTP_REDIRECT_MIN && status < HTTP_REDIRECT_MAX;
}

/**
 * Parses a URL, throwing a ResolveError (rather than a bare TypeError) when the
 * input is not a usable absolute URL.
 */
function parseUrl(raw: string): URL {
	try {
		return new URL(raw);
	} catch (err) {
		throw new ResolveError(`Not a valid URL: ${raw}`, err);
	}
}

/**
 * Adds a scheme to a bare host or host/path so it parses as an absolute URL.
 * Leaves inputs that already carry a scheme untouched.
 */
function ensureScheme(raw: string): string {
	return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** True when a host is `substack.com` itself (not a subdomain of it). */
function isSubstackApex(host: string): boolean {
	return host.toLowerCase() === SUBSTACK_HOST;
}

/** True when a host is `<something>.substack.com`. */
function isSubstackSubdomain(host: string): boolean {
	return host.toLowerCase().endsWith(SUBSTACK_SUFFIX);
}

/** True when a path ends in a recognized feed suffix. */
function hasFeedPathSuffix(pathname: string): boolean {
	const lower = pathname.replace(/\/$/, "").toLowerCase();
	return FEED_PATH_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** True when a content-type names an XML/RSS/Atom payload. */
function looksLikeXmlContentType(contentType: string | undefined): boolean {
	if (contentType === undefined) {
		return false;
	}
	const lower = contentType.toLowerCase();
	return lower.includes("xml") || lower.includes("rss") || lower.includes("atom");
}

/**
 * True when a response body begins like a feed: an XML declaration or a
 * recognized feed root element. An HTML document (`<!DOCTYPE html>`, `<html>`)
 * must not match, so a plain `<` prefix is not enough.
 */
function bodyLooksLikeFeed(text: string): boolean {
	const head = text.trimStart().slice(0, 200).toLowerCase();
	return (
		head.startsWith("<?xml") ||
		head.startsWith("<rss") ||
		head.startsWith("<feed") ||
		head.startsWith("<rdf")
	);
}

/**
 * Extracts a bare Substack handle from an input, or null when the input does
 * not name one. Accepts `@handle`, `substack.com/@handle`, and
 * `https://substack.com/@handle` (with optional trailing path or slash).
 */
function extractHandle(raw: string): string | null {
	const trimmed = raw.trim();
	const bare = /^@([A-Za-z0-9_-]+)$/.exec(trimmed);
	if (bare) {
		return bare[1] ?? null;
	}
	const withScheme = /^(?:https?:\/\/)?(?:www\.)?substack\.com\/@([A-Za-z0-9_-]+)/i.exec(trimmed);
	if (withScheme) {
		return withScheme[1] ?? null;
	}
	return null;
}

/**
 * Reads the canonical host from a Substack publication object: the custom
 * domain when present, otherwise `<subdomain>.substack.com`. Returns null when
 * neither field is a usable string.
 */
function hostFromPublication(pub: ProfilePublication | undefined): string | null {
	if (pub === undefined) {
		return null;
	}
	if (typeof pub.custom_domain === "string" && pub.custom_domain.trim().length > 0) {
		return pub.custom_domain.trim().toLowerCase();
	}
	if (typeof pub.subdomain === "string" && pub.subdomain.trim().length > 0) {
		return `${pub.subdomain.trim().toLowerCase()}${SUBSTACK_SUFFIX}`;
	}
	return null;
}

/**
 * Reads the publication object out of a public_profile JSON response. Prefers
 * `primaryPublication`, then the primary entry of `publicationUsers`, then the
 * first `publicationUsers` entry. Returns undefined when the JSON has none.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function publicationFromProfile(json: unknown): ProfilePublication | undefined {
	if (!isRecord(json)) {
		return undefined;
	}

	const primary = json["primaryPublication"];
	if (isRecord(primary)) {
		return primary;
	}

	const users = json["publicationUsers"];
	if (Array.isArray(users)) {
		const list: unknown[] = users;
		const primaryUser: unknown =
			list.find((u): u is Record<string, unknown> => isRecord(u) && u["is_primary"] === true) ??
			list[0];
		if (isRecord(primaryUser)) {
			const pub = primaryUser["publication"];
			if (isRecord(pub)) {
				return pub;
			}
		}
	}

	return undefined;
}

export class FeedResolver {
	private readonly fetcher: HttpFetcher;

	constructor(fetcher: HttpFetcher) {
		this.fetcher = fetcher;
	}

	/**
	 * Classifies `input` and resolves it to a canonical feed.
	 *
	 * Dispatch order:
	 *  1. A Substack handle (`@x`, `substack.com/@x`) -> profile API lookup.
	 *  2. A URL whose host is `*.substack.com` -> Substack, feed at host/feed.
	 *     A `/p/<slug>` post URL on a substack.com host falls in here; the same
	 *     path on a custom domain does not (those are added via @handle).
	 *  3. A URL whose path already names a feed (`/feed`, `/rss`, ...) -> generic.
	 *  4. Any other URL -> probe `host/feed`; XML means generic.
	 *
	 * In cases 2 to 4 the canonical host is derived by walking redirects from
	 * the candidate feed URL, so a publication that moved hosts resolves to
	 * where its feed actually lives.
	 */
	async resolve(input: string): Promise<ResolverResult> {
		const trimmed = input.trim();
		if (trimmed.length === 0) {
			throw new ResolveError("Empty input");
		}

		const handle = extractHandle(trimmed);
		if (handle !== null) {
			return this.resolveHandle(handle);
		}

		const url = parseUrl(ensureScheme(trimmed));

		if (isSubstackApex(url.hostname)) {
			// `substack.com/...` that is not an `@handle` is not a feed we can
			// canonicalize without more information.
			throw new ResolveError(`Not a resolvable Substack input: ${trimmed}`);
		}

		// A Substack post URL is recognized as Substack only on a substack.com
		// host. A `/p/<slug>` path on a custom domain is NOT enough to claim
		// Substack: a non-Substack site can use the same path shape. Custom-domain
		// Substacks are added via the @handle path instead, which the profile API
		// canonicalizes correctly.
		if (isSubstackSubdomain(url.hostname)) {
			return this.resolveSubstackHost(url.hostname, null);
		}

		if (hasFeedPathSuffix(url.pathname)) {
			return this.resolveGenericFeedUrl(url.toString());
		}

		return this.probeForFeed(url.hostname);
	}

	/**
	 * Resolves a Substack handle: GET the public profile, read the publication's
	 * custom domain or subdomain, then canonicalize that host (walking any
	 * redirect to a moved custom domain).
	 */
	private async resolveHandle(handle: string): Promise<ResolverResult> {
		const profileUrl = `https://${SUBSTACK_HOST}/api/v1/user/${encodeURIComponent(handle)}/public_profile`;
		let response: HttpResponse;
		try {
			response = await this.fetcher({ url: profileUrl });
		} catch (err) {
			throw new ResolveError(`Profile lookup failed for @${handle}`, err);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new ResolveError(`Profile lookup for @${handle} returned status ${response.status}`);
		}

		const publication = publicationFromProfile(response.json);
		const host = hostFromPublication(publication);
		if (host === null) {
			throw new ResolveError(`No publication found for @${handle}`);
		}
		return this.resolveSubstackHost(host, handle);
	}

	/**
	 * Canonicalizes a Substack host by walking redirects from `host/feed`, then
	 * returns the canonical feed URL. The host the chain lands on is canonical.
	 */
	private async resolveSubstackHost(host: string, handle: string | null): Promise<ResolverResult> {
		const candidate = `https://${host.toLowerCase()}/feed`;
		const canonicalHost = await this.walkToCanonicalHost(candidate);
		return {
			sourceType: "substack",
			canonicalHost,
			feedUrl: `https://${canonicalHost}/feed`,
			handle,
		};
	}

	/**
	 * Resolves a plain feed URL (one whose path already names a feed) as a
	 * generic feed, walking redirects to find the canonical host.
	 */
	private async resolveGenericFeedUrl(feedUrl: string): Promise<ResolverResult> {
		const finalUrl = await this.walkToCanonicalUrl(feedUrl);
		return {
			sourceType: "generic",
			canonicalHost: finalUrl.hostname.toLowerCase(),
			feedUrl: finalUrl.toString(),
			handle: null,
		};
	}

	/**
	 * Probes `host/feed` for a feed when the input gave no feed path. A response
	 * that reads as XML resolves as a generic feed at the (post-redirect)
	 * canonical host. Anything else is not a feed we can use.
	 */
	private async probeForFeed(host: string): Promise<ResolverResult> {
		const candidate = `https://${host.toLowerCase()}/feed`;
		const { finalUrl, response } = await this.walkRedirects(candidate);
		const contentType = getHeader(response.headers, "Content-Type");
		const isXml = looksLikeXmlContentType(contentType) || bodyLooksLikeFeed(response.text);
		if (response.status >= 200 && response.status < 300 && isXml) {
			return {
				sourceType: "generic",
				canonicalHost: finalUrl.hostname.toLowerCase(),
				feedUrl: finalUrl.toString(),
				handle: null,
			};
		}
		throw new ResolveError(`No feed found at ${candidate}`);
	}

	/** Walks redirects from a URL and returns just the canonical host. */
	private async walkToCanonicalHost(startUrl: string): Promise<string> {
		const { finalUrl } = await this.walkRedirects(startUrl);
		return finalUrl.hostname.toLowerCase();
	}

	/** Walks redirects from a URL and returns just the final resolved URL. */
	private async walkToCanonicalUrl(startUrl: string): Promise<URL> {
		const { finalUrl } = await this.walkRedirects(startUrl);
		return finalUrl;
	}

	/**
	 * Follows 3xx redirects manually starting from `startUrl`, resolving relative
	 * Location headers against the current URL, up to MAX_REDIRECT_HOPS hops.
	 *
	 * Returns the final URL and the final non-redirect response. A direct 200
	 * (the `requestUrl` auto-follow case, where the redirect was already
	 * followed and no Location is present to walk) ends the walk at the
	 * requested URL. A 3xx that exceeds the hop cap, or one missing a Location
	 * header, raises a ResolveError.
	 */
	private async walkRedirects(startUrl: string): Promise<{ finalUrl: URL; response: HttpResponse }> {
		let current = parseUrl(startUrl);
		for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
			let response: HttpResponse;
			try {
				response = await this.fetcher({ url: current.toString() });
			} catch (err) {
				throw new ResolveError(`Request failed for ${current.toString()}`, err);
			}

			if (!isRedirect(response.status)) {
				// Either a real 200/4xx/5xx, or the auto-followed 200 case: the
				// requested URL is canonical.
				return { finalUrl: current, response };
			}

			const location = getHeader(response.headers, "Location");
			if (location === undefined || location.trim().length === 0) {
				throw new ResolveError(
					`Redirect from ${current.toString()} had no Location header`,
				);
			}
			// Resolve relative Locations against the current URL.
			current = new URL(location.trim(), current);
		}

		throw new ResolveError(
			`Too many redirects resolving ${startUrl} (cap ${MAX_REDIRECT_HOPS})`,
		);
	}
}
