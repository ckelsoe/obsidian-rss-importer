// Obsidian's settings search finds a setting by its name, description and
// aliases. A section drawn by hand has none of those unless it is given them.
// This tab draws nothing by hand, so every row must carry a name and a string
// description, and the media defaults show only while some feed uses them.

import { App } from 'obsidian';
import {
	RssImporterSettingTab,
	type RssImporterPluginLike,
} from '../settings-tab';
import { DEFAULT_SETTINGS, type FeedConfig } from '../settings';

interface Item {
	type?: string;
	name?: string;
	desc?: unknown;
	render?: unknown;
	visible?: boolean | (() => boolean);
	items?: Item[];
}

function leaves(items: Item[]): Item[] {
	return items.flatMap((i) => (i.items ? leaves(i.items) : [i]));
}

function tabWith(
	settings: Partial<typeof DEFAULT_SETTINGS>,
	feeds: Partial<FeedConfig>[] = [],
): Item[] {
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, ...settings, feeds },
		saveSettings: () => Promise.resolve(),
		makeSource: () => ({ source: {} as never }),
	} as unknown as RssImporterPluginLike;
	const tab = new RssImporterSettingTab(new App(), plugin);
	return leaves(tab.getSettingDefinitions());
}

// Shown, by name, for the media rows whose visibility depends on other settings.
function shown(items: Item[]): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const name of [
		'Media location',
		'Media subfolder',
		'Media folder outside vault',
	]) {
		const row = items.find((i) => i.name === name);
		expect(row).toBeDefined();
		const v = row?.visible;
		out[name] = typeof v === 'function' ? v() : v !== false;
	}
	return out;
}

describe('settings search', () => {
	it('draws nothing by hand, and names and describes every row', () => {
		const items = tabWith({});
		expect(items.filter((i) => i.render !== undefined)).toEqual([]);
		for (const i of items) {
			expect(typeof i.name).toBe('string');
			expect(i.name).not.toBe('');
			expect(typeof i.desc).toBe('string');
		}
	});

	it('finds the settings people look for by name', () => {
		const names = tabWith({}).map((i) => i.name);
		for (const n of [
			'Duplicate handling',
			'Request delay',
			'Download media',
			'Note name template',
		])
			expect(names).toContain(n);
	});
});

describe('media defaults visibility', () => {
	it('hides every media default while nothing downloads media', () => {
		expect(shown(tabWith({ downloadMedia: false }))).toEqual({
			'Media location': false,
			'Media subfolder': false,
			'Media folder outside vault': false,
		});
	});

	it('shows the vault subfolder when downloads save into the vault', () => {
		expect(
			shown(tabWith({ downloadMedia: true, mediaLocation: 'vault' })),
		).toEqual({
			'Media location': true,
			'Media subfolder': true,
			'Media folder outside vault': false,
		});
	});

	it('shows the outside folder when downloads save outside the vault', () => {
		expect(
			shown(tabWith({ downloadMedia: true, mediaLocation: 'outside' })),
		).toEqual({
			'Media location': true,
			'Media subfolder': false,
			'Media folder outside vault': true,
		});
	});

	it('counts a feed that turns downloads on for itself', () => {
		expect(
			shown(
				tabWith({ downloadMedia: false, mediaLocation: 'vault' }, [
					{
						publicationTitle: 'Podcast',
						destinationFolder: 'Podcasts',
						enabled: true,
						downloadMedia: true,
						mediaLocation: 'outside',
					},
				]),
			),
		).toEqual({
			'Media location': true,
			'Media subfolder': false,
			'Media folder outside vault': true,
		});
	});
});
