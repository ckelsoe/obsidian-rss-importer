// Deterministic, per-feed cleanup of promotional clutter in a note's Markdown
// body. This is the deterministic half of a hybrid: an external AI skill later
// authors the rules and handles fuzzy residue. The pure functions here only act
// on STABLE STRUCTURAL SIGNALS — link targets (hosts) and horizontal-rule
// footers — never on body prose text. That is the whole point: when a feed
// rewords its call-to-action, a host-based rule keeps matching; a text-based one
// would silently stop.
//
// Two guarantees this module exists to enforce:
//   - It NEVER touches frontmatter. Callers pass the body only.
//   - It is idempotent: applyCleanup(applyCleanup(x)) === applyCleanup(x).
//
// The module imports nothing from `obsidian` and touches no DOM, so it is fully
// unit-testable in the node jest environment.

/**
 * The deterministic cleanup rules for one feed. Both fields are required here;
 * the settings layer resolves per-feed overrides against global defaults and
 * builds this concrete config.
 */
export interface CleanupConfig {
	/**
	 * Substrings matched (case-insensitive) against a link's URL. A block that
	 * contains a promo-host link and is "promotional-shaped" is dropped. Examples:
	 * "buymeacoffee.com", "substack.com/app", "/subscribe".
	 */
	linkHosts: string[];
	/**
	 * When true, everything from the LAST Markdown horizontal rule through the end
	 * of the body is removed (the trailing footer region). When false, no trim.
	 */
	trimAfterLastRule: boolean;
}

// A short paragraph (one whose non-link text is under this many characters) that
// links a promo host is treated as a call-to-action and dropped. A longer
// paragraph that merely cites a promo host once is real content and preserved.
const SHORT_PARAGRAPH_NON_LINK_LIMIT = 300;

// A line that is ONLY a Markdown horizontal rule: three or more of -, *, or _,
// optionally separated by spaces, and nothing else. Matches ---, ***, ___,
// "- - -", "* * *", etc.
const HORIZONTAL_RULE = /^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/**
 * Apply the deterministic cleanup rules to a note BODY (never frontmatter).
 *
 * Steps, in order:
 *   1. trimAfterLastRule: drop everything from the last horizontal rule onward.
 *   2. link-host rule: drop each promotional-shaped block that links a promo
 *      host, preserving long real paragraphs that merely cite one.
 *   3. Collapse the runs of blank lines a removal can leave (3+ -> a single
 *      blank line) and trim trailing whitespace so the result is stable.
 *
 * Idempotent: a body already cleaned by this function is returned with no
 * further change. An empty or whitespace-only body is returned unchanged.
 */
export function applyCleanup(body: string, config: CleanupConfig): string {
	if (body.trim().length === 0) {
		return body;
	}

	let working = body;

	if (config.trimAfterLastRule) {
		working = trimAfterLastHorizontalRule(working);
	}

	const hosts = normalizeHosts(config.linkHosts);
	if (hosts.length > 0) {
		working = dropPromotionalLinkBlocks(working, hosts);
	}

	return collapseBlankLines(working);
}

/**
 * The frontmatter block and the body of a note, split apart. `frontmatter` is
 * the complete leading `---\n...\n---` fence (including both delimiters and the
 * trailing newline) or empty string when the note has none; `body` is
 * everything after it. Joining `frontmatter + body` reproduces the input
 * exactly, so a caller can clean only the body and reattach the frontmatter
 * untouched.
 */
export interface NoteParts {
	readonly frontmatter: string;
	readonly body: string;
}

/**
 * Split a note's raw content into its frontmatter block and its body. The
 * frontmatter must start at the very first character (Obsidian's rule) and be
 * closed by a `---` line; anything else is treated as a body with no
 * frontmatter. This NEVER mutates the frontmatter — it is the seam that lets the
 * re-run command clean the body and write the original frontmatter back.
 */
export function splitFrontmatter(content: string): NoteParts {
	// The frontmatter fence: a leading `---` line, the YAML, then a closing
	// `---` line. The trailing newline after the closing fence (if any) is kept
	// with the frontmatter so the body starts at real content.
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
	if (match === null) {
		return { frontmatter: "", body: content };
	}
	const frontmatter = match[0];
	return { frontmatter, body: content.slice(frontmatter.length) };
}

/**
 * Lowercase, trim, and drop empty host entries so matching is case-insensitive
 * and a stray blank line in the user's host list never matches every URL.
 */
function normalizeHosts(hosts: readonly string[]): string[] {
	const out: string[] = [];
	for (const host of hosts) {
		const normalized = host.trim().toLowerCase();
		if (normalized.length > 0) {
			out.push(normalized);
		}
	}
	return out;
}

/**
 * Remove everything from the LAST horizontal-rule line through the end of the
 * body. Returns the input unchanged when there is no horizontal rule. The rule
 * line itself is removed along with the footer it introduces.
 */
function trimAfterLastHorizontalRule(body: string): string {
	const lines = body.split("\n");
	let lastRuleIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line !== undefined && HORIZONTAL_RULE.test(line)) {
			lastRuleIndex = i;
		}
	}
	if (lastRuleIndex === -1) {
		return body;
	}
	return lines.slice(0, lastRuleIndex).join("\n");
}

/**
 * Split the body into blocks (separated by blank lines), drop each block that is
 * a promotional-shaped promo-host link, and rejoin. List items are treated as
 * candidate blocks too: a bullet list whose items each link a promo host has
 * each offending item dropped without disturbing the others.
 */
function dropPromotionalLinkBlocks(body: string, hosts: readonly string[]): string {
	const blocks = body.split(/\n[ \t]*\n/);
	const kept: string[] = [];
	for (const block of blocks) {
		kept.push(filterBlock(block, hosts));
	}
	return kept.join("\n\n");
}

/**
 * Filter a single block. When the block is a list, each list item is judged
 * independently so a single promo bullet does not take the whole list with it.
 * Otherwise the block is judged as a whole: kept or dropped.
 */
function filterBlock(block: string, hosts: readonly string[]): string {
	const lines = block.split("\n");
	const allListItems =
		lines.length > 0 && lines.every((line) => line.trim().length === 0 || isListItem(line));
	if (allListItems) {
		const keptLines = lines.filter(
			(line) => line.trim().length === 0 || !isPromotionalLinkLine(line, hosts),
		);
		return keptLines.join("\n");
	}
	return isPromotionalBlock(block, hosts) ? "" : block;
}

/** True when a line is a Markdown list item (-, *, +, or an ordered "1." form). */
function isListItem(line: string): boolean {
	return /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line);
}

/**
 * True when a single list-item line is a promotional CTA: it links a promo host
 * and its non-link text is short (a one-line bullet, not a long sentence that
 * happens to cite a promo host).
 */
function isPromotionalLinkLine(line: string, hosts: readonly string[]): boolean {
	const links = extractLinks(line);
	if (links.length === 0 || !someLinkHitsHost(links, hosts)) {
		return false;
	}
	const nonLink = nonLinkText(line, links);
	return nonLink.length < SHORT_PARAGRAPH_NON_LINK_LIMIT;
}

/**
 * Decide whether a whole (non-list) block is promotional and should be dropped.
 *
 * The safety rule is the length gate, and it is absolute: a paragraph whose
 * non-link prose is long is real content and is PRESERVED even if it cites a
 * promo host. A block is promotional only when it links a promo host AND its
 * non-link text is short (under the paragraph limit) — that is, it is a
 * call-to-action or a link-dominated footer line, not a real paragraph that
 * happens to mention a promo link once.
 */
function isPromotionalBlock(block: string, hosts: readonly string[]): boolean {
	const links = extractLinks(block);
	if (links.length === 0 || !someLinkHitsHost(links, hosts)) {
		return false;
	}
	const nonLink = nonLinkText(block, links);
	return nonLink.length < SHORT_PARAGRAPH_NON_LINK_LIMIT;
}

/** A link found in a block: the visible text (if any) and the URL target. */
interface ExtractedLink {
	readonly url: string;
	/** The full matched source text, used to compute the non-link remainder. */
	readonly match: string;
}

// Markdown inline link: [text](url). The url group stops at whitespace or the
// closing paren so a trailing "title" or a following sentence is not captured.
const MD_LINK = /\[[^\]]*\]\(\s*(<[^>]*>|[^()\s]+)[^)]*\)/g;
// Bare autolink: <https://...> or a naked http(s) URL. The angle-bracket form is
// matched first; the naked form stops at whitespace or a closing angle bracket.
const AUTOLINK = /<((?:https?|ftp):\/\/[^>\s]+)>|((?:https?):\/\/[^\s)<>]+)/g;

/**
 * Extract every Markdown inline link and bare autolink from a block. The URL is
 * unwrapped from any surrounding angle brackets so hostMatches sees the raw
 * target.
 */
function extractLinks(block: string): ExtractedLink[] {
	const out: ExtractedLink[] = [];
	for (const m of block.matchAll(MD_LINK)) {
		const raw = m[1];
		if (raw !== undefined) {
			out.push({ url: stripAngleBrackets(raw), match: m[0] });
		}
	}
	for (const m of block.matchAll(AUTOLINK)) {
		const raw = m[1] ?? m[2];
		if (raw !== undefined) {
			out.push({ url: stripAngleBrackets(raw), match: m[0] });
		}
	}
	return out;
}

function stripAngleBrackets(url: string): string {
	if (url.startsWith("<") && url.endsWith(">")) {
		return url.slice(1, -1);
	}
	return url;
}

/** True when at least one of the links targets a configured promo host. */
function someLinkHitsHost(links: readonly ExtractedLink[], hosts: readonly string[]): boolean {
	return links.some((link) => hostMatches(link.url, hosts));
}

/** Case-insensitive substring test of a URL against the configured host list. */
function hostMatches(url: string, hosts: readonly string[]): boolean {
	const lower = url.toLowerCase();
	return hosts.some((host) => lower.includes(host));
}

/**
 * The block's text with every link's source removed, then whitespace collapsed.
 * Used to measure how much real (non-link) prose a block carries: a long
 * remainder means the block is real content that cites a link, not a CTA.
 */
function nonLinkText(block: string, links: readonly ExtractedLink[]): string {
	let text = block;
	for (const link of links) {
		text = text.split(link.match).join(" ");
	}
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Collapse 3+ consecutive newlines (a blank-line run a removal can leave) into a
 * single blank line, and trim leading/trailing blank lines. Internal single
 * blank lines between real blocks are preserved so paragraph structure survives.
 */
function collapseBlankLines(body: string): string {
	return body
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
}
