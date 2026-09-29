import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the registered command and lifecycle hooks without loading Pi or calling a provider.
function setup(
	model,
	auth = { ok: true, apiKey: "test-key" },
	generatedTitle = "🛠️ Fix session naming",
	env = {},
	initialPrompt = "Fix session naming",
) {
	const source = readFileSync(new URL("../extensions/auto-session-name.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	const calls = [];
	const errors = [];
	const names = [];
	const titles = [];
	const commands = new Map();
	const events = new Map();
	const intervals = [];
	let sessionName;
	let branch = [{ id: "user-1", type: "message", message: { role: "user", content: initialPrompt } }];
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nautoSessionNameExtension`, {
		basename: (path) => path.split("/").filter(Boolean).at(-1) ?? "",
		complete: async (...args) => {
			calls.push(args);
			return { stopReason: "stop", content: [{ type: "text", text: generatedTitle }] };
		},
		setTimeout,
		clearTimeout,
		setInterval: (callback, delay) => {
			intervals.push({ callback, delay });
			return intervals.length;
		},
		clearInterval() {},
		process: { env },
	});
	extension({
		registerMessageRenderer() {},
		registerCommand: (name, command) => commands.set(name, command),
		on: (event, handler) => events.set(event, handler),
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
		sendMessage: (message) => errors.push(message.content),
		setSessionName: (name) => {
			sessionName = name;
			names.push(name);
		},
		getSessionName: () => sessionName,
	});
	const ctx = {
		model,
		modelRegistry: {
			find: () => {
				assert.fail("naming must not select a hard-coded catalogue model");
			},
			getApiKeyAndHeaders: async (selected) => {
				assert.equal(selected, model);
				return auth;
			},
		},
		sessionManager: { getBranch: () => branch },
		isIdle: () => true,
		hasPendingMessages: () => false,
		cwd: "/workspace/pi-extensions",
		ui: {
			notify() {},
			setTitle: (title) => titles.push(title),
		},
	};
	return {
		calls,
		errors,
		names,
		titles,
		run: () => commands.get("auto-name-session").handler("", ctx),
		start: () => events.get("session_start")({ reason: "startup" }, ctx),
		nameInitialPrompt: () => events.get("message_end")({ message: { role: "user", content: initialPrompt } }, ctx),
		addAssistantMessage: (content) => branch.push({ id: `assistant-${branch.length}`, type: "message", message: { role: "assistant", content } }),
		intervals,
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("names the session with its selected model and resolved auth", async () => {
	const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const headers = { "x-test": "header" };
	const fixture = setup(model, { ok: true, apiKey: "test-key", headers });
	await fixture.run();
	assert.equal(fixture.calls.length, 1);
	assert.equal(fixture.calls[0][0], model);
	assert.equal(fixture.calls[0][2].apiKey, "test-key");
	assert.equal(fixture.calls[0][2].headers, headers);
	assert.deepEqual(fixture.names, ["🛠️ Fix session naming"]);
	assert.deepEqual(fixture.titles, ["🛠️ Fix session naming - pi-extensions"]);
	assert.deepEqual(fixture.errors, []);
	assert.equal(fixture.calls[0][2].reasoning, "off");
	assert.ok(!("reasoningEffort" in fixture.calls[0][2]));
	assert.equal(fixture.calls[0][2].timeoutMs, 20_000);
	assert.equal(fixture.calls[0][2].maxRetries, 2);
	assert.ok(fixture.calls[0][2].maxTokens >= 256);
	assert.match(fixture.calls[0][1].messages[0].content[0].text, /Start with exactly one emoji/);
});

test("initial naming remains enabled by default", async () => {
	const fixture = setup({ provider: "openai-codex", id: "gpt-5.6-sol" });
	fixture.nameInitialPrompt();
	await flush();
	assert.equal(fixture.calls.length, 1);
	assert.deepEqual(fixture.names, ["🛠️ Fix session naming"]);
});

test("periodically renames only after the session has changed", async () => {
	const fixture = setup(
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		undefined,
		undefined,
		{ PI_AUTO_SESSION_NAME_PERIODIC: "1" },
	);
	await fixture.run();
	fixture.start();
	assert.equal(fixture.intervals.length, 1);
	assert.equal(fixture.intervals[0].delay, 5 * 60 * 1_000);

	fixture.intervals[0].callback();
	await flush();
	assert.equal(fixture.calls.length, 1, "unchanged sessions must not call the naming model");

	fixture.addAssistantMessage("I updated the extension.");
	fixture.intervals[0].callback();
	await flush();
	assert.equal(fixture.calls.length, 2);
	assert.deepEqual(fixture.names, ["🛠️ Fix session naming", "🛠️ Fix session naming"]);

	fixture.intervals[0].callback();
	await flush();
	assert.equal(fixture.calls.length, 2, "the same session revision must not be renamed twice");
});

test("does not schedule periodic renaming by default", () => {
	const fixture = setup({ provider: "openai-codex", id: "gpt-5.6-sol" });
	fixture.start();
	assert.equal(fixture.intervals.length, 0);
});

test("caps session material sent by initial and later naming requests", async () => {
	const longPrompt = `private beginning ${"x".repeat(7_000)}`;
	const fixture = setup(
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		undefined,
		undefined,
		{},
		longPrompt,
	);

	fixture.nameInitialPrompt();
	await flush();
	await fixture.run();

	assert.equal(fixture.calls.length, 2);
	for (const call of fixture.calls) {
		const request = call[1].messages[0].content[0].text;
		assert.ok(request.length <= 6_400, `naming prompt was ${request.length} characters`);
		assert.doesNotMatch(request, /private beginning/);
	}
});

test("adds a fallback emoji when the naming model omits one", async () => {
	const fixture = setup({ provider: "openai-codex", id: "gpt-5.6-sol" }, undefined, "Fix session naming");
	await fixture.run();
	assert.deepEqual(fixture.names, ["📝 Fix session naming"]);
});

test("reports a missing selected model without calling a provider", async () => {
	const fixture = setup(undefined);
	await fixture.run();
	assert.equal(fixture.calls.length, 0);
	assert.match(fixture.errors[0], /no session model selected/);
});

test("reports authentication failure without calling a provider", async () => {
	const fixture = setup({ provider: "openai-codex", id: "gpt-5.6-sol" }, { ok: false, error: "not logged in" });
	await fixture.run();
	assert.equal(fixture.calls.length, 0);
	assert.match(fixture.errors[0], /openai-codex\/gpt-5.6-sol: not logged in/);
});
