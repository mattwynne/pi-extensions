import { complete, type Model } from "@earendil-works/pi-ai";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "auto-session-name";
const DRAFT_ENTRY_TYPE = "auto-session-name-draft";
const FINAL_ENTRY_TYPE = "auto-session-name-final";
const PERIODIC_ENTRY_TYPE = "auto-session-name-periodic";
const STATE_ENTRY_TYPE = "auto-session-name-state";
const PERIODIC_RENAME_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_NAMING_CONTEXT_CHARS = 6_000;
const PERIODIC_RENAMING_ENABLED = process.env.PI_AUTO_SESSION_NAME_PERIODIC === "1";

type MessageEntry = {
	id?: string;
	type: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type NamingPhase = "draft" | "final" | "periodic";
type NameState = { title: string; snapshot: string; timestamp: number };

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n");
}

function getFirstUserPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch() as MessageEntry[]) {
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "user") continue;

		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}
}

function getSessionContext(ctx: ExtensionContext): string | undefined {
	const text = (ctx.sessionManager.getBranch() as MessageEntry[])
		.filter((entry) => entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant"))
		.map((entry) => {
			const text = extractText(entry.message?.content).trim();
			return text ? `${entry.message?.role}: ${text}` : "";
		})
		.filter(Boolean)
		.join("\n\n")
		.trim();

	if (!text) return undefined;
	return text.length > MAX_NAMING_CONTEXT_CHARS ? `…${text.slice(-MAX_NAMING_CONTEXT_CHARS)}` : text;
}

function hasCustomEntry(ctx: ExtensionContext, customType: string): boolean {
	return (ctx.sessionManager.getBranch() as MessageEntry[]).some(
		(entry) => entry.type === "custom" && entry.customType === customType,
	);
}

function isAutoNamingEntry(entry: MessageEntry): boolean {
	return entry.type === "custom" && [DRAFT_ENTRY_TYPE, FINAL_ENTRY_TYPE, PERIODIC_ENTRY_TYPE, STATE_ENTRY_TYPE].includes(entry.customType ?? "");
}

function getSessionSnapshot(ctx: ExtensionContext): string {
	return (ctx.sessionManager.getBranch() as MessageEntry[])
		.filter((entry) => !isAutoNamingEntry(entry) && entry.type !== "session_info" && entry.type !== "label")
		.map((entry) => entry.id ?? `${entry.type}:${entry.customType ?? ""}:${extractText(entry.message?.content)}`)
		.join("\n");
}

function getStoredNameState(ctx: ExtensionContext): NameState | undefined {
	for (const entry of [...(ctx.sessionManager.getBranch() as MessageEntry[])].reverse()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
		const state = entry.data as Partial<NameState>;
		if (typeof state.title === "string" && typeof state.snapshot === "string" && typeof state.timestamp === "number") {
			return state as NameState;
		}
	}
}

function cleanTitle(text: string): string {
	const title = text
		.trim()
		.replace(/^title:\s*/i, "")
		.replace(/^session name:\s*/i, "")
		.split(/\r?\n/)[0]
		.trim()
		.replace(/^['\"“”‘’]+|['\"“”‘’]+$/g, "")
		.replace(/[.。]+$/g, "")
		.slice(0, 80)
		.trim();

	if (!title) return "";
	// A model should choose a purpose-specific emoji. Keep a readable fallback if it does not.
	return /^\p{Extended_Pictographic}/u.test(title) ? title : `📝 ${title}`;
}

function titlePrompt(initialPrompt: string, sessionContext?: string): string {
	const lines = [
		"Name this Pi coding-agent session.",
		"Start with exactly one emoji that represents the session's main purpose, then a space and 3-7 words.",
		"Return only the session name, with no quotes, labels, markdown, or punctuation at the end.",
		"Prefer concrete verbs and nouns. Keep it short.",
	];
	const rawMaterial = sessionContext?.trim() || initialPrompt.trim();
	const material = rawMaterial.length > MAX_NAMING_CONTEXT_CHARS
		? `…${rawMaterial.slice(-MAX_NAMING_CONTEXT_CHARS)}`
		: rawMaterial;
	lines.push("", sessionContext?.trim() ? "Current session context:" : "Initial user prompt:", material);

	return lines.join("\n");
}

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && /extension ctx is stale/i.test(error.message);
}

function sendError(pi: ExtensionAPI, reason: string, isActive: () => boolean = () => true) {
	if (!isActive()) return;

	try {
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: `Auto session naming failed: ${reason}`,
				display: true,
				details: { level: "error", timestamp: Date.now() },
			},
			{ deliverAs: "nextTurn" },
		);
	} catch (error) {
		if (!isStaleContextError(error)) throw error;
	}
}

async function chooseModel(ctx: ExtensionContext): Promise<{ model: Model<any>; apiKey: string; headers?: Record<string, string> } | { error: string }> {
	// Catalogue presence does not guarantee access through a provider account.
	// Reuse the user-selected session model, whose availability they already chose.
	const model = ctx.model;
	if (!model) return { error: "no session model selected" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { error: `${model.provider}/${model.id}: ${auth.error}` };
	if (!auth.apiKey) return { error: `${model.provider}/${model.id}: no API key` };

	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

async function generateTitle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	phase: NamingPhase,
	initialPrompt: string,
	sessionContext: string | undefined,
	isActive: () => boolean,
): Promise<string | undefined> {
	if (!isActive()) return;
	pi.appendEntry(
		phase === "draft" ? DRAFT_ENTRY_TYPE : phase === "final" ? FINAL_ENTRY_TYPE : PERIODIC_ENTRY_TYPE,
		{ timestamp: Date.now() },
	);

	const choice = await chooseModel(ctx);
	if (!isActive()) return;
	if ("error" in choice) {
		sendError(pi, choice.error, isActive);
		return;
	}

	const response = await complete(
		choice.model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: titlePrompt(initialPrompt, sessionContext) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: choice.apiKey,
			headers: choice.headers,
			maxTokens: 256,
			// Naming is a background convenience; absorb transient provider/network failures before reporting one.
			timeoutMs: 20_000,
			maxRetries: 2,
			reasoning: "off",
		},
	);

	if (!isActive()) return;

	if (response.stopReason === "error") {
		sendError(pi, response.errorMessage ?? "model call failed", isActive);
		return;
	}

	const title = cleanTitle(
		response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(" "),
	);

	if (!title) {
		sendError(pi, "model returned an empty title", isActive);
		return;
	}

	return title;
}

export default function autoSessionNameExtension(pi: ExtensionAPI) {
	let draftInFlight = false;
	let finalInFlight = false;
	let finalQueued = false;
	let firstPrompt: string | undefined;
	let generatedName: string | undefined;
	let lastNamedSnapshot: string | undefined;
	let active = true;
	let draftTimer: ReturnType<typeof setTimeout> | undefined;
	let finalTimer: ReturnType<typeof setTimeout> | undefined;
	let periodicTimer: ReturnType<typeof setInterval> | undefined;
	const isActive = () => active;

	const canReplaceGeneratedName = () => {
		const currentName = pi.getSessionName();
		return !currentName || currentName === generatedName;
	};

	const setGeneratedName = (title: string, snapshot: string, ctx: ExtensionContext) => {
		generatedName = title;
		lastNamedSnapshot = snapshot;
		pi.setSessionName(title);
		ctx.ui.setTitle(`${title} - ${basename(ctx.cwd)}`);
		pi.appendEntry<NameState>(STATE_ENTRY_TYPE, { title, snapshot, timestamp: Date.now() });
	};

	const refreshNameIfChanged = async (ctx: ExtensionContext) => {
		if (!isActive() || finalInFlight || !ctx.isIdle() || ctx.hasPendingMessages() || !canReplaceGeneratedName()) return;

		const prompt = firstPrompt ?? getFirstUserPrompt(ctx)?.trim();
		if (!prompt) return;

		const snapshot = getSessionSnapshot(ctx);
		if (snapshot === lastNamedSnapshot) return;

		finalInFlight = true;
		try {
			const title = await generateTitle(pi, ctx, "periodic", prompt, getSessionContext(ctx), isActive);
			if (title && isActive() && canReplaceGeneratedName()) setGeneratedName(title, snapshot, ctx);
		} catch (error) {
			if (!isActive() || isStaleContextError(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			sendError(pi, message, isActive);
		} finally {
			finalInFlight = false;
		}
	};

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("error", "[session name]")} ${message.content}`, 0, 0));
		return box;
	});

	pi.registerCommand("auto-name-session", {
		description: "Generate a session name now",
		handler: async (_args, ctx) => {
			if (finalInFlight) {
				ctx.ui.notify("Session naming is already in progress", "info");
				return;
			}

			const prompt = firstPrompt ?? getFirstUserPrompt(ctx)?.trim();
			if (!prompt) {
				ctx.ui.notify("No user prompt found to name this session from", "error");
				return;
			}

			finalInFlight = true;
			try {
				ctx.ui.notify("Generating session name…", "info");
				const title = await generateTitle(pi, ctx, "final", prompt, getSessionContext(ctx), isActive);
				if (!title || !isActive()) return;

				setGeneratedName(title, getSessionSnapshot(ctx), ctx);
				ctx.ui.notify(`Session named: ${title}`, "info");
			} catch (error) {
				if (!isActive() || isStaleContextError(error)) return;
				const message = error instanceof Error ? error.message : String(error);
				sendError(pi, message, isActive);
			} finally {
				finalInFlight = false;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const savedState = getStoredNameState(ctx);
		if (savedState) {
			generatedName = savedState.title;
			lastNamedSnapshot = savedState.snapshot;
		} else {
			lastNamedSnapshot = getSessionSnapshot(ctx);
		}

		if (PERIODIC_RENAMING_ENABLED) {
			periodicTimer = setInterval(() => {
				void refreshNameIfChanged(ctx);
			}, PERIODIC_RENAME_INTERVAL_MS);
		}
	});

	pi.on("session_shutdown", () => {
		active = false;
		if (draftTimer) clearTimeout(draftTimer);
		if (finalTimer) clearTimeout(finalTimer);
		if (periodicTimer) clearInterval(periodicTimer);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user") return;
		if (firstPrompt || draftInFlight || hasCustomEntry(ctx, DRAFT_ENTRY_TYPE)) return;
		if (pi.getSessionName()) return;

		firstPrompt = (getFirstUserPrompt(ctx) ?? extractText(event.message.content)).trim();
		if (!firstPrompt) return;

		draftInFlight = true;
		draftTimer = setTimeout(() => {
			void (async () => {
				try {
					const title = await generateTitle(pi, ctx, "draft", firstPrompt!, undefined, isActive);
					if (title && isActive() && !pi.getSessionName()) setGeneratedName(title, getSessionSnapshot(ctx), ctx);
				} catch (error) {
					if (!isActive() || isStaleContextError(error)) return;
					const message = error instanceof Error ? error.message : String(error);
					sendError(pi, message, isActive);
				} finally {
					draftInFlight = false;
				}
			})();
		}, 0);
	});

	pi.on("agent_end", (event, ctx) => {
		if (finalQueued || finalInFlight || hasCustomEntry(ctx, FINAL_ENTRY_TYPE)) return;

		const prompt = firstPrompt ?? getFirstUserPrompt(ctx)?.trim();
		if (!prompt) return;

		const assistantResponse = event.messages
			.filter((message) => message.role === "assistant")
			.map((message) => extractText(message.content))
			.filter((text) => text.trim().length > 0)
			.join("\n\n")
			.trim();

		if (!assistantResponse) return;

		finalQueued = true;
		finalInFlight = true;
		finalTimer = setTimeout(() => {
			void (async () => {
				try {
					const title = await generateTitle(pi, ctx, "final", prompt, getSessionContext(ctx) ?? assistantResponse, isActive);
					if (!title || !isActive()) return;
					if (canReplaceGeneratedName()) setGeneratedName(title, getSessionSnapshot(ctx), ctx);
				} catch (error) {
					if (!isActive() || isStaleContextError(error)) return;
					const message = error instanceof Error ? error.message : String(error);
					sendError(pi, message, isActive);
				} finally {
					finalInFlight = false;
				}
			})();
		}, 0);
	});
}
