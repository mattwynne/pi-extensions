import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_KEY = "last-prompt";
const PREVIEW_LINES = 3;

function promptText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content || "[Empty prompt]";
	return content.map((block) => block.type === "text" ? block.text : "[Image]").join("\n") || "[Empty prompt]";
}

export default function lastPromptExtension(pi: ExtensionAPI) {
	let lastPrompt: string | undefined;

	function updateWidget(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (lastPrompt === undefined) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		// Keep terminal control sequences out of the display; retain the original for the viewer.
		const preview = stripTerminalSequences(lastPrompt).replace(/\t/g, "    ").replace(/\r/g, "");
		ctx.ui.setWidget(WIDGET_KEY, () => {
			let cachedWidth = -1;
			let visible: string[] = [];
			return {
				render(width: number) {
					if (width <= 0) return [];
					const theme = ctx.ui.theme;
					// Spinner redraws should not rewrap a potentially long prompt.
					if (width !== cachedWidth) {
						const lines = wrapTextWithAnsi(preview, width);
						visible = lines.slice(0, PREVIEW_LINES);
						if (lines.length > PREVIEW_LINES) {
							visible[PREVIEW_LINES - 1] = truncateToWidth(visible[PREVIEW_LINES - 1], width - 1, "") + "…";
						}
						cachedWidth = width;
					}
					return [
						theme.fg("muted", truncateToWidth("Latest prompt · /last-prompt for full text", width)),
						// A wide grapheme may exceed a one-column wrap width; clip it before rendering.
						...visible.map((line) => theme.fg("text", truncateToWidth(line, width))),
					];
				},
				invalidate() { cachedWidth = -1; },
			};
		});
	}

	function restorePrompt(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		lastPrompt = undefined;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "user") {
				lastPrompt = promptText(entry.message.content);
				break;
			}
		}
		updateWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => restorePrompt(ctx));
	pi.on("session_tree", (_event, ctx) => restorePrompt(ctx));
	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "user") return;
		lastPrompt = promptText(event.message.content);
		updateWidget(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("last-prompt", {
		description: "Read the latest prompt in full (changes in the viewer are discarded)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("The prompt viewer requires Pi's terminal interface.", "info");
				return;
			}
			if (lastPrompt === undefined) {
				ctx.ui.notify("No prompt in this branch yet.", "info");
				return;
			}
			// Use Pi's scrollable editor as a viewer. Never submit or save its return value.
			await ctx.ui.editor("Latest prompt — close to return; edits are discarded", lastPrompt);
		},
	});
}
