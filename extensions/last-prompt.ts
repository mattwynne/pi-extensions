import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "last-prompt";

function promptText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content || "[Empty prompt]";
	return content.map((block) => block.type === "text" ? block.text : "[Image]").join("\n") || "[Empty prompt]";
}

export default function lastPromptExtension(pi: ExtensionAPI) {
	let lastPrompt: string | undefined;
	let visible = true;

	function updateWidget(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (!visible || lastPrompt === undefined) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const preview = stripTerminalSequences(lastPrompt).replace(/\s+/g, " ").trim() || "[Empty prompt]";
		ctx.ui.setWidget(WIDGET_KEY, () => {
			let cachedWidth = -1;
			let title = "";
			let text = "";
			let padding = "";
			return {
				render(width: number) {
					if (width <= 0) return [];
					const theme = ctx.ui.theme;
					if (width < 5) return [theme.fg("text", truncateToWidth(preview, width))];
					// Spinner redraws should not repeatedly truncate a potentially long prompt.
					if (width !== cachedWidth) {
						title = truncateToWidth(" Latest prompt · Ctrl+Alt+P ", width - 2, "");
						text = truncateToWidth(preview, width - 4);
						padding = " ".repeat(width - 4 - visibleWidth(text));
						cachedWidth = width;
					}
					return [
						theme.fg("muted", "┌" + title + "─".repeat(width - 2 - visibleWidth(title)) + "┐"),
						theme.fg("muted", "│ ") + theme.fg("text", text) + padding + theme.fg("muted", " │"),
						theme.fg("muted", "└" + "─".repeat(width - 2) + "┘"),
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

	function toggle(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (lastPrompt === undefined) {
			ctx.ui.notify("No prompt in this branch yet.", "info");
			return;
		}
		visible = !visible;
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

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Hide or show the latest-prompt box",
		handler: toggle,
	});
	pi.registerCommand("last-prompt", {
		description: "Hide or show the latest-prompt box",
		handler: async (_args, ctx) => toggle(ctx),
	});
}
