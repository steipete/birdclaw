// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0))
		rmSync(fixture, { recursive: true, force: true });
});
function fixture(cli?: string) {
	const root = mkdtempSync(path.join(tmpdir(), "birdclaw-bin-"));
	fixtures.push(root);
	mkdirSync(path.join(root, "bin"));
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ type: "module", version: "9.8.7" }),
	);
	const entry = path.join(root, "bin/birdclaw.mjs");
	copyFileSync(new URL("../bin/birdclaw.mjs", import.meta.url), entry);
	if (cli) {
		mkdirSync(path.join(root, "dist/cli"), { recursive: true });
		writeFileSync(path.join(root, "dist/cli/birdclaw.js"), cli);
	}
	return (args: string[]) =>
		spawnSync(
			process.execPath,
			[...("bun" in process.versions ? ["--no-env-file"] : []), entry, ...args],
			{ encoding: "utf8" },
		);
}
it.each(["--version", "-V"])(
	"reads %s without loading CLI implementation",
	(flag) => {
		const result = fixture()([flag]);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("9.8.7\n");
		expect(result.stderr).toBe("");
	},
);
it.each([
	[],
	["--help"],
	["--json", "--version"],
	["--version", "extra"],
	["search", "tweets", "two words"],
])("delegates other arguments unchanged: %j", (...args: string[]) => {
	const result = fixture(
		"export async function runCli(){console.log(JSON.stringify(process.argv.slice(2)));}",
	)(args);
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual(args);
});
it("retains the normal CLI error boundary", () => {
	const result = fixture(
		'export async function runCli(){throw new Error("fixture failure");}',
	)(["search"]);
	expect(result.status).toBe(1);
	expect(result.stderr.trim()).toBe("fixture failure");
});
