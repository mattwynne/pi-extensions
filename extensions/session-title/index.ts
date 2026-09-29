import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function rightOverlayBoxOnBorder(
	name: string,
	width: number,
	border: (text: string) => string,
	box: (text: string) => string,
): string {
	if (width <= 0) return "";
	if (!name.trim()) return border("─".repeat(width));

	const trailingRuleWidth = Math.min(5, Math.max(0, width - 1));
	const maxBoxWidth = Math.max(1, width - trailingRuleWidth);
	const labelText =
		maxBoxWidth >= 3
			? ` ${truncateToWidth(name.trim(), maxBoxWidth - 2)} `
			: truncateToWidth(name.trim(), maxBoxWidth);
	const labelWidth = visibleWidth(labelText);
	const prefixWidth = Math.max(0, width - labelWidth - trailingRuleWidth);
	const suffixWidth = Math.max(0, width - prefixWidth - labelWidth);

	return border("─".repeat(prefixWidth)) + box(labelText) + border("─".repeat(suffixWidth));
}

export default function sessionTitleExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Clear the earlier widget-based version, if it was loaded before this revision.
		ctx.ui.setWidget("session-title", undefined);

		class SessionTitleEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				if (lines.length === 0) return lines;

				const name = pi.getSessionName() ?? "";
				lines[0] = rightOverlayBoxOnBorder(
					name,
					width,
					(text) => this.borderColor(text),
					(text) => ctx.ui.theme.inverse(this.borderColor(text)),
				);
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SessionTitleEditor(tui, theme, keybindings));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent(undefined);
	});
}
