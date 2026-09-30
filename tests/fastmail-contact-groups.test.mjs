import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createFastmailContactGroupsExtension } from "../extensions/fastmail-contact-groups/extension.ts";

function setup({ response, truncateHead } = {}) {
	const tools = [];
	const calls = [];
	const Type = {
		Object: value => value,
		String: (value = {}) => value,
		Boolean: (value = {}) => value,
		Optional: value => value,
	};
	const register = createFastmailContactGroupsExtension({
		Type,
		StringEnum: values => values,
		truncateHead: truncateHead ?? (content => ({ content, truncated: false })),
		limits: { maxBytes: 50_000, maxLines: 2_000 },
	});
	register({
		registerTool: tool => tools.push(tool),
		exec: async (...args) => {
			calls.push(args);
			return response ?? { code: 0, stdout: JSON.stringify({ summary: "Preview", applied: false }) };
		},
	});
	return { tool: tools[0], tools, calls };
}

test("entrypoint uses Pi-native dependencies and the implementation has no PA coupling", async () => {
	const index = await readFile(new URL("../extensions/fastmail-contact-groups/index.ts", import.meta.url), "utf8");
	const extension = await readFile(new URL("../extensions/fastmail-contact-groups/extension.ts", import.meta.url), "utf8");
	assert.match(index, /from "@earendil-works\/pi-ai"/);
	assert.match(index, /from "@earendil-works\/pi-coding-agent"/);
	assert.match(index, /createFastmailContactGroupsExtension/);
	assert.doesNotMatch(index + extension, /personal-assistant|integrations\/fastmail-contacts|compactRenderer|createJiti|\bjiti\b/);
});

test("native index entrypoint loads with Pi-supplied runtime exports and registers the tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "fastmail-contact-groups-entrypoint-"));
	const extensionRoot = join(root, "extensions", "fastmail-contact-groups");
	const packagesRoot = join(root, "node_modules", "@earendil-works");
	try {
		await cp(new URL("../extensions/fastmail-contact-groups", import.meta.url), extensionRoot, { recursive: true });
		await mkdir(join(packagesRoot, "pi-ai"), { recursive: true });
		await mkdir(join(packagesRoot, "pi-coding-agent"), { recursive: true });
		await writeFile(join(packagesRoot, "pi-ai", "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", type: "module", exports: "./index.js" }));
		await writeFile(join(packagesRoot, "pi-ai", "index.js"), `
			export const Type = {
				Object: value => value,
				String: (value = {}) => value,
				Boolean: (value = {}) => value,
				Optional: value => value,
			};
			export const StringEnum = values => values;
		`);
		await writeFile(join(packagesRoot, "pi-coding-agent", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }));
		await writeFile(join(packagesRoot, "pi-coding-agent", "index.js"), `
			export const DEFAULT_MAX_BYTES = 50000;
			export const DEFAULT_MAX_LINES = 2000;
			export const truncateHead = content => ({ content, truncated: false });
		`);

		const entrypoint = await import(pathToFileURL(join(extensionRoot, "index.ts")).href);
		const tools = [];
		entrypoint.default({ registerTool: tool => tools.push(tool) });
		assert.deepEqual(tools.map(tool => tool.name), ["fastmail_contact_groups"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("registers exactly one contact-group tool without subprocess or network work", () => {
	const originalFetch = globalThis.fetch;
	let fetched = false;
	globalThis.fetch = async () => {
		fetched = true;
		throw new Error("unexpected network request");
	};
	try {
		const { tool, tools, calls } = setup();
		assert.deepEqual(tools.map(candidate => candidate.name), ["fastmail_contact_groups"]);
		assert.deepEqual(tool.parameters.action, ["list", "get", "add", "remove"]);
		assert.deepEqual(calls, []);
		assert.equal(fetched, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("guidance separates official MCP contacts from guarded CardDAV groups", () => {
	const { tool } = setup();
	assert(tool.promptGuidelines.some(guideline => guideline.includes("official Fastmail MCP contact tools") && guideline.includes("basic contact")));
	assert(tool.promptGuidelines.some(guideline => guideline.includes("MCP contact IDs") && guideline.includes("CardDAV UIDs")));
	assert(tool.promptGuidelines.some(guideline => guideline.includes("account identity") && guideline.includes("synchronization")));
});

test("default mutation request is preview-only with safe argv, cancellation, and timeout", async () => {
	const { tool, calls } = setup();
	const controller = new AbortController();
	await tool.execute("id", { action: "add", group: "Paperwork; echo bad", email: "x@example.com" }, controller.signal);
	assert.equal(calls[0][0], "python3");
	assert.match(calls[0][1][0], /contact-groups\.py$/);
	assert.deepEqual(calls[0][1].slice(1), ["add", "--group", "Paperwork; echo bad", "--email", "x@example.com"]);
	assert.deepEqual(calls[0][2], { signal: controller.signal, timeout: 120_000 });
});

test("only literal apply=true requests a write", async () => {
	const first = setup();
	await first.tool.execute("id", { action: "remove", group: "g", contactUid: "u" }, undefined);
	assert.equal(first.calls[0][1].includes("--apply"), false);

	const second = setup();
	await second.tool.execute("id", { action: "remove", group: "g", contactUid: "u", apply: true }, undefined);
	assert.deepEqual(second.calls[0][1].slice(1), ["remove", "--group", "g", "--contact-uid", "u", "--apply"]);
});

test("returns structured helper details and warns when model output is truncated", async () => {
	const result = { summary: "Preview", applied: false, groups: [{ name: "Paperwork" }] };
	const { tool } = setup({
		response: { code: 0, stdout: JSON.stringify(result) },
		truncateHead: content => ({ content: content.slice(0, 12), truncated: true }),
	});
	const output = await tool.execute("id", { action: "list" }, undefined);
	assert.deepEqual(output.details, result);
	assert.match(output.content[0].text, /Output truncated; query one group\/contact for details/);
});

test("surfaces sanitized helper errors without echoing stderr", async () => {
	const { tool } = setup({ response: { code: 1, stdout: JSON.stringify({ error: "CardDAV conflict (412)" }), stderr: "private server detail" } });
	await assert.rejects(tool.execute("id", { action: "list" }, undefined), error => {
		assert.match(error.message, /CardDAV conflict/);
		assert.doesNotMatch(error.message, /private server detail/);
		return true;
	});
});

test("malformed subprocess output is never echoed", async () => {
	const { tool } = setup({ response: { code: 1, stdout: "SECRET", stderr: "SECRET" } });
	await assert.rejects(tool.execute("id", { action: "list" }, undefined), error => {
		assert.doesNotMatch(error.message, /SECRET/);
		assert.match(error.message, /re-read group state/);
		return true;
	});
});
