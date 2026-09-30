import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createFastmailContactGroupsExtension } from "./extension.ts";

const register = createFastmailContactGroupsExtension({
	Type,
	StringEnum,
	truncateHead,
	limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES },
});

export default function fastmailContactGroups(pi: ExtensionAPI) {
	register(pi);
}
