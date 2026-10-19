# Pi extensions

[![Release check](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml/badge.svg)](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml)

Extensions for [Pi](https://github.com/earendil-works/pi) that improve the session
interface and let agents work with Google accounts and Fastmail contact groups.

## Capabilities

### Automatic session naming

- Name sessions using the session's selected model.
- Retry or refine a name with `/auto-name-session`.
- Optionally check for name updates every five minutes by setting
  `PI_AUTO_SESSION_NAME_PERIODIC=1`. Checks run only while Pi is idle and the
  conversation has changed since the last generated name.

Naming requests use your provider credentials and can incur charges. They send
up to 6,000 characters of session material: the first user prompt for the initial
name, or recent user and assistant messages for later refinements.

### Context-window progress

- Show context usage as a colour-coded, 12-cell bar in the footer.
- Refresh it manually with `/context-bar`.

### Session title

- Show the session name in the editor's top border in Pi's terminal interface.

This replaces Pi's editor component; do not combine it with another extension
that replaces the editor.

### Questions

- Let the agent ask a multiple-choice question with explanatory context.
- Let you write your own answer instead of choosing an option.

Works only in Pi's terminal interface, not RPC, JSON, or print modes.

### Google Calendar

- Connect multiple Google accounts.
- List calendars and search events across accounts.
- Read, create, update, and delete events.
- Check availability with free/busy queries.
- Re-authenticate an account without removing it.

See the [Google Calendar guide](extensions/google-calendar/README.md) for setup,
commands, and tool details.

### Google Drive, Docs, Sheets, and Slides

- Connect multiple Google accounts.
- Find and create Drive folders, inspect file parents, and move files.
- Read, create, edit, and share Docs, Sheets, and Slides.
- Work with document sections and tables, spreadsheet ranges and tabs, and
  slide content.

See the [Google Drive guide](extensions/google-drive/README.md) for setup,
commands, and tool details.

Both Google integrations require a Google Desktop OAuth client and account
authorization. Their write tools can change your data without a confirmation
dialog.

### Fastmail Contact Groups

- List and inspect contact groups.
- Preview adding or removing an existing contact from a group.
- Apply approved membership changes with conflict checks and read-back
  verification.

Intended for project-scoped use. Basic contact search, creation, and updates
remain with Fastmail's official MCP tools. See the
[Fastmail Contact Groups guide](extensions/fastmail-contact-groups/README.md)
for setup, credentials, and safety constraints.

### Model provider selection

- Limit built-in model selection to Codex and OpenRouter.
- Leave providers supplied by other extensions available, including
  `pi-claude-code-provider` if separately installed.
- Preserve the configured default model and credentials.

This changes model selection, not access permissions. Tools can still use other
providers, and `/login` still lists them.

## Tests

Requires Node.js 24 or newer:

```sh
npm run check
```

The check runs every Node test and checks the syntax of every extension
TypeScript file. It also installs and audits the dependencies for Google
Calendar and Fastmail Contact Groups. Google Drive dependencies are not
currently installed or audited by this command.

## License

[MIT](LICENSE). The Pi-derived question extension retains its upstream MIT
notice in [`extensions/question.ts`](extensions/question.ts).
