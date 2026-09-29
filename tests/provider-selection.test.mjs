import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

function setup() {
	const source = readFileSync(new URL("../extensions/provider-selection.ts", import.meta.url), "utf8")
		.replace(/^import .*;\n/gm, "")
		.replace("export default function", "function");
	const providers = ["google", "anthropic", "opencode", "openai", "openai-codex", "openrouter"].map((id) => ({
		id,
		name: id,
		auth: { apiKey: { resolve: async () => ({ auth: { apiKey: "tool-key" } }) } },
		getModels: () => [{ id: "example", provider: id }],
		refreshModels: async () => {},
		stream() {},
		streamSimple() {},
	}));
	const registered = new Map();
	const extension = runInNewContext(`${stripTypeScriptTypes(source)}\nproviderSelectionExtension`, {
		builtinProviders: () => providers,
	});
	extension({ registerProvider: (provider) => registered.set(provider.id, provider) });
	return { providers, registered };
}

test("hides direct providers but leaves Codex, OpenRouter and the Claude Code wrapper untouched", () => {
	const { registered } = setup();
	assert.deepEqual([...registered.keys()], ["google", "anthropic", "opencode", "openai"]);
	assert.ok(!registered.has("pi-claude-code-provider"));
	for (const provider of registered.values()) {
		assert.equal(provider.filterModels(provider.getModels(), undefined).length, 0);
		assert.equal(provider.filterModels(provider.getModels(), { type: "api_key", key: "example" }).length, 0);
	}
});

test("preserves catalogs, credentials, refresh and streams for tools", async () => {
	const { providers, registered } = setup();
	for (const original of providers.filter((provider) => registered.has(provider.id))) {
		const filtered = registered.get(original.id);
		assert.equal(filtered.auth, original.auth);
		assert.equal(filtered.getModels, original.getModels);
		assert.equal(filtered.refreshModels, original.refreshModels);
		assert.equal(filtered.stream, original.stream);
		assert.equal(filtered.streamSimple, original.streamSimple);
		assert.equal((await filtered.auth.apiKey.resolve()).auth.apiKey, "tool-key");
	}
});
