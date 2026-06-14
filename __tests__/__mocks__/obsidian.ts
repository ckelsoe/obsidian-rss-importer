// Inert stub of the `obsidian` module for jest, wired in via moduleNameMapper
// in jest.config.cjs.
//
// `obsidian` is a peer dependency provided at runtime by Obsidian itself; at
// test time there is no real module to resolve, so any source file that imports
// from it would fail to load without this stub. Tests cover the PURE helpers
// (parsers, converters, sanitizers, tallies) and inject plain-object fakes for
// vault/app/fetcher; they never exercise the stubbed runtime. Keep these stubs
// inert: satisfy the imports and return empty shapes, nothing more.
//
// Add exports here as new source modules import new symbols from obsidian.

/** A chainable DOM-element stand-in. Every builder returns another stub. */
export class ChainableStub {
	children: ChainableStub[] = [];
	empty(): void {}
	detach(): void {}
	remove(): void {}
	addClass(..._cls: string[]): this {
		return this;
	}
	removeClass(..._cls: string[]): this {
		return this;
	}
	toggleClass(_cls: string, _on?: boolean): this {
		return this;
	}
	setText(_text: string | DocumentFragment): this {
		return this;
	}
	setAttr(_name: string, _value: unknown): this {
		return this;
	}
	setAttribute(_name: string, _value: string): void {}
	getAttribute(_name: string): string | null {
		return null;
	}
	createEl(_tag: string, _opts?: unknown): ChainableStub {
		const el = new ChainableStub();
		this.children.push(el);
		return el;
	}
	createDiv(_opts?: unknown): ChainableStub {
		return this.createEl("div");
	}
	createSpan(_opts?: unknown): ChainableStub {
		return this.createEl("span");
	}
	appendChild(child: ChainableStub): ChainableStub {
		this.children.push(child);
		return child;
	}
	addEventListener(_type: string, _listener: unknown): void {}
	removeEventListener(_type: string, _listener: unknown): void {}
	onClickEvent(_listener: unknown): void {}
}

export class Component {
	load(): void {}
	onload(): void {}
	unload(): void {}
	onunload(): void {}
	registerEvent(_evt: unknown): void {}
	registerDomEvent(): void {}
	register(_cb: unknown): void {}
	addChild<T>(child: T): T {
		return child;
	}
}

export class Plugin extends Component {
	app: unknown;
	manifest: unknown;
	constructor(app?: unknown, manifest?: unknown) {
		super();
		this.app = app;
		this.manifest = manifest;
	}
	addCommand(cmd: unknown): unknown {
		return cmd;
	}
	addRibbonIcon(_icon: string, _title: string, _cb: unknown): ChainableStub {
		return new ChainableStub();
	}
	addSettingTab(_tab: unknown): void {}
	async loadData(): Promise<unknown> {
		return null;
	}
	async saveData(_data: unknown): Promise<void> {}
}

export class Modal {
	app: unknown;
	contentEl: ChainableStub = new ChainableStub();
	modalEl: ChainableStub = new ChainableStub();
	titleEl: ChainableStub = new ChainableStub();
	constructor(app: unknown) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
	setTitle(_title: string): this {
		return this;
	}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: ChainableStub = new ChainableStub();
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
	display(): void {}
	hide(): void {}
}

export class Setting {
	constructor(_containerEl?: unknown) {}
	setName(_name: string | DocumentFragment): this {
		return this;
	}
	setDesc(_desc: string | DocumentFragment): this {
		return this;
	}
	setClass(_cls: string): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
	addText(cb: (c: unknown) => unknown): this {
		cb(new TextComponent());
		return this;
	}
	addTextArea(cb: (c: unknown) => unknown): this {
		cb(new TextComponent());
		return this;
	}
	addToggle(cb: (c: unknown) => unknown): this {
		cb(new ToggleComponent());
		return this;
	}
	addDropdown(cb: (c: unknown) => unknown): this {
		cb(new DropdownComponent());
		return this;
	}
	addButton(cb: (c: unknown) => unknown): this {
		cb(new ButtonComponent());
		return this;
	}
	addExtraButton(cb: (c: unknown) => unknown): this {
		cb(new ButtonComponent());
		return this;
	}
	addComponent(cb: (el: ChainableStub) => unknown): this {
		cb(new ChainableStub());
		return this;
	}
	then(cb: (s: this) => unknown): this {
		cb(this);
		return this;
	}
}

class ValueComponent {
	onChange(_cb: (value: never) => unknown): this {
		return this;
	}
	setDisabled(_disabled: boolean): this {
		return this;
	}
}

export class TextComponent extends ValueComponent {
	inputEl: ChainableStub = new ChainableStub();
	setValue(_value: string): this {
		return this;
	}
	getValue(): string {
		return "";
	}
	setPlaceholder(_placeholder: string): this {
		return this;
	}
}

export class ToggleComponent extends ValueComponent {
	setValue(_value: boolean): this {
		return this;
	}
	getValue(): boolean {
		return false;
	}
}

export class DropdownComponent extends ValueComponent {
	selectEl: ChainableStub = new ChainableStub();
	addOption(_value: string, _display: string): this {
		return this;
	}
	addOptions(_options: Record<string, string>): this {
		return this;
	}
	setValue(_value: string): this {
		return this;
	}
	getValue(): string {
		return "";
	}
}

export class ButtonComponent {
	buttonEl: ChainableStub = new ChainableStub();
	setButtonText(_text: string): this {
		return this;
	}
	setIcon(_icon: string): this {
		return this;
	}
	setCta(): this {
		return this;
	}
	setWarning(): this {
		return this;
	}
	setDisabled(_disabled: boolean): this {
		return this;
	}
	onClick(_cb: () => unknown): this {
		return this;
	}
}

export class SecretComponent extends ValueComponent {
	constructor(_app?: unknown, _el?: unknown) {
		super();
	}
	setValue(_value: string): this {
		return this;
	}
	getValue(): string {
		return "";
	}
}

export abstract class PopoverSuggest<T> {
	app: unknown;
	constructor(app: unknown) {
		this.app = app;
	}
	abstract renderSuggestion(value: T, el: ChainableStub): void;
	abstract selectSuggestion(value: T, evt: unknown): void;
	open(): void {}
	close(): void {}
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
	limit = 100;
	constructor(app: unknown, _textInputEl: unknown) {
		super(app);
	}
	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
	getValue(): string {
		return "";
	}
	setValue(_value: string): void {}
	onSelect(_cb: (value: T, evt: unknown) => unknown): this {
		return this;
	}
	selectSuggestion(_value: T, _evt: unknown): void {}
	renderSuggestion(_value: T, _el: ChainableStub): void {}
}

export class Notice {
	noticeEl: ChainableStub = new ChainableStub();
	constructor(_message: string | DocumentFragment, _timeout?: number) {}
	setMessage(_message: string | DocumentFragment): this {
		return this;
	}
	hide(): void {}
}

export class TAbstractFile {
	path = "";
	name = "";
}
export class TFile extends TAbstractFile {
	extension = "md";
	basename = "";
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

export class App {}

export const Platform = {
	isDesktop: true,
	isDesktopApp: true,
	isMobile: false,
	isMobileApp: false,
};

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(^\/|\/$)/g, "");
}

export function setIcon(_el: unknown, _icon: string): void {}

export function requestUrl(_req: unknown): Promise<unknown> {
	return Promise.resolve({
		status: 200,
		headers: {},
		json: null,
		text: "",
		arrayBuffer: new ArrayBuffer(0),
	});
}

export function sanitizeHTMLToDom(_html: string): DocumentFragment {
	return new ChainableStub() as unknown as DocumentFragment;
}
