import { Plugin } from "obsidian";

/**
 * RSS Importer plugin entry point.
 *
 * The plugin class is wiring only. Command registration, the settings tab, and
 * feed-source wiring are added across the build phases; sources and any
 * network-dependent state are constructed in `app.workspace.onLayoutReady`.
 */
export default class RssImporterPlugin extends Plugin {}
