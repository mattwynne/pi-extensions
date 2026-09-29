import type { ContextUsage, ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-window-progress";
const BAR_WIDTH = 12;

function colorForPercent(percent: number): ThemeColor {
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  if (percent >= 50) return "accent";
  return "success";
}

function contextBar(usage: ContextUsage, ctx: ExtensionContext): string {
  if (usage.percent == null) {
    return `ctx [${ctx.ui.theme.fg("dim", "????????????")}]`;
  }

  const percent = Math.max(0, Math.min(100, Math.round(usage.percent)));
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const filledBar = ctx.ui.theme.fg(colorForPercent(percent), "█".repeat(filled));
  const emptyBar = ctx.ui.theme.fg("dim", "░".repeat(empty));

  return `ctx [${filledBar}${emptyBar}]`;
}

function update(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const usage = ctx.getContextUsage();
  if (!usage) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, contextBar(usage, ctx));
}

export default function contextWindowProgress(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => update(ctx));
  pi.on("model_select", (_event, ctx) => update(ctx));
  pi.on("before_agent_start", (_event, ctx) => update(ctx));
  pi.on("turn_end", (_event, ctx) => update(ctx));
  pi.on("message_end", (_event, ctx) => update(ctx));
  pi.on("session_compact", (_event, ctx) => update(ctx));
  pi.on("agent_end", (_event, ctx) => update(ctx));

  pi.registerCommand("context-bar", {
    description: "Refresh the context window progress bar in the footer",
    handler: async (_args, ctx) => update(ctx),
  });
}
