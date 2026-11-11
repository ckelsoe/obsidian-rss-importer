// The footer row is a flex row that wraps. Each "|" separator must share a
// nowrap item with the link after it, or a narrow pane can leave a stray "|"
// at the end or start of a line.

import { App, type Setting } from 'obsidian';
import {
	RssImporterSettingTab,
	type RssImporterPluginLike,
} from '../settings-tab';
import { DEFAULT_SETTINGS } from '../settings';

interface ElOptions {
	cls?: string;
	text?: string;
	href?: string;
	attr?: Record<string, string>;
}

interface FakeEl {
	cls: string[];
	text: string;
	attrs: Record<string, string>;
	children: FakeEl[];
	empty(): void;
	addClass(c: string): void;
	createDiv(o?: ElOptions): FakeEl;
	createSpan(o?: ElOptions): FakeEl;
	createEl(tag: string, o?: ElOptions): FakeEl;
}

function fakeEl(): FakeEl {
	const append = (o: ElOptions = {}): FakeEl => {
		const child = fakeEl();
		if (o.cls !== undefined) child.cls.push(o.cls);
		if (o.text !== undefined) child.text = o.text;
		if (o.href !== undefined) child.attrs.href = o.href;
		Object.assign(child.attrs, o.attr ?? {});
		el.children.push(child);
		return child;
	};
	const el: FakeEl = {
		cls: [],
		text: '',
		attrs: {},
		children: [],
		empty() {
			el.children = [];
		},
		addClass(c) {
			el.cls.push(c);
		},
		createDiv: (o) => append(o),
		createSpan: (o) => append(o),
		createEl: (_tag, o) => append(o),
	};
	return el;
}

describe('settings footer', () => {
	it('reads Version | GitHub | Discord | Report issues, each separator grouped with its link', () => {
		const plugin = {
			settings: { ...DEFAULT_SETTINGS, feeds: [] },
			manifest: { version: '1.2.3' },
			saveSettings: () => Promise.resolve(),
			makeSource: () => ({ source: {} as never }),
		} as unknown as RssImporterPluginLike;
		const tab = new RssImporterSettingTab(new App(), plugin);
		const defs = tab.getSettingDefinitions();
		const last = defs[defs.length - 1] as unknown as {
			searchable?: boolean;
			render: (s: Setting) => void;
		};
		expect(last.searchable).toBe(false);

		const settingEl = fakeEl();
		last.render({ settingEl } as unknown as Setting);
		expect(settingEl.cls).toContain('rss-importer-settings-footer');
		const [inner] = settingEl.children;
		expect(inner?.cls).toEqual(['rss-importer-footer-inner']);
		const [version, ...links] = inner?.children ?? [];
		expect(version?.text).toBe('Version 1.2.3');
		expect(
			links.map((l) => [l.cls[0], l.children.map((c) => c.text)]),
		).toEqual([
			['rss-importer-footer-link', ['|', 'GitHub']],
			['rss-importer-footer-link', ['|', 'Discord']],
			['rss-importer-footer-link', ['|', 'Report issues']],
		]);
		for (const l of links) {
			const a = l.children[1];
			expect(a?.attrs.target).toBe('_blank');
			expect(a?.attrs.rel).toBe('noopener');
		}
		expect(links[1]?.children[1]?.attrs.href).toBe(
			'https://discord.gg/gd6tKJDPj4',
		);
	});
});
