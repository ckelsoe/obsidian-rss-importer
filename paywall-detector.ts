/**
 * Paywall detector.
 *
 * Classifies a fetched item body as truncated or complete, and resolves its
 * access tier, using STRUCTURAL signals only. We never key off localized body
 * prose ("subscribe to read", "members only", etc.) because that produces false
 * positives on free posts that merely mention subscribing, and it breaks the
 * moment a publication is translated or reworded.
 *
 * Instead we drive off a data-driven list of paywall class-name keys matched
 * against the parsed DOM. Substack and similar platforms wrap the gated portion
 * of a post in stable structural containers (the paywall card, the
 * subscribe widget, the truncated available-content region). Those container
 * class names are far more durable than the words inside them.
 */

import type { FeedAudience } from "./feed-source";

/** Input to the detector. `bodyHtml` is null before `fetchBody` has run. */
export interface PaywallDetectInput {
	/**
	 * The source-reported audience field, when one exists (Substack JSON
	 * `audience`). Examples seen in the wild: "only_paid", "only_free",
	 * "everyone", "free". Null or undefined for generic RSS feeds.
	 */
	audienceField?: string | null;
	/** The fetched body HTML, or null when no body has been fetched yet. */
	bodyHtml: string | null;
}

/** Result of classification. `signals` lists the matched keys for debugging. */
export interface PaywallDetectResult {
	/** True when the body is a paywalled teaser rather than a complete post. */
	isTruncated: boolean;
	/** Resolved access tier. */
	audience: FeedAudience;
	/** Names of the structural signals that fired, for debuggability. */
	signals: string[];
}

/**
 * A structural paywall signal. `kind` separates a hard paywall wrapper (its
 * mere presence means the body is truncated) from a softer truncation marker
 * (only meaningful when the item is also known to be paid).
 */
interface PaywallSignal {
	/** Stable signal name surfaced in the result for debugging. */
	name: string;
	/** Class-name fragments that, if present on any element, fire this signal. */
	classKeys: string[];
	/**
	 * "wrapper": presence alone proves truncation.
	 * "truncation": only proves truncation when the item is also paid.
	 */
	kind: "wrapper" | "truncation";
}

/**
 * Data-driven structural signals. Matching is done on class-name fragments via
 * substring (case-insensitive), so "paywall" matches "paywall",
 * "post-paywall", "paywall-card", etc. Keep this list structural. Do NOT add
 * prose-based markers here.
 */
const PAYWALL_SIGNALS: readonly PaywallSignal[] = [
	{ name: "paywall-wrapper", classKeys: ["paywall"], kind: "wrapper" },
	{ name: "subscribe-widget", classKeys: ["subscribe-widget"], kind: "wrapper" },
	{ name: "subscription-widget", classKeys: ["subscription-widget"], kind: "wrapper" },
	{ name: "gate-wrapper", classKeys: ["content-gate", "post-gate"], kind: "wrapper" },
	{ name: "available-content", classKeys: ["available-content"], kind: "truncation" },
	{ name: "truncated-content", classKeys: ["truncated-content", "post-truncated"], kind: "truncation" },
] as const;

/** Source audience field tokens that indicate a paid-only item. */
const PAID_TOKENS: readonly string[] = ["only_paid", "paid", "subscriber", "members"];

/** Source audience field tokens that indicate a free item. */
const FREE_TOKENS: readonly string[] = ["everyone", "free", "only_free", "public"];

/**
 * Resolve the access tier from the source-reported audience field. Returns
 * "unknown" (the honest default) when the field is absent or unrecognized. Paid
 * tokens win over free tokens if a field somehow matches both, because a paid
 * gate is the more consequential classification to surface.
 */
function resolveAudience(audienceField: string | null | undefined): FeedAudience {
	if (audienceField === null || audienceField === undefined) {
		return "unknown";
	}
	const normalized = audienceField.trim().toLowerCase();
	if (normalized.length === 0) {
		return "unknown";
	}
	if (PAID_TOKENS.some((token) => normalized.includes(token))) {
		return "paid";
	}
	if (FREE_TOKENS.some((token) => normalized.includes(token))) {
		return "free";
	}
	return "unknown";
}

/**
 * Collect the lowercased class tokens present anywhere in the document. We read
 * `className` rather than the parsed token list so SVG elements (whose
 * `className` is an object, not a string) are handled defensively.
 */
function collectClassText(doc: Document): string {
	const parts: string[] = [];
	const all = doc.querySelectorAll("*");
	for (let i = 0; i < all.length; i += 1) {
		const el = all.item(i);
		if (el === null) {
			continue;
		}
		// `getAttribute("class")` returns the raw string for both HTML and SVG
		// elements, avoiding the SVGAnimatedString shape of `el.className`.
		const cls = el.getAttribute("class");
		if (cls !== null && cls.length > 0) {
			parts.push(cls.toLowerCase());
		}
	}
	return parts.join(" ");
}

/**
 * Decide whether a known-paid body looks truncated by structure. A complete
 * post has substantial rendered text; a teaser is a short lead-in. We use a
 * conservative character threshold on the text content so this only ever
 * contributes alongside a known-paid audience, never on its own.
 */
const TRUNCATION_TEXT_THRESHOLD = 800;

function looksShort(doc: Document): boolean {
	const body = doc.body;
	const text = body === null ? "" : (body.textContent ?? "");
	return text.trim().length < TRUNCATION_TEXT_THRESHOLD;
}

/**
 * Classify a fetched body. Pure aside from constructing a DOMParser, which is
 * created lazily inside the function (never at module load) so the module can be
 * imported in a non-DOM context without throwing.
 *
 * Rules:
 * - A paywall wrapper signal present => isTruncated true (regardless of tier).
 * - audience paid AND the body looks short (or a truncation marker fired)
 *   => isTruncated true.
 * - Otherwise isTruncated false.
 */
export function detectPaywall(input: PaywallDetectInput): PaywallDetectResult {
	const audience = resolveAudience(input.audienceField);
	const signals: string[] = [];

	const html = input.bodyHtml;
	if (html === null || html.trim().length === 0) {
		// No body to inspect. For a paid item with no fetched body we still flag
		// truncation, because a paid item we could not fully fetch is, by
		// definition, not a complete post in hand.
		const isTruncated = audience === "paid";
		if (isTruncated) {
			signals.push("paid-no-body");
		}
		return { isTruncated, audience, signals };
	}

	const doc = new DOMParser().parseFromString(html, "text/html");
	const classText = collectClassText(doc);

	let hasWrapper = false;
	let hasTruncationMarker = false;
	for (const signal of PAYWALL_SIGNALS) {
		const matched = signal.classKeys.some((key) => classText.includes(key));
		if (!matched) {
			continue;
		}
		signals.push(signal.name);
		if (signal.kind === "wrapper") {
			hasWrapper = true;
		} else {
			hasTruncationMarker = true;
		}
	}

	let isTruncated = hasWrapper;
	if (audience === "paid") {
		if (hasTruncationMarker) {
			isTruncated = true;
		} else if (looksShort(doc)) {
			isTruncated = true;
			signals.push("paid-short-body");
		}
	}

	return { isTruncated, audience, signals };
}
