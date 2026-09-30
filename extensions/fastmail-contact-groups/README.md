# Fastmail Contact Groups

A Pi extension for conservative Fastmail CardDAV contact-group membership changes. It registers one tool: `fastmail_contact_groups`.

Use Fastmail's official MCP contact tools for basic contact search, creation, and updates. This extension only lists and inspects CardDAV groups and previews or applies membership changes for an existing contact.

## Installation

Load this directory as a Pi extension. For project-only use, add its checkout path to that project's `.pi/settings.json`:

```json
{
  "extensions": [
    "/path/to/pi-extensions/extensions/fastmail-contact-groups"
  ]
}
```

Run `/reload` after changing the extension or settings. Do not also install a global symlink for the same project; duplicate loading could register the tool twice.

The TypeScript extension has no separately installed npm dependencies. Pi supplies its extension API and schema helpers.

## Authentication

The helper reads these variables only when the tool executes:

- `FASTMAIL_USERNAME` — the Fastmail account whose Contacts data should be used.
- `FASTMAIL_APP_PASSWORD` — a Fastmail app password with Contacts access.

Registration does not read credentials or contact data and does not open a network connection. There is no account fallback. Never put credentials in arguments, settings, or tracked files.

## Safety contract

- `list` and `get` are read-only.
- `add` and `remove` are previews unless `apply: true` is explicitly supplied after user approval.
- Contacts and groups must resolve uniquely. Duplicate names, contacts, and cross-address-book matches fail closed.
- Membership affects the whole contact, including all its email addresses.
- MCP contact IDs and CardDAV UIDs are different namespaces.
- A write starts from a fresh group read, requires a strong ETag, sends `If-Match`, and never retries automatically.
- Read-back verifies the requested membership and preservation of unrelated members and properties.
- Conflicts and uncertain writes require a fresh inspection before another attempt.
- The helper follows no redirects and sanitizes network, server, and subprocess errors.

A verified group membership change does not prove any downstream mail-routing behavior.

## Direct helper use

The Python helper uses only the standard library:

```bash
python3 extensions/fastmail-contact-groups/contact-groups.py list
python3 extensions/fastmail-contact-groups/contact-groups.py get --group "Exact group name" --email sender@example.com

# Preview only. Add --apply only after explicit approval:
python3 extensions/fastmail-contact-groups/contact-groups.py add --group "Exact group name" --email sender@example.com
```

## Tests

From the repository root:

```bash
node --test tests/fastmail-contact-groups.test.mjs
python3 -m unittest discover -s extensions/fastmail-contact-groups/tests -p '*_test.py'
```

All tests use mocked subprocesses or CardDAV transports and require no credentials. They do not establish permission to mutate a live address book.
