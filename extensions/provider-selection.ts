import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Keep the picker independent of API keys inherited from shells/projects.
// Claude Code is an extension provider, so it is not in builtinProviders().
const SELECTABLE_PROVIDERS = new Set(["pi-claude-code-provider", "openai-codex", "openrouter"]);

export default function providerSelectionExtension(pi: ExtensionAPI) {
	for (const provider of builtinProviders()) {
		if (SELECTABLE_PROVIDERS.has(provider.id)) continue;
		pi.registerProvider({
			...provider,
			// Filter availability, not the catalog or auth: tools may still need
			// direct provider credentials (for example Gemini web search).
			filterModels: () => [],
		});
	}
}
