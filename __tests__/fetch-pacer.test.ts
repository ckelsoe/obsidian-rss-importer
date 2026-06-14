import { FetchPacer, parseRetryAfterMs } from "../fetch-pacer";
import type { HttpFetcher, HttpRequest, HttpResponse } from "../feed-source";

/** Builds a minimal HttpResponse with the given status and headers. */
function makeResponse(status: number, headers: Record<string, string> = {}): HttpResponse {
	return {
		status,
		headers,
		json: null,
		text: "",
		arrayBuffer: new ArrayBuffer(0),
	};
}

/** Builds a request whose url encodes the given tag, for ordering assertions. */
function req(tag: string): HttpRequest {
	return { url: `https://example.test/${tag}` };
}

/**
 * A sleep stub that records every requested duration and resolves on a
 * microtask, so awaiting it yields to other queued work without real timers.
 */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
	const calls: number[] = [];
	const sleep = (ms: number): Promise<void> => {
		calls.push(ms);
		return Promise.resolve();
	};
	return { sleep, calls };
}

describe("parseRetryAfterMs", () => {
	it("parses integer seconds into milliseconds", () => {
		expect(parseRetryAfterMs("5")).toBe(5000);
		expect(parseRetryAfterMs("0")).toBe(0);
		expect(parseRetryAfterMs("  12  ")).toBe(12000);
	});

	it("returns null for absent, non-integer, or negative values", () => {
		expect(parseRetryAfterMs(undefined)).toBeNull();
		expect(parseRetryAfterMs("")).toBeNull();
		expect(parseRetryAfterMs("1.5")).toBeNull();
		expect(parseRetryAfterMs("soon")).toBeNull();
		expect(parseRetryAfterMs("-3")).toBeNull();
		// HTTP-date form is intentionally unsupported.
		expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeNull();
	});
});

describe("FetchPacer ordering", () => {
	it("runs concurrent fetch() calls sequentially in issue order", async () => {
		const order: string[] = [];
		const fetcher: HttpFetcher = (request) => {
			const tag = request.url.split("/").pop() ?? "";
			order.push(`start:${tag}`);
			return Promise.resolve().then(() => {
				order.push(`end:${tag}`);
				return makeResponse(200);
			});
		};
		const { sleep } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 10, sleep });

		// Fire three calls without awaiting between them.
		const results = await Promise.all([
			pacer.fetch(req("a")),
			pacer.fetch(req("b")),
			pacer.fetch(req("c")),
		]);

		// Each request must fully finish before the next one starts: no
		// interleaving of start/end markers.
		expect(order).toEqual([
			"start:a",
			"end:a",
			"start:b",
			"end:b",
			"start:c",
			"end:c",
		]);
		expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
	});

	it("does not block later callers when an earlier call rejects", async () => {
		let call = 0;
		const fetcher: HttpFetcher = () => {
			call += 1;
			if (call === 1) {
				return Promise.reject(new Error("boom"));
			}
			return Promise.resolve(makeResponse(200));
		};
		const { sleep } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 0, sleep });

		const first = pacer.fetch(req("a"));
		const second = pacer.fetch(req("b"));

		await expect(first).rejects.toThrow("boom");
		await expect(second).resolves.toEqual(expect.objectContaining({ status: 200 }));
	});
});

describe("FetchPacer pacing", () => {
	it("does not sleep before the first request but sleeps delayMs between them", async () => {
		const fetcher: HttpFetcher = () => Promise.resolve(makeResponse(200));
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 250, sleep });

		await pacer.fetch(req("a"));
		expect(calls).toEqual([]); // first request is not paced

		await pacer.fetch(req("b"));
		await pacer.fetch(req("c"));
		// One 250ms gap before each subsequent request.
		expect(calls).toEqual([250, 250]);
	});

	it("does not sleep at all when delayMs is zero", async () => {
		const fetcher: HttpFetcher = () => Promise.resolve(makeResponse(200));
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 0, sleep });

		await pacer.fetch(req("a"));
		await pacer.fetch(req("b"));
		expect(calls).toEqual([]);
	});
});

describe("FetchPacer 429 handling", () => {
	it("retries after a 429 and returns the eventual 200", async () => {
		const statuses = [429, 200];
		let i = 0;
		const fetcher: HttpFetcher = () => {
			const status = statuses[i] ?? 200;
			i += 1;
			return Promise.resolve(makeResponse(status, { "Retry-After": "2" }));
		};
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 100, sleep });

		const res = await pacer.fetch(req("a"));

		expect(res.status).toBe(200);
		expect(i).toBe(2); // one retry
		// Retry-After of 2 seconds drove the single backoff. No pacing sleep
		// since this was the first request.
		expect(calls).toEqual([2000]);
	});

	it("parses Retry-After case-insensitively", async () => {
		const statuses = [429, 200];
		let i = 0;
		const fetcher: HttpFetcher = () => {
			const status = statuses[i] ?? 200;
			i += 1;
			return Promise.resolve(makeResponse(status, { "retry-after": "7" }));
		};
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 100, sleep });

		await pacer.fetch(req("a"));
		expect(calls).toEqual([7000]);
	});

	it("falls back to delayMs when Retry-After is absent", async () => {
		const statuses = [429, 200];
		let i = 0;
		const fetcher: HttpFetcher = () => {
			const status = statuses[i] ?? 200;
			i += 1;
			return Promise.resolve(makeResponse(status)); // no Retry-After header
		};
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 333, sleep });

		await pacer.fetch(req("a"));
		expect(calls).toEqual([333]);
	});

	it("caps the backoff at 60 seconds", async () => {
		const statuses = [429, 200];
		let i = 0;
		const fetcher: HttpFetcher = () => {
			const status = statuses[i] ?? 200;
			i += 1;
			return Promise.resolve(makeResponse(status, { "Retry-After": "9999" }));
		};
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 100, sleep });

		await pacer.fetch(req("a"));
		expect(calls).toEqual([60000]);
	});

	it("gives up after maxRetries and returns the final 429", async () => {
		let attempts = 0;
		const fetcher: HttpFetcher = () => {
			attempts += 1;
			return Promise.resolve(makeResponse(429, { "Retry-After": "1" }));
		};
		const { sleep, calls } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 100, maxRetries: 2, sleep });

		const res = await pacer.fetch(req("a"));

		expect(res.status).toBe(429); // never recovered
		expect(attempts).toBe(3); // initial + 2 retries
		expect(calls).toEqual([1000, 1000]); // one backoff per retry
	});

	it("uses a default of 3 retries when maxRetries is omitted", async () => {
		let attempts = 0;
		const fetcher: HttpFetcher = () => {
			attempts += 1;
			return Promise.resolve(makeResponse(429, { "Retry-After": "1" }));
		};
		const { sleep } = recordingSleep();
		const pacer = new FetchPacer(fetcher, { delayMs: 100, sleep });

		const res = await pacer.fetch(req("a"));

		expect(res.status).toBe(429);
		expect(attempts).toBe(4); // initial + 3 default retries
	});
});
