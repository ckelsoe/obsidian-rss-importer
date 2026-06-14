/** @jest-environment jsdom */
import { readFileSync } from "fs";
import { join } from "path";
import { convertHtmlToMarkdown, createConverter } from "../html-converter";

const FIXTURE_DIR = join(__dirname, "fixtures");

function fixture(name: string): string {
	return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("convertHtmlToMarkdown: core Markdown", () => {
	it("renders headings as atx with the right level", () => {
		const md = convertHtmlToMarkdown("<h1>Top</h1><h2>Sub</h2><h3>Deeper</h3>");
		expect(md).toContain("# Top");
		expect(md).toContain("## Sub");
		expect(md).toContain("### Deeper");
		// atx, not setext: no underline rows.
		expect(md).not.toMatch(/^=+$/m);
		expect(md).not.toMatch(/^-{3,}$/m);
	});

	it("uses '-' as the bullet list marker, never '*'", () => {
		const md = convertHtmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
		// Turndown pads the marker to a 4-char list indent: "-   one".
		expect(md).toMatch(/^- {1,3}one$/m);
		expect(md).toMatch(/^- {1,3}two$/m);
		expect(md.startsWith("-")).toBe(true);
		expect(md).not.toContain("* one");
		expect(md).not.toContain("+ one");
	});

	it("renders bold, italic, and inline links", () => {
		const md = convertHtmlToMarkdown(
			'<p><strong>bold</strong> and <em>italic</em> and <a href="https://example.com/x">a link</a></p>',
		);
		expect(md).toContain("**bold**");
		expect(md).toContain("_italic_");
		expect(md).toContain("[a link](https://example.com/x)");
	});

	it("keeps the code language on a fenced block from pre > code.language-xxx", () => {
		const html = '<pre><code class="language-python">def f():\n    return 1\n</code></pre>';
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("```python");
		expect(md).toContain("def f():");
		expect(md).toContain("return 1");
		// fence opens and closes exactly once.
		expect(md.match(/```/g)?.length).toBe(2);
	});

	it("falls back to an untagged fence when no language class is present", () => {
		const md = convertHtmlToMarkdown("<pre><code>plain code\n</code></pre>");
		expect(md).toContain("```\nplain code\n```");
	});
});

describe("convertHtmlToMarkdown: GFM plugin", () => {
	it("converts an HTML table to a GFM pipe table", () => {
		const html =
			"<table><thead><tr><th>Name</th><th>Score</th></tr></thead>" +
			"<tbody><tr><td>Ann</td><td>10</td></tr><tr><td>Bo</td><td>7</td></tr></tbody></table>";
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("| Name | Score |");
		expect(md).toMatch(/\| ?-+ ?\| ?-+ ?\|/);
		expect(md).toContain("| Ann | 10 |");
		expect(md).toContain("| Bo | 7 |");
	});

	it("converts strikethrough via the gfm plugin", () => {
		const md = convertHtmlToMarkdown("<p><del>gone</del> stays</p>");
		// turndown-plugin-gfm wraps strikethrough in single tildes.
		expect(md).toContain("~gone~");
		expect(md).toContain("stays");
	});

	it("converts a gfm task list", () => {
		const html =
			'<ul><li><input type="checkbox" checked>done</li>' +
			'<li><input type="checkbox">todo</li></ul>';
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("[x]");
		expect(md).toContain("[ ]");
		expect(md).toContain("done");
		expect(md).toContain("todo");
	});
});

describe("convertHtmlToMarkdown: figure and figcaption rule", () => {
	it("emits the image followed by an italic caption line", () => {
		const html =
			'<figure><img src="https://cdn.example.com/p.png" alt="A photo">' +
			"<figcaption>The caption text</figcaption></figure>";
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("![A photo](https://cdn.example.com/p.png)");
		expect(md).toContain("_The caption text_");
		// caption appears after the image.
		const imgIdx = md.indexOf("![A photo]");
		const capIdx = md.indexOf("_The caption text_");
		expect(imgIdx).toBeGreaterThanOrEqual(0);
		expect(capIdx).toBeGreaterThan(imgIdx);
	});

	it("handles a figure with a linked image and a caption", () => {
		const html =
			'<figure><a href="https://example.com/full"><img src="https://cdn.example.com/q.png" alt="alt q"></a>' +
			"<figcaption>Linked caption</figcaption></figure>";
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("![alt q](https://cdn.example.com/q.png)");
		expect(md).toContain("_Linked caption_");
	});
});

describe("convertHtmlToMarkdown: widget stripping and degradation", () => {
	it("strips a subscribe widget matched by class name, not by body text", () => {
		const html =
			"<p>Real body.</p>" +
			'<div class="subscribe-widget"><p>Subscribe now to get every post in your inbox</p>' +
			'<a href="https://pub.substack.com/subscribe">Subscribe</a></div>' +
			"<p>More body.</p>";
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("Real body.");
		expect(md).toContain("More body.");
		// the widget's promotional copy is gone.
		expect(md).not.toContain("Subscribe now to get every post");
	});

	it("degrades an unknown link-only widget to its link rather than dropping it", () => {
		const html =
			'<div class="cta-banner"><a href="https://example.com/read-more">Read the full thing</a></div>';
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("[Read the full thing](https://example.com/read-more)");
	});

	it("never matches a widget on body text alone", () => {
		// A normal paragraph that happens to contain the word "subscribe" must
		// survive: matching is class-based only.
		const md = convertHtmlToMarkdown("<p>You can subscribe at the library for free.</p>");
		expect(md).toContain("You can subscribe at the library for free.");
	});

	it("strips Substack app-install and subscribe embeds by data-component-name, keeping images and prose", () => {
		const html =
			'<div data-component-name="InstallSubstackAppToDOM" class="install-substack-app-embed">' +
			'<p class="preamble">If you are reading this in email, the text may cut off. Get the app.</p>' +
			'<a class="install-substack-app-embed-btn button primary" href="https://substack.com/app">Get the app</a></div>' +
			"<p>The real article body that must be kept.</p>" +
			'<div class="captioned-image-container"><img src="https://substackcdn.com/image/x.png" alt="A figure" /></div>' +
			'<div data-component-name="SubscribeWidgetToDOM" class="subscription-widget show-subscribe">' +
			'<a href="https://pub.substack.com/subscribe">Become a supporter</a></div>';
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("The real article body that must be kept.");
		expect(md).toContain("https://substackcdn.com/image/x.png");
		expect(md).not.toContain("Get the app");
		expect(md).not.toContain("reading this in email");
		expect(md).not.toContain("Become a supporter");
	});
});

describe("convertHtmlToMarkdown: footnotes", () => {
	it("collapses anchor refs to [^n] and appends definitions in stable order", () => {
		const html =
			'<p>First claim<a href="#footnote-1" id="footnote-anchor-1">1</a> and ' +
			'second claim<a href="#footnote-2" id="footnote-anchor-2">2</a>.</p>' +
			'<div class="footnote" id="footnote-1"><p>First source.</p></div>' +
			'<div class="footnote" id="footnote-2"><p>Second source.</p></div>';
		const md = convertHtmlToMarkdown(html);
		expect(md).toContain("First claim[^1]");
		expect(md).toContain("second claim[^2]");
		expect(md).toContain("[^1]: First source.");
		expect(md).toContain("[^2]: Second source.");
		// definitions sit at the very end, ref 1 before ref 2.
		expect(md.indexOf("[^1]: First source.")).toBeLessThan(md.indexOf("[^2]: Second source."));
		// the definition body appears exactly once: it was not also rendered
		// inline where the def container sat in the document.
		expect(md.split("First source.").length - 1).toBe(1);
		expect(md.split("Second source.").length - 1).toBe(1);
		// definitions are the tail of the document.
		expect(md.trimEnd().endsWith("[^2]: Second source.")).toBe(true);
	});

	it("orders definitions by first-seen ref, not by document position", () => {
		// Ref 2 appears before ref 1 in the prose; definitions are in 1,2 order
		// in the source. Output footnote order should follow ref appearance: 2,1.
		const html =
			'<p>Alpha<a href="#fn-2">2</a> then beta<a href="#fn-1">1</a>.</p>' +
			'<div id="fn-1"><p>Def one.</p></div>' +
			'<div id="fn-2"><p>Def two.</p></div>';
		const md = convertHtmlToMarkdown(html);
		expect(md.indexOf("[^2]: Def two.")).toBeLessThan(md.indexOf("[^1]: Def one."));
	});
});

describe("convertHtmlToMarkdown: determinism", () => {
	it("produces byte-identical output when run twice on the same input", () => {
		const html =
			"<h2>Title</h2><p><strong>Bold</strong> text with a " +
			'<a href="#footnote-1" id="footnote-anchor-1">1</a> ref.</p>' +
			'<figure><img src="https://cdn.example.com/i.png" alt="i"><figcaption>cap</figcaption></figure>' +
			'<div class="subscribe-widget"><a href="https://x/subscribe">Subscribe</a></div>' +
			'<div id="footnote-1"><p>note body</p></div>';
		const first = convertHtmlToMarkdown(html);
		const second = convertHtmlToMarkdown(html);
		expect(second).toBe(first);
	});

	it("does not leak footnote state between separate conversions", () => {
		const a = convertHtmlToMarkdown(
			'<p>A<a href="#footnote-1" id="footnote-anchor-1">1</a></p>' +
				'<div id="footnote-1"><p>note A</p></div>',
		);
		const b = convertHtmlToMarkdown("<p>Plain B with no footnotes.</p>");
		expect(a).toContain("[^1]: note A");
		expect(b).not.toContain("[^1]");
		expect(b).toBe("Plain B with no footnotes.");
	});
});

describe("convertHtmlToMarkdown: edge cases", () => {
	it("returns an empty string for empty or whitespace-only input", () => {
		expect(convertHtmlToMarkdown("")).toBe("");
		expect(convertHtmlToMarkdown("   \n  ")).toBe("");
	});

	it("collapses runs of blank lines so output is tidy", () => {
		const md = convertHtmlToMarkdown("<p>one</p><p></p><p></p><p>two</p>");
		expect(md).not.toMatch(/\n{3,}/);
	});
});

describe("createConverter", () => {
	it("returns a working TurndownService configured with atx and '-' bullets", () => {
		const service = createConverter();
		const md = service.turndown("<h1>Hi</h1><ul><li>x</li></ul>");
		expect(md).toContain("# Hi");
		expect(md).toMatch(/^- {1,3}x$/m);
	});
});

describe("convertHtmlToMarkdown: real Substack content:encoded fixture", () => {
	it("converts a trimmed real Substack body to non-empty Markdown without throwing", () => {
		const html = fixture("substack-content-encoded.html");
		let md = "";
		expect(() => {
			md = convertHtmlToMarkdown(html);
		}).not.toThrow();
		expect(md.length).toBeGreaterThan(0);
		// structural spot-checks against the real content. The h2 wraps a
		// <strong>, so Turndown keeps the emphasis inside the atx heading.
		expect(md).toContain("## **How Am I Saved?**");
		expect(md).toContain("_A quiet chapel at dawn");
		expect(md).toContain("```python");
		// the subscribe widget chrome is stripped, link and all.
		expect(md).not.toContain("Subscribe at no charge");
		expect(md).not.toContain("(https://frankviola.substack.com/subscribe?)");
		// the share button widget is stripped too.
		expect(md).not.toContain("action=share");
		// fixture conversion is deterministic too.
		expect(convertHtmlToMarkdown(html)).toBe(md);
	});
});
