// Picks which configured feed to import from when more than one exists.

import { App, FuzzySuggestModal } from "obsidian";
import type { FeedConfig } from "./settings";

export class FeedPickerModal extends FuzzySuggestModal<FeedConfig> {
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
