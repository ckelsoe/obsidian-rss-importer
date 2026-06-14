import {
	BufferedDebugLogger,
	NoopDebugLogger,
	DEFAULT_MAX_EVENTS,
	type DebugEvent,
} from "../debug-logger";

// A deterministic clock: each call returns a Date one second after the
// previous, starting at a fixed epoch. This pins every timestamp the
// logger stamps so format() output is byte-stable across runs.
function makeClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): () => Date {
	let tick = 0;
	return (): Date => new Date(startMs + tick++ * 1000);
}

// A no-op console sink keeps Jest output clean and lets us assert against
// what was forwarded to it without touching the global console.
function makeSink(): {
	sink: (message: string, payload?: unknown) => void;
	calls: Array<{ message: string; payload?: unknown }>;
} {
	const calls: Array<{ message: string; payload?: unknown }> = [];
	return {
		calls,
		sink: (message, payload): void => {
			calls.push({ message, payload });
		},
	};
}

describe("BufferedDebugLogger", () => {
	it("is a strict no-op when disabled: nothing buffered, nothing sent to the sink", () => {
		const { sink, calls } = makeSink();
		const logger = new BufferedDebugLogger(false, { now: makeClock(), consoleSink: sink });

		logger.log({ kind: "note", message: "should be dropped" });
		logger.log({ kind: "request", message: "also dropped", endpoint: "/feed.xml" });

		expect(logger.enabled).toBe(false);
		expect(logger.snapshot()).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("buffers events and mirrors each to the console sink when enabled", () => {
		const { sink, calls } = makeSink();
		const logger = new BufferedDebugLogger(true, { now: makeClock(), consoleSink: sink });

		logger.log({ kind: "request", message: "fetch feed", endpoint: "/feed.xml" });

		const snap = logger.snapshot();
		expect(snap).toHaveLength(1);
		const first = snap[0] as DebugEvent;
		expect(first.message).toBe("fetch feed");
		expect(first.kind).toBe("request");
		// The logger stamps the timestamp from the injected clock.
		expect(first.timestamp.toISOString()).toBe("2026-01-01T00:00:00.000Z");
		// The sink received a prefixed line with kind and endpoint.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.message).toBe("[RSS debug] request /feed.xml: fetch feed");
	});

	it("becomes active after setEnabled(true) and inert again after setEnabled(false)", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(false, { now: makeClock(), consoleSink: sink });

		logger.log({ kind: "note", message: "dropped while off" });
		expect(logger.snapshot()).toHaveLength(0);

		logger.setEnabled(true);
		logger.log({ kind: "note", message: "kept while on" });
		expect(logger.snapshot()).toHaveLength(1);
		expect(logger.snapshot()[0]?.message).toBe("kept while on");

		logger.setEnabled(false);
		logger.log({ kind: "note", message: "dropped again" });
		expect(logger.snapshot()).toHaveLength(1);
	});

	it("drops the oldest events past maxEvents, keeping the newest in order", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, {
			maxEvents: 3,
			now: makeClock(),
			consoleSink: sink,
		});

		for (let i = 1; i <= 5; i++) {
			logger.log({ kind: "note", message: `event-${i}` });
		}

		const messages = logger.snapshot().map((e) => e.message);
		// 5 pushed, cap 3: events 1 and 2 are dropped, 3/4/5 remain in order.
		expect(messages).toEqual(["event-3", "event-4", "event-5"]);
	});

	it("clear() empties the buffer", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, { now: makeClock(), consoleSink: sink });

		logger.log({ kind: "note", message: "one" });
		logger.log({ kind: "note", message: "two" });
		expect(logger.snapshot()).toHaveLength(2);

		logger.clear();
		expect(logger.snapshot()).toEqual([]);
	});

	it("format() contains the header lines and every event block with a deterministic timestamp", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, {
			now: makeClock(),
			consoleSink: sink,
			headerLines: ["Plugin: rss-importer 1.2.3"],
		});

		logger.log({ kind: "request", message: "fetch feed", endpoint: "/feed.xml" });
		logger.log({ kind: "parsed", message: "normalized items", payload: { count: 7 } });

		const out = logger.format();

		// Header content.
		expect(out).toContain("=== RSS Importer debug session ===");
		expect(out).toContain("Plugin: rss-importer 1.2.3");
		expect(out).toContain("Events: 2");
		expect(out).toContain("=== End debug session ===");

		// Event 1: request with endpoint, no payload. Timestamps come from the
		// clock in the order events were logged (header uses the next tick).
		expect(out).toContain("[1] 2026-01-01T00:00:00.000Z REQUEST /feed.xml: fetch feed");

		// Event 2: parsed with a pretty-printed JSON payload.
		expect(out).toContain("[2] 2026-01-01T00:00:01.000Z PARSED: normalized items");
		expect(out).toContain('"count": 7');
	});

	it("format() reports an empty buffer without throwing", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, { now: makeClock(), consoleSink: sink });

		const out = logger.format();
		expect(out).toContain("Events: 0");
		expect(out).toContain("(buffer is empty)");
	});

	it("format() marks non-serializable payloads instead of throwing", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, { now: makeClock(), consoleSink: sink });

		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		logger.log({ kind: "error", message: "boom", payload: cyclic });

		const out = logger.format();
		expect(out).toContain("ERROR: boom");
		expect(out).toContain("(non-serializable:");
	});

	it("DEFAULT_MAX_EVENTS is 250", () => {
		expect(DEFAULT_MAX_EVENTS).toBe(250);
	});

	it("falls back to the default cap when a non-positive maxEvents is supplied", () => {
		const { sink } = makeSink();
		const logger = new BufferedDebugLogger(true, {
			maxEvents: 0,
			now: makeClock(),
			consoleSink: sink,
		});

		for (let i = 0; i < 5; i++) {
			logger.log({ kind: "note", message: `e-${i}` });
		}
		// With a 0 cap clamped to the default, all 5 survive.
		expect(logger.snapshot()).toHaveLength(5);
	});
});

describe("NoopDebugLogger", () => {
	it("stays disabled and discards everything", () => {
		const logger = new NoopDebugLogger();
		expect(logger.enabled).toBe(false);

		logger.setEnabled(true);
		expect(logger.enabled).toBe(false);

		logger.log({ kind: "note", message: "ignored" });
		expect(logger.snapshot()).toEqual([]);
		expect(logger.format()).toBe("");

		// clear() must not throw on the noop.
		expect(() => logger.clear()).not.toThrow();
	});
});
