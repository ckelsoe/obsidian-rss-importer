// Asks the user whether to overwrite, skip, or cancel when a same-item note
// already exists and the duplicate policy is "prompt".

import { App, Modal, Setting } from "obsidian";
import type {
	DuplicatePromptContext,
	DuplicatePromptDecision,
} from "./note-writer";

export class DuplicatePromptModal extends Modal {
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
