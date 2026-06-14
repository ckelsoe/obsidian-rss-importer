import {
	Notice,
	Plugin,
	TFile,
	requestUrl,
	type RequestUrlResponse,
} from "obsidian";

import type { FeedSource, HttpFetcher, HttpRequest, HttpResponse, SourceType } from "./feed-source";
import {
	DEFAULT_SETTINGS,
	buildCleanupConfig,
	cleanupHasRules,
	effectiveDownloadMedia,
	effectiveImageSubfolder,
	effectiveImagesMode,
	effectiveMediaLocation,
	effectiveMediaOutsideFolder,
	effectiveMediaSubfolder,
	effectiveNoteNameTemplate,
	type FeedConfig,
	type RssImporterSettings,
} from "./settings";
import { GenericRssFeedSource } from "./source-generic";
import { SubstackFeedSource } from "./source-substack";
import { FetchPacer } from "./fetch-pacer";
import {
	NoteWriter,
	type DuplicatePromptCallback,
	type DuplicatePromptDecision,
} from "./note-writer";
import { convertHtmlToMarkdown } from "./html-converter";
import { applyCleanup, splitFrontmatter } from "./cleanup";
import { ImageDownloader } from "./image-downloader";
import { MediaDownloader } from "./media-downloader";
import { DismissStore } from "./dismiss-store";
import { BufferedDebugLogger } from "./debug-logger";
import { ImportRunner } from "./import-runner";
import { ImportModal } from "./import-modal";
import { AddFeedModal } from "./add-feed-modal";
import { FeedPickerModal } from "./feed-picker-modal";
import { DuplicatePromptModal } from "./duplicate-prompt-modal";
import { RssImporterSettingTab, type RssImporterPluginLike } from "./settings-tab";

// Adapt Obsidian's requestUrl to the plugin's HttpFetcher contract. requestUrl
// (not fetch) is required to avoid CORS and certificate issues on Electron, and
// it is the only HTTP path Obsidian sanctions for plugins. `throw: false` lets
// the sources map status codes themselves (3xx redirect walking, 429 backoff)
// instead of Obsidian throwing first.
const obsidianFetcher: HttpFetcher = async (req: HttpRequest): Promise<HttpResponse> => {
	const response = await requestUrl({
		url: req.url,
		method: req.method ?? "GET",
		headers: req.headers ? { ...req.headers } : undefined,
		body: req.body,
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers ?? {},
		json: safeJson(response),
		text: response.text ?? "",
		arrayBuffer: response.arrayBuffer ?? new ArrayBuffer(0),
	};
};

// requestUrl's `json` is a getter that parses `text` lazily and throws a
// SyntaxError on invalid JSON. Catch ONLY SyntaxError and return null so the
// source layer produces a clear parse error with the raw body. Any other
// exception is a genuine bug and propagates loudly.
function safeJson(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch (err) {
		if (err instanceof SyntaxError) {
			return null;
		}
		throw err;
	}
}

// Wrap a long-running async action so a mid-run failure surfaces as a Notice and
// a console error instead of an unhandled promise rejection.
function runGuarded(action: string, fn: () => Promise<void>): void {
	fn().catch((err: unknown) => {
		console.error(`RSS Importer: ${action} failed`, err);
		const detail = err instanceof Error ? err.message : "See the console for details.";
		new Notice(`${action} failed. ${detail}`);
	});
}

// Type guards for the per-feed literal-union fields read from data.json. Stored
// settings are user-editable JSON, so a value can be missing or a wrong literal;
// these narrow to the known unions before the value is trusted.
function isImagesMode(value: unknown): value is import("./settings").ImagesMode {
	return value === "link" || value === "download";
}

function isDuplicatePolicy(value: unknown): value is import("./settings").DuplicatePolicy {
	return value === "skip" || value === "overwrite" || value === "prompt";
}

function isMediaLocation(value: unknown): value is import("./settings").MediaLocation {
	return value === "vault" || value === "outside";
}

// Narrow a stored value to an array of strings (the shape of a cleanup host
// list). Used to validate both the global default and per-feed overrides.
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// Best-effort recovery of a host list from a malformed stored value: keep the
// string entries of an array, else fall back to the given default. Used only for
// the global field, which always has a value (unlike droppable per-feed fields).
function coerceStringArray(value: unknown, fallback: string[]): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	return [...fallback];
}

// Sync classification used only to pick which source resolves a freshly entered
// input for the add-feed preview. The resolved feed's own sourceType (captured
// into the FeedConfig) is what drives import, so a custom-domain Substack that
// falls through to "generic" here still imports its free posts correctly.
function classifyInputSourceType(input: string): SourceType {
	const trimmed = input.trim().toLowerCase();
	if (
		trimmed.startsWith("@") ||
		trimmed.includes("substack.com/@") ||
		/(^|\/\/|\.)substack\.com(\/|$)/.test(trimmed) ||
		trimmed.includes(".substack.com")
	) {
		return "substack";
	}
	return "generic";
}

export default class RssImporterPlugin extends Plugin implements RssImporterPluginLike {
	settings: RssImporterSettings = DEFAULT_SETTINGS;
	debugLogger: BufferedDebugLogger = new BufferedDebugLogger(false);
	private dismissStore!: DismissStore;
	private ribbonEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		// A load failure here is otherwise silent in the UI (Obsidian only logs
		// it to the developer console), so surface it with a Notice as well.
		try {
			await this.loadSettings();

			this.debugLogger = new BufferedDebugLogger(this.settings.debug, {
				headerLines: [`RSS Importer version: ${this.manifest.version}`],
			});

			this.dismissStore = new DismissStore({
				read: () => this.settings.dismissed,
				write: async (map) => {
					this.settings.dismissed = map;
					await this.saveData(this.settings);
				},
			});

			this.addSettingTab(new RssImporterSettingTab(this.app, this));

			this.addCommand({
				id: "import",
				name: "Import from a feed",
				callback: () => {
					this.launchImport();
				},
			});
			this.addCommand({
				id: "add-feed",
				name: "Add feed",
				callback: () => {
					this.openAddFeed();
				},
			});
			this.addCommand({
				id: "clean-up-notes",
				name: "Clean up imported notes",
				callback: () => {
					this.launchCleanup();
				},
			});
			this.addCommand({
				id: "export-debug-log",
				name: "Export debug log",
				callback: () => {
					runGuarded("Export debug log", () => this.exportDebugLog());
				},
			});
			this.addCommand({
				id: "clear-debug-log",
				name: "Clear debug log",
				callback: () => {
					this.debugLogger.clear();
					new Notice("Debug log cleared");
				},
			});

			this.updateRibbonIcon();
		} catch (err) {
			console.error("RSS Importer failed to load", err);
			new Notice(
				`RSS importer failed to load. ${err instanceof Error ? err.message : "See the console for details."}`,
			);
			throw err;
		}
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<RssImporterSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
		if (typeof this.settings.dismissed !== "object" || this.settings.dismissed === null) {
			this.settings.dismissed = {};
		}
		if (!Array.isArray(this.settings.feeds)) {
			this.settings.feeds = [];
		}

		// Coerce the literal-union fields. data.json is user-editable, so a stored
		// value can be a missing or invalid literal; fall back to the default for
		// the top-level fields and drop invalid per-feed overrides so the default
		// applies.
		if (!isImagesMode(this.settings.imagesMode)) {
			this.settings.imagesMode = DEFAULT_SETTINGS.imagesMode;
		}
		if (!isDuplicatePolicy(this.settings.duplicatePolicy)) {
			this.settings.duplicatePolicy = DEFAULT_SETTINGS.duplicatePolicy;
		}
		if (!isMediaLocation(this.settings.mediaLocation)) {
			this.settings.mediaLocation = DEFAULT_SETTINGS.mediaLocation;
		}
		// Coerce the global cleanup fields. A stored value can be a wrong type
		// (data.json is user-editable), so fall back to the default. The host list
		// is filtered to strings so a single bad entry cannot poison cleanup.
		if (!isStringArray(this.settings.cleanupLinkHosts)) {
			this.settings.cleanupLinkHosts = coerceStringArray(
				this.settings.cleanupLinkHosts,
				DEFAULT_SETTINGS.cleanupLinkHosts,
			);
		}
		if (typeof this.settings.cleanupTrimAfterLastRule !== "boolean") {
			this.settings.cleanupTrimAfterLastRule = DEFAULT_SETTINGS.cleanupTrimAfterLastRule;
		}
		for (const feed of this.settings.feeds) {
			// The per-feed override fields are optional literal/string unions on
			// FeedConfig, but data.json is user-editable so a stored value can be a
			// wrong type. View the feed as a loose record to inspect and drop the
			// bad override; deleting it makes the global default apply.
			const record = feed as unknown as Record<string, unknown>;
			if ("imagesMode" in record && !isImagesMode(record["imagesMode"])) {
				delete record["imagesMode"];
			}
			if ("noteNameTemplate" in record && typeof record["noteNameTemplate"] !== "string") {
				delete record["noteNameTemplate"];
			}
			if ("imageSubfolder" in record && typeof record["imageSubfolder"] !== "string") {
				delete record["imageSubfolder"];
			}
			if ("downloadMedia" in record && typeof record["downloadMedia"] !== "boolean") {
				delete record["downloadMedia"];
			}
			if ("mediaLocation" in record && !isMediaLocation(record["mediaLocation"])) {
				delete record["mediaLocation"];
			}
			if ("mediaSubfolder" in record && typeof record["mediaSubfolder"] !== "string") {
				delete record["mediaSubfolder"];
			}
			if ("mediaOutsideFolder" in record && typeof record["mediaOutsideFolder"] !== "string") {
				delete record["mediaOutsideFolder"];
			}
			// A per-feed cleanup host list must be an array of strings or be dropped
			// so the global default applies. The trim flag must be a boolean.
			if ("cleanupLinkHosts" in record && !isStringArray(record["cleanupLinkHosts"])) {
				delete record["cleanupLinkHosts"];
			}
			if (
				"cleanupTrimAfterLastRule" in record &&
				typeof record["cleanupTrimAfterLastRule"] !== "boolean"
			) {
				delete record["cleanupTrimAfterLastRule"];
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Re-sync derived state that depends on settings.
		this.debugLogger.setEnabled(this.settings.debug);
		this.updateRibbonIcon();
	}

	/**
	 * Picks a source for a freshly entered input (add-feed preview). Each call
	 * gets its own paced fetcher so the preview's single resolve is paced
	 * independently of any running import.
	 */
	makeSource(input: string): { source: FeedSource } {
		const fetcher = this.makeFetcher();
		const source: FeedSource =
			classifyInputSourceType(input) === "substack"
				? new SubstackFeedSource({ fetcher })
				: new GenericRssFeedSource({ fetcher });
		return { source };
	}

	// A fresh FetchPacer per session so each import or preview has its own
	// sequential queue and the configured inter-request delay.
	private makeFetcher(): HttpFetcher {
		const pacer = new FetchPacer(obsidianFetcher, { delayMs: this.settings.requestDelayMs });
		return (req) => pacer.fetch(req);
	}

	private makeSourceForFeed(feed: FeedConfig): FeedSource {
		const fetcher = this.makeFetcher();
		return feed.sourceType === "substack"
			? new SubstackFeedSource({ fetcher })
			: new GenericRssFeedSource({ fetcher });
	}

	private launchImport(): void {
		if (this.settings.feeds.length === 0) {
			new Notice("Add a feed first");
			this.openAddFeed();
			return;
		}
		const feeds = this.settings.feeds.filter((f) => f.enabled);
		if (feeds.length === 0) {
			new Notice("Every feed is disabled. Enable one in settings.");
			return;
		}
		if (feeds.length === 1) {
			const only = feeds[0];
			if (only !== undefined) {
				this.openImport(only);
			}
			return;
		}
		new FeedPickerModal(this.app, feeds, (feed) => {
			this.openImport(feed);
		}).open();
	}

	private openImport(feed: FeedConfig): void {
		let runner: ImportRunner;
		let source: FeedSource;
		// NoteWriter construction throws when the destination folder contains a
		// ".." segment that would escape the vault. That throw must not escape the
		// command callback uncaught, so the whole synchronous wiring is guarded and
		// the modal only opens on success.
		try {
			source = this.makeSourceForFeed(feed);
			const noteWriter = new NoteWriter({
				vault: this.app.vault,
				destinationFolder: feed.destinationFolder,
				noteNameTemplate: effectiveNoteNameTemplate(feed, this.settings),
				onDuplicate: this.settings.duplicatePolicy,
				promptOnDuplicate: this.promptOnDuplicate,
				tagDestination: this.settings.tagDestination,
			});

			let processImages: ((markdown: string, item: import("./feed-source").FeedItem) => Promise<string>) | undefined;
			if (effectiveImagesMode(feed, this.settings) === "download") {
				const downloader = new ImageDownloader({ fetcher: this.makeFetcher(), vault: this.app.vault });
				const subfolder = effectiveImageSubfolder(feed, this.settings);
				const folderPath =
					feed.destinationFolder === "" ? subfolder : `${feed.destinationFolder}/${subfolder}`;
				processImages = (markdown) => downloader.downloadAndRewrite(markdown, folderPath);
			}

			let downloadMedia: ((item: import("./feed-source").FeedItem) => Promise<string | null>) | undefined;
			if (effectiveDownloadMedia(feed, this.settings)) {
				const mediaDownloader = new MediaDownloader({
					fetcher: this.makeFetcher(),
					vault: this.app.vault,
				});
				const location = effectiveMediaLocation(feed, this.settings);
				const mediaSubfolder = effectiveMediaSubfolder(feed, this.settings);
				const vaultFolder =
					feed.destinationFolder === ""
						? mediaSubfolder
						: `${feed.destinationFolder}/${mediaSubfolder}`;
				const outsideFolder = effectiveMediaOutsideFolder(feed, this.settings);
				downloadMedia = (item) =>
					mediaDownloader.download(item, { location, vaultFolder, outsideFolder });
			}

			// Build a cleanup function only when this feed has active rules, so a
			// feed with none pays no per-item cost and the runner's cleanup pass is
			// skipped entirely.
			let cleanup: ((body: string) => string) | undefined;
			const cleanupConfig = buildCleanupConfig(feed, this.settings);
			if (cleanupHasRules(cleanupConfig)) {
				cleanup = (body) => applyCleanup(body, cleanupConfig);
			}

			runner = new ImportRunner({
				source,
				noteWriter,
				convert: convertHtmlToMarkdown,
				processImages,
				downloadMedia,
				cleanup,
				debugLogger: this.debugLogger,
			});
		} catch (err) {
			console.error(err);
			new Notice(
				`Could not start import. ${err instanceof Error ? err.message : "See the console."}`,
			);
			return;
		}

		new ImportModal(this.app, {
			feed,
			source,
			runner,
			settings: this.settings,
			dismissStore: this.dismissStore,
			onDone: () => {
				feed.lastImportedAt = new Date().toISOString();
				void this.saveSettings();
			},
		}).open();
	}

	// Re-runnable cleanup: pick a feed, then re-apply its deterministic cleanup
	// to the notes already on disk under its destination folder. Mirrors
	// launchImport's feed-selection flow (no feed -> add one, one -> straight
	// through, many -> picker).
	private launchCleanup(): void {
		if (this.settings.feeds.length === 0) {
			new Notice("Add a feed first");
			this.openAddFeed();
			return;
		}
		const feeds = this.settings.feeds;
		if (feeds.length === 1) {
			const only = feeds[0];
			if (only !== undefined) {
				runGuarded("Clean up imported notes", () => this.cleanupFeedNotes(only));
			}
			return;
		}
		new FeedPickerModal(this.app, feeds, (feed) => {
			runGuarded("Clean up imported notes", () => this.cleanupFeedNotes(feed));
		}).open();
	}

	/**
	 * Re-apply a feed's deterministic cleanup to its existing notes. Enumerates
	 * the markdown files under the feed's destination folder (the same folder-
	 * prefix scan vault-index uses), splits the frontmatter from the body, cleans
	 * the body, and writes back via vault.process only when the body changed. The
	 * frontmatter is never touched. Reports "Cleaned N of M notes".
	 */
	private async cleanupFeedNotes(feed: FeedConfig): Promise<void> {
		const config = buildCleanupConfig(feed, this.settings);
		if (!cleanupHasRules(config)) {
			new Notice("This feed has no cleanup rules. Add some in settings.");
			return;
		}

		const folder = feed.destinationFolder.trim().replace(/^\/+|\/+$/g, "");
		const prefix = folder === "" ? "" : `${folder}/`;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => prefix === "" || file.path.startsWith(prefix));

		let cleaned = 0;
		for (const file of files) {
			if (!(file instanceof TFile)) {
				continue;
			}
			let changed = false;
			await this.app.vault.process(file, (content) => {
				const parts = splitFrontmatter(content);
				const cleanedBody = applyCleanup(parts.body, config);
				if (cleanedBody === parts.body) {
					return content;
				}
				changed = true;
				return `${parts.frontmatter}${cleanedBody}`;
			});
			if (changed) {
				cleaned++;
			}
		}

		new Notice(`Cleaned ${cleaned} of ${files.length} notes`);
	}

	private openAddFeed(): void {
		new AddFeedModal(this.app, {
			settings: this.settings,
			makeSource: (input) => this.makeSource(input),
			onSave: async (feed) => {
				this.settings.feeds.push(feed);
				await this.saveSettings();
			},
		}).open();
	}

	// The duplicate-policy prompt callback, used only when duplicatePolicy is
	// "prompt". Resolves to overwrite, skip, or cancel.
	private readonly promptOnDuplicate: DuplicatePromptCallback = (context) => {
		return new Promise<DuplicatePromptDecision>((resolve) => {
			new DuplicatePromptModal(this.app, context, resolve).open();
		});
	};

	private async exportDebugLog(): Promise<void> {
		const text = this.debugLogger.format();
		await navigator.clipboard.writeText(text);
		new Notice("Debug log copied to clipboard");
	}

	private updateRibbonIcon(): void {
		if (this.settings.showRibbonIcon && this.ribbonEl === null) {
			this.ribbonEl = this.addRibbonIcon(this.settings.ribbonIcon, "Import from a feed", () => {
				this.launchImport();
			});
		} else if (!this.settings.showRibbonIcon && this.ribbonEl !== null) {
			this.ribbonEl.remove();
			this.ribbonEl = null;
		}
	}
}
