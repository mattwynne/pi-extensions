# Pi extensions

[![Release check](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml/badge.svg)](https://github.com/mattwynne/pi-extensions/actions/workflows/release-check.yml)

Version-controlled global extensions for [Pi](https://github.com/earendil-works/pi).

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

# google-calendar and google-drive need their own npm deps installed in the real directory:
for ext in google-calendar google-drive; do
  (cd "$PI_EXTENSIONS_DIR/extensions/$ext" && npm install)
  ln -s "$PI_EXTENSIONS_DIR/extensions/$ext" \
    "$PI_GLOBAL_EXTENSIONS_DIR/$ext"
done
```

These examples use POSIX symbolic links. Keep the checkout in place while the
links are installed. Run `/reload` in Pi after installing or changing an
extension.

The `fastmail-contact-groups` extension is intended for project-scoped use
because it accesses a personal address book. Add
`extensions/fastmail-contact-groups` from this checkout to the project's
`.pi/settings.json` instead of linking it globally. It registers the guarded
`fastmail_contact_groups` CardDAV tool; basic contact operations remain with
Fastmail's official MCP tools. See its [README](extensions/fastmail-contact-groups/README.md)
for credentials and safety constraints.

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

The context-window-progress extension adds a colour-coded 12-cell context-usage bar to the footer. Run `/context-bar` to refresh it manually.

The TUI-only session-title extension renders the session name in the editor's top border. It replaces Pi's editor component, so do not load it with another extension that does the same.

The question extension is an enhanced version of Pi's official question example. It lets an agent ask a multiple-choice question with optional explanatory context and a free-text alternative.

## Model provider selection

`provider-selection.ts` keeps built-in model selection limited to Codex and
OpenRouter. The separately installed `pi-claude-code-provider` remains available
and the default model is unchanged. Other extension-provided providers are not
filtered; review this policy if adding one later.

The extension uses Pi's native provider `filterModels` API, not credential
deletion or environment changes. Direct providers stay hidden even when a shell
exports `GEMINI_API_KEY` or another API key. Their built-in catalogs, auth and
streaming remain available to tools that look them up explicitly. Blocked
providers use freshly constructed built-ins, so extra models found only in Pi's
remote catalog cache are not retained. Allowed providers are untouched. This is
a model-picker preference, not an access-control boundary; `/login` still lists
providers.

The global symlink applies in every project. Run `/reload` in each already-open
Pi process (or restart it); changes on disk cannot update other running processes
automatically. `--no-extensions` bypasses this policy. To undo it, remove only the
`~/.pi/agent/extensions/provider-selection.ts` symlink and reload.

Smoke test without sending a model request:

```sh
pi --offline --list-models
```

Expected provider IDs: `openai-codex`, `openrouter`, `pi-claude-code-provider`.

## Tests

Requires Node.js 24 or newer and Python 3. The release check installs the
Calendar package from its lockfile, runs every Node and Fastmail contact-group
Python test, validates each extension source file, and audits the Calendar
dependencies:

```sh
npm run check
```

## License

This repository is licensed under the [MIT License](LICENSE).
The Pi-derived question extension retains its upstream MIT notice in
[`extensions/question.ts`](extensions/question.ts).
