import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

function setup(mode = "tui") {
	const source = readFileSync(new URL("../extensions/last-prompt.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	const events = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const widgets = [];
	const notifications = [];
	const backgrounds = [];
	let branch = [];
	let colour = "";
	let truncations = 0;
	// ASCII layout substitutes; real Pi utilities are exercised in the runtime smoke test.
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nlastPromptExtension`, {
		Key: { ctrlAlt: (key) => `ctrl+alt+${key}` },
		stripTerminalSequences: (text) => text.replace(/\x1b\[[0-9;]*m/g, ""),
		visibleWidth: (text) => text.length,
		truncateToWidth: (text, width, ellipsis = "…") => {
			truncations += 1;
			return text.length <= width ? text
				: text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis.slice(0, width);
		},
	});
	extension({
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
	});
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: {
				fg: (_token, text) => colour + text,
				bg: (token, text) => { backgrounds.push({ token, text }); return text; },
			},
			setWidget: (key, value) => widgets.push({ key, value }),
			editor: () => assert.fail("The prompt box must never open an editable viewer"),
			notify: (...args) => notifications.push(args),
		},
	};
	return {
		widgets, notifications, backgrounds,
		emit: (name, event = {}) => events.get(name)(event, ctx),
		prompt: (content, role = "user") => events.get("message_start")({ message: { role, content } }, ctx),
		command: () => commands.get("last-prompt").handler("", ctx),
		toggle: () => shortcuts.get("ctrl+alt+p").handler(ctx),
		branch: (entries) => { branch = entries; },
		colour: (value) => { colour = value; },
		component: () => widgets.at(-1).value(),
		truncations: () => truncations,
	};
}

const user = (content) => ({ type: "message", message: { role: "user", content } });

test("pins a shaded prompt with top and side edges but no bottom border", () => {
	const fixture = setup();
	fixture.emit("session_start");
	assert.equal(fixture.widgets.at(-1).value, undefined);
	fixture.prompt("Fix the tests");
	assert.equal(fixture.widgets.at(-1).key, "last-prompt");
	const lines = fixture.component().render(60);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^┌ Latest prompt · Ctrl\+Alt\+P .*┐$/);
	assert.match(lines[1], /^│ Fix the tests +│$/);
	assert.ok(lines.every((line) => !/[└┘]/.test(line)));
	assert.ok(lines.every((line) => line.length === 60));
	assert.deepEqual(fixture.backgrounds, Array.from(lines, (text) => ({ token: "toolPendingBg", text })));
	fixture.prompt("Thinking...", "assistant");
	fixture.prompt("tool output", "toolResult");
	assert.match(fixture.component().render(60)[1], /Fix the tests/);
	assert.equal(fixture.widgets.length, 2);
});

test("the shortcut hides and shows the box without losing incoming prompts", () => {
	const fixture = setup();
	fixture.prompt("First task");
	fixture.toggle();
	assert.equal(fixture.widgets.at(-1).value, undefined);
	fixture.prompt("Actually, stop after the tests");
	assert.equal(fixture.widgets.at(-1).value, undefined, "new messages must not reopen a hidden box");
	fixture.toggle();
	assert.match(fixture.component().render(80)[1], /Actually, stop after the tests/);
});

test("/last-prompt toggles the same box and never opens an editor", async () => {
	const fixture = setup();
	fixture.prompt("Task");
	await fixture.command();
	assert.equal(fixture.widgets.at(-1).value, undefined);
	fixture.toggle();
	assert.match(fixture.component().render(80)[1], /Task/);
	await fixture.command();
	assert.equal(fixture.widgets.at(-1).value, undefined);
});

test("restores the latest user message on the active branch without changing visibility", () => {
	const fixture = setup();
	fixture.branch([
		user("Old task"),
		{ type: "custom", data: "not a prompt" },
		user([{ type: "text", text: "Current task" }]),
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "compaction", summary: "Earlier work" },
	]);
	fixture.emit("session_start");
	assert.match(fixture.component().render(80)[1], /Current task/);
	fixture.toggle();
	fixture.branch([user("Other branch")]);
	fixture.emit("session_tree");
	assert.equal(fixture.widgets.at(-1).value, undefined);
	fixture.toggle();
	assert.match(fixture.component().render(80)[1], /Other branch/);
	fixture.branch([]);
	fixture.emit("session_tree");
	assert.equal(fixture.widgets.at(-1).value, undefined);
});

test("empty sessions and shutdown clear the widget", async () => {
	const fixture = setup();
	fixture.prompt("Private task from another session");
	fixture.emit("session_start", { reason: "new" });
	assert.equal(fixture.widgets.at(-1).value, undefined);
	await fixture.command();
	assert.match(fixture.notifications[0][0], /No prompt/);
	fixture.prompt("New task");
	fixture.emit("session_shutdown");
	assert.equal(fixture.widgets.at(-1).value, undefined);
});

test("truncates instead of wrapping and fits narrow terminals", () => {
	const fixture = setup();
	fixture.prompt("abcdefghijklmnopqrstuvwxyz");
	const component = fixture.component();
	assert.match(component.render(80)[1], /abcdefghijklmnopqrstuvwxyz/);
	assert.equal(component.render(10)[1], "│ abcde… │");
	for (const width of [1, 2, 3, 4, 5, 10, 80]) {
		const lines = component.render(width);
		assert.equal(lines.length, width < 5 ? 1 : 2);
		assert.ok(lines.every((line) => line.length <= width));
	}
	assert.deepEqual(Array.from(component.render(0)), []);
});

test("shading covers the whole row even on narrow terminals", () => {
	const fixture = setup();
	fixture.prompt("x");
	const component = fixture.component();
	for (const width of [1, 2, 3, 4, 5, 40]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => line.length === width));
		assert.ok(fixture.backgrounds.slice(-lines.length).every(({ token, text }) =>
			token === "toolPendingBg" && text.length === width));
	}
});

test("caches truncation across redraws and refreshes on resize and theme changes", () => {
	const fixture = setup();
	fixture.prompt("Prompt");
	const component = fixture.component();
	component.render(80);
	const initial = fixture.truncations();
	component.render(80);
	assert.equal(fixture.truncations(), initial);
	component.render(40);
	assert.ok(fixture.truncations() > initial);
	const resized = fixture.truncations();
	fixture.colour("new-theme:");
	component.invalidate();
	assert.match(component.render(40)[1], /new-theme:Prompt/);
	assert.ok(fixture.truncations() > resized);
});

test("flattens multiline prompts and shows image placeholders without their data", () => {
	const fixture = setup();
	fixture.prompt([
		{ type: "text", text: "Inspect this\nimage" },
		{ type: "image", data: "private", mimeType: "image/png" },
	]);
	assert.match(fixture.component().render(80)[1], /^│ Inspect this image \[Image\] +│$/);
	fixture.prompt([{ type: "image", data: "private" }]);
	assert.match(fixture.component().render(80)[1], /\[Image\]/);
	for (const empty of ["", [], " \n\t "]) {
		fixture.prompt(empty);
		assert.match(fixture.component().render(80)[1], /\[Empty prompt\]/);
	}
});

test("removes terminal sequences and collapses whitespace", () => {
	const fixture = setup();
	fixture.prompt("\x1b[31mred\x1b[0m\ttext\r\nnext line");
	assert.match(fixture.component().render(80)[1], /^│ red text next line +│$/);
});

test("terminal-only functionality is disabled in RPC, JSON, and print modes", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const fixture = setup(mode);
		fixture.branch([user("Existing prompt")]);
		fixture.emit("session_start");
		fixture.prompt("New prompt");
		fixture.emit("session_tree");
		fixture.toggle();
		await fixture.command();
		fixture.emit("session_shutdown");
		assert.equal(fixture.widgets.length, 0, mode);
		assert.equal(fixture.notifications.length, 0, mode);
	}
});
