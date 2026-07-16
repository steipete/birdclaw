import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const docsSite = path.join(root, "dist", "docs-site");
let renderInline: (text: string, currentRel: string) => string;

describe("docs site", () => {
	beforeAll(async () => {
		const module = (await import(
			pathToFileURL(path.join(root, "scripts", "build-docs-site.mjs")).href
		)) as {
			__test__: { inline: typeof renderInline };
		};
		renderInline = module.__test__.inline;
	});

	it("renders the Sign in page in onboarding order", () => {
		const install = fs.readFileSync(
			path.join(docsSite, "install.html"),
			"utf8",
		);
		const auth = fs.readFileSync(path.join(docsSite, "auth.html"), "utf8");

		expect(install).toContain('href="auth.html">Sign in</a>');
		expect(auth).toContain('href="install.html">Install</a>');
		expect(auth).toContain('href="quickstart.html">Quickstart</a>');
		expect(auth.indexOf(">Install</a>")).toBeLessThan(
			auth.indexOf(">Sign in</a>"),
		);
		expect(auth.indexOf(">Sign in</a>")).toBeLessThan(
			auth.indexOf(">Quickstart</a>"),
		);
		expect(auth).toContain("xurl whoami");
		expect(auth).not.toContain("--client-secret");
		expect(auth).not.toContain("BIRDCLAW_PROFILE");
		expect(auth).toContain("import your X archive before the first live sync");
		expect(auth).toContain("npm install -g @xdevplatform/xurl");
		expect(auth).toContain("Existing bird installations");
		expect(auth).not.toContain("npm install -g @steipete/bird");
		expect(auth).not.toContain('href="https://github.com/steipete/bird"');
		expect(auth).not.toContain("brew install steipete/tap/bird");

		const quickstart = fs.readFileSync(
			path.join(docsSite, "quickstart.html"),
			"utf8",
		);
		expect(quickstart).not.toContain("fully usable in live-only mode");
		expect(quickstart).toContain(
			"Do not run live sync against a freshly initialized database",
		);
	});

	it("keeps underscores inside autolink URLs literal", () => {
		const archive = fs.readFileSync(
			path.join(docsSite, "archive.html"),
			"utf8",
		);
		const expected =
			'<a href="https://x.com/settings/download_your_data">https://x.com/settings/download_your_data</a>';

		expect(archive).toContain(expected);
		expect(archive).not.toContain("download<em>your</em>data");
	});

	it("preserves query strings in autolinks", () => {
		const url = "https://example.test/path_with_value?a=1&b=2";

		expect(renderInline(`<${url}>`, "auth.md")).toBe(
			`<a href="${url.replace("&", "&amp;")}">${url.replace("&", "&amp;")}</a>`,
		);
	});

	it("preserves angle-bracket Markdown link destinations", () => {
		const url = "https://example.test/path_with_value?a=1&b=2";

		expect(renderInline(`[X](<${url}>)`, "auth.md")).toBe(
			`<a href="${url.replace("&", "&amp;")}">X</a>`,
		);
	});

	it("preserves parentheses in angle-bracket Markdown link destinations", () => {
		const url = "https://example.test/Foo_(bar)";

		expect(renderInline(`[X](<${url}>)`, "auth.md")).toBe(
			`<a href="${url}">X</a>`,
		);
	});

	it("preserves code-formatted Markdown link labels", () => {
		expect(
			renderInline("[`xurl`](https://github.com/xdevplatform/xurl)", "auth.md"),
		).toBe(
			'<a href="https://github.com/xdevplatform/xurl"><code>xurl</code></a>',
		);
	});

	it("normalizes line breaks and escaped pipes in Markdown link labels", () => {
		expect(renderInline("[a<br>b\\|c](https://example.test)", "auth.md")).toBe(
			'<a href="https://example.test">a<br>b|c</a>',
		);
	});
});
