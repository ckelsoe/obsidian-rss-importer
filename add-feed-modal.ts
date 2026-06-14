// Modal for adding a new feed.
//
// Flow: the user types a feed URL or Substack handle, clicks Resolve, and the
// modal classifies the input (handle/Substack -> SubstackFeedSource, else
// GenericRssFeedSource), calls source.resolve(input), and renders a preview
// card (publication title, canonical host, source-type badge, a few sample
// titles, free/paid hint). The destination folder defaults to
// `<defaultParentFolder>/<publicationTitle>` with folder autocomplete, and a
// tags field captures feed-level tags. Save is disabled until a successful
// resolve; on Save the modal builds a FeedConfig and hands it to the onSave
// callback supplied by the caller.

import { App, Modal, Notice, Setting } from "obsidian";
import type { FeedSource, ResolvedFeed } from "./feed-source";
import type { FeedConfig, RssImporterSettings } from "./settings";
import { createStackedRow } from "./ui-helpers";
import { FolderSuggest } from "./folder-suggest";

export interface AddFeedModalDeps {
	settings: RssImporterSettings;
	/** Picks a source for an input. The integrator wires this to the real sources. */
	makeSource: (input: string) => { source: FeedSource };
	onSave: (feed: FeedConfig) => Promise<void>;
}

/**
 * Build the default destination folder for a freshly resolved feed: the global
 * parent folder joined with the publication title. Both segments are trimmed of
 * surrounding slashes/whitespace so the join never produces a doubled or
 * leading slash. Exported for unit testing.
 */
export function defaultDestinationFolder(parentFolder: string, publicationTitle: string): string {
	const parent = parentFolder.trim().replace(/^\/+|\/+$/g, "");
	const title = publicationTitle.trim().replace(/[\\/]+/g, " ").replace(/^\/+|\/+$/g, "").trim();
	if (parent.length === 0) {
		return title;
	}
	if (title.length === 0) {
		return parent;
	}
	return `${parent}/${title}`;
}

/**
 * Split a comma-separated tags string into a clean list: trim each entry, drop
 * empties, dedupe while preserving order. Exported for unit testing.
 */
export function parseTagsInput(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const tag = part.trim();
		if (tag.length === 0 || seen.has(tag)) {
			continue;
		}
		seen.add(tag);
		out.push(tag);
	}
	return out;
}

export class AddFeedModal extends Modal {
	private readonly deps: AddFeedModalDeps;

	private resolved: ResolvedFeed | null = null;
	private source: FeedSource | null = null;

	private inputEl: HTMLInputElement | null = null;
	private folderInputEl: HTMLInputElement | null = null;
	private tagsInputEl: HTMLInputElement | null = null;
	private previewEl: HTMLDivElement | null = null;
	private saveButtonEl: HTMLButtonElement | null = null;
	private folderEdited = false;
	private focusTimer: number | null = null;

	constructor(app: App, deps: AddFeedModalDeps) {
		super(app);
		this.deps = deps;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rss-importer-add-feed");
		this.setTitle("Add feed");

		// Input plus Resolve button. Stacked so the input gets full width and
		// the button sits beneath it.
		const inputRow = createStackedRow(contentEl, {
			name: "Feed URL or handle",
			description: "A feed URL, a Substack subdomain or post URL, or an @handle.",
		});
		const input = inputRow.content.createEl("input", {
			cls: "rss-importer-text-input",
			attr: { type: "text", placeholder: "Paste a feed URL or @handle" },
		});
		this.inputEl = input;
		const resolveBtn = inputRow.content.createEl("button", {
			cls: "rss-importer-resolve-button mod-cta",
			text: "Resolve",
			attr: { type: "button" },
		});
		resolveBtn.addEventListener("click", () => {
			void this.resolveInput();
		});
		input.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void this.resolveInput();
			}
		});

		// Preview card (filled in after a successful resolve).
		const previewRow = createStackedRow(contentEl, {
			name: "Preview",
			description: "Resolve the feed to see its details before saving.",
		});
		this.previewEl = previewRow.content.createDiv({ cls: "rss-importer-preview" });
		this.renderPreviewPlaceholder();

		// Destination folder with vault autocomplete.
		const folderRow = createStackedRow(contentEl, {
			name: "Destination folder",
			description: "Where this feed's notes are saved.",
		});
		const folderInput = folderRow.content.createEl("input", {
			cls: "rss-importer-text-input",
			attr: { type: "text", placeholder: this.deps.settings.defaultParentFolder },
		});
		this.folderInputEl = folderInput;
		new FolderSuggest(this.app, folderInput);
		folderInput.addEventListener("input", () => {
			this.folderEdited = true;
		});

		// Feed-level tags.
		const tagsRow = createStackedRow(contentEl, {
			name: "Tags",
			description: "Comma-separated tags applied to every note from this feed.",
		});
		const tagsInput = tagsRow.content.createEl("input", {
			cls: "rss-importer-text-input",
			attr: { type: "text", placeholder: "Newsletter, reading" },
		});
		this.tagsInputEl = tagsInput;

		// Footer actions: Cancel and Save. Save stays disabled until resolved.
		const footer = new Setting(contentEl);
		footer.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				this.close();
			}),
		);
		footer.addButton((btn) => {
			btn
				.setButtonText("Save")
				.setCta()
				.setDisabled(true)
				.onClick(() => {
					void this.save();
				});
			this.saveButtonEl = btn.buttonEl;
		});

		this.focusTimer = window.setTimeout(() => {
			this.focusTimer = null;
			input.focus();
		}, 0);
	}

	onClose(): void {
		if (this.focusTimer !== null) {
			window.clearTimeout(this.focusTimer);
			this.focusTimer = null;
		}
		this.contentEl.empty();
	}

	// Classify the input, resolve it, and render the preview. All failures
	// surface as a Notice plus a console.error; the modal stays open so the
	// user can correct the input.
	private async resolveInput(): Promise<void> {
		const input = this.inputEl?.value.trim() ?? "";
		if (input.length === 0) {
			new Notice("Enter a feed URL or handle first.");
			return;
		}
		this.setSaveDisabled(true);
		this.renderPreviewLoading();
		try {
			const { source } = this.deps.makeSource(input);
			const resolved = await source.resolve(input);
			this.source = source;
			this.resolved = resolved;
			this.renderPreviewCard(resolved);
			this.seedFolderDefault(resolved);
			this.setSaveDisabled(false);
		} catch (err) {
			this.resolved = null;
			this.source = null;
			this.renderPreviewError();
			new Notice("Could not resolve that feed. Check the URL or handle and try again.");
			console.error(err);
		}
	}

	// Build a FeedConfig from the resolved feed plus the folder and tags inputs,
	// then hand it to the caller. Guards against a Save click that races the
	// resolve state.
	private async save(): Promise<void> {
		if (this.resolved === null) {
			new Notice("Resolve a feed before saving.");
			return;
		}
		const resolved = this.resolved;
		const folderRaw = this.folderInputEl?.value.trim() ?? "";
		const destinationFolder =
			folderRaw.length === 0
				? defaultDestinationFolder(this.deps.settings.defaultParentFolder, resolved.publicationTitle)
				: folderRaw;
		const tags = parseTagsInput(this.tagsInputEl?.value ?? "");

		const feed: FeedConfig = {
			feedId: resolved.feedId,
			sourceType: resolved.sourceType,
			feedUrl: resolved.feedUrl,
			canonicalHost: resolved.canonicalHost,
			publicationTitle: resolved.publicationTitle,
			author: resolved.author,
			destinationFolder,
			tags,
			tagNamespace: "",
			importSourceTags: true,
			enabled: true,
			addedAt: new Date().toISOString(),
			lastImportedAt: null,
		};

		try {
			await this.deps.onSave(feed);
			new Notice(`Added feed ${resolved.publicationTitle}.`);
			this.close();
		} catch (err) {
			new Notice("Could not save the feed. See the console for details.");
			console.error(err);
		}
	}

	private seedFolderDefault(resolved: ResolvedFeed): void {
		if (this.folderInputEl === null || this.folderEdited) {
			return;
		}
		this.folderInputEl.value = defaultDestinationFolder(
			this.deps.settings.defaultParentFolder,
			resolved.publicationTitle,
		);
	}

	private setSaveDisabled(disabled: boolean): void {
		if (this.saveButtonEl !== null) {
			this.saveButtonEl.toggleAttribute("disabled", disabled);
		}
	}

	private renderPreviewPlaceholder(): void {
		const el = this.previewEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.addClass("is-empty");
		el.removeClass("is-error");
		el.createSpan({
			cls: "rss-importer-preview-hint",
			text: "No feed resolved yet.",
		});
	}

	private renderPreviewLoading(): void {
		const el = this.previewEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.removeClass("is-empty");
		el.removeClass("is-error");
		el.createSpan({ cls: "rss-importer-preview-hint", text: "Resolving feed…" });
	}

	private renderPreviewError(): void {
		const el = this.previewEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.removeClass("is-empty");
		el.addClass("is-error");
		el.createSpan({
			cls: "rss-importer-preview-hint",
			text: "Could not resolve that feed.",
		});
	}

	// Render the resolved feed's details into the preview card.
	private renderPreviewCard(resolved: ResolvedFeed): void {
		const el = this.previewEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.removeClass("is-empty");
		el.removeClass("is-error");

		const header = el.createDiv({ cls: "rss-importer-preview-header" });
		header.createSpan({
			cls: "rss-importer-preview-title",
			text: resolved.publicationTitle.length > 0 ? resolved.publicationTitle : resolved.canonicalHost,
		});
		header.createSpan({
			cls: `rss-importer-source-badge rss-importer-source-${resolved.sourceType}`,
			text: resolved.sourceType === "substack" ? "Substack" : "RSS",
		});

		const meta = el.createDiv({ cls: "rss-importer-preview-meta" });
		meta.createSpan({ cls: "rss-importer-preview-host", text: resolved.canonicalHost });
		if (resolved.audienceHint !== "unknown") {
			meta.createSpan({
				cls: `rss-importer-audience-badge rss-importer-audience-${resolved.audienceHint}`,
				text: resolved.audienceHint === "paid" ? "Paid" : "Free",
			});
		}
		if (resolved.author !== null && resolved.author.length > 0) {
			meta.createSpan({ cls: "rss-importer-preview-author", text: `by ${resolved.author}` });
		}

		if (resolved.sampleTitles.length > 0) {
			const list = el.createEl("ul", { cls: "rss-importer-preview-samples" });
			for (const title of resolved.sampleTitles.slice(0, 5)) {
				list.createEl("li", { text: title });
			}
		} else {
			el.createSpan({
				cls: "rss-importer-preview-hint",
				text: "No recent items to preview.",
			});
		}
	}
}
