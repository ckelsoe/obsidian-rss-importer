/**
 * Serializes and paces calls to an underlying `HttpFetcher`.
 *
 * The pacer exists so the rest of the plugin can fire feed and body requests
 * freely without hammering a host. It enforces three things:
 *
 *  1. One in-flight request at a time. Concurrent `fetch()` calls are queued
 *     and run in the order they were issued.
 *  2. A fixed `delayMs` gap between consecutive underlying requests, so a burst
 *     of items does not turn into a burst of network calls.
 *  3. Polite handling of HTTP 429. On a rate-limit response it reads the
 *     `Retry-After` header (integer seconds), waits that long (capped), and
 *     retries up to `maxRetries` times before giving up and returning the last
 *     429 to the caller.
 *
 * Time is injected via `sleep` so tests run instantly and deterministically.
 * The pacer depends only on the `HttpFetcher` contract, never on Obsidian.
 */

import type { HttpFetcher, HttpRequest, HttpResponse } from "./feed-source";

/** Upper bound on a single backoff wait, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

/** Status code that signals the caller is being rate limited. */
const HTTP_TOO_MANY_REQUESTS = 429;

export interface FetchPacerOptions {
	/** Minimum gap between two consecutive underlying requests, in ms. */
	delayMs: number;
	/** How many extra attempts to make after a 429. Defaults to 3. */
	maxRetries?: number;
	/** Injected delay primitive. Defaults to a real setTimeout-based wait. */
	sleep?: (ms: number) => Promise<void>;
}

/** A real, timer-backed sleep. Replaced in tests by an injected fake. */
function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/**
 * Parses a `Retry-After` header value expressed as integer seconds.
 *
 * Only the integer-seconds form is supported (the HTTP-date form is rare for
 * feed hosts and would need a clock to interpret). Returns the wait in
 * milliseconds, or null when the value is absent or not a non-negative integer.
 */
export function parseRetryAfterMs(value: string | undefined): number | null {
	if (value === undefined) {
		return null;
	}
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	const seconds = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return null;
	}
	return seconds * 1000;
}

/**
 * Looks up a header case-insensitively.
 *
 * `HttpResponse.headers` does not guarantee lowercased keys, so match by
 * comparing lowercased names rather than assuming a casing.
 */
function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === target) {
			return headers[key];
		}
	}
	return undefined;
}

export class FetchPacer {
	private readonly fetcher: HttpFetcher;
	private readonly delayMs: number;
	private readonly maxRetries: number;
	private readonly sleep: (ms: number) => Promise<void>;

	/**
	 * Tail of the run queue. Each `fetch()` chains its work onto this promise so
	 * the underlying fetcher is only ever entered once at a time. The chain never
	 * rejects (errors are isolated per call) so one failing request cannot stall
	 * the queue for later callers.
	 */
	private queueTail: Promise<void> = Promise.resolve();

	/** True once the first underlying request has run, so we know to pace. */
	private hasRun = false;

	constructor(fetcher: HttpFetcher, opts: FetchPacerOptions) {
		this.fetcher = fetcher;
		this.delayMs = opts.delayMs;
		this.maxRetries = opts.maxRetries ?? 3;
		this.sleep = opts.sleep ?? realSleep;
	}

	/**
	 * Enqueues a request. Resolves with the underlying response once this call
	 * reaches the front of the queue, has been paced, and (if rate limited) has
	 * exhausted its retries.
	 */
	fetch(req: HttpRequest): Promise<HttpResponse> {
		const run = this.queueTail.then(() => this.runPaced(req));
		// Keep the queue chain alive even if this call rejects, so the next
		// caller's turn is not blocked by a prior failure.
		this.queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Runs a single request at the head of the queue: paces, then fetches with
	 * 429-aware retries.
	 */
	private async runPaced(req: HttpRequest): Promise<HttpResponse> {
		if (this.hasRun && this.delayMs > 0) {
			await this.sleep(this.delayMs);
		}
		this.hasRun = true;
		return this.fetchWithRetry(req);
	}

	/**
	 * Performs the underlying fetch and retries on 429 up to `maxRetries` times.
	 * After the retries are exhausted, returns the final 429 response rather than
	 * throwing, so callers can inspect the status. Network errors from the
	 * underlying fetcher propagate to the caller unchanged.
	 */
	private async fetchWithRetry(req: HttpRequest): Promise<HttpResponse> {
		let response = await this.fetcher(req);
		let attemptsLeft = this.maxRetries;

		while (response.status === HTTP_TOO_MANY_REQUESTS && attemptsLeft > 0) {
			const retryAfterMs = parseRetryAfterMs(getHeader(response.headers, "Retry-After"));
			const waitMs = Math.min(retryAfterMs ?? this.delayMs, MAX_BACKOFF_MS);
			if (waitMs > 0) {
				await this.sleep(waitMs);
			}
			attemptsLeft -= 1;
			response = await this.fetcher(req);
		}

		return response;
	}
}
