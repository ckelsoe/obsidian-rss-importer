// Writes normalized feed items into the vault as markdown notes.
//
// The note format is frontmatter (keyed by FRONTMATTER_KEYS so the dedup
// index and the writer never drift) followed by the converted body markdown:
//
//   ---
//   feed-source: <sourceId>
//   feed-item-id: <id>
//   url: "<canonical url, force-quoted>"
//   title: <yaml-escaped title>
//   author: <yaml-escaped author>
//   date: <YYYY-MM-DD>
//   tags: [tag-a, tag-b]
//   ---
//
//   <body markdown>
//
// This module lives apart from main.ts and the import modal so the pure
// format helpers can be unit-tested without the Obsidian runtime. The
// NoteWriter class takes a VaultLike structural interface: tests inject a
// plain object, and main.ts passes this.app.vault directly (Obsidian's Vault
// class satisfies VaultLike structurally).

import type { FeedItem } from "./feed-source";
import { FRONTMATTER_KEYS } from "./feed-source";

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown by NoteWriter for any writer-level failure. Callers should catch this
 * specifically to render a clear message; anything else escaping writeNote is
 * a bug.
 */
export class NoteWriterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoteWriterError";
	}
}

/**
 * Thrown when the user cancels an in-progress import from the per-file
 * duplicate prompt. Distinct from NoteWriterError so callers can break the
 * batch loop without treating it as a write failure.
 */
export class NoteWriterCancelledError extends Error {
	constructor(message = "Import cancelled by user from duplicate prompt") {
		super(message);
		this.name = "NoteWriterCancelledError";
	}
}

// -----------------------------------------------------------------------------
// Structural DI interface — Obsidian's Vault assigns to this directly.
// -----------------------------------------------------------------------------

export interface FileLike {
	readonly path: string;
}

export interface FolderLike {
	readonly path: string;
}

export interface VaultLike {
	getFileByPath(path: string): FileLike | null;
	getFolderByPath(path: string): FolderLike | null;
	createFolder(path: string): Promise<unknown>;
	create(path: string, data: string): Promise<FileLike>;
	read(file: FileLike): Promise<string>;
	process(file: FileLike, fn: (data: string) => string): Promise<string>;
}

export type DuplicatePolicy = "skip" | "overwrite" | "prompt";

/**
 * Context passed to the prompt callback when a same-item duplicate is
 * encountered. Intentionally minimal: the callback asks the user a
 * yes/no/cancel question, it does not render item metadata.
 */
export interface DuplicatePromptContext {
	readonly feedItemId: string;
	readonly itemTitle: string;
	readonly targetPath: string;
}

/**
 * Decision returned by the prompt callback. Sticky "apply to all" escalation
 * lives at the caller layer; from the writer's point of view each call either
 * overwrites this file, skips this file, or aborts the whole batch.
 */
export type DuplicatePromptDecision = "overwrite" | "skip" | "cancel";

export type DuplicatePromptCallback = (
	context: DuplicatePromptContext,
) => Promise<DuplicatePromptDecision>;

export type WriteStatus = "created" | "overwritten" | "skipped";

export interface WriteOutcome {
	readonly status: WriteStatus;
	readonly path: string;
}

export interface NoteWriterOptions {
	readonly vault: VaultLike;
	readonly destinationFolder: string;
	readonly noteNameTemplate: string;
	readonly onDuplicate: DuplicatePolicy;
	/**
	 * Required when onDuplicate is 'prompt'. Invoked per duplicate same-item
	 * match so the caller can ask the user what to do. Ignored for 'skip' and
	 * 'overwrite'. Construction throws if the policy is 'prompt' but this
	 * callback is missing.
	 */
	readonly promptOnDuplicate?: DuplicatePromptCallback;
	/** Frontmatter key the merged tags are written under. Defaults to feed-tags. */
	readonly tagDestination?: TagDestination;
}

/**
 * Where merged tags are written. "feed-tags" (default) is a plain note property
 * that stays out of the global Obsidian tag pane/search/graph; "tags" writes
 * Obsidian tags that DO appear there.
 */
export type TagDestination = "feed-tags" | "tags";

export interface ComposeOptions {
	/** Tags carried by the configured feed; merged with the item's own tags. */
	readonly feedTags?: string[];
	/** Frontmatter key the merged tags are written under. Defaults to feed-tags. */
	readonly tagDestination?: TagDestination;
	/**
	 * Local path of the downloaded media file (vault-relative or absolute). When
	 * set, a `media-file` frontmatter line is added and the body media link points
	 * at this local file instead of the remote media-url. The remote media-url
	 * frontmatter line is kept for reference.
	 */
	readonly mediaFile?: string;
}

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing).
// -----------------------------------------------------------------------------

// Reserved Windows device names. Even with an extension these can confuse
// legacy code, so we prefix them with an underscore to neutralize.
const RESERVED_DEVICE_NAMES = new Set([
	"CON", "PRN", "AUX", "NUL",
	"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
	"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Sanitize a title into a filename that is legal on Windows, macOS, and Linux
 * and does not collide with Obsidian's wikilink parser. Never throws, always
 * returns a non-empty string.
 */
export function sanitizeFilename(title: string): string {
	// Strip leading/trailing whitespace first so subsequent length checks do
	// not operate on padded input.
	let out = title.trim();

	// Collapse runs of whitespace (including newlines and tabs) into single
	// spaces FIRST. A multi-line title should flatten to a space-separated
	// single line, not gain dashes at every line break.
	out = out.replace(/\s+/g, " ");

	// Now replace the Windows-forbidden chars, square brackets (wikilink
	// collision), and any remaining non-whitespace control characters with
	// dashes. Whitespace control chars like \t and \n were already handled by
	// the step above, so what is left is things like NUL (\x00) and the other
	// non-whitespace control codes.
	// eslint-disable-next-line no-control-regex -- intentional: this class strips NUL and other non-whitespace control codes from the filename
	out = out.replace(/[<>:"/\\|?*\x00-\x08\x0b\x0c\x0e-\x1f[\]]/g, "-");

	// Strip leading and trailing dots and spaces. Windows silently drops them
	// from filenames, which causes "File.md" and "File .md" to collide.
	out = out.replace(/^[. ]+/, "");
	out = out.replace(/[. ]+$/, "");

	// Clamp length: 200 chars leaves room for ".md" plus any disambiguation
	// suffix the vault layer might add. Filesystems typically cap at 255.
	if (out.length > 200) {
		out = out.slice(0, 200).trim();
		// Re-strip trailing dots/spaces after the slice.
		out = out.replace(/[. ]+$/, "");
	}

	if (RESERVED_DEVICE_NAMES.has(out.toUpperCase())) {
		out = `_${out}`;
	}

	// Empty-after-sanitization fallback. This happens for titles that are
	// entirely punctuation or whitespace.
	if (out.length === 0) {
		out = "Untitled";
	}

	return out;
}

/**
 * Build a YYYY-MM-DD date string from an ISO 8601 timestamp, or empty string
 * when the timestamp is null or unparseable. UTC is used so the date does not
 * shift with the runner's local timezone.
 */
function isoToYmd(publishedAt: string | null): string {
	if (publishedAt === null) {
		return "";
	}
	const date = new Date(publishedAt);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Kebab-case a title into a slug: lowercase, collapse any run of non
 * alphanumeric characters to a single dash, strip leading/trailing dashes.
 * Returns empty string when the title has no alphanumeric content.
 */
function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Expand a note-name template against a feed item. Supported tokens:
 *
 *   {{date}}   YYYY-MM-DD from item.publishedAt, or empty when absent.
 *   {{title}}  the item title.
 *   {{slug}}   kebab-case of the title.
 *
 * Each token's value is run through sanitizeFilename so a title containing a
 * slash cannot inject a path separator into the generated name. The whole
 * expanded result is sanitized once more as a final guard, then checked: an
 * empty result (e.g. a template of only empty tokens) is rejected with a
 * NoteWriterError so the caller never tries to write a nameless file.
 */
export function expandNoteName(template: string, item: FeedItem): string {
	// Token replacements. {{date}} is allowed to expand to empty; the others
	// are sanitized so they can never contain a '/'. We sanitize each token
	// individually before substitution, then sanitize the whole result, so a
	// token value can never introduce a path separator or a forbidden char.
	const dateValue = isoToYmd(item.publishedAt);
	const replacements: Record<string, string> = {
		date: dateValue === "" ? "" : sanitizeFilename(dateValue),
		title: sanitizeFilename(item.title),
		slug: sanitizeFilename(slugify(item.title)),
	};

	const expanded = template.replace(
		/\{\{(date|title|slug)\}\}/g,
		(_match, token: string) => {
			const value = replacements[token];
			return value === undefined ? "" : value;
		},
	);

	// Final sanitize as defense in depth. This also collapses any '/' that
	// survived in the literal template text into a dash so the result is a
	// single path segment.
	const name = sanitizeFilename(expanded);

	// sanitizeFilename never returns empty (it falls back to 'Untitled'), so
	// the only way to get a truly empty name is if the template expanded to a
	// string of only dots/spaces that the fallback then rescued. Reject a
	// result that is just the fallback when the template itself was empty of
	// real content, so the caller knows the template produced nothing usable.
	const trimmedExpanded = expanded.trim();
	if (trimmedExpanded.length === 0) {
		throw new NoteWriterError(
			`Note name template "${template}" expanded to an empty name for item ${item.id}`,
		);
	}

	return name;
}

// Reserved YAML tokens that parse as something other than a string if left
// unquoted. Covers the common casings a real title/author/id could match.
const YAML_RESERVED_TOKENS = new Set([
	"true", "True", "TRUE",
	"false", "False", "FALSE",
	"yes", "Yes", "YES",
	"no", "No", "NO",
	"on", "On", "ON",
	"off", "Off", "OFF",
	"null", "Null", "NULL",
	"~",
]);

/**
 * Quote a YAML scalar if it could be misparsed as something other than a
 * string. Uses double-quoted form with backslash, double-quote, and
 * whitespace control characters escaped. Plain strings that are
 * unambiguously string-typed and contain no special characters pass through
 * unquoted.
 *
 * Rules for unquoted pass-through:
 *  - Must start with an ASCII letter (no leading digit/minus, which avoids
 *    number and date parsing).
 *  - Remaining characters must be alphanumeric, space, underscore, period,
 *    or hyphen.
 *  - Must not match any YAML reserved token, so an author named "Yes" or an
 *    id that happens to be "null" gets quoted.
 */
function yamlScalar(value: string): string {
	if (
		value.length > 0 &&
		/^[A-Za-z][A-Za-z0-9 _.-]*$/.test(value) &&
		!YAML_RESERVED_TOKENS.has(value)
	) {
		return value;
	}
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

/**
 * Force a value into double-quoted YAML form regardless of its content. Used
 * for the url field: an unquoted `https://...` scalar parses as a mapping key
 * plus value on some YAML parsers because of the `//`, so it must always be
 * quoted.
 */
function yamlQuoted(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

/**
 * Slug-normalize a single tag for the tags array: trim, lowercase, collapse
 * internal whitespace runs to single dashes, strip leading/trailing dashes.
 * Returns empty string for a tag with no usable content; callers drop those.
 */
function normalizeTag(tag: string): string {
	return tag
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Merge feed-level tags with the item's own tags into a single deduplicated
 * list. Feed tags come first in their original order, then item tags, first
 * occurrence winning on collision. Empty or whitespace-only entries are
 * dropped before any other processing.
 */
function mergeTags(
	feedTags: readonly string[] | undefined,
	itemTags: readonly string[] | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (tag: string): void => {
		const normalized = normalizeTag(tag);
		if (normalized.length === 0 || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		out.push(normalized);
	};
	for (const tag of feedTags ?? []) {
		push(tag);
	}
	for (const tag of itemTags ?? []) {
		push(tag);
	}
	return out;
}

/** Render a YAML flow array of plain (already-normalized) tags. */
function yamlTagArray(tags: readonly string[]): string {
	return `[${tags.join(", ")}]`;
}

/**
 * The visible callout prepended to a truncated (paywalled teaser) body so the
 * reader is never misled into thinking they have the complete post. Uses an
 * Obsidian callout block.
 */
const TRUNCATED_CALLOUT = [
	"> [!warning] Truncated content",
	"> This is a paywalled teaser, not the complete post. Open the original to read the full text.",
].join("\n");

/**
 * Compose a complete note (YAML frontmatter plus body) for a feed item.
 *
 * The frontmatter keys are taken from FRONTMATTER_KEYS so the dedup reader and
 * this writer can never disagree on identity fields. The url value is always
 * force-quoted (an unquoted `//` breaks YAML); title and author are escaped
 * with the general YAML scalar rules. The date is YYYY-MM-DD from the item's
 * publishedAt, or omitted when the feed gave no date. Tags are a YAML flow
 * array merging feedTags with the item's own tags, deduplicated.
 *
 * When the item is a truncated teaser, a visible callout warning is prepended
 * to the body and a `substack-truncated: true` line is added to frontmatter so
 * the state is both human-visible and machine-queryable.
 *
 * When the item carries media (a podcast/audio/video enclosure), a `media-url`
 * frontmatter line records it (force-quoted, since it is a URL) and a labelled
 * link to the media is appended to the body so the episode is reachable from the
 * note. When opts.mediaFile is set (the enclosure was downloaded locally), a
 * `media-file` frontmatter line is added after media-url and the body link points
 * at the local file instead of the remote URL; the media-url line is kept for
 * reference.
 */
export function composeNote(
	item: FeedItem,
	bodyMarkdown: string,
	opts: ComposeOptions,
): string {
	const lines: string[] = ["---"];
	lines.push(`${FRONTMATTER_KEYS.feedSource}: ${yamlScalar(item.sourceId)}`);
	lines.push(`${FRONTMATTER_KEYS.feedItemId}: ${yamlScalar(item.id)}`);
	// Force-quote the url: an unquoted https://... value parses wrong on some
	// YAML parsers because of the // sequence.
	lines.push(`${FRONTMATTER_KEYS.url}: ${yamlQuoted(item.url)}`);
	lines.push(`${FRONTMATTER_KEYS.title}: ${yamlScalar(item.title)}`);
	if (item.author !== null && item.author.length > 0) {
		lines.push(`${FRONTMATTER_KEYS.author}: ${yamlScalar(item.author)}`);
	}
	const date = isoToYmd(item.publishedAt);
	if (date.length > 0) {
		lines.push(`${FRONTMATTER_KEYS.date}: ${date}`);
	}
	const tags = mergeTags(opts.feedTags, item.tags);
	if (tags.length > 0) {
		// Default to a plain note property so feed tags do not flood the Obsidian
		// tag pane; "tags" opts into real Obsidian tags.
		const tagKey = opts.tagDestination === "tags" ? FRONTMATTER_KEYS.tags : "feed-tags";
		lines.push(`${tagKey}: ${yamlTagArray(tags)}`);
	}
	// Media items (podcast episodes, attached audio/video) record their media URL
	// in frontmatter. Force-quoted because it is a URL. Placed after tags and
	// before the truncated marker.
	const hasMedia = item.mediaUrl !== null && item.mediaUrl.length > 0;
	const hasMediaFile = opts.mediaFile !== undefined && opts.mediaFile.length > 0;
	if (hasMedia && item.mediaUrl !== null) {
		lines.push(`media-url: ${yamlQuoted(item.mediaUrl)}`);
	}
	// When the enclosure was downloaded, record the local file path right after
	// the remote url. Force-quoted because a path can contain spaces or colons.
	if (hasMediaFile && opts.mediaFile !== undefined) {
		lines.push(`media-file: ${yamlQuoted(opts.mediaFile)}`);
	}
	if (item.isTruncated) {
		// Machine-readable marker alongside the visible callout below.
		lines.push("substack-truncated: true");
	}
	lines.push("---");

	let body = item.isTruncated
		? `${TRUNCATED_CALLOUT}\n\n${bodyMarkdown}`
		: bodyMarkdown;

	// Link the media at the end of the body so a podcast note plays its episode
	// and any other media item is reachable from the note. Prefer the downloaded
	// local file when present; otherwise fall back to the remote url.
	if (hasMediaFile && opts.mediaFile !== undefined) {
		const label = item.kind === "podcast" ? "Episode audio" : "Media";
		body = `${body}\n\n[${label}](${opts.mediaFile})`;
	} else if (hasMedia && item.mediaUrl !== null) {
		const label = item.kind === "podcast" ? "Episode audio" : "Media";
		body = `${body}\n\n[${label}](${item.mediaUrl})`;
	}

	return `${lines.join("\n")}\n\n${body}`;
}

/**
 * Extract the feed-item-id value from a note's YAML frontmatter, if any. Used
 * by the writer to detect filename collisions: if a note already exists at the
 * target path with a different feed-item-id, writing would destroy a different
 * item's note and we must refuse loudly.
 *
 * Returns null when the content has no frontmatter, no feed-item-id key, or
 * the frontmatter is malformed enough that the id cannot be parsed.
 */
export function extractFeedItemId(content: string): string | null {
	const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!block) {
		return null;
	}
	const body = block[1];
	if (body === undefined) {
		return null;
	}
	// Escape the key for use in a regex in case it ever gains regex-special
	// characters; today it is "feed-item-id" but keep this robust.
	const keyPattern = FRONTMATTER_KEYS.feedItemId.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	const idLine = body.match(new RegExp(`^${keyPattern}:\\s*(.*?)\\s*$`, "m"));
	if (!idLine) {
		return null;
	}
	const raw = idLine[1];
	if (raw === undefined) {
		return null;
	}
	let value = raw.trim();
	// Strip matched surrounding quotes (YAML double- or single-quoted form).
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		value = value.slice(1, -1);
		// Unescape the standard double-quoted escapes we emit, in a SINGLE pass.
		// The escaped-backslash sequence `\\` must be consumed before the letter
		// escapes, otherwise a literal backslash followed by "n" (written as `\\n`)
		// would be misread as a newline. Sequential global replaces cannot do this
		// safely: turning `\\` into `\` first leaves a `\n` that the next pass then
		// rewrites to a newline. One left-to-right pass over each escape sequence
		// matches `\\` as a unit and maps the rest by their following character.
		value = value.replace(/\\(.)/g, (_match, next: string) => {
			switch (next) {
				case "\\":
					return "\\";
				case '"':
					return '"';
				case "n":
					return "\n";
				case "r":
					return "\r";
				case "t":
					return "\t";
				default:
					// Unknown escape: drop the backslash, keep the character.
					return next;
			}
		});
	}
	return value.length > 0 ? value : null;
}

/**
 * Detect whether an existing note's frontmatter carries the
 * `substack-truncated: true` marker. Used to protect a complete note from
 * being clobbered by a later truncated teaser of the same item.
 */
function existingNoteIsTruncated(content: string): boolean {
	const block = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
	if (!block) {
		return false;
	}
	const body = block[1];
	if (body === undefined) {
		return false;
	}
	const line = body.match(/^substack-truncated:\s*(.*?)\s*$/m);
	if (!line) {
		return false;
	}
	const raw = line[1];
	if (raw === undefined) {
		return false;
	}
	return raw.trim().toLowerCase() === "true";
}

// -----------------------------------------------------------------------------
// NoteWriter class — handles vault-level file creation and duplicate policy.
// -----------------------------------------------------------------------------

export class NoteWriter {
	private readonly vault: VaultLike;
	// destinationFolder stored here is the NORMALIZED form: construction throws
	// if the raw input had path-traversal segments, so this value is always
	// safe to concatenate with a filename.
	private readonly destinationFolder: string;
	private readonly noteNameTemplate: string;
	private readonly onDuplicate: DuplicatePolicy;
	private readonly promptOnDuplicate?: DuplicatePromptCallback;
	private readonly tagDestination?: TagDestination;

	constructor(opts: NoteWriterOptions) {
		if (
			opts.onDuplicate !== "skip" &&
			opts.onDuplicate !== "overwrite" &&
			opts.onDuplicate !== "prompt"
		) {
			throw new NoteWriterError(
				`Invalid onDuplicate policy "${String(opts.onDuplicate)}" — expected 'skip', 'overwrite', or 'prompt'`,
			);
		}
		if (
			opts.onDuplicate === "prompt" &&
			typeof opts.promptOnDuplicate !== "function"
		) {
			throw new NoteWriterError(
				"Invalid onDuplicate policy 'prompt' — a promptOnDuplicate callback is required",
			);
		}
		this.vault = opts.vault;
		this.destinationFolder = normalizeFolderPath(opts.destinationFolder);
		this.noteNameTemplate = opts.noteNameTemplate;
		this.onDuplicate = opts.onDuplicate;
		this.promptOnDuplicate = opts.promptOnDuplicate;
		this.tagDestination = opts.tagDestination;
	}

	async writeNote(
		item: FeedItem,
		bodyMarkdown: string,
		composeOptions?: ComposeOptions,
	): Promise<WriteOutcome> {
		await this.ensureFolder(this.destinationFolder);

		const filename = `${expandNoteName(this.noteNameTemplate, item)}.md`;
		const targetPath =
			this.destinationFolder === ""
				? filename
				: `${this.destinationFolder}/${filename}`;

		const markdown = composeNote(item, bodyMarkdown, {
			...(composeOptions ?? {}),
			tagDestination: composeOptions?.tagDestination ?? this.tagDestination,
		});

		const existing = this.vault.getFileByPath(targetPath);
		if (existing === null) {
			try {
				await this.vault.create(targetPath, markdown);
			} catch (cause) {
				throw new NoteWriterError(
					`Failed to create ${targetPath} for item ${item.id}: ${describeCause(cause)}`,
				);
			}
			return { status: "created", path: targetPath };
		}

		// A file already exists at this path. Before honoring the duplicate
		// policy, check whether it belongs to a DIFFERENT item: two distinct
		// feed items can sanitize to the same filename, and silently
		// overwriting or skipping would cause data loss the user never sees.
		let existingContent: string;
		try {
			existingContent = await this.vault.read(existing);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to read existing ${targetPath} while checking for collisions: ${describeCause(cause)}`,
			);
		}

		const existingId = extractFeedItemId(existingContent);
		if (existingId !== null && existingId !== item.id) {
			throw new NoteWriterError(
				`Filename collision at ${targetPath}: this note belongs to item ${existingId}, not ${item.id}. Rename one of the source items or delete the existing note to re-import.`,
			);
		}

		// A truncated teaser must never clobber an existing complete
		// (non-truncated) note of the same item. Skip the write and report it
		// as skipped so a re-import after a paywall change does not regress a
		// good note back to a teaser.
		if (item.isTruncated && !existingNoteIsTruncated(existingContent)) {
			return { status: "skipped", path: targetPath };
		}

		if (this.onDuplicate === "skip") {
			return { status: "skipped", path: targetPath };
		}

		// Resolve prompt-mode into a concrete action. 'skip' short-circuits,
		// 'cancel' throws, anything else falls through to the overwrite path
		// shared with onDuplicate === 'overwrite'.
		if (this.onDuplicate === "prompt") {
			if (!this.promptOnDuplicate) {
				throw new NoteWriterError(
					"promptOnDuplicate callback missing at write time — this is a plugin bug",
				);
			}
			const decision = await this.promptOnDuplicate({
				feedItemId: item.id,
				itemTitle: item.title,
				targetPath,
			});
			if (decision === "cancel") {
				throw new NoteWriterCancelledError();
			}
			if (decision !== "overwrite" && decision !== "skip") {
				throw new NoteWriterError(
					`promptOnDuplicate returned invalid decision "${String(decision)}"`,
				);
			}
			if (decision === "skip") {
				return { status: "skipped", path: targetPath };
			}
		}

		// Overwrite path: use process so the write respects any other plugin's
		// read-modify-write of the same file. The callback ignores the previous
		// content by design: we replace the entire file with regenerated
		// markdown.
		try {
			await this.vault.process(existing, () => markdown);
		} catch (cause) {
			throw new NoteWriterError(
				`Failed to overwrite ${targetPath} for item ${item.id}: ${describeCause(cause)}`,
			);
		}
		return { status: "overwritten", path: targetPath };
	}

	/**
	 * Walk the folder path and create each missing ancestor in turn. Obsidian's
	 * createFolder throws if the folder already exists, so each segment is
	 * checked first.
	 */
	private async ensureFolder(folderPath: string): Promise<void> {
		if (folderPath === "") {
			return;
		}
		const segments = folderPath.split("/");
		for (let i = 1; i <= segments.length; i++) {
			const partial = segments.slice(0, i).join("/");
			const existing = this.vault.getFolderByPath(partial);
			if (existing === null) {
				try {
					await this.vault.createFolder(partial);
				} catch (cause) {
					throw new NoteWriterError(
						`Failed to create folder "${partial}": ${describeCause(cause)}`,
					);
				}
			}
		}
	}
}

/** Render a caught unknown into a message string without losing detail. */
function describeCause(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Normalize a user-configured destination folder. Throws if the path contains
 * `..` segments that would escape the vault: silently stripping them would be
 * a lie to the user about where their files went.
 */
function normalizeFolderPath(folder: string): string {
	const cleaned = folder
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");
	const segments = cleaned.split("/").filter((s) => s !== "" && s !== ".");
	if (segments.some((s) => s === "..")) {
		throw new NoteWriterError(
			`Destination folder "${folder}" contains ".." which would escape the vault — use a vault-relative path`,
		);
	}
	return segments.join("/");
}
