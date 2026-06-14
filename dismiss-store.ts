/**
 * Tracks which feed items the user has dismissed, persisted via data.json.
 *
 * The on-disk shape is a plain `DismissedMap` (feed source id to an array of
 * dismissed feed-item ids). In memory we keep one `Set` per feed for O(1)
 * membership checks and automatic de-duplication, then serialize back to arrays
 * whenever we persist.
 *
 * The store is pure and dependency-injected: it never touches Obsidian or the
 * filesystem directly. The caller supplies `read` (returns the current map) and
 * `write` (persists a map). That keeps this unit-testable in plain node.
 */

/** Persisted shape: feed source id to an array of dismissed feed-item ids. */
export type DismissedMap = Record<string, string[]>;

export interface DismissStoreOptions {
	/** Returns the currently persisted map. Called once at construction. */
	read: () => DismissedMap;
	/** Persists the given map. Called after every mutation. */
	write: (map: DismissedMap) => Promise<void>;
}

export class DismissStore {
	private readonly write: (map: DismissedMap) => Promise<void>;
	/** feed source id to the set of dismissed item ids. */
	private readonly byFeed: Map<string, Set<string>> = new Map();

	constructor(opts: DismissStoreOptions) {
		this.write = opts.write;
		const initial = opts.read();
		for (const feedId of Object.keys(initial)) {
			const ids = initial[feedId];
			if (ids === undefined) {
				continue;
			}
			this.byFeed.set(feedId, new Set(ids));
		}
	}

	/** True when `itemId` has been dismissed for `feedId`. */
	isDismissed(feedId: string, itemId: string): boolean {
		const set = this.byFeed.get(feedId);
		return set !== undefined && set.has(itemId);
	}

	/** The dismissed item ids for `feedId`, as a fresh array. */
	listDismissed(feedId: string): string[] {
		const set = this.byFeed.get(feedId);
		if (set === undefined) {
			return [];
		}
		return Array.from(set);
	}

	/**
	 * Marks `itemId` dismissed for `feedId` and persists. Repeated calls with the
	 * same pair are idempotent (the Set dedupes), but we still persist so the
	 * caller's write callback observes the current state.
	 */
	async dismiss(feedId: string, itemId: string): Promise<void> {
		let set = this.byFeed.get(feedId);
		if (set === undefined) {
			set = new Set();
			this.byFeed.set(feedId, set);
		}
		set.add(itemId);
		await this.persist();
	}

	/**
	 * Removes `itemId` from the dismissed set for `feedId` and persists. Safe to
	 * call for an item that was never dismissed; it is a no-op on the data but
	 * still persists the current state.
	 */
	async undismiss(feedId: string, itemId: string): Promise<void> {
		const set = this.byFeed.get(feedId);
		if (set !== undefined) {
			set.delete(itemId);
			if (set.size === 0) {
				this.byFeed.delete(feedId);
			}
		}
		await this.persist();
	}

	/** Serializes the in-memory sets back to the persisted array shape. */
	private toMap(): DismissedMap {
		const map: DismissedMap = {};
		for (const [feedId, set] of this.byFeed) {
			map[feedId] = Array.from(set);
		}
		return map;
	}

	private async persist(): Promise<void> {
		await this.write(this.toMap());
	}
}
