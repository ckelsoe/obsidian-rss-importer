/** @jest-environment jsdom */

import { detectPaywall } from "../paywall-detector";

describe("detectPaywall", () => {
	describe("audience resolution", () => {
		it("maps only_paid to paid", () => {
			const result = detectPaywall({ audienceField: "only_paid", bodyHtml: "<p>short</p>" });
			expect(result.audience).toBe("paid");
		});

		it("maps everyone to free", () => {
			const result = detectPaywall({ audienceField: "everyone", bodyHtml: "<p>hi</p>" });
			expect(result.audience).toBe("free");
		});

		it("maps free to free", () => {
			const result = detectPaywall({ audienceField: "free", bodyHtml: "<p>hi</p>" });
			expect(result.audience).toBe("free");
		});

		it("maps an unrecognized field to unknown", () => {
			const result = detectPaywall({ audienceField: "mystery", bodyHtml: "<p>hi</p>" });
			expect(result.audience).toBe("unknown");
		});

		it("maps a null field to unknown", () => {
			const result = detectPaywall({ audienceField: null, bodyHtml: "<p>hi</p>" });
			expect(result.audience).toBe("unknown");
		});

		it("maps an absent field to unknown", () => {
			const result = detectPaywall({ bodyHtml: "<p>hi</p>" });
			expect(result.audience).toBe("unknown");
		});
	});

	describe("structural truncation detection", () => {
		it("flags a div.paywall wrapper as truncated and reports the signal", () => {
			const html = '<article><p>Free preview line.</p><div class="paywall">Subscribe to keep reading</div></article>';
			const result = detectPaywall({ audienceField: "everyone", bodyHtml: html });
			expect(result.isTruncated).toBe(true);
			expect(result.signals).toContain("paywall-wrapper");
		});

		it("flags a subscribe-widget wrapper as truncated", () => {
			const html = '<article><p>Preview.</p><div class="subscribe-widget">Subscribe</div></article>';
			const result = detectPaywall({ audienceField: null, bodyHtml: html });
			expect(result.isTruncated).toBe(true);
			expect(result.signals).toContain("subscribe-widget");
		});

		it("matches a class fragment, so post-paywall-card fires the wrapper signal", () => {
			const html = '<div class="post-paywall-card">gate</div>';
			const result = detectPaywall({ audienceField: null, bodyHtml: html });
			expect(result.isTruncated).toBe(true);
			expect(result.signals).toContain("paywall-wrapper");
		});

		it("does NOT flag a free post whose prose merely says subscribe (no wrapper)", () => {
			const html =
				"<article><p>If you enjoyed this, please subscribe to my newsletter " +
				"and become a paid member. " +
				"Here is a lot more genuine free content that fills out the post so it " +
				"does not read as short. ".repeat(20) +
				"</p></article>";
			const result = detectPaywall({ audienceField: "free", bodyHtml: html });
			expect(result.isTruncated).toBe(false);
			expect(result.signals).toEqual([]);
		});

		it("does NOT flag an unknown-audience post with prose subscribe and no wrapper", () => {
			const html = "<article><p>Remember to subscribe and share. Members get extras.</p></article>";
			const result = detectPaywall({ audienceField: null, bodyHtml: html });
			expect(result.isTruncated).toBe(false);
			expect(result.signals).toEqual([]);
		});
	});

	describe("paid plus short body", () => {
		it("flags a paid item with a short body via the truncation marker", () => {
			const html = '<article><p>Teaser.</p><div class="available-content">cut off here</div></article>';
			const result = detectPaywall({ audienceField: "only_paid", bodyHtml: html });
			expect(result.isTruncated).toBe(true);
			expect(result.signals).toContain("available-content");
		});

		it("flags a paid item with a short plain body (no wrapper) via paid-short-body", () => {
			const html = "<article><p>This paid teaser is just a couple of lines.</p></article>";
			const result = detectPaywall({ audienceField: "only_paid", bodyHtml: html });
			expect(result.isTruncated).toBe(true);
			expect(result.signals).toContain("paid-short-body");
		});

		it("does NOT flag a paid item with a long complete body and no wrapper", () => {
			const longBody = "This is a full paid post with plenty of body text. ".repeat(40);
			const html = `<article><p>${longBody}</p></article>`;
			const result = detectPaywall({ audienceField: "only_paid", bodyHtml: html });
			expect(result.isTruncated).toBe(false);
			expect(result.signals).toEqual([]);
		});
	});

	describe("missing body", () => {
		it("flags a paid item with a null body as truncated", () => {
			const result = detectPaywall({ audienceField: "only_paid", bodyHtml: null });
			expect(result.isTruncated).toBe(true);
			expect(result.audience).toBe("paid");
			expect(result.signals).toContain("paid-no-body");
		});

		it("does NOT flag a free item with a null body", () => {
			const result = detectPaywall({ audienceField: "free", bodyHtml: null });
			expect(result.isTruncated).toBe(false);
			expect(result.signals).toEqual([]);
		});

		it("does NOT flag an unknown item with an empty body", () => {
			const result = detectPaywall({ audienceField: null, bodyHtml: "   " });
			expect(result.isTruncated).toBe(false);
			expect(result.audience).toBe("unknown");
		});
	});
});
