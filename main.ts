import {
	App,
	FuzzySuggestModal,
	Modal,
	Notice,
	Plugin,
	Setting,
	requestUrl,
	type RequestUrlResponse,
} from "obsidian";

import type { FeedSource, HttpFetcher, HttpRequest, HttpResponse, SourceType } from "./feed-source";
import {
	DEFAULT_SETTINGS,
	effectiveImageSubfolder,
	effectiveImagesMode,
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
	type DuplicatePromptContext,
	type DuplicatePromptDecision,
} from "./note-writer";
import { convertHtmlToMarkdown } from "./html-converter";
import { ImageDownloader } from "./image-downloader";
import { DismissStore } from "./dismiss-store";
import { BufferedDebugLogger } from "./debug-logger";
import { ImportRunner } from "./import-runner";
import { ImportModal } from "./import-modal";
import { AddFeedModal } from "./add-feed-modal";
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
		const source = this.makeSourceForFeed(feed);
		const noteWriter = new NoteWriter({
			vault: this.app.vault,
			destinationFolder: feed.destinationFolder,
			noteNameTemplate: effectiveNoteNameTemplate(feed, this.settings),
			onDuplicate: this.settings.duplicatePolicy,
			promptOnDuplicate: this.promptOnDuplicate,
		});

		let processImages: ((markdown: string, item: import("./feed-source").FeedItem) => Promise<string>) | undefined;
		if (effectiveImagesMode(feed, this.settings) === "download") {
			const downloader = new ImageDownloader({ fetcher: this.makeFetcher(), vault: this.app.vault });
			const subfolder = effectiveImageSubfolder(feed, this.settings);
			const folderPath =
				feed.destinationFolder === "" ? subfolder : `${feed.destinationFolder}/${subfolder}`;
			processImages = (markdown) => downloader.downloadAndRewrite(markdown, folderPath);
		}

		const runner = new ImportRunner({
			source,
			noteWriter,
			convert: convertHtmlToMarkdown,
			processImages,
			debugLogger: this.debugLogger,
		});

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

// Picks which configured feed to import from when more than one exists.
class FeedPickerModal extends FuzzySuggestModal<FeedConfig> {
	private readonly feeds: FeedConfig[];
	private readonly onChoose: (feed: FeedConfig) => void;

	constructor(app: App, feeds: FeedConfig[], onChoose: (feed: FeedConfig) => void) {
		super(app);
		this.feeds = feeds;
		this.onChoose = onChoose;
		this.setPlaceholder("Pick a feed to import from");
	}

	getItems(): FeedConfig[] {
		return this.feeds;
	}

	getItemText(feed: FeedConfig): string {
		return feed.publicationTitle;
	}

	onChooseItem(feed: FeedConfig): void {
		this.onChoose(feed);
	}
}

// Asks the user whether to overwrite, skip, or cancel when a same-item note
// already exists and the duplicate policy is "prompt".
class DuplicatePromptModal extends Modal {
	private readonly context: DuplicatePromptContext;
	private readonly resolve: (decision: DuplicatePromptDecision) => void;
	private decided = false;

	constructor(
		app: App,
		context: DuplicatePromptContext,
		resolve: (decision: DuplicatePromptDecision) => void,
	) {
		super(app);
		this.context = context;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.setTitle("Note already exists");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: `A note for "${this.context.itemTitle}" already exists at ${this.context.targetPath}. Overwrite it?`,
		});
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Overwrite")
					.setDestructive()
					.onClick(() => {
						this.settle("overwrite");
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Skip").onClick(() => {
					this.settle("skip");
				}),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel import").onClick(() => {
					this.settle("cancel");
				}),
			);
	}

	onClose(): void {
		// Dismissing the modal without a choice cancels the import.
		this.settle("cancel");
		this.contentEl.empty();
	}

	private settle(decision: DuplicatePromptDecision): void {
		if (this.decided) {
			return;
		}
		this.decided = true;
		this.resolve(decision);
		this.close();
	}
}
