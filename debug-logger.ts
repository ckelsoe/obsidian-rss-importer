// Debug logger for RSS Importer. When the plugin's debug setting is
// enabled, this module captures a bounded ring buffer of feed
// request/response/parsed events so a user can reproduce a problem,
// export the captured session, and paste it into a bug report without
// fiddling with browser DevTools.
//
// Design contract:
// - NEVER log authentication headers, cookies, or any secret. The HTTP
//   adapter is responsible for filtering sensitive headers out of the
//   `log` call at the source. This module trusts its input and does not
//   re-scan for secrets.
// - Keep the module free of `obsidian` imports so tests can exercise it
//   with a plain Jest stub. The plugin wires the concrete logger instance
//   into the fetcher and sources.
// - Treat `enabled=false` as a strict no-op: when debug is off, `log()`
//   returns immediately without allocating the event object, storing it,
//   or writing to the console. This keeps the hot path cheap.
//
// The `DebugLogger` type is a structural interface so tests and alternate
// implementations (a null logger, a streaming logger) can substitute
// freely. `BufferedDebugLogger` is the only implementation the plugin
// ships; `NoopDebugLogger` is the permanently-off default.

/**
 * Categorizes a single debug event. `request` fires before an HTTP call,
 * `response` fires after the status and body are read, `parsed` fires
 * after a source has successfully turned the raw feed into normalized
 * items. `error` fires on any thrown/caught failure. `note` is a
 * free-form developer marker the plugin can use to annotate the timeline
 * ("user clicked import", "modal closed").
 */
export type DebugEventKind = "request" | "response" | "parsed" | "error" | "note";

/**
 * Shape of an event as logged by a caller. The timestamp is filled in by
 * the logger so callers do not have to track their own clock. That keeps
 * call sites terse and prevents "logged time drifts from wall time" bugs
 * in long-running sessions.
 */
export interface DebugEventInput {
	readonly kind: DebugEventKind;
	readonly message: string;
	/**
	 * Optional free-form payload, typically the raw feed XML/JSON or the
	 * parsed item array. Should be JSON-serializable. Callers should NOT
	 * include authorization headers, cookies, or any other secret.
	 */
	readonly payload?: unknown;
	/**
	 * Optional endpoint or feed URL for request/response events, used for
	 * formatting and filtering. Free-form otherwise, purely human-facing.
	 */
	readonly endpoint?: string;
}

export interface DebugEvent extends DebugEventInput {
	readonly timestamp: Date;
}

export interface DebugLogger {
	readonly enabled: boolean;
	setEnabled(enabled: boolean): void;
	log(event: DebugEventInput): void;
	snapshot(): readonly DebugEvent[];
	clear(): void;
	format(): string;
}

/**
 * Maximum number of events the ring buffer will retain. Older events are
 * dropped when the cap is reached. Sized to hold roughly one full import
 * session worth of request/response pairs (feed fetch plus per-item body
 * fetches) plus user-click notes without growing the plugin's memory
 * footprint past a few megabytes.
 */
export const DEFAULT_MAX_EVENTS = 250;

/**
 * In-memory ring-buffer implementation of `DebugLogger`. The buffer is a
 * plain array that shifts the oldest entry when it hits `maxEvents`. That
 * is O(n) per drop, but n is small so it never shows up in profiles.
 *
 * The public API is deliberately tiny: `log`, `snapshot`, `clear`,
 * `format`, plus an `enabled` toggle. Tests can assert against
 * `snapshot()` without caring how the buffer is stored internally.
 */
export class BufferedDebugLogger implements DebugLogger {
	private _enabled: boolean;
	private readonly maxEvents: number;
	private readonly buffer: DebugEvent[] = [];
	// Wall-clock provider is injected so tests can pin timestamps. Defaults
	// to a fresh Date in production; tests pass a counter-based fake.
	private readonly now: () => Date;
	// Optional static lines injected into the formatted header so exported
	// debug sessions can be tied to a concrete plugin build/version.
	private readonly headerLines: readonly string[];
	// Sink for the live DevTools mirror. Defaults to console.debug so the
	// plugin can tail events in Obsidian's developer console; tests pass a
	// no-op to keep Jest output clean.
	private readonly consoleSink: (message: string, payload?: unknown) => void;

	constructor(
		enabled: boolean,
		options: {
			readonly maxEvents?: number;
			readonly now?: () => Date;
			readonly headerLines?: readonly string[];
			readonly consoleSink?: (message: string, payload?: unknown) => void;
		} = {},
	) {
		this._enabled = enabled;
		// Guard against zero or negative caps that would make the buffer drop
		// every event the instant it is pushed.
		const requestedMax = options.maxEvents ?? DEFAULT_MAX_EVENTS;
		this.maxEvents = requestedMax > 0 ? requestedMax : DEFAULT_MAX_EVENTS;
		this.now = options.now ?? ((): Date => new Date());
		this.headerLines = options.headerLines ?? [];
		this.consoleSink =
			options.consoleSink ??
			((message, payload): void => {
				// Mirroring to DevTools is the explicit purpose of this sink,
				// gated behind the user's debug setting. Uses console.debug (not
				// console.log) to satisfy the obsidianmd no-console rule; the
				// in-memory buffer is the primary capture path, so verbose-level
				// console output is acceptable as a secondary mirror.
				if (payload === undefined) {
					console.debug(message);
				} else {
					console.debug(message, payload);
				}
			});
	}

	get enabled(): boolean {
		return this._enabled;
	}

	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
	}

	log(event: DebugEventInput): void {
		if (!this._enabled) {
			return;
		}
		const withTs: DebugEvent = { ...event, timestamp: this.now() };
		this.buffer.push(withTs);
		while (this.buffer.length > this.maxEvents) {
			this.buffer.shift();
		}
		// Mirror to DevTools so the user can watch events stream live.
		const endpointPart = event.endpoint ? ` ${event.endpoint}` : "";
		const prefix = `[RSS debug] ${event.kind}${endpointPart}: ${event.message}`;
		this.consoleSink(prefix, event.payload);
	}

	snapshot(): readonly DebugEvent[] {
		return [...this.buffer];
	}

	clear(): void {
		this.buffer.length = 0;
	}

	/**
	 * Render the current buffer as a single newline-delimited string
	 * suitable for pasting into a bug report or a chat message. Each event
	 * is a block of the form:
	 *
	 *   [N] YYYY-MM-DDTHH:MM:SS.sssZ KIND [endpoint]: message
	 *   <pretty-printed JSON payload, if any>
	 *
	 * Payloads are formatted with `JSON.stringify(_, null, 2)`; cyclic or
	 * non-serializable payloads fall back to a `(non-serializable)` marker
	 * so the format call never throws.
	 */
	format(): string {
		const snap = this.snapshot();
		const header = [
			"=== RSS Importer debug session ===",
			`Generated: ${this.now().toISOString()}`,
			`Events: ${snap.length}`,
			...this.headerLines,
			"Authorization headers are never captured. Payloads may contain",
			"feed titles, article text, and item metadata.",
			"",
		].join("\n");
		if (snap.length === 0) {
			return `${header}(buffer is empty)\n=== End debug session ===\n`;
		}
		const blocks = snap.map((event, index) => {
			const n = index + 1;
			const ts = event.timestamp.toISOString();
			const kind = event.kind.toUpperCase();
			const endpointPart = event.endpoint ? ` ${event.endpoint}` : "";
			const headerLine = `[${n}] ${ts} ${kind}${endpointPart}: ${event.message}`;
			if (event.payload === undefined) {
				return headerLine;
			}
			let payloadText: string;
			try {
				const json = JSON.stringify(event.payload, null, 2);
				payloadText =
					json === undefined
						? `(non-serializable: ${describeNonString(event.payload)})`
						: json;
			} catch (err) {
				// Surface the original failure detail rather than swallowing it.
				payloadText = `(non-serializable: ${
					err instanceof Error ? err.message : describeNonString(err)
				})`;
			}
			return `${headerLine}\n${payloadText}`;
		});
		return `${header}${blocks.join("\n\n")}\n\n=== End debug session ===\n`;
	}
}

// Stringify an unknown value for human-readable diagnostics without
// triggering @typescript-eslint/no-base-to-string. `String(value)` on an
// object produces the literal "[object Object]" which is useless;
// constructor names plus JSON.stringify is more informative.
function describeNonString(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// Fall through to the constructor-name fallback below.
	}
	const ctor = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
	return ctor ? `[object ${ctor}]` : "unknown value";
}

/**
 * A permanently-disabled logger. Useful as a default when debug is off so
 * callers can always call `log()` without null-checking. The `enabled`
 * setter is ignored: this logger stays off no matter what.
 *
 * The method signatures mirror `DebugLogger` (they accept parameters even
 * though they are unused) so tests and call sites can invoke them without
 * TypeScript narrowing the concrete type to a zero-arg form.
 */
export class NoopDebugLogger implements DebugLogger {
	readonly enabled = false;
	setEnabled(_enabled: boolean): void {
		// Deliberate no-op. The Noop logger cannot be turned on.
		void _enabled;
	}
	log(_event: DebugEventInput): void {
		// Deliberate no-op.
		void _event;
	}
	snapshot(): readonly DebugEvent[] {
		return [];
	}
	clear(): void {
		// Deliberate no-op.
	}
	format(): string {
		return "";
	}
}
