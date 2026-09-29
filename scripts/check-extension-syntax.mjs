import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionsRoot = join(repositoryRoot, "extensions");

function typescriptFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.name !== "node_modules")
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return typescriptFiles(path);
			return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
		});
}

const files = typescriptFiles(extensionsRoot).sort();
if (files.length === 0) {
	throw new Error("No extension TypeScript files found");
}

for (const file of files) {
	const result = spawnSync(process.execPath, ["--check", file], { cwd: repositoryRoot, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Checked TypeScript syntax for ${files.length} extension files.`);
