import { ContactGroupsError, createConfiguredService, type ContactGroupParams, type GroupService } from "./contact-groups.ts";

export interface FastmailContactGroupsDependencies {
	Type: any;
	StringEnum: (values: readonly string[]) => any;
	truncateHead: (text: string, limits: { maxBytes: number; maxLines: number }) => {
		content: string;
		truncated: boolean;
	};
	limits: { maxBytes: number; maxLines: number };
	createService?: (signal?: AbortSignal) => Pick<GroupService, "execute">;
}

export function createFastmailContactGroupsExtension({
	Type,
	StringEnum,
	truncateHead,
	limits,
	createService = createConfiguredService,
}: FastmailContactGroupsDependencies) {
	return function registerFastmailContactGroups(pi: any) {
		pi.registerTool({
			name: "fastmail_contact_groups",
			label: "Fastmail Contact Groups",
			description:
				"List and inspect Fastmail contact groups, or preview/add/remove one existing contact's membership via CardDAV. Mutations default to preview; apply=true executes an explicitly approved change. Does not create contacts/groups, alter contact fields, or remove membership from other groups. Exact group names or CardDAV UIDs only (not MCP contact IDs). Output capped at 50 groups and standard tool text limits.",
			promptSnippet: "Inspect and safely change Fastmail contact-group membership",
			promptGuidelines: [
				"Use fastmail_contact_groups only for Fastmail contact-group membership; use Pi's configured official Fastmail MCP contact tools directly for basic contact search, creation, and updates.",
				"Before fastmail_contact_groups add/remove, inspect or preview the exact group/contact. Membership affects the whole contact, including all its email addresses: confirm that scope if it is wider than the named address. Use apply=true only for an approved change. Preserve other groups unless removal is separately approved.",
				"fastmail_contact_groups requires an existing unique CardDAV contact. Create a missing contact through the official Fastmail MCP tools only after searching for duplicates; never assume MCP contact IDs equal CardDAV UIDs, and stop if account identity or synchronization is uncertain.",
				"If fastmail_contact_groups reports a conflict or uncertain/partial write, re-read before retrying. Do not claim the intended membership change is complete until it is verified.",
			],
			parameters: Type.Object({
				action: StringEnum(["list", "get", "add", "remove"] as const),
				group: Type.Optional(Type.String({ description: "Exact group name or CardDAV UID from list; required except for list. Duplicate names require a UID." })),
				email: Type.Optional(Type.String({ description: "Exact email on the existing contact. Optional for get, required for add/remove unless contactUid is supplied." })),
				contactUid: Type.Optional(Type.String({ description: "CardDAV vCard UID, not a Fastmail MCP contact ID. Can disambiguate an email shared by multiple contacts." })),
				apply: Type.Optional(Type.Boolean({ description: "Default false: preview only. True applies an explicitly approved add/remove and verifies it." })),
			}),
			async execute(_id: string, params: ContactGroupParams, signal?: AbortSignal) {
				let result: Record<string, any>;
				try {
					result = await createService(signal).execute(params);
				} catch (error) {
					if (error instanceof ContactGroupsError) throw new Error(error.message);
					if (signal?.aborted) {
						throw signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
					}
					throw new Error("Unexpected contact-group error; no automatic retry. Re-read live state before retrying a write.");
				}
				const truncated = truncateHead(`${result.summary}\n${JSON.stringify(result, null, 2)}`, limits);
				let text = truncated.content;
				if (truncated.truncated) text += "\n[Output truncated; query one group/contact for details.]";
				return { content: [{ type: "text", text }], details: result };
			},
		});
	};
}
