/**
 * Feed XML parser.
 *
 * Parses RSS 2.0, Atom 1.0, and podcast (RSS + itunes:*) XML into a flat
 * intermediate shape (`ParsedFeed` / `RawFeedItem`). The source layer maps each
 * `RawFeedItem` onto the normalized `FeedItem` contract; this module stays
 * source-agnostic and does no HTTP, no DOM rendering, and no normalization
 * beyond date-to-ISO and trimming.
 *
 * Design notes:
 * - DOMParser is constructed LAZILY inside `parseFeed`, never at module load, so
 *   importing this file in a plain Node context (no `document`/`window`) is safe.
 * - Namespaced tags (content:encoded, dc:creator, itunes:*) are read by their
 *   full qualified name AND by a namespace-agnostic localName scan, because
 *   DOMParser namespace resolution varies between engines (browser jsdom vs
 *   Obsidian's Electron). Relying on `getElementsByTagNameNS` alone is fragile.
 * - We validate the envelope once (a recognizable channel/feed root) and
 *   tolerate sloppy item values (missing dates normalize to null rather than
 *   throwing), matching the parser convention in this plugin.
 */

/** A media enclosure attached to an item (podcast audio, cover image, ...). */
export interface RawEnclosure {
	url: string;
	type: string | null;
	length: number | null;
}

/**
 * One feed item before normalization. Every field is best-effort: a producer may
 * omit any of them. `title` is always a string (empty when the feed omits it) so
 * downstream code never has to guard the most-used field.
 */
export interface RawFeedItem {
	guid: string | null;
	link: string | null;
	title: string;
	author: string | null;
	/** ISO 8601 timestamp, or null when the date is absent or unparseable. */
	pubDateIso: string | null;
	/** content:encoded (RSS) or atom <content>, preferred over `description`. */
	contentHtml: string | null;
	/** RSS <description> or atom <summary>. */
	description: string | null;
	categories: string[];
	enclosure: RawEnclosure | null;
}

/** A parsed feed: channel/feed metadata plus its items. */
export interface ParsedFeed {
	feedTitle: string;
	feedLink: string | null;
	items: RawFeedItem[];
}

/**
 * Thrown when the XML cannot be parsed (a DOMParser `<parsererror>`) or when no
 * recognizable RSS `<channel>` or Atom `<feed>` root is present. The original
 * parser-error text, when available, is surfaced in the message so the caller
 * can show or log a useful reason rather than a bare "parse failed".
 */
export class FeedParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FeedParseError";
	}
}

/**
 * Read the text content of the first direct (or any-descendant) child element of
 * `parent` matching one of `names`, comparing by localName so a namespace prefix
 * (`dc:creator`) or a default-namespaced tag both match. Returns a trimmed
 * string, or null when nothing matches or the matched element is empty.
 *
 * `directOnly` restricts the scan to immediate children, which matters for tags
 * like <title> and <link> that can legitimately appear deeper inside item bodies
 * or nested structures.
 */
function readText(
	parent: Element,
	names: readonly string[],
	directOnly: boolean,
): string | null {
	const wanted = names.map((n) => n.toLowerCase());
	const scope = directOnly ? parent.children : parent.getElementsByTagName("*");
	for (let i = 0; i < scope.length; i += 1) {
		const el = scope.item(i);
		if (el === null) {
			continue;
		}
		if (!wanted.includes(el.localName.toLowerCase())) {
			continue;
		}
		const text = el.textContent;
		if (text === null) {
			continue;
		}
		const trimmed = text.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

/**
 * Find the first direct-child element of `parent` whose localName matches one of
 * `names`. Used for elements whose attributes we need (enclosure, atom link).
 */
function findChild(parent: Element, names: readonly string[]): Element | null {
	const wanted = names.map((n) => n.toLowerCase());
	const children = parent.children;
	for (let i = 0; i < children.length; i += 1) {
		const el = children.item(i);
		if (el === null) {
			continue;
		}
		if (wanted.includes(el.localName.toLowerCase())) {
			return el;
		}
	}
	return null;
}

/** Collect all direct-child elements of `parent` matching one of `names`. */
function findChildren(parent: Element, names: readonly string[]): Element[] {
	const wanted = names.map((n) => n.toLowerCase());
	const out: Element[] = [];
	const children = parent.children;
	for (let i = 0; i < children.length; i += 1) {
		const el = children.item(i);
		if (el === null) {
			continue;
		}
		if (wanted.includes(el.localName.toLowerCase())) {
			out.push(el);
		}
	}
	return out;
}

/** Parse a non-empty integer attribute, returning null on absence or garbage. */
function parseIntAttr(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a feed date string (RFC 822 pubDate or ISO atom updated/published)
 * to ISO 8601. Returns null when the value is absent or not a parseable date,
 * rather than throwing, so one bad timestamp never fails the whole feed.
 */
function toIso(raw: string | null): string | null {
	if (raw === null) {
		return null;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return null;
	}
	const ms = Date.parse(trimmed);
	if (!Number.isFinite(ms)) {
		return null;
	}
	return new Date(ms).toISOString();
}

/**
 * Resolve the enclosure for an item. RSS uses <enclosure url type length>; Atom
 * uses <link rel="enclosure" href type length>. Returns null when no usable URL
 * is present (an enclosure without a url is not actionable).
 */
function readEnclosure(item: Element): RawEnclosure | null {
	const rssEnclosure = findChild(item, ["enclosure"]);
	if (rssEnclosure !== null) {
		const url = rssEnclosure.getAttribute("url");
		if (url !== null && url.trim().length > 0) {
			return {
				url: url.trim(),
				type: emptyToNull(rssEnclosure.getAttribute("type")),
				length: parseIntAttr(rssEnclosure.getAttribute("length")),
			};
		}
	}

	for (const link of findChildren(item, ["link"])) {
		if ((link.getAttribute("rel") ?? "").toLowerCase() !== "enclosure") {
			continue;
		}
		const href = link.getAttribute("href");
		if (href !== null && href.trim().length > 0) {
			return {
				url: href.trim(),
				type: emptyToNull(link.getAttribute("type")),
				length: parseIntAttr(link.getAttribute("length")),
			};
		}
	}
	return null;
}

/** Trim a possibly-null attribute, collapsing empty strings to null. */
function emptyToNull(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolve an item's canonical link. RSS <link> carries the URL as text content.
 * Atom <link> carries it in the `href` attribute, with `rel="alternate"` (or no
 * rel) being the canonical permalink; enclosure/self links are skipped.
 */
function readItemLink(item: Element): string | null {
	const links = findChildren(item, ["link"]);
	// Prefer an Atom alternate/relless link via href.
	for (const link of links) {
		const rel = (link.getAttribute("rel") ?? "alternate").toLowerCase();
		if (rel === "enclosure" || rel === "self") {
			continue;
		}
		const href = link.getAttribute("href");
		if (href !== null && href.trim().length > 0) {
			return href.trim();
		}
	}
	// Fall back to RSS <link> text content.
	for (const link of links) {
		const text = link.textContent;
		if (text !== null && text.trim().length > 0) {
			return text.trim();
		}
	}
	return null;
}

/**
 * Resolve an item's author. RSS uses dc:creator (or <author>, which on RSS is an
 * email and on Atom is a wrapper element holding <name>). We try dc:creator
 * first, then an Atom <author><name>, then a plain <author> text node.
 */
function readAuthor(item: Element): string | null {
	const creator = readText(item, ["creator"], true);
	if (creator !== null) {
		return creator;
	}
	const authorEl = findChild(item, ["author"]);
	if (authorEl !== null) {
		const name = readText(authorEl, ["name"], true);
		if (name !== null) {
			return name;
		}
		const text = authorEl.textContent;
		if (text !== null && text.trim().length > 0) {
			return text.trim();
		}
	}
	return null;
}

/**
 * Collect categories. RSS <category> carries the value as text content; Atom
 * <category term="..."> carries it in the `term` attribute. Both are gathered
 * and de-duplicated while preserving order.
 */
function readCategories(item: Element): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const cat of findChildren(item, ["category"])) {
		const term = emptyToNull(cat.getAttribute("term"));
		const text = cat.textContent === null ? null : cat.textContent.trim();
		const value = term ?? (text !== null && text.length > 0 ? text : null);
		if (value === null) {
			continue;
		}
		const key = value.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(value);
	}
	return out;
}

/** Map a single <item> (RSS) or <entry> (Atom) element to a RawFeedItem. */
function readItem(item: Element): RawFeedItem {
	const title = readText(item, ["title"], true) ?? "";
	const contentHtml = readText(item, ["encoded", "content"], true);
	const description = readText(item, ["description", "summary", "subtitle"], true);
	const pubDate = readText(item, ["pubdate", "published", "updated", "date"], true);
	return {
		guid: readText(item, ["guid", "id"], true),
		link: readItemLink(item),
		title,
		author: readAuthor(item),
		pubDateIso: toIso(pubDate),
		contentHtml,
		description,
		categories: readCategories(item),
		enclosure: readEnclosure(item),
	};
}

/**
 * Locate the channel/feed root and its item elements, supporting both RSS
 * (rss > channel > item) and Atom (feed > entry). Returns null when neither
 * shape is recognizable so the caller can throw a `FeedParseError`.
 */
function locateRoot(
	doc: Document,
): { root: Element; items: Element[]; isAtom: boolean } | null {
	// RSS: <rss><channel>...</channel></rss> (channel may also be the doc root in
	// RDF-flavored feeds, so scan by localName rather than assuming the path).
	const channels = doc.getElementsByTagName("channel");
	const channel = channels.item(0);
	if (channel !== null) {
		const items = findChildren(channel, ["item"]);
		return { root: channel, items, isAtom: false };
	}

	// Atom: <feed><entry>...</entry></feed>.
	const root = doc.documentElement;
	if (root !== null && root.localName.toLowerCase() === "feed") {
		const entries = findChildren(root, ["entry"]);
		return { root, items: entries, isAtom: true };
	}
	return null;
}

/** Resolve the feed-level canonical link for RSS vs Atom roots. */
function readFeedLink(root: Element, isAtom: boolean): string | null {
	if (!isAtom) {
		return readText(root, ["link"], true);
	}
	// Atom feed: prefer the alternate link's href.
	for (const link of findChildren(root, ["link"])) {
		const rel = (link.getAttribute("rel") ?? "alternate").toLowerCase();
		if (rel === "self") {
			continue;
		}
		const href = emptyToNull(link.getAttribute("href"));
		if (href !== null) {
			return href;
		}
	}
	return null;
}

/**
 * Parse a feed document (RSS, Atom, or podcast XML) into a `ParsedFeed`.
 *
 * Throws `FeedParseError` when the input is not well-formed XML (DOMParser emits
 * a `<parsererror>` element) or when no RSS `<channel>` / Atom `<feed>` root is
 * present. Individual item quirks (missing dates, absent bodies) are tolerated.
 *
 * The DOMParser is constructed here, not at module scope, so this module imports
 * safely in environments without a DOM.
 */
export function parseFeed(xml: string): ParsedFeed {
	if (typeof xml !== "string" || xml.trim().length === 0) {
		throw new FeedParseError("Feed XML was empty.");
	}

	const doc = new DOMParser().parseFromString(xml, "text/xml");

	// DOMParser does not throw on malformed XML; it returns a document whose body
	// contains a <parsererror> element. Detect it explicitly.
	const parserError = doc.getElementsByTagName("parsererror").item(0);
	if (parserError !== null) {
		const detail = parserError.textContent;
		const reason = detail !== null && detail.trim().length > 0 ? detail.trim() : "unknown reason";
		throw new FeedParseError(`Feed XML could not be parsed: ${reason}`);
	}

	const located = locateRoot(doc);
	if (located === null) {
		throw new FeedParseError("Feed XML has no RSS <channel> or Atom <feed> root.");
	}

	const feedTitle = readText(located.root, ["title"], true) ?? "";
	const feedLink = readFeedLink(located.root, located.isAtom);
	const items = located.items.map((item) => readItem(item));

	return { feedTitle, feedLink, items };
}
