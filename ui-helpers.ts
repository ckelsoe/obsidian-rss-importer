// Shared UI building blocks used by the modals and the settings tab.
//
// The "stacked row" convention (label and description on top, control area
// full-width below) is centralized here so it is reused consistently instead
// of fighting Obsidian's right-rail Setting widget for long controls like
// textareas and multi-control composite rows. Ported from the annoteca
// plugin's ui-helpers.ts with the CSS prefix changed to `rss-importer-`.

export interface StackedRowOpts {
	name: string;
	description?: string;
	cls?: string;
}

export interface StackedRow {
	row: HTMLDivElement;
	content: HTMLDivElement;
}

// Build a stacked row: title plus optional description on top, a content area
// below for full-width controls. Use this for textareas, multi-control
// composite rows (preview cards, folder plus tags forms), and anything else
// that does not fit comfortably in Obsidian's Setting right-rail layout.
export function createStackedRow(parent: HTMLElement, opts: StackedRowOpts): StackedRow {
	const row = parent.createDiv({
		cls: `rss-importer-stacked-row${opts.cls ? " " + opts.cls : ""}`,
	});
	const labels = row.createDiv({ cls: "rss-importer-stacked-labels" });
	labels.createDiv({ cls: "rss-importer-stacked-name", text: opts.name });
	if (opts.description) {
		labels.createDiv({ cls: "rss-importer-stacked-desc", text: opts.description });
	}
	const content = row.createDiv({ cls: "rss-importer-stacked-content" });
	return { row, content };
}
