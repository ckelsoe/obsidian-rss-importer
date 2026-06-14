import { applyCleanup, splitFrontmatter, type CleanupConfig } from "../cleanup";

// A long real paragraph that merely cites a promo host once. Well over the
// 300-char non-link limit, so the safety rule must preserve it.
const LONG_PARAGRAPH =
	"This week I dug into the economics of independent publishing and why so many " +
	"writers end up burning out within the first two years of going solo. The short " +
	"version is that the platform incentives push you toward volume over depth, and " +
	"once you are on that treadmill it is very hard to step off without watching your " +
	"numbers crater. I link out to [their store](https://curios.com/shop) here only as " +
	"one example of the merch-funnel pattern, not as an endorsement, and the rest of " +
	"this piece is about the structural forces that make that funnel feel mandatory.";

function config(overrides: Partial<CleanupConfig> = {}): CleanupConfig {
	return {
		linkHosts: [],
		trimAfterLastRule: false,
		...overrides,
	};
}

describe("applyCleanup link-host rule", () => {
	it("drops a short call-to-action paragraph linking a promo host", () => {
		const body = [
			"Real opening paragraph that carries the actual content of the post.",
			"",
			"Support my work on [Buy Me a Coffee](https://buymeacoffee.com/writer).",
			"",
			"A real closing paragraph with the conclusion.",
		].join("\n");
		const out = applyCleanup(body, config({ linkHosts: ["buymeacoffee.com"] }));
		expect(out).not.toContain("buymeacoffee.com");
		expect(out).not.toContain("Support my work");
		expect(out).toContain("Real opening paragraph");
		expect(out).toContain("A real closing paragraph");
	});

	it("drops a list item that links a promo host", () => {
		const body = [
			"Find me here:",
			"",
			"- [My newsletter](https://substack.com/app/subscribe)",
			"- [My website](https://example.com/about)",
		].join("\n");
		const out = applyCleanup(body, config({ linkHosts: ["substack.com/app"] }));
		expect(out).not.toContain("substack.com/app");
		expect(out).not.toContain("My newsletter");
		// The non-promo bullet survives.
		expect(out).toContain("My website");
	});

	it("matches a path fragment like /subscribe case-insensitively", () => {
		const body = "Click [here](https://Example.com/Subscribe/now) to join.";
		const out = applyCleanup(body, config({ linkHosts: ["/subscribe"] }));
		expect(out).toBe("");
	});

	it("matches a bare autolink to a promo host", () => {
		const body = "Tip jar: <https://buymeacoffee.com/writer>";
		const out = applyCleanup(body, config({ linkHosts: ["buymeacoffee.com"] }));
		expect(out).toBe("");
	});

	it("KEEPS a long real paragraph that cites a promo host once (safety rule)", () => {
		const out = applyCleanup(LONG_PARAGRAPH, config({ linkHosts: ["curios.com"] }));
		// The whole paragraph survives: it is real content, not a CTA.
		expect(out).toBe(LONG_PARAGRAPH);
	});

	it("drops a short block when every link points at a promo host", () => {
		const body = "[Subscribe](https://substack.com/app) | [Tip](https://buymeacoffee.com/x)";
		const out = applyCleanup(
			body,
			config({ linkHosts: ["substack.com/app", "buymeacoffee.com"] }),
		);
		expect(out).toBe("");
	});

	it("leaves blocks with no promo link untouched", () => {
		const body = [
			"Paragraph one with [a real link](https://example.com/article).",
			"",
			"Paragraph two.",
		].join("\n");
		const out = applyCleanup(body, config({ linkHosts: ["buymeacoffee.com"] }));
		expect(out).toBe(body);
	});
});

describe("applyCleanup trimAfterLastRule", () => {
	it("removes everything from the last horizontal rule to the end", () => {
		const body = [
			"Body paragraph one.",
			"",
			"Body paragraph two.",
			"",
			"---",
			"",
			"Footer with [subscribe link](https://example.com/subscribe).",
			"Copyright notice.",
		].join("\n");
		const out = applyCleanup(body, config({ trimAfterLastRule: true }));
		expect(out).toContain("Body paragraph one.");
		expect(out).toContain("Body paragraph two.");
		expect(out).not.toContain("Footer");
		expect(out).not.toContain("Copyright notice.");
		expect(out).not.toContain("---");
	});

	it("trims from the LAST rule when several are present", () => {
		const body = [
			"Intro.",
			"",
			"***",
			"",
			"Middle section that should survive.",
			"",
			"___",
			"",
			"Trailing footer.",
		].join("\n");
		const out = applyCleanup(body, config({ trimAfterLastRule: true }));
		expect(out).toContain("Middle section that should survive.");
		expect(out).not.toContain("Trailing footer.");
	});

	it("does nothing when trimAfterLastRule is false", () => {
		const body = ["Content.", "", "---", "", "Footer."].join("\n");
		const out = applyCleanup(body, config({ trimAfterLastRule: false }));
		expect(out).toContain("Footer.");
	});

	it("leaves a body with no horizontal rule unchanged under trim", () => {
		const body = ["Just content.", "", "More content."].join("\n");
		const out = applyCleanup(body, config({ trimAfterLastRule: true }));
		expect(out).toBe(body);
	});
});

describe("applyCleanup idempotency and no-ops", () => {
	it("is idempotent: applying twice equals applying once", () => {
		const body = [
			"Real content here.",
			"",
			"Tip me: [Buy Me a Coffee](https://buymeacoffee.com/x)",
			"",
			"More real content.",
			"",
			"---",
			"",
			"Footer junk.",
		].join("\n");
		const cfg = config({ linkHosts: ["buymeacoffee.com"], trimAfterLastRule: true });
		const once = applyCleanup(body, cfg);
		const twice = applyCleanup(once, cfg);
		expect(twice).toBe(once);
	});

	it("collapses the blank-line run a removal leaves behind", () => {
		const body = [
			"Para one.",
			"",
			"[Tip](https://buymeacoffee.com/x)",
			"",
			"Para two.",
		].join("\n");
		const out = applyCleanup(body, config({ linkHosts: ["buymeacoffee.com"] }));
		expect(out).toBe("Para one.\n\nPara two.");
		// No triple newline left where the block was removed.
		expect(out).not.toMatch(/\n{3,}/);
	});

	it("is a no-op when there are no rules", () => {
		const body = [
			"Tip me: [Buy Me a Coffee](https://buymeacoffee.com/x)",
			"",
			"---",
			"",
			"Footer.",
		].join("\n");
		expect(applyCleanup(body, config())).toBe(body);
	});

	it("returns an empty body unchanged", () => {
		expect(applyCleanup("", config({ linkHosts: ["x"], trimAfterLastRule: true }))).toBe("");
	});

	it("returns a whitespace-only body unchanged", () => {
		const ws = "   \n\n  \t";
		expect(applyCleanup(ws, config({ linkHosts: ["x"], trimAfterLastRule: true }))).toBe(ws);
	});
});

describe("splitFrontmatter", () => {
	it("splits a note into its frontmatter fence and body", () => {
		const content = [
			"---",
			"feed-source: feed-1",
			"title: A Post",
			"---",
			"",
			"Body content here.",
		].join("\n");
		const parts = splitFrontmatter(content);
		expect(parts.frontmatter).toBe("---\nfeed-source: feed-1\ntitle: A Post\n---\n");
		expect(parts.body).toBe("\nBody content here.");
		// Rejoining reproduces the input exactly.
		expect(parts.frontmatter + parts.body).toBe(content);
	});

	it("returns an empty frontmatter when the note has none", () => {
		const content = "Just a body, no frontmatter.";
		const parts = splitFrontmatter(content);
		expect(parts.frontmatter).toBe("");
		expect(parts.body).toBe(content);
	});

	it("NEVER lets cleanup touch the frontmatter through the split", () => {
		// A promo host appears inside the frontmatter (a url field). Cleaning the
		// body only must leave that frontmatter line intact.
		const content = [
			"---",
			"url: \"https://buymeacoffee.com/writer\"",
			"title: Real Post",
			"---",
			"",
			"Real body paragraph.",
			"",
			"Tip me: [Buy Me a Coffee](https://buymeacoffee.com/writer)",
		].join("\n");
		const parts = splitFrontmatter(content);
		const cleanedBody = applyCleanup(parts.body, config({ linkHosts: ["buymeacoffee.com"] }));
		const result = parts.frontmatter + cleanedBody;
		// Frontmatter url survives; body CTA is gone.
		expect(result).toContain('url: "https://buymeacoffee.com/writer"');
		expect(result).not.toContain("Tip me:");
		expect(result).toContain("Real body paragraph.");
	});
});
