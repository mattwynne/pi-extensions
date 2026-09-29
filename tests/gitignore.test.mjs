import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function isIgnored(path) {
	const result = spawnSync(
		"git",
		["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", "--", path],
		{ cwd: repositoryRoot, encoding: "utf8" },
	);
	assert.ok([0, 1].includes(result.status), result.stderr);
	return result.status === 0;
}

test("ignores representative local secrets and generated state", () => {
	for (const path of [
		".env",
		".env.local",
		"oauth-client.json",
		"config/client_secret_123.apps.googleusercontent.com.json",
		"tokens/account.json",
		".tokens/account.json",
		"auth-url.txt",
		"debug.log",
		"npm-debug.log.1",
		"private-key.pem",
		"signing.key",
		"certificate.p12",
		"certificate.pfx",
		"id_ed25519",
		".local/session.json",
		".worktrees/release/HEAD",
		".yaks/task/.state",
	]) {
		assert.equal(isIgnored(path), true, `${path} should be ignored`);
	}
});

test("keeps explicit example fixtures visible to Git", () => {
	for (const path of [
		".env.example",
		".env.test.example",
		"oauth-client.json.example",
		"config/client_secret.example.json",
		"private-key.pem.example",
	]) {
		assert.equal(isIgnored(path), false, `${path} should remain trackable`);
	}
});
