import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

function loadQuestionTool() {
	const source = readFileSync(new URL("../extensions/question.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	let tool;
	const Type = new Proxy({}, {
		get: () => (...args) => ({ args }),
	});
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nquestion`, {
		Type,
		Editor: class {},
		Key: {},
		matchesKey: () => false,
		Text: class {},
		truncateToWidth: (text) => text,
	});
	extension({ registerTool: (registered) => { tool = registered; } });
	return tool;
}

function loadSessionTitleHandlers() {
	const source = readFileSync(new URL("../extensions/session-title/index.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	const handlers = new Map();
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nsessionTitleExtension`, {
		CustomEditor: class {},
		truncateToWidth: (text) => text,
		visibleWidth: (text) => text.length,
	});
	extension({
		on: (event, handler) => handlers.set(event, handler),
		getSessionName: () => "Example",
	});
	return handlers;
}

test("question custom UI is restricted to TUI mode", async () => {
	const tool = loadQuestionTool();
	for (const mode of ["rpc", "json", "print"]) {
		let customCalls = 0;
		const result = await tool.execute("call", {
			question: "Choose",
			options: [{ label: "One" }],
		}, undefined, undefined, {
			mode,
			hasUI: mode === "rpc",
			ui: { custom: async () => { customCalls += 1; } },
		});
		assert.equal(customCalls, 0, `${mode} must not open a terminal component`);
		assert.match(result.content[0].text, /TUI mode/);
		assert.equal(result.details.answer, null);
	}
});

test("session title editor is installed and removed only in TUI mode", () => {
	const handlers = loadSessionTitleHandlers();
	for (const mode of ["rpc", "json", "print"]) {
		const calls = [];
		const ctx = {
			mode,
			hasUI: mode === "rpc",
			ui: {
				setWidget: (...args) => calls.push(["widget", ...args]),
				setEditorComponent: (...args) => calls.push(["editor", ...args]),
			},
		};
		handlers.get("session_start")({}, ctx);
		handlers.get("session_shutdown")({}, ctx);
		assert.deepEqual(calls, [], `${mode} must not change terminal components`);
	}

	const calls = [];
	const tui = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget: (...args) => calls.push(["widget", ...args]),
			setEditorComponent: (...args) => calls.push(["editor", ...args]),
		},
	};
	handlers.get("session_start")({}, tui);
	handlers.get("session_shutdown")({}, tui);
	assert.equal(calls[0][0], "widget");
	assert.equal(calls[1][0], "editor");
	assert.equal(typeof calls[1][1], "function");
	assert.deepEqual(calls[2], ["editor", undefined]);
});
