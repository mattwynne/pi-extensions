import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

function setup(mode = "tui", wrap) {
	const source = readFileSync(new URL("../extensions/last-prompt.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	const events = new Map();
	const commands = new Map();
	const widgets = [];
	const viewers = [];
	const notifications = [];
	let branch = [];
	let colour = "";
	// Simple ASCII layout substitutes; real Pi utilities are exercised in the runtime smoke test.
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nlastPromptExtension`, {
		stripTerminalSequences: (text) => text.replace(/\x1b\[[0-9;]*m/g, ""),
		truncateToWidth: (text, width, ellipsis = "…") => text.length <= width ? text
			: text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis.slice(0, width),
		wrapTextWithAnsi: wrap ?? ((text, width) => text.split("\n").flatMap((line) => {
			const lines = [];
			for (let i = 0; i < line.length; i += width) lines.push(line.slice(i, i + width));
			return lines.length ? lines : [""];
		})),
	});
	extension({
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_token, text) => colour + text },
			setWidget: (key, value) => widgets.push({ key, value }),
			editor: async (...args) => { viewers.push(args); return "Discard these edits"; },
			notify: (...args) => notifications.push(args),
		},
	};
	return {
		widgets, viewers, notifications,
		emit: (name, event = {}) => events.get(name)(event, ctx),
		prompt: (content, role = "user") => events.get("message_start")({ message: { role, content } }, ctx),
		view: () => commands.get("last-prompt").handler("", ctx),
		branch: (entries) => { branch = entries; },
		colour: (value) => { colour = value; },
		component: () => widgets.at(-1).value(),
	};
}

const user = (content) => ({ type: "message", message: { role: "user", content } });

test("pins a prompt above the editor and leaves it visible after the response", () => {
	const fixture = setup();
	fixture.emit("session_start");
	assert.equal(fixture.widgets.at(-1).value, undefined);
	fixture.prompt("Fix the tests");
	assert.equal(fixture.widgets.at(-1).key, "last-prompt");
	assert.deepEqual(Array.from(fixture.component().render(80)), [
		"Latest prompt · /last-prompt for full text", "Fix the tests",
	]);
	fixture.prompt("Thinking...", "assistant");
	fixture.prompt("tool output", "toolResult");
	assert.equal(fixture.component().render(80)[1], "Fix the tests");
	assert.equal(fixture.widgets.length, 2, "non-user messages must not recreate the widget");
});

test("updates for each dispatched user message, including steering", () => {
	const fixture = setup();
	fixture.prompt("First task");
	fixture.prompt("Actually, stop after the tests");
	assert.equal(fixture.component().render(80)[1], "Actually, stop after the tests");
});

test("restores only the latest user message on the active branch", () => {
	const fixture = setup();
	fixture.branch([
		user("Old task"),
		{ type: "custom", data: "not a prompt" },
		user([{ type: "text", text: "Current task" }]),
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "compaction", summary: "Earlier work" },
	]);
	fixture.emit("session_start");
	assert.equal(fixture.component().render(80)[1], "Current task");
	fixture.branch([user("Other branch")]);
	fixture.emit("session_tree");
	assert.equal(fixture.component().render(80)[1], "Other branch");
	fixture.branch([]);
	fixture.emit("session_tree");
	assert.equal(fixture.widgets.at(-1).value, undefined);
});

test("switching sessions clears the previous prompt and shutdown removes the widget", async () => {
	const fixture = setup();
	fixture.prompt("Private task from another session");
	fixture.emit("session_start", { reason: "new" });
	assert.equal(fixture.widgets.at(-1).value, undefined);
	await fixture.view();
	assert.equal(fixture.viewers.length, 0);
	assert.match(fixture.notifications[0][0], /No prompt/);
	fixture.prompt("New task");
	fixture.emit("session_shutdown");
	assert.equal(fixture.widgets.at(-1).value, undefined);
});

test("caps the preview at three wrapped lines and responds to resize and theme changes", () => {
	const fixture = setup();
	fixture.prompt("abcdefghijklmnopqrstuvwxyz");
	const component = fixture.component();
	assert.equal(component.render(80).length, 2);
	const narrow = component.render(5);
	assert.equal(narrow.length, 4);
	assert.equal(narrow.at(-1), "klmn…");
	assert.ok(narrow.every((line) => line.length <= 5));
	assert.equal(component.render(1).at(-1), "…");
	assert.deepEqual(Array.from(component.render(0)), []);
	fixture.colour("new-theme:");
	component.invalidate();
	assert.equal(component.render(80)[1], "new-theme:abcdefghijklmnopqrstuvwxyz");
});

test("clips wrapped lines that exceed the available width", () => {
	// Pi's wrapper can return a two-column grapheme for a one-column viewport.
	const fixture = setup("tui", () => ["overflow"]);
	fixture.prompt("Prompt");
	const lines = fixture.component().render(1);
	assert.ok(lines.every((line) => line.length <= 1));
	assert.equal(lines[1], "…");
});

test("caches wrapping across redraws and recomputes on resize or invalidation", () => {
	let wraps = 0;
	const fixture = setup("tui", () => { wraps += 1; return ["Prompt"]; });
	fixture.prompt("Prompt");
	const component = fixture.component();
	component.render(80);
	component.render(80);
	assert.equal(wraps, 1);
	component.render(40);
	assert.equal(wraps, 2);
	component.invalidate();
	component.render(40);
	assert.equal(wraps, 3);
});

test("preserves multiline text, shows images, and handles empty prompts", () => {
	const fixture = setup();
	fixture.prompt([
		{ type: "text", text: "Inspect this\nimage" },
		{ type: "image", data: "binary data must not be displayed", mimeType: "image/png" },
	]);
	assert.deepEqual(Array.from(fixture.component().render(80)).slice(1), ["Inspect this", "image", "[Image]"]);
	fixture.prompt([{ type: "image", data: "private" }]);
	assert.equal(fixture.component().render(80)[1], "[Image]");
	for (const empty of ["", []]) {
		fixture.prompt(empty);
		assert.equal(fixture.component().render(80)[1], "[Empty prompt]");
	}
});

test("removes terminal sequences from the preview and expands tabs", () => {
	const fixture = setup();
	fixture.prompt("\x1b[31mred\x1b[0m\ttext\r\nnext line");
	assert.deepEqual(Array.from(fixture.component().render(80)).slice(1), ["red    text", "next line"]);
});

test("the full viewer receives the untruncated prompt and discards edits", async () => {
	const fixture = setup();
	const prompt = "full prompt\n".repeat(100);
	fixture.prompt(prompt);
	assert.equal(fixture.component().render(80).length, 4);
	await fixture.view();
	await fixture.view();
	assert.equal(fixture.viewers[0][1], prompt);
	assert.equal(fixture.viewers[1][1], prompt);
	assert.equal(fixture.widgets.length, 1, "viewing must not change the pinned prompt");
});

test("terminal-only functionality is disabled in RPC, JSON, and print modes", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const fixture = setup(mode);
		fixture.branch([user("Existing prompt")]);
		fixture.emit("session_start");
		fixture.prompt("New prompt");
		fixture.emit("session_tree");
		fixture.emit("session_shutdown");
		await fixture.view();
		assert.equal(fixture.widgets.length, 0, mode);
		assert.equal(fixture.viewers.length, 0, mode);
	}
});
