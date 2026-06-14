/**
 * HTML to Markdown conversion for imported feed bodies.
 *
 * Feed bodies (Substack `content:encoded`, WordPress `description`, generic RSS
 * HTML) arrive as a single HTML string. This module turns that into clean,
 * deterministic Markdown using Turndown plus the GitHub-flavored-markdown
 * plugin (tables, strikethrough, task lists), layered with a handful of
 * feed-specific rules:
 *
 * - `figure` + `figcaption` becomes an image followed by an italic caption.
 * - Subscribe / share / button widgets matched by CLASS NAME (never body text)
 *   are stripped; an unrecognized widget that is fundamentally a link degrades
 *   to that link rather than to raw text.
 * - `pre > code.language-xxx` becomes a fenced block tagged with `xxx`.
 * - Anchor-based footnote references collapse to `[^n]`, and their definitions
 *   are appended once at the end of the document in first-seen order.
 *
 * Determinism is a hard requirement: converting the same input twice yields
 * byte-identical Markdown. All per-conversion state lives in a fresh context
 * created for each `turndown` call, never on the module or service.
 *
 * DOM access is lazy. Turndown constructs its own `DOMParser` internally when
 * handed a string, and this module never touches `document`/`window`/
 * `DOMParser` at import time, so it loads safely in a Node context. The
 * conversion itself still needs a DOM (jsdom in tests, the renderer in the
 * app).
 */

import type TurndownService from "turndown";
import * as turndownModule from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * The Turndown package is published as CommonJS whose `module.exports` IS the
 * constructor (no `__esModule`, no `.default`). esbuild synthesizes a default
 * import correctly for the production bundle, but a CommonJS transpile without
 * the `esModuleInterop` runtime helper binds a default import to `undefined`.
 * A namespace import binds to `require("turndown")` itself across both bundlers,
 * so resolve the constructor from it: the namespace value is either the
 * constructor function directly (raw CommonJS) or an object carrying it on
 * `.default` (interop-wrapped). Resolved once at load with no `as any`.
 */
type TurndownCtor = new (options?: ConstructorParameters<typeof TurndownService>[0]) => TurndownService;

function resolveTurndownCtor(): TurndownCtor {
	const ns: unknown = turndownModule;
	if (typeof ns === "function") {
		return ns as TurndownCtor;
	}
	if (ns !== null && typeof ns === "object" && "default" in ns) {
		const inner: unknown = ns.default;
		if (typeof inner === "function") {
			return inner as TurndownCtor;
		}
	}
	throw new Error("turndown module did not export a constructor");
}

const Turndown: TurndownCtor = resolveTurndownCtor();

/**
 * A Turndown plugin: a function that mutates a service in place. Matches the
 * `@types/turndown` `Plugin` shape and is what `service.use` expects.
 */
type TurndownPlugin = (service: TurndownService) => void;

/**
 * Resolve the GFM plugin to a typed function. The `turndown-plugin-gfm` package
 * ships no types, so the imported `gfm` binding is untyped; contain that at a
 * single guarded boundary (an `unknown` round-trip plus a runtime function
 * check) so the rest of the module, and `service.use`, work with a typed value.
 */
function resolveGfmPlugin(): TurndownPlugin {
	const candidate: unknown = gfm;
	if (typeof candidate !== "function") {
		throw new Error("turndown-plugin-gfm did not export a gfm plugin function");
	}
	return candidate as TurndownPlugin;
}

const gfmPlugin: TurndownPlugin = resolveGfmPlugin();

/**
 * Class-name fragments for known subscribe / share / button widgets, removed
 * outright. Matched case-insensitively as a substring of any single class
 * token, so `subscription-widget-wrap-editor`, `subscribe-widget`, and
 * `button-wrapper` all match. Data-driven by design: extend this list, not the
 * rule logic, to retire a new widget family. We never match on body text.
 */
const WIDGET_STRIP_KEYS: readonly string[] = [
	"subscribe",
	"subscription",
	"share-dialog",
	"share-wrapper",
	"sharewrapper",
	"button-wrapper",
	"button-primary",
	"paywall",
	"poll-embed",
	"comments-button",
	"footer-buttons",
];

/**
 * Class-name fragments for generic promotional wrappers that are not in the
 * explicit strip list. A node matching one of these is treated as an unknown
 * widget: if it is fundamentally a single link it degrades to that link;
 * otherwise its inner content is kept. Also data-driven.
 */
const WIDGET_DEGRADE_KEYS: readonly string[] = [
	"cta",
	"banner",
	"promo",
	"callout",
	"widget",
	"embed",
];

/** A node carrying a class attribute we can read. */
interface ClassedElement {
	getAttribute(name: string): string | null;
	querySelector(selectors: string): Element | null;
}

/** Per-conversion mutable state. One instance is created per `turndown` call. */
interface ConversionContext {
	/** Footnote ref order, by the ref label as it appears (e.g. "1", "2"). */
	footnoteOrder: string[];
	/** Definition Markdown keyed by ref label. */
	footnoteDefs: Map<string, string>;
}

/**
 * Reads the `class` attribute as a lowercased token list. Returns an empty
 * array when there is no class attribute, so callers never see undefined.
 */
function classTokens(node: ClassedElement): string[] {
	const raw = node.getAttribute("class");
	if (raw === null || raw.length === 0) {
		return [];
	}
	return raw.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** True when any class token contains one of the given key fragments. */
function classMatchesAny(node: ClassedElement, keys: readonly string[]): boolean {
	const tokens = classTokens(node);
	if (tokens.length === 0) {
		return false;
	}
	return tokens.some((token) => keys.some((key) => token.includes(key)));
}

/** Known subscribe/share/button widget: removed outright. */
function isStripWidget(node: ClassedElement): boolean {
	return classMatchesAny(node, WIDGET_STRIP_KEYS);
}

/** Generic promotional wrapper not in the strip list: degraded to its link. */
function isDegradeWidget(node: ClassedElement): boolean {
	return !isStripWidget(node) && classMatchesAny(node, WIDGET_DEGRADE_KEYS);
}

/**
 * Reads a footnote ref label from an anchor, or null if it is not a footnote
 * reference. Recognizes the common shapes: an `href` of `#footnote-N` /
 * `#fn-N` / `#fnref...`, or an `id` of `footnote-anchor-N`. The label is the
 * trailing numeric token, falling back to the anchor's trimmed text.
 */
function footnoteRefLabel(anchor: ClassedElement): string | null {
	const href = anchor.getAttribute("href");
	const id = anchor.getAttribute("id");
	const fromHref = href !== null ? /^#(?:footnote|fn|fnref)[-_]?(.+)$/i.exec(href) : null;
	const fromId = id !== null ? /^(?:footnote-anchor|fnref)[-_]?(.+)$/i.exec(id) : null;
	const match = fromHref ?? fromId;
	if (match === null) {
		return null;
	}
	const captured = match[1];
	if (captured === undefined) {
		return null;
	}
	const numeric = /(\d+)\s*$/.exec(captured);
	if (numeric !== null && numeric[1] !== undefined) {
		return numeric[1];
	}
	return captured.trim().length > 0 ? captured.trim() : null;
}

/**
 * Reads a footnote definition label from a container node, or null. Recognizes
 * an `id` of `footnote-N` / `fn-N` (but not the `-anchor-` ref variant).
 */
function footnoteDefLabel(node: ClassedElement): string | null {
	const id = node.getAttribute("id");
	if (id === null) {
		return null;
	}
	const match = /^(?:footnote|fn)[-_]?(.+)$/i.exec(id);
	if (match === null || match[1] === undefined) {
		return null;
	}
	if (/^anchor/i.test(match[1])) {
		return null;
	}
	const numeric = /(\d+)\s*$/.exec(match[1]);
	if (numeric !== null && numeric[1] !== undefined) {
		return numeric[1];
	}
	return match[1].trim().length > 0 ? match[1].trim() : null;
}

/** Collapses runs of whitespace to single spaces and trims. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Builds a configured `TurndownService` with the GFM plugin and the
 * feed-specific rules wired in. The `context` is captured by the rules so each
 * service instance owns exactly one conversion's worth of footnote state.
 */
function buildService(context: ConversionContext): TurndownService {
	const service = new Turndown({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
		strongDelimiter: "**",
		hr: "---",
		linkStyle: "inlined",
	});

	service.use(gfmPlugin);

	// Known subscribe / share / button widgets, matched purely by class name,
	// are removed outright. Body text is never the match criterion.
	service.addRule("stripFeedWidgets", {
		filter: (node): boolean => isStripWidget(node),
		replacement: (): string => "",
	});

	// Generic promotional wrappers that are not on the strip list degrade: if
	// the wrapper is fundamentally a single link, emit that link; otherwise keep
	// its inner content rather than dropping real prose.
	service.addRule("degradeUnknownWidgets", {
		filter: (node): boolean => isDegradeWidget(node),
		replacement: (content, node): string => {
			const link = node.querySelector("a[href]");
			if (link !== null) {
				const href = link.getAttribute("href");
				const label = collapseWhitespace(link.textContent ?? "");
				if (href !== null && href.length > 0 && label.length > 0) {
					return `[${label}](${href})`;
				}
			}
			return content;
		},
	});

	// figure with a figcaption: emit the inner image markdown, then the caption
	// as a standalone italic line. Without a caption, fall through to the inner
	// content (Turndown's default img handling).
	service.addRule("figureWithCaption", {
		filter: "figure",
		replacement: (content, node): string => {
			const captionEl = node.querySelector("figcaption");
			const img = node.querySelector("img");
			let imageMd = "";
			if (img !== null) {
				const src = img.getAttribute("src");
				if (src !== null && src.length > 0) {
					const alt = collapseWhitespace(img.getAttribute("alt") ?? "");
					imageMd = `![${alt}](${src})`;
				}
			}
			if (imageMd.length === 0) {
				// No usable <img>; keep whatever the children produced (e.g. a
				// linked image Turndown already rendered).
				imageMd = content.trim();
			}
			const caption = captionEl !== null ? collapseWhitespace(captionEl.textContent ?? "") : "";
			if (caption.length === 0) {
				return imageMd.length > 0 ? `\n\n${imageMd}\n\n` : "";
			}
			return `\n\n${imageMd}\n\n_${caption}_\n\n`;
		},
	});

	// pre > code.language-xxx: fenced block carrying the language tag. Falls
	// back to a plain fence when no language class is present.
	service.addRule("fencedCodeWithLanguage", {
		filter: (node): boolean => {
			if (node.nodeName !== "PRE") {
				return false;
			}
			return node.querySelector("code") !== null;
		},
		replacement: (_content, node): string => {
			const code = node.querySelector("code");
			const codeText = code !== null ? code.textContent ?? "" : node.textContent ?? "";
			let language = "";
			if (code !== null) {
				for (const token of classTokens(code)) {
					const match = /^language-(.+)$/.exec(token);
					if (match !== null && match[1] !== undefined) {
						language = match[1];
						break;
					}
				}
			}
			const body = codeText.replace(/\n+$/, "");
			return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
		},
	});

	// Anchor footnote references: collapse to [^N] and record the first-seen
	// order. The definition body is resolved later from the def containers.
	service.addRule("footnoteRef", {
		filter: (node): boolean => {
			if (node.nodeName !== "A") {
				return false;
			}
			return footnoteRefLabel(node) !== null;
		},
		replacement: (_content, node): string => {
			const label = footnoteRefLabel(node);
			if (label === null) {
				return "";
			}
			if (!context.footnoteOrder.includes(label)) {
				context.footnoteOrder.push(label);
			}
			return `[^${label}]`;
		},
	});

	// Footnote definition containers: capture the body keyed by label and emit
	// nothing inline. Definitions are appended at the document end afterward.
	service.addRule("footnoteDef", {
		filter: (node): boolean => {
			if (node.nodeType !== 1) {
				return false;
			}
			return footnoteDefLabel(node) !== null;
		},
		replacement: (content, node): string => {
			const label = footnoteDefLabel(node);
			if (label === null) {
				return content;
			}
			const def = collapseWhitespace(content);
			if (def.length > 0) {
				context.footnoteDefs.set(label, def);
			}
			return "";
		},
	});

	return service;
}

/**
 * Appends footnote definitions to the converted body in stable order: refs
 * first in first-seen order, then any definitions that had no matching ref
 * (sorted for determinism). A definition with no captured body is skipped.
 */
function appendFootnotes(markdown: string, context: ConversionContext): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const label of context.footnoteOrder) {
		const def = context.footnoteDefs.get(label);
		if (def !== undefined && def.length > 0) {
			lines.push(`[^${label}]: ${def}`);
		}
		seen.add(label);
	}
	const leftover = [...context.footnoteDefs.keys()].filter((label) => !seen.has(label)).sort();
	for (const label of leftover) {
		const def = context.footnoteDefs.get(label);
		if (def !== undefined && def.length > 0) {
			lines.push(`[^${label}]: ${def}`);
		}
	}
	if (lines.length === 0) {
		return markdown;
	}
	const body = markdown.trimEnd();
	return `${body}\n\n${lines.join("\n")}`;
}

/**
 * Normalizes Turndown output: collapse 3+ blank lines to a single blank line
 * and trim leading/trailing whitespace. This is what makes repeated conversion
 * byte-stable regardless of how rules spaced their fragments.
 */
function normalizeMarkdown(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Creates a configured converter with a fresh, empty conversion context. Useful
 * when a caller wants to run several conversions and inspect the underlying
 * service, but most callers want `convertHtmlToMarkdown` instead, which manages
 * the context lifecycle for them.
 */
export function createConverter(): TurndownService {
	const context: ConversionContext = { footnoteOrder: [], footnoteDefs: new Map() };
	return buildService(context);
}

/**
 * Converts an HTML feed body to Markdown deterministically. Same input string
 * yields byte-identical output every call. An empty or whitespace-only input
 * returns an empty string. The caught error from a Turndown failure is
 * surfaced to the caller (rethrown) rather than swallowed.
 */
export function convertHtmlToMarkdown(html: string): string {
	if (html.trim().length === 0) {
		return "";
	}
	const context: ConversionContext = { footnoteOrder: [], footnoteDefs: new Map() };
	const service = buildService(context);
	let converted: string;
	try {
		converted = service.turndown(html);
	} catch (err) {
		// Surface the original failure rather than swallow it: rethrow with the
		// underlying message embedded. (`Error`'s `cause` option needs an ES2022
		// lib this project does not target, so the detail rides in the message.)
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to convert HTML to Markdown: ${detail}`);
	}
	const withFootnotes = appendFootnotes(converted, context);
	return normalizeMarkdown(withFootnotes);
}
