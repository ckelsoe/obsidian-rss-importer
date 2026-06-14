// Vault-folder autocomplete for a plain text input.
//
// AbstractInputSuggest renders a dropdown of suggestions beneath a text input
// and wires up keyboard/mouse selection for us. We supply the candidate list
// (every loaded folder, including the vault root as an empty string) filtered
// by a case-insensitive substring match on the query, plus how to render and
// how to commit a selection. Callers register an onSelect handler via the
// inherited `onSelect` API to react when the user picks a folder.

import { AbstractInputSuggest, App, TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<string> {
	private readonly inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	// Every folder path in the vault, including "" for the root, narrowed to
	// the ones whose path contains the typed query (case-insensitive). An empty
	// query returns the full list so the dropdown shows everything to start.
	protected getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		const folders: string[] = [];
		// Root is a valid destination but has no TFolder entry to iterate, so
		// seed it explicitly. It matches an empty query and is filtered out of
		// non-empty queries by the substring test below (since "" never
		// contains a non-empty needle).
		if (lower.length === 0) {
			folders.push("");
		}
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (!(file instanceof TFolder)) {
				continue;
			}
			const path = file.path;
			if (path.toLowerCase().includes(lower)) {
				folders.push(path);
			}
		}
		return folders;
	}

	renderSuggestion(folder: string, el: HTMLElement): void {
		el.setText(folder.length === 0 ? "/" : folder);
	}

	// Commit the chosen folder: write it into the input, fire an `input` event
	// so any value-change listeners (and the inherited onSelect) observe it,
	// then dismiss the dropdown.
	selectSuggestion(folder: string): void {
		this.inputEl.value = folder;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}
