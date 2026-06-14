// Settings tab for RSS Importer, built on the declarative getSettingDefinitions
// API (Obsidian 1.13.0+). The tab has two sections:
//   - A "Feeds" list: each configured feed is a navigable page (edit metadata
//     or remove it); the add affordance opens the AddFeedModal.
//   - A "Defaults" group: the global controls each feed falls back to, bound by
//     key to the plugin's settings store via getControlValue/setControlValue.
// Heading words banned by the scorecard ("settings", "options", "general", and
// the plugin name) are deliberately avoided.

import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	SettingPage,
	type Plugin,
	type SettingDefinitionItem,
} from "obsidian";
import type { FeedSource } from "./feed-source";
import type { FeedConfig, RssImporterSettings } from "./settings";
import { REQUEST_DELAY_MIN, REQUEST_DELAY_MAX } from "./settings";
import { AddFeedModal } from "./add-feed-modal";

/**
 * The minimal plugin surface this tab and the modals it opens need. Declared
 * structurally rather than importing the concrete plugin class from main.ts so
 * the UI shell does not create an import cycle. The real plugin satisfies this.
 */
export interface RssImporterPluginLike extends Plugin {
	settings: RssImporterSettings;
	saveSettings(): Promise<void>;
	/** Picks a source for a user-supplied feed input (wired in main.ts). */
	makeSource(input: string): { source: FeedSource };
}

export class RssImporterSettingTab extends PluginSettingTab {
	// Narrow the base PluginSettingTab `plugin` field to our typed plugin. This
	// must be a plain field, NOT a getter: the base constructor assigns
	// `this.plugin = plugin`, which throws against a getter-only accessor.
	plugin: RssImporterPluginLike;

	constructor(app: App, plugin: RssImporterPluginLike) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const feeds = this.plugin.settings.feeds;
		return [
			{
				type: "list",
				heading: "Feeds",
				emptyState: "No feeds yet. Add one to start importing.",
				onDelete: (index: number) => {
					this.removeFeed(index);
				},
				addItem: {
					name: "Add feed",
					action: () => {
						this.openAddFeed();
					},
				},
				items: feeds.map((feed) => ({
					type: "page" as const,
					name: feed.publicationTitle.length > 0 ? feed.publicationTitle : feed.canonicalHost,
					desc: feed.enabled ? feed.destinationFolder : `(disabled) ${feed.destinationFolder}`,
					page: () => new FeedEditorPage(this, feed),
				})),
			},
			{
				type: "group",
				heading: "Defaults",
				items: [
					{
						name: "Show ribbon icon",
						desc: "Add a left-ribbon button that opens the importer.",
						control: { type: "toggle", key: "showRibbonIcon" },
					},
					{
						name: "Duplicate handling",
						desc: "What to do when a note already exists for an item.",
						control: {
							type: "dropdown",
							key: "duplicatePolicy",
							options: {
								skip: "Skip",
								overwrite: "Overwrite",
								prompt: "Ask each time",
							},
						},
					},
					{
						name: "Request delay",
						desc: "Pause between feed requests, in milliseconds.",
						control: {
							type: "slider",
							key: "requestDelayMs",
							min: REQUEST_DELAY_MIN,
							max: REQUEST_DELAY_MAX,
							step: 100,
						},
					},
					{
						name: "Images",
						desc: "Link to remote images, or download them into the vault.",
						control: {
							type: "dropdown",
							key: "imagesMode",
							options: {
								link: "Link to remote",
								download: "Download into vault",
							},
						},
					},
					{
						name: "Parent folder",
						desc: "Default parent folder for new feeds.",
						control: { type: "folder", key: "defaultParentFolder" },
					},
					{
						name: "Note name template",
						desc: "Tokens: {{date}}, {{title}}, {{slug}}.",
						control: { type: "text", key: "noteNameTemplate" },
					},
					{
						name: "Verbose logging",
						desc: "Write detailed import logs to the developer console.",
						control: { type: "toggle", key: "debug" },
					},
				],
			},
		];
	}

	// Binds declarative control reads to the plugin's own settings store. The
	// `as unknown as Record<string, unknown>` cast is the controlled pattern the
	// reference plugin uses for the settings store; keys come only from the
	// control definitions above.
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		this.refreshDomState();
	}

	private openAddFeed(): void {
		new AddFeedModal(this.app, {
			settings: this.plugin.settings,
			makeSource: (input: string) => this.plugin.makeSource(input),
			onSave: async (feed: FeedConfig) => {
				this.plugin.settings.feeds.push(feed);
				await this.plugin.saveSettings();
				this.update();
			},
		}).open();
	}

	private removeFeed(index: number): void {
		const feeds = this.plugin.settings.feeds;
		if (index < 0 || index >= feeds.length) {
			return;
		}
		feeds.splice(index, 1);
		void this.plugin.saveSettings();
		this.update();
	}

}

// A navigable sub-page for editing one feed's metadata. SettingPage.display()
// (not the deprecated PluginSettingTab.display()) is the supported way to render
// an imperative sub-page opened from a declarative list item.
class FeedEditorPage extends SettingPage {
	private readonly tab: RssImporterSettingTab;
	private readonly feed: FeedConfig;

	constructor(tab: RssImporterSettingTab, feed: FeedConfig) {
		super();
		this.tab = tab;
		this.feed = feed;
		this.title = feed.publicationTitle.length > 0 ? feed.publicationTitle : feed.canonicalHost;
	}

	private get plugin(): RssImporterPluginLike {
		return this.tab.plugin;
	}

	display(): void {
		const feed = this.feed;
		const editor = this.containerEl;
		editor.empty();

		new Setting(editor)
			.setName("Enabled")
			.setDesc("Turn importing for this feed on or off.")
			.addToggle((toggle) =>
				toggle.setValue(feed.enabled).onChange(async (value) => {
					feed.enabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(editor)
			.setName("Title")
			.setDesc("Display name for this feed.")
			.addText((text) =>
				text.setValue(feed.publicationTitle).onChange(async (value) => {
					feed.publicationTitle = value;
					this.title = value.length > 0 ? value : feed.canonicalHost;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(editor)
			.setName("Destination folder")
			.setDesc("Where this feed's notes are saved.")
			.addText((text) =>
				text.setValue(feed.destinationFolder).onChange(async (value) => {
					feed.destinationFolder = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(editor)
			.setName("Tags")
			.setDesc("Comma-separated tags applied to every note from this feed.")
			.addText((text) =>
				text.setValue(feed.tags.join(", ")).onChange(async (value) => {
					feed.tags = value
						.split(",")
						.map((t) => t.trim())
						.filter((t) => t.length > 0);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(editor)
			.setName("Pull item tags")
			.setDesc("Also import each item's own tags from the source feed.")
			.addToggle((toggle) =>
				toggle.setValue(feed.importSourceTags).onChange(async (value) => {
					feed.importSourceTags = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(editor)
			.setName("Remove feed")
			.setDesc("Delete this feed. Imported notes are left in place.")
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setDestructive()
					.onClick(async () => {
						const feeds = this.plugin.settings.feeds;
						const index = feeds.indexOf(feed);
						if (index >= 0) {
							feeds.splice(index, 1);
							await this.plugin.saveSettings();
							new Notice(`Removed feed ${this.title}.`);
							this.tab.update();
						}
					}),
			);
	}
}
