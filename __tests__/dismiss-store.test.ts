import { DismissStore, type DismissedMap } from "../dismiss-store";

/**
 * Builds a store whose read returns a mutable copy of `seed` and whose write
 * captures every persisted map. Returns the store plus the captured writes so
 * tests can assert on the exact array payloads handed to write().
 */
function makeStore(seed: DismissedMap = {}): {
	store: DismissStore;
	writes: DismissedMap[];
} {
	const writes: DismissedMap[] = [];
	const initial: DismissedMap = {};
	for (const key of Object.keys(seed)) {
		const ids = seed[key];
		if (ids !== undefined) {
			initial[key] = [...ids];
		}
	}
	const store = new DismissStore({
		read: () => initial,
		write: async (map: DismissedMap) => {
			// Snapshot so later mutations cannot retroactively change the record.
			const snapshot: DismissedMap = {};
			for (const key of Object.keys(map)) {
				const ids = map[key];
				if (ids !== undefined) {
					snapshot[key] = [...ids];
				}
			}
			writes.push(snapshot);
		},
	});
	return { store, writes };
}

describe("DismissStore", () => {
	test("dismiss then isDismissed reports true", async () => {
		const { store } = makeStore();
		expect(store.isDismissed("feedA", "item1")).toBe(false);
		await store.dismiss("feedA", "item1");
		expect(store.isDismissed("feedA", "item1")).toBe(true);
	});

	test("undismiss reverses a prior dismiss", async () => {
		const { store } = makeStore();
		await store.dismiss("feedA", "item1");
		expect(store.isDismissed("feedA", "item1")).toBe(true);
		await store.undismiss("feedA", "item1");
		expect(store.isDismissed("feedA", "item1")).toBe(false);
		expect(store.listDismissed("feedA")).toEqual([]);
	});

	test("write receives the persisted map as arrays", async () => {
		const { store, writes } = makeStore();
		await store.dismiss("feedA", "item1");
		await store.dismiss("feedA", "item2");
		expect(writes).toHaveLength(2);
		const last = writes[writes.length - 1];
		expect(last).toBeDefined();
		const ids = last?.feedA;
		expect(Array.isArray(ids)).toBe(true);
		expect(ids).toEqual(["item1", "item2"]);
	});

	test("repeated dismiss of the same item dedupes", async () => {
		const { store, writes } = makeStore();
		await store.dismiss("feedA", "item1");
		await store.dismiss("feedA", "item1");
		await store.dismiss("feedA", "item1");
		expect(store.listDismissed("feedA")).toEqual(["item1"]);
		const last = writes[writes.length - 1];
		expect(last?.feedA).toEqual(["item1"]);
	});

	test("two feeds stay isolated", async () => {
		const { store } = makeStore();
		await store.dismiss("feedA", "shared");
		await store.dismiss("feedB", "other");
		expect(store.isDismissed("feedA", "shared")).toBe(true);
		expect(store.isDismissed("feedB", "shared")).toBe(false);
		expect(store.isDismissed("feedB", "other")).toBe(true);
		expect(store.isDismissed("feedA", "other")).toBe(false);
		expect(store.listDismissed("feedA")).toEqual(["shared"]);
		expect(store.listDismissed("feedB")).toEqual(["other"]);
	});

	test("seeded data is loaded and queryable on construction", () => {
		const { store } = makeStore({ feedA: ["seed1", "seed2"] });
		expect(store.isDismissed("feedA", "seed1")).toBe(true);
		expect(store.isDismissed("feedA", "seed2")).toBe(true);
		expect(store.listDismissed("feedA")).toEqual(["seed1", "seed2"]);
	});

	test("listDismissed returns a fresh copy that callers cannot use to mutate state", async () => {
		const { store } = makeStore();
		await store.dismiss("feedA", "item1");
		const first = store.listDismissed("feedA");
		first.push("injected");
		expect(store.listDismissed("feedA")).toEqual(["item1"]);
	});

	test("undismiss of an unknown item is a safe no-op that still persists", async () => {
		const { store, writes } = makeStore();
		await store.undismiss("feedA", "never");
		expect(store.isDismissed("feedA", "never")).toBe(false);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual({});
	});
});
