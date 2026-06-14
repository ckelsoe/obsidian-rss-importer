// Regression test for the add-feed Save button. The button previously mixed
// Obsidian's ButtonComponent.setDisabled() with raw toggleAttribute() and stayed
// disabled, and required a prior Resolve click, so Save appeared to do nothing.
// Save now resolves on demand and calls onSave. No DOM is built here (onOpen is
// bypassed); the input fields are injected so save() can run headless.

import { App } from "obsidian";
import { AddFeedModal, type AddFeedModalDeps } from "../add-feed-modal";
import { DEFAULT_SETTINGS, type FeedConfig } from "../settings";
import type { FeedSource, ResolvedFeed } from "../feed-source";

function cannedResolved(): ResolvedFeed {
	return {
		sourceType: "generic",
		feedId: "example.com",
		canonicalHost: "example.com",
		feedUrl: "https://example.com/feed",
		publicationTitle: "Example",
		author: "Anne Author",
		sampleTitles: ["One", "Two"],
		audienceHint: "unknown",
	};
}

interface ModalInternals {
	inputEl: { value: string };
	folderInputEl: { value: string };
	tagsInputEl: { value: string };
	save(): Promise<void>;
}

function makeModal(
	onSave: (feed: FeedConfig) => Promise<void>,
	resolve: () => Promise<ResolvedFeed> = () => Promise.resolve(cannedResolved()),
): AddFeedModal {
	const source: FeedSource = {
		type: "generic",
		resolve,
		listItems: () => Promise.resolve([]),
		fetchBody: (item) => Promise.resolve(item),
	};
	const deps: AddFeedModalDeps = {
		settings: { ...DEFAULT_SETTINGS },
		makeSource: () => ({ source }),
		onSave,
	};
	const modal = new AddFeedModal(new App(), deps);
	const internals = modal as unknown as ModalInternals;
	internals.inputEl = { value: "https://example.com/feed" };
	internals.folderInputEl = { value: "" };
	internals.tagsInputEl = { value: "reading, feeds" };
	return modal;
}

describe("AddFeedModal save", () => {
	it("resolves on demand and saves when Save is clicked without a prior Resolve", async () => {
		const saved: FeedConfig[] = [];
		const modal = makeModal((feed) => {
			saved.push(feed);
			return Promise.resolve();
		});
		await (modal as unknown as ModalInternals).save();

		expect(saved).toHaveLength(1);
		const feed = saved[0];
		expect(feed?.feedUrl).toBe("https://example.com/feed");
		expect(feed?.sourceType).toBe("generic");
		expect(feed?.canonicalHost).toBe("example.com");
		// Empty folder input falls back to <parent>/<publication>.
		expect(feed?.destinationFolder).toBe("Feeds/Example");
		expect(feed?.tags).toEqual(["reading", "feeds"]);
	});

	it("does not call onSave when resolve fails", async () => {
		let calls = 0;
		const modal = makeModal(
			() => {
				calls += 1;
				return Promise.resolve();
			},
			() => Promise.reject(new Error("network down")),
		);
		await (modal as unknown as ModalInternals).save();
		expect(calls).toBe(0);
	});
});
