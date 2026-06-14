// Regression test for the 0.1.0 load failure: RssImporterSettingTab defined a
// getter-only `get plugin()`, but Obsidian's PluginSettingTab base constructor
// assigns `this.plugin = plugin`, which throws "Cannot set property plugin which
// has only a getter" -> the whole plugin failed to load. No test had ever
// constructed the settings tab, so the suite missed it. This test does, against
// the faithful mock (whose PluginSettingTab assigns this.plugin like the real
// base), so the regression cannot return silently.

import { App } from "obsidian";
import { RssImporterSettingTab, type RssImporterPluginLike } from "../settings-tab";
import { DEFAULT_SETTINGS } from "../settings";

function makePluginStub(): RssImporterPluginLike {
	return {
		settings: { ...DEFAULT_SETTINGS, feeds: [] },
		saveSettings: () => Promise.resolve(),
		makeSource: () => ({ source: {} as never }),
	} as unknown as RssImporterPluginLike;
}

describe("RssImporterSettingTab", () => {
	it("constructs without throwing and exposes the typed plugin as a writable field", () => {
		const stub = makePluginStub();
		const tab = new RssImporterSettingTab(new App(), stub);
		expect(tab).toBeDefined();
		// The base assigned this.plugin; our field narrows the type. Must be the
		// same instance, and assignable (not a getter-only accessor).
		expect(tab.plugin).toBe(stub);
	});

	it("getSettingDefinitions returns the Feeds list and Defaults group", () => {
		const tab = new RssImporterSettingTab(new App(), makePluginStub());
		const defs = tab.getSettingDefinitions();
		const headings = defs
			.map((d) => (d as { heading?: string }).heading)
			.filter((h): h is string => typeof h === "string");
		expect(headings).toContain("Feeds");
		expect(headings).toContain("Defaults");
	});
});
