# Pi extensions

[![Release check](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml/badge.svg)](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml)

Extensions for [Pi](https://github.com/earendil-works/pi), kept together in one
version-controlled checkout. Most can be enabled globally; Fastmail Contact
Groups is intended for individual projects.

## Choose your extensions

| Extension | What it does |
| --- | --- |
| [Automatic session naming](#automatic-session-naming) | Names sessions using the selected model. |
| [Model provider selection](#model-provider-selection) | Limits built-in model selection to Codex and OpenRouter. |
| [Context-window progress](#context-window-progress) | Shows context usage in the footer. |
| [Session title](#session-title) | Shows the session name above the editor in Pi's terminal interface. |
| [Question](#question) | Lets the agent ask multiple-choice questions in Pi's terminal interface. |
| [Google Calendar](extensions/google-calendar/README.md) | Connects Google accounts to read and manage calendar events. |
| [Google Drive](extensions/google-drive/README.md) | Connects Google accounts to work with Drive files, Docs, Sheets, and Slides. |
| [Fastmail Contact Groups](extensions/fastmail-contact-groups/README.md) | Previews and applies contact-group membership changes. |

Google Calendar and Google Drive each require a Google Desktop OAuth client and
account authorization. Follow their linked setup guides after installation.
Both expose tools that can change your data without a confirmation dialog;
only enable them if you are comfortable with that behavior.

## Installation

Clone the repository, record its checkout location, and create Pi's global
extension directory:

```sh
git clone https://github.com/mattwynne/pi-extensions.git
cd pi-extensions
export PI_EXTENSIONS_DIR="$PWD"
export PI_GLOBAL_EXTENSIONS_DIR="${PI_GLOBAL_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
mkdir -p "$PI_GLOBAL_EXTENSIONS_DIR"
```

Link whichever extensions you want to enable:

```sh
ln -s "$PI_EXTENSIONS_DIR/extensions/auto-session-name.ts" \
  "$PI_GLOBAL_EXTENSIONS_DIR/auto-session-name.ts"
ln -s "$PI_EXTENSIONS_DIR/extensions/provider-selection.ts" \
  "$PI_GLOBAL_EXTENSIONS_DIR/provider-selection.ts"
ln -s "$PI_EXTENSIONS_DIR/extensions/context-window-progress.ts" \
  "$PI_GLOBAL_EXTENSIONS_DIR/context-window-progress.ts"
ln -s "$PI_EXTENSIONS_DIR/extensions/session-title" \
  "$PI_GLOBAL_EXTENSIONS_DIR/session-title"
ln -s "$PI_EXTENSIONS_DIR/extensions/question.ts" \
  "$PI_GLOBAL_EXTENSIONS_DIR/question.ts"

# Google extensions need dependencies installed in the checkout directory:
# Remove any extension you don't want from the list below.
for ext in google-calendar google-drive; do
  (cd "$PI_EXTENSIONS_DIR/extensions/$ext" && npm install)
  ln -s "$PI_EXTENSIONS_DIR/extensions/$ext" \
    "$PI_GLOBAL_EXTENSIONS_DIR/$ext"
done

# fastmail-contact-groups is project-scoped, but also has npm dependencies:
(cd "$PI_EXTENSIONS_DIR/extensions/fastmail-contact-groups" && npm install)
```

These examples use POSIX symbolic links. Keep the checkout in place while the
links are installed. Run `/reload` in Pi after installing or changing an
extension.

### Fastmail project setup

The `fastmail-contact-groups` extension is intended for project-scoped use
because it accesses a personal address book. Add its absolute checkout path to
the `extensions` array in the project's `.pi/settings.json` instead of linking
it globally:

```json
{
  "extensions": [
    "/absolute/path/to/pi-extensions/extensions/fastmail-contact-groups"
  ]
}
```

Replace `/absolute/path/to/pi-extensions` with your checkout location. If the
file already has an `extensions` array, add the path to that array. Relative
paths resolve from the project's `.pi` directory, not the project root. Run
`/reload` after saving the settings.

This extension registers the guarded `fastmail_contact_groups` CardDAV tool;
basic contact operations remain with Fastmail's official MCP tools. See its
[README](extensions/fastmail-contact-groups/README.md) for credentials and safety
constraints.

## Automatic session naming

Automatic session naming uses the session's selected model and credentials, so
each naming request can incur provider cost and sends session material to that
provider. Every request sends at most the most recent 6,000 characters: the
first user prompt for the initial draft, or user and assistant messages for
later automatic and manual refinements. To retry or refresh a name, run
`/auto-name-session`.

Recurring five-minute name checks are disabled by default. Set
`PI_AUTO_SESSION_NAME_PERIODIC=1` before starting Pi to enable them. An enabled
check sends a naming request only while Pi is idle and the session has changed
since the last generated name.

## Context-window progress

The context-window-progress extension adds a colour-coded 12-cell context-usage
bar to the footer. Run `/context-bar` to refresh it manually.

## Session title

The session-title extension shows the session name in the editor's top border.
It works only in Pi's terminal interface (TUI). It replaces Pi's editor
component, so do not load it with another extension that does the same.

## Question

The question extension is an enhanced version of Pi's official question
example. It lets an agent ask a multiple-choice question with optional
explanatory context and a free-text alternative. It works only in Pi's terminal
interface (TUI), not RPC, JSON, or print modes.

## Model provider selection

`provider-selection.ts` hides built-in providers other than Codex and OpenRouter
from model selection. It does not revoke credentials or prevent tools from
using other providers, and it does not change the default model. `/login` still
lists providers.

Providers supplied by other extensions are not filtered. This includes
`pi-claude-code-provider`, if you have installed it separately.

The global symlink applies in every project. Run `/reload` in each already-open
Pi process (or restart it); changes on disk cannot update other running processes
automatically. `--no-extensions` bypasses this policy. To undo it, remove only the
`~/.pi/agent/extensions/provider-selection.ts` symlink and reload.

Smoke test without sending a model request:

```sh
pi --offline --list-models
```

Check that no built-in provider IDs other than `openai-codex` and `openrouter`
appear. `pi-claude-code-provider` appears only if separately installed; other
extension-provided providers may also appear.

### Implementation details

The extension uses Pi's native provider `filterModels` API, without deleting
credentials or changing the environment. Hidden providers stay hidden even
when a shell exports `GEMINI_API_KEY` or another API key. Their built-in model
catalogs, authentication, and streaming remain available to tools that look
them up explicitly.

Hidden providers are recreated from Pi's built-ins, so extra models found only
in Pi's remote catalog cache are not retained. Allowed providers are untouched.

## Tests

Requires Node.js 24 or newer. The release check installs Google Calendar and
Fastmail Contact Groups dependencies from their lockfiles, runs every Node
test, checks the syntax of every extension TypeScript file, and audits those
two extensions' dependencies. Google Drive dependencies are not currently
installed or audited by this command:

```sh
npm run check
```

## License

This repository is licensed under the [MIT License](LICENSE).
The Pi-derived question extension retains its upstream MIT notice in
[`extensions/question.ts`](extensions/question.ts).
