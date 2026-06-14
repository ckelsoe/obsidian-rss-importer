// Orchestrates a batch import: walk a list of normalized feed items, fetch each
// body, convert it to Markdown, optionally download images, and hand the result
// to the note writer. The runner is the single place that decides what a
// per-item failure means versus what aborts the whole batch.
//
// Failure policy (the contract this module exists to enforce):
//   - A processImages failure must NOT fail the item. It is best-effort: we
//     catch inside, log, and keep the un-rewritten Markdown.
//   - Any other thrown error on an item is recorded as a 'failed' result with
//     the error message as the reason, logged to the console, and the batch
//     CONTINUES to the next item. One bad item never sinks the run.
//   - A NoteWriterCancelledError is the single exception: the user cancelled a
//     duplicate prompt, which means "stop the whole import". It propagates out
//     of run() so the caller sees the cancellation explicitly.
//   - opts.isAborted() is checked before each item; an external abort (user hit
//     stop) ends the loop cleanly and returns the tally of work done so far.
//
// This module is pure orchestration over injected dependencies: it never
// imports `obsidian`, never touches the DOM, and is fully unit-testable with
// plain-object stubs for the source, note writer, and converter.

import type { FeedItem } from "./feed-source";
import type { NoteWriter } from "./note-writer";
import { NoteWriterCancelledError } from "./note-writer";
import type { DebugLogger } from "./debug-logger";

/** Outcome of importing a single feed item. */
export interface ImportItemResult {
	item: FeedItem;
	status: "created" | "overwritten" | "skipped" | "failed";
	/** Vault-relative path written, or null when the item failed before a write. */
	path: string | null;
	/** Failure reason when status is 'failed', else null. */
	reason: string | null;
}

/** Aggregate result of a batch import: per-status counts plus the per-item log. */
export interface ImportTally {
	total: number;
	created: number;
	overwritten: number;
	skipped: number;
	failed: number;
	results: ImportItemResult[];
}

/** Progress callback payload, emitted after each item is processed. */
export interface ImportProgress {
	/** Zero-based index of the item just processed. */
	index: number;
	total: number;
	/** The fully-fetched item (body populated), as written/attempted. */
	item: FeedItem;
}

/**
 * Dependency surface for the runner. Everything the runner needs is injected so
 * it can be unit-tested with stubs and so main.ts owns the concrete wiring.
 */
export interface ImportRunnerDeps {
	source: FeedSourceLike;
	/** Pre-built for the target feed (destination folder, name template, policy). */
	noteWriter: NoteWriter;
	/** ./html-converter convertHtmlToMarkdown. */
	convert: (html: string) => string;
	/** Optional best-effort image download + markdown rewrite. */
	processImages?: (markdown: string, item: FeedItem) => Promise<string>;
	/**
	 * Optional best-effort media (podcast audio/video enclosure) download. Returns
	 * the local path to thread into the note as composeOptions.mediaFile, or null
	 * when there is no media or the download failed. A failure must NOT fail the
	 * item: the runner catches, logs, and writes the note without a local file.
	 */
	downloadMedia?: (item: FeedItem) => Promise<string | null>;
	/** Optional debug logger; defaults to a no-op when absent. */
	debugLogger?: DebugLogger;
}

/**
 * The slice of FeedSource the runner actually consumes. Narrowed to fetchBody so
 * tests inject a one-method stub and the runner does not depend on resolve /
 * listItems. The concrete FeedSource satisfies this structurally.
 */
export interface FeedSourceLike {
	fetchBody(item: FeedItem): Promise<FeedItem>;
}

/** Options for a single run() call. */
export interface ImportRunOptions {
	/** Feed-level tags applied to every note, merged with each item's own tags. */
	feedTags?: string[];
	/** Invoked after each item is processed (success or failure). */
	onProgress?: (progress: ImportProgress) => void;
	/** Polled before each item; returning true ends the loop cleanly. */
	isAborted?: () => boolean;
}

export class ImportRunner {
	private readonly source: FeedSourceLike;
	private readonly noteWriter: NoteWriter;
	private readonly convert: (html: string) => string;
	private readonly processImages?: (
		markdown: string,
		item: FeedItem,
	) => Promise<string>;
	private readonly downloadMedia?: (item: FeedItem) => Promise<string | null>;
	private readonly debug?: DebugLogger;

	constructor(deps: ImportRunnerDeps) {
		this.source = deps.source;
		this.noteWriter = deps.noteWriter;
		this.convert = deps.convert;
		this.processImages = deps.processImages;
		this.downloadMedia = deps.downloadMedia;
		this.debug = deps.debugLogger;
	}

	async run(
		items: readonly FeedItem[],
		opts: ImportRunOptions,
	): Promise<ImportTally> {
		const tally: ImportTally = {
			total: items.length,
			created: 0,
			overwritten: 0,
			skipped: 0,
			failed: 0,
			results: [],
		};

		for (let index = 0; index < items.length; index++) {
			// Check abort BEFORE doing any work for this item, so an abort
			// requested mid-run stops cleanly without starting the next fetch.
			if (opts.isAborted?.() === true) {
				this.debug?.log({
					kind: "note",
					message: `Import aborted before item ${index + 1} of ${items.length}`,
				});
				break;
			}

			const item = items[index];
			if (item === undefined) {
				// Defensive: indexed access is guarded so the loop body never
				// operates on undefined even if the array is sparse.
				continue;
			}

			const result = await this.importOne(item, opts.feedTags);
			tally.results.push(result);
			this.recordStatus(tally, result.status);

			// onProgress reports the fetched item when we have it. importOne
			// returns the item it actually operated on (the fetched one on
			// success, the original on an early fetch failure).
			opts.onProgress?.({
				index,
				total: items.length,
				item: result.item,
			});
		}

		return tally;
	}

	/**
	 * Import a single item end to end. Returns an ImportItemResult; never throws
	 * for an ordinary per-item failure. The ONLY error it rethrows is
	 * NoteWriterCancelledError, which signals a user-requested abort of the whole
	 * batch and must escape run().
	 */
	private async importOne(
		item: FeedItem,
		feedTags: string[] | undefined,
	): Promise<ImportItemResult> {
		// Track the item we will report progress for. On a successful fetch this
		// becomes the body-populated item; on a fetch failure it stays the
		// original so the caller still gets a sensible item reference.
		let reported: FeedItem = item;
		try {
			const full = await this.source.fetchBody(item);
			reported = full;

			const html = full.contentHtml ?? "";
			let markdown = this.convert(html);

			if (this.processImages !== undefined) {
				try {
					markdown = await this.processImages(markdown, full);
				} catch (err) {
					// Best-effort: an image pass failure must not fail the item.
					// Keep the converted markdown as-is and log the detail.
					console.error(err);
					this.debug?.log({
						kind: "error",
						message: `Image processing failed for "${full.title}", keeping converted text`,
						payload: describeError(err),
					});
				}
			}

			// An empty body is not a failure (the feed simply gave no content), but
			// it is worth a diagnostic note so an unexpectedly blank note is
			// traceable to a content-less feed rather than a conversion bug.
			if (markdown.trim().length === 0) {
				this.debug?.log({
					kind: "note",
					message: `Imported "${full.title}" with an empty body (feed provided no content)`,
					endpoint: full.url,
				});
			}

			// Best-effort media download. A failure must NOT fail the item: catch,
			// log, and write the note without a local file (the remote media-url
			// stays in frontmatter and as the body link).
			let mediaFile: string | undefined;
			if (this.downloadMedia !== undefined && full.mediaUrl !== null && full.mediaUrl.length > 0) {
				try {
					const local = await this.downloadMedia(full);
					if (local !== null) {
						mediaFile = local;
					}
				} catch (err) {
					console.error(err);
					this.debug?.log({
						kind: "error",
						message: `Media download failed for "${full.title}", keeping the remote link`,
						payload: describeError(err),
					});
				}
			}

			const outcome = await this.noteWriter.writeNote(full, markdown, {
				feedTags,
				mediaFile,
			});
			this.debug?.log({
				kind: "note",
				message: `${outcome.status} ${outcome.path}`,
				endpoint: full.url,
			});
			return {
				item: full,
				status: outcome.status,
				path: outcome.path,
				reason: null,
			};
		} catch (err) {
			// A user cancellation from the duplicate prompt aborts the whole run.
			// Re-throw so run() unwinds and the caller can report the cancel.
			if (err instanceof NoteWriterCancelledError) {
				throw err;
			}
			const reason = describeError(err);
			console.error(err);
			this.debug?.log({
				kind: "error",
				message: `Failed to import "${reported.title}": ${reason}`,
				endpoint: reported.url,
			});
			return {
				item: reported,
				status: "failed",
				path: null,
				reason,
			};
		}
	}

	/** Bump the matching counter for a recorded item status. */
	private recordStatus(
		tally: ImportTally,
		status: ImportItemResult["status"],
	): void {
		switch (status) {
			case "created":
				tally.created++;
				break;
			case "overwritten":
				tally.overwritten++;
				break;
			case "skipped":
				tally.skipped++;
				break;
			case "failed":
				tally.failed++;
				break;
		}
	}
}

/** Render a caught unknown into a non-empty human message. */
function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message.length > 0 ? err.message : err.name;
	}
	return String(err);
}

/**
 * One-line human summary of a completed import for a Notice. Counts that are
 * zero are still shown so the message reads consistently across runs (e.g.
 * "Imported 3, skipped 1, failed 0"). "Imported" folds created and overwritten
 * together because both produced a note on disk.
 */
export function formatImportNotice(tally: ImportTally): string {
	const imported = tally.created + tally.overwritten;
	return `Imported ${imported}, skipped ${tally.skipped}, failed ${tally.failed}`;
}
