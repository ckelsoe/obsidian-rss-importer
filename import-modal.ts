// Modal for importing items from one configured feed.
//
// On open it enumerates the feed's items (building a ResolvedFeed from the
// stored FeedConfig), scans the destination folder for already-imported items,
// and renders a row per item with a three-state badge:
//   - imported: a note already exists for this item in the vault index.
//   - dismissed: the user dismissed this item via the dismiss store.
//   - available: neither of the above; the row gets a selection checkbox.
// Each row also offers Dismiss / Undismiss. The Import button runs the injected
// ImportRunner over the selected items, updating a live progress line, then
// shows the summary notice plus a per-item breakdown. The modal owns its abort
// flag and any timer, both reset on close.

import { App, Modal, Notice, setIcon } from "obsidian";
import type { FeedItem, ResolvedFeed } from "./feed-source";
import type { FeedConfig, RssImporterSettings } from "./settings";
import type { DismissStore } from "./dismiss-store";
import type { ImportRunner, ImportProgress, ImportTally } from "./import-runner";
import { formatImportNotice } from "./import-runner";
import { buildFeedItemIndex } from "./vault-index";
import type { ImportedRecord } from "./vault-index";

/** Soft cap on how many items to enumerate for the modal list. */
const LIST_ITEM_LIMIT = 50;

/** How many older items one "Load older" click pulls from the archive. */
const LOAD_OLDER_PAGE_SIZE = 12;

export type ItemBadgeState = "imported" | "dismissed" | "available";

export interface ImportModalDeps {
	feed: FeedConfig;
	source: import("./feed-source").FeedSource;
	runner: ImportRunner;
	settings: RssImporterSettings;
	dismissStore: DismissStore;
	onDone?: () => void;
}

/**
 * Reconstruct the minimal ResolvedFeed the source needs to enumerate items from
 * a stored FeedConfig. The config already carries the canonical metadata that
 * the original resolve captured, so this is a straight projection. Sample
 * titles and the audience hint are preview-only and not needed for listing, so
 * they default to empty/unknown. Exported for unit testing.
 */
export function buildResolvedFeedFromConfig(feed: FeedConfig): ResolvedFeed {
	return {
		sourceType: feed.sourceType,
		feedId: feed.feedId,
		canonicalHost: feed.canonicalHost,
		feedUrl: feed.feedUrl,
		publicationTitle: feed.publicationTitle,
		author: feed.author,
		sampleTitles: [],
		audienceHint: "unknown",
	};
}

/**
 * Decide the badge state for one item. Imported wins over dismissed (a note
 * already in the vault is the strongest signal), dismissed wins over available.
 * Pure and exported so the three-state logic is unit-testable without the DOM.
 */
export function badgeStateForItem(
	item: FeedItem,
	feedId: string,
	vaultIndex: ReadonlyMap<string, ImportedRecord>,
	dismissStore: Pick<DismissStore, "isDismissed">,
): ItemBadgeState {
	if (vaultIndex.has(item.id)) {
		return "imported";
	}
	if (dismissStore.isDismissed(feedId, item.id)) {
		return "dismissed";
	}
	return "available";
}

/**
 * The ids of items that are still selectable (badge state "available"): not yet
 * imported and not dismissed. "Select all" operates on exactly this set, so an
 * already-imported item is never re-selected. Pure and exported for testing.
 */
export function selectableItemIds(
	items: readonly FeedItem[],
	feedId: string,
	vaultIndex: ReadonlyMap<string, ImportedRecord>,
	dismissStore: Pick<DismissStore, "isDismissed">,
): string[] {
	const ids: string[] = [];
	for (const item of items) {
		if (badgeStateForItem(item, feedId, vaultIndex, dismissStore) === "available") {
			ids.push(item.id);
		}
	}
	return ids;
}

export interface SelectAllControlState {
	/** Button label reflecting whether the next click selects or clears. */
	label: string;
	/** True when nothing is selectable, so the control is inert. */
	disabled: boolean;
	/** What a click should do given the current selection. */
	action: "select" | "clear";
}

/**
 * Decide what the "Select all" control should show and do, given how many of the
 * loaded items are selectable (available) and how many of those are already
 * selected. The control is a toggle: once every selectable item is checked, the
 * same button clears them again. "Select all" only ever covers the items that
 * are currently loaded into the list, so with endless scroll the user can load
 * more and click again to extend the selection. Pure and exported for testing.
 */
export function selectAllControlState(
	selectableCount: number,
	selectedSelectableCount: number,
): SelectAllControlState {
	if (selectableCount === 0) {
		return { label: "Select all", disabled: true, action: "select" };
	}
	const allSelected = selectedSelectableCount >= selectableCount;
	return allSelected
		? { label: "Deselect all", disabled: false, action: "clear" }
		: { label: "Select all", disabled: false, action: "select" };
}

interface ItemRow {
	item: FeedItem;
	rowEl: HTMLDivElement;
	checkbox: HTMLInputElement | null;
}

export class ImportModal extends Modal {
	private readonly deps: ImportModalDeps;

	private aborted = false;
	private importing = false;
	// True while a "Load older" archive page is in flight, so a second click is
	// ignored and the button shows a loading state.
	private loadingOlder = false;
	// False once an archive page returns no new items, so the button stays hidden
	// rather than re-offering a page that yields nothing.
	private hasMoreOlder = true;
	// Where the next archive page starts. Grows by the number of items currently
	// loaded so each click pages further back.
	private items: FeedItem[] = [];
	private vaultIndex: Map<string, ImportedRecord> = new Map();
	private readonly rows: ItemRow[] = [];
	// Selected item ids, kept independent of the checkbox DOM. Dismiss/undismiss
	// and a post-import refresh rebuild the whole list, so the checkboxes cannot
	// be the only record of the selection or it would be lost on every re-render.
	private readonly selectedIds = new Set<string>();

	private listEl: HTMLDivElement | null = null;
	private loadCountEl: HTMLSpanElement | null = null;
	private selectCountEl: HTMLSpanElement | null = null;
	private selectAllButtonEl: HTMLButtonElement | null = null;
	private loadOlderEl: HTMLDivElement | null = null;
	private loadOlderButtonEl: HTMLButtonElement | null = null;
	private progressEl: HTMLDivElement | null = null;
	private summaryEl: HTMLDivElement | null = null;
	private importButtonEl: HTMLButtonElement | null = null;
	private focusTimer: number | null = null;
	// Endless scroll: an observer watches a sentinel at the bottom of the list and
	// auto-triggers the same archive backfill the "Load older" button does. Only
	// armed for sources with an archive (Substack); null otherwise or when the
	// runtime lacks IntersectionObserver, in which case the button is the fallback.
	private olderObserver: IntersectionObserver | null = null;
	private sentinelEl: HTMLDivElement | null = null;

	constructor(app: App, deps: ImportModalDeps) {
		super(app);
		this.deps = deps;
	}

	onOpen(): void {
		// Reset the abort flag once per modal open, not per import run, so a
		// reused modal instance starts clean while a single open session keeps a
		// consistent flag across loadItems and any number of runImport calls.
		this.aborted = false;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rss-importer-import-modal");
		this.setTitle(`Import from ${this.deps.feed.publicationTitle}`);

		// Toolbar above the list. Left: a running count of loaded items that grows
		// as endless scroll pages the archive, then reads "All N" once exhausted.
		// Right: how many of the loaded items are selected, plus a toggle that
		// selects every available (not-yet-imported) item or clears them all.
		const toolbar = contentEl.createDiv({ cls: "rss-importer-list-toolbar" });
		this.loadCountEl = toolbar.createSpan({ cls: "rss-importer-load-count" });

		const toolbarRight = toolbar.createDiv({ cls: "rss-importer-toolbar-right" });
		this.selectCountEl = toolbarRight.createSpan({ cls: "rss-importer-select-count" });
		const selectAllBtn = toolbarRight.createEl("button", {
			cls: "rss-importer-select-all-button",
			text: "Select all",
			attr: { type: "button" },
		});
		selectAllBtn.toggleAttribute("disabled", true);
		selectAllBtn.addEventListener("click", () => {
			this.toggleSelectAll();
		});
		this.selectAllButtonEl = selectAllBtn;

		this.listEl = contentEl.createDiv({ cls: "rss-importer-item-list" });
		this.renderListMessage("Loading items…");

		// Endless scroll: when the source has an archive, watch a bottom sentinel
		// inside the scrollable list and auto-load older items as it comes into
		// view. The "Load older" button below stays as a fallback and as the
		// terminal "No older items" indicator.
		if (this.deps.feed.sourceType === "substack" && typeof IntersectionObserver !== "undefined") {
			this.olderObserver = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							void this.loadOlder();
							break;
						}
					}
				},
				// A margin so the next page starts loading just before the user
				// hits the very bottom, keeping the scroll feeling continuous.
				{ root: this.listEl, rootMargin: "200px" },
			);
		}

		// Archive backfill is Substack-only: generic feeds expose no older items
		// beyond the recent window, so the control is created only for Substack.
		if (this.deps.feed.sourceType === "substack") {
			this.loadOlderEl = contentEl.createDiv({ cls: "rss-importer-load-older" });
			const olderBtn = this.loadOlderEl.createEl("button", {
				cls: "rss-importer-load-older-button",
				text: "Load older",
				attr: { type: "button" },
			});
			olderBtn.addEventListener("click", () => {
				void this.loadOlder();
			});
			this.loadOlderButtonEl = olderBtn;
			// Hidden until the first page of items has loaded.
			this.loadOlderEl.toggleClass("is-hidden", true);
		}

		this.progressEl = contentEl.createDiv({ cls: "rss-importer-progress" });
		this.summaryEl = contentEl.createDiv({ cls: "rss-importer-summary" });

		const actions = contentEl.createDiv({ cls: "rss-importer-modal-actions" });
		const importBtn = actions.createEl("button", {
			cls: "rss-importer-import-button mod-cta",
			text: "Import selected",
			attr: { type: "button" },
		});
		importBtn.toggleAttribute("disabled", true);
		importBtn.addEventListener("click", () => {
			void this.runImport();
		});
		this.importButtonEl = importBtn;

		const closeBtn = actions.createEl("button", {
			cls: "rss-importer-close-button",
			text: "Close",
			attr: { type: "button" },
		});
		closeBtn.addEventListener("click", () => {
			this.close();
		});

		void this.loadItems();
	}

	onClose(): void {
		this.aborted = true;
		if (this.focusTimer !== null) {
			window.clearTimeout(this.focusTimer);
			this.focusTimer = null;
		}
		if (this.olderObserver !== null) {
			this.olderObserver.disconnect();
			this.olderObserver = null;
		}
		this.sentinelEl = null;
		this.loadCountEl = null;
		this.selectCountEl = null;
		this.selectAllButtonEl = null;
		this.loadOlderEl = null;
		this.loadOlderButtonEl = null;
		this.contentEl.empty();
	}

	// Enumerate the feed's items and build the vault index, then render the list.
	// Any failure leaves a clear message in the list area plus a Notice.
	private async loadItems(): Promise<void> {
		try {
			const resolved = buildResolvedFeedFromConfig(this.deps.feed);
			const items = await this.deps.source.listItems(resolved, { limit: LIST_ITEM_LIMIT });
			if (this.aborted) {
				return;
			}
			this.items = items;
			this.vaultIndex = buildFeedItemIndex(this.app, this.deps.feed.destinationFolder);
			this.renderItems();
			this.refreshLoadOlder();
		} catch (err) {
			this.renderListMessage("Could not load this feed's items.");
			new Notice("Could not load this feed. See the console for details.");
			console.error(err);
		}
	}

	// Append a page of older items from the Substack archive. Each page starts at
	// the current item count (a soft offset), so successive clicks page further
	// back. New ids not already present are appended; the selection set is
	// preserved across the re-render. Failures show a Notice and never leave the
	// button stuck disabled. When a page yields no new items the button hides and
	// reads "No older items".
	private async loadOlder(): Promise<void> {
		if (this.loadingOlder) {
			return;
		}
		this.loadingOlder = true;
		this.refreshLoadOlder();
		try {
			const resolved = buildResolvedFeedFromConfig(this.deps.feed);
			const page = await this.deps.source.listItems(resolved, {
				offset: this.items.length,
				limit: LOAD_OLDER_PAGE_SIZE,
			});
			if (this.aborted) {
				return;
			}

			const existing = new Set(this.items.map((it) => it.id));
			let added = 0;
			for (const item of page) {
				if (existing.has(item.id)) {
					continue;
				}
				existing.add(item.id);
				this.items.push(item);
				added += 1;
			}

			if (added === 0) {
				this.hasMoreOlder = false;
			}
			this.renderItems();
		} catch (err) {
			new Notice("Could not load older items. See the console for details.");
			console.error(err);
		} finally {
			this.loadingOlder = false;
			this.refreshLoadOlder();
			// Re-arm against a fresh sentinel now that loading has cleared. The
			// render that ran mid-load could not re-trigger (the loading guard
			// swallowed it); observing a new element fires an initial callback, so
			// a short page that left the sentinel visible loads the next page too.
			this.observeSentinel();
		}
	}

	// Reflect the current load-older state onto the button: hidden when there are
	// no more older items, disabled and relabeled while a page is loading.
	private refreshLoadOlder(): void {
		const wrap = this.loadOlderEl;
		const btn = this.loadOlderButtonEl;
		if (wrap === null || btn === null) {
			return;
		}
		if (!this.hasMoreOlder) {
			wrap.toggleClass("is-hidden", false);
			btn.toggleAttribute("disabled", true);
			btn.setText("No older items");
			return;
		}
		wrap.toggleClass("is-hidden", false);
		btn.toggleAttribute("disabled", this.loadingOlder);
		btn.setText(this.loadingOlder ? "Loading…" : "Load older");
	}

	private renderListMessage(message: string): void {
		const el = this.listEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.createDiv({ cls: "rss-importer-list-message", text: message });
	}

	// Render one row per item with its badge and per-row actions.
	private renderItems(): void {
		const el = this.listEl;
		if (el === null) {
			return;
		}
		el.empty();
		this.rows.length = 0;

		if (this.items.length === 0) {
			this.renderListMessage("This feed has no items right now.");
			this.refreshImportButton();
			this.refreshSelectAll();
			this.refreshLoadCount();
			return;
		}

		for (const item of this.items) {
			this.renderItemRow(el, item);
		}
		this.refreshImportButton();
		this.refreshSelectAll();
		this.refreshLoadCount();
		this.observeSentinel();

		this.focusTimer = window.setTimeout(() => {
			this.focusTimer = null;
			this.importButtonEl?.focus();
		}, 0);
	}

	private renderItemRow(parent: HTMLElement, item: FeedItem): void {
		const state = badgeStateForItem(
			item,
			this.deps.feed.feedId,
			this.vaultIndex,
			this.deps.dismissStore,
		);

		const rowEl = parent.createDiv({ cls: `rss-importer-item-row is-${state}` });

		// Selection cell: a checkbox only for available items; a badge for
		// imported/dismissed rows so the layout stays aligned.
		const selectCell = rowEl.createDiv({ cls: "rss-importer-item-select" });
		let checkbox: HTMLInputElement | null = null;
		if (state === "available") {
			checkbox = selectCell.createEl("input", {
				cls: "rss-importer-item-checkbox",
				attr: { type: "checkbox" },
			});
			// Restore prior selection across re-renders.
			checkbox.checked = this.selectedIds.has(item.id);
			const box = checkbox;
			checkbox.addEventListener("change", () => {
				if (box.checked) {
					this.selectedIds.add(item.id);
				} else {
					this.selectedIds.delete(item.id);
				}
				this.refreshImportButton();
				this.refreshSelectAll();
			});
		}

		const main = rowEl.createDiv({ cls: "rss-importer-item-main" });
		const titleEl = main.createDiv({ cls: "rss-importer-item-title" });
		titleEl.setText(item.title.length > 0 ? item.title : "(untitled)");

		const metaEl = main.createDiv({ cls: "rss-importer-item-meta" });
		this.renderBadge(metaEl, state);
		if (item.publishedAt !== null) {
			metaEl.createSpan({ cls: "rss-importer-item-date", text: formatDate(item.publishedAt) });
		}
		if (item.audience === "paid") {
			metaEl.createSpan({
				cls: "rss-importer-audience-badge rss-importer-audience-paid",
				text: "Paid",
			});
		}
		if (item.isTruncated) {
			metaEl.createSpan({ cls: "rss-importer-item-truncated", text: "Teaser" });
		}

		const actions = rowEl.createDiv({ cls: "rss-importer-item-actions" });
		const dismissed = state === "dismissed";
		const dismissBtn = actions.createEl("button", {
			cls: "rss-importer-item-dismiss",
			text: dismissed ? "Undismiss" : "Dismiss",
			attr: { type: "button" },
		});
		// Imported rows can still be dismissed/undismissed; the toggle keys off
		// the current dismiss-store state rather than the rendered badge.
		dismissBtn.addEventListener("click", () => {
			void this.toggleDismiss(item);
		});

		this.rows.push({ item, rowEl, checkbox });
	}

	private renderBadge(parent: HTMLElement, state: ItemBadgeState): void {
		const badge = parent.createSpan({ cls: `rss-importer-badge rss-importer-badge-${state}` });
		const icon = badge.createSpan({ cls: "rss-importer-badge-icon" });
		if (state === "imported") {
			setIcon(icon, "check");
			badge.createSpan({ cls: "rss-importer-badge-text", text: "Imported" });
		} else if (state === "dismissed") {
			setIcon(icon, "eye-off");
			badge.createSpan({ cls: "rss-importer-badge-text", text: "Dismissed" });
		} else {
			setIcon(icon, "circle");
			badge.createSpan({ cls: "rss-importer-badge-text", text: "Available" });
		}
	}

	// Toggle the item's dismissed state in the store, then re-render so its
	// badge and selectability update. Re-reads the vault index is unnecessary
	// (dismiss does not write notes), so we reuse the current one.
	private async toggleDismiss(item: FeedItem): Promise<void> {
		const feedId = this.deps.feed.feedId;
		try {
			if (this.deps.dismissStore.isDismissed(feedId, item.id)) {
				await this.deps.dismissStore.undismiss(feedId, item.id);
			} else {
				await this.deps.dismissStore.dismiss(feedId, item.id);
				// A dismissed item is no longer selectable; drop it from selection.
				this.selectedIds.delete(item.id);
			}
			this.renderItems();
		} catch (err) {
			new Notice("Could not update the dismissed state. See the console for details.");
			console.error(err);
		}
	}

	private selectedItems(): FeedItem[] {
		const selected: FeedItem[] = [];
		for (const row of this.rows) {
			if (row.checkbox !== null && row.checkbox.checked) {
				selected.push(row.item);
			}
		}
		return selected;
	}

	// (Re)create the bottom sentinel and observe it. Called after every render and
	// after each archive page so a fresh element generates an initial intersection
	// callback. No-op without an observer (non-Substack, or no IntersectionObserver)
	// or when the archive is exhausted, so the sentinel disappears at the end.
	private observeSentinel(): void {
		const observer = this.olderObserver;
		const el = this.listEl;
		if (observer === null || el === null) {
			return;
		}
		if (this.sentinelEl !== null) {
			observer.unobserve(this.sentinelEl);
			this.sentinelEl = null;
		}
		if (!this.hasMoreOlder) {
			return;
		}
		this.sentinelEl = el.createDiv({ cls: "rss-importer-scroll-sentinel" });
		observer.observe(this.sentinelEl);
	}

	// Select every available loaded item, or clear them once all are selected.
	// Operates on the selection set (not the DOM) and then reflects the result
	// onto the rendered checkboxes, matching how dismiss/re-render treat selection.
	private toggleSelectAll(): void {
		const ids = selectableItemIds(
			this.items,
			this.deps.feed.feedId,
			this.vaultIndex,
			this.deps.dismissStore,
		);
		const selectedSelectable = ids.filter((id) => this.selectedIds.has(id)).length;
		const state = selectAllControlState(ids.length, selectedSelectable);
		if (state.disabled) {
			return;
		}
		for (const id of ids) {
			if (state.action === "select") {
				this.selectedIds.add(id);
			} else {
				this.selectedIds.delete(id);
			}
		}
		for (const row of this.rows) {
			if (row.checkbox !== null) {
				row.checkbox.checked = this.selectedIds.has(row.item.id);
			}
		}
		this.refreshImportButton();
		this.refreshSelectAll();
	}

	// Reflect the current selectable/selected counts onto the select-all toggle
	// and the "x of y selected" count beside it. The count is over selectable
	// (available) items only, so already-imported rows never inflate the total.
	private refreshSelectAll(): void {
		const btn = this.selectAllButtonEl;
		if (btn === null) {
			return;
		}
		const ids = selectableItemIds(
			this.items,
			this.deps.feed.feedId,
			this.vaultIndex,
			this.deps.dismissStore,
		);
		const selectedSelectable = ids.filter((id) => this.selectedIds.has(id)).length;
		const state = selectAllControlState(ids.length, selectedSelectable);
		btn.setText(state.label);
		btn.toggleAttribute("disabled", state.disabled);

		const countEl = this.selectCountEl;
		if (countEl !== null) {
			countEl.setText(ids.length === 0 ? "" : `${selectedSelectable} of ${ids.length} selected`);
		}
	}

	// Reflect the loaded-item count onto the left of the toolbar. While the
	// source still has older items to page (Substack archive not yet exhausted),
	// it reads "N items loaded"; otherwise the loaded set is everything available,
	// so it reads "All N items". Generic feeds have no archive, so they reach the
	// "All" wording as soon as their recent window loads.
	private refreshLoadCount(): void {
		const el = this.loadCountEl;
		if (el === null) {
			return;
		}
		const n = this.items.length;
		if (n === 0) {
			el.setText("");
			return;
		}
		const moreToLoad = this.deps.feed.sourceType === "substack" && this.hasMoreOlder;
		el.setText(moreToLoad ? `${n} items loaded` : `All ${n} items`);
	}

	private refreshImportButton(): void {
		const btn = this.importButtonEl;
		if (btn === null) {
			return;
		}
		const count = this.selectedItems().length;
		btn.toggleAttribute("disabled", this.importing || count === 0);
		btn.setText(count > 0 ? `Import selected (${count})` : "Import selected");
	}

	// Run the import over the selected items. Disables the button for the
	// duration, streams progress into the progress line, then renders the
	// summary and rebuilds the vault index so newly imported rows flip to the
	// imported badge.
	private async runImport(): Promise<void> {
		if (this.importing) {
			return;
		}
		const items = this.selectedItems();
		if (items.length === 0) {
			new Notice("Select at least one item to import.");
			return;
		}

		this.importing = true;
		this.refreshImportButton();
		this.clearSummary();

		try {
			const tally = await this.deps.runner.run(items, {
				feedTags: this.deps.feed.tags,
				onProgress: (p: ImportProgress) => {
					this.renderProgress(p);
				},
				isAborted: () => this.aborted,
			});
			this.clearProgress();
			new Notice(formatImportNotice(tally));
			this.renderSummary(tally);

			// Refresh the index and re-render so imported items lose their
			// checkbox and gain the imported badge.
			this.vaultIndex = buildFeedItemIndex(this.app, this.deps.feed.destinationFolder);
			// metadataCache updates asynchronously, so notes written this run may not
			// be in the rebuilt index yet. Mark them imported directly from the result
			// so their badge flips immediately without reopening the importer.
			for (const result of tally.results) {
				if (result.status === "created" || result.status === "overwritten") {
					this.vaultIndex.set(result.item.id, { path: result.path ?? "" });
				}
			}
			// Drop now-imported items from the selection so the count stays right.
			for (const id of Array.from(this.selectedIds)) {
				if (this.vaultIndex.has(id)) {
					this.selectedIds.delete(id);
				}
			}
			this.renderItems();
			this.deps.onDone?.();
		} catch (err) {
			this.clearProgress();
			new Notice("The import failed. See the console for details.");
			console.error(err);
		} finally {
			this.importing = false;
			this.refreshImportButton();
		}
	}

	private renderProgress(p: ImportProgress): void {
		const el = this.progressEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.addClass("is-active");
		const title = p.item.title.length > 0 ? p.item.title : "(untitled)";
		el.createSpan({
			cls: "rss-importer-progress-text",
			text: `Importing ${p.index + 1} of ${p.total}: ${title}`,
		});
	}

	private clearProgress(): void {
		const el = this.progressEl;
		if (el === null) {
			return;
		}
		el.empty();
		el.removeClass("is-active");
	}

	private clearSummary(): void {
		const el = this.summaryEl;
		if (el === null) {
			return;
		}
		el.empty();
	}

	private renderSummary(tally: ImportTally): void {
		const el = this.summaryEl;
		if (el === null) {
			return;
		}
		el.empty();

		el.createDiv({
			cls: "rss-importer-summary-counts",
			text: `${tally.created} created, ${tally.overwritten} overwritten, ${tally.skipped} skipped, ${tally.failed} failed`,
		});

		// Successes are reflected by the imported badge in the list above, so the
		// summary only details failures. This keeps it compact instead of listing
		// every item.
		const failures = tally.results.filter((result) => result.status === "failed");
		if (failures.length > 0) {
			const list = el.createEl("ul", { cls: "rss-importer-summary-list" });
			for (const result of failures) {
				const li = list.createEl("li", { cls: "rss-importer-summary-item is-failed" });
				const title = result.item.title.length > 0 ? result.item.title : "(untitled)";
				li.createSpan({ cls: "rss-importer-summary-title", text: title });
				if (result.reason !== null && result.reason.length > 0) {
					li.createSpan({ cls: "rss-importer-summary-reason", text: result.reason });
				}
			}
		}
	}
}

// Render an ISO timestamp as a short YYYY-MM-DD label, or empty when it does
// not parse. Local to the modal: the note writer has its own UTC formatter for
// frontmatter; this is display-only.
function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
