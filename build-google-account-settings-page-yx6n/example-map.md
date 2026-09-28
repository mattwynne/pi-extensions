# Story — First Iteration
As a Pi user, I want a Google Calendar settings page where I can configure OAuth and add, see, and remove multiple Google Calendar accounts, so Calendar tools no longer depend on credentials or accounts hard-coded in source.

# Product Boundary
Google Calendar is a separate integration with its own accounts, OAuth scopes, tools, and settings page. Future Gmail, Contacts, Docs, and Drive integrations will be separate. Shared infrastructure will be extracted only after working integrations demonstrate real duplication.

# Rule 1 — `/google-calendar` shows a minimal account list

## Examples
- Given no accounts, opening `/google-calendar` shows an empty state and one prominent “Add account” action.
- Given personal@example.com and me@work.example are healthy, opening `/google-calendar` shows two rows containing only email and Connected.
- Given a saved credential can no longer refresh, its row shows Re-authentication required.
- Provider IDs, tokens, labels, scopes, and defaults are not shown in the list.

# Rule 2 — First-time setup imports the user's Desktop OAuth client

## Examples
- Given no OAuth client configuration, `/google-calendar` explains that the user must create and import a Google Desktop OAuth client before adding an account.
- Choosing Import accepts a downloaded Google OAuth JSON file, validates that it contains an installed/Desktop client, and stores it in the private Calendar data directory.
- A missing, malformed, or non-Desktop client file is rejected with a specific correction and does not modify saved configuration.
- Client IDs and client secrets are never displayed in the account list or written to logs.
- The repository and release do not contain a private, project-specific, or shared OAuth client.
- After a valid client is configured, Add account can begin browser authorization.

# Rule 3 — Add creates one new Calendar account

## Examples
- Add account opens Google's browser consent flow and requests identity/email, Calendar-list read access, Calendar-event read/write access, and Calendar free/busy read access.
- A successful callback verifies the Google identity and appends its email to the list.
- Cancelling, timing out, or failing OAuth leaves the account list unchanged.
- Attempting Add before OAuth client setup returns the user to the setup action without opening a browser.
- Adding an identity already in the registry fails without changing its saved credential and says to remove the existing account before adding it again.
- Two different Google identities remain isolated and usable concurrently.
- Google’s stable subject identifier, not email, defines identity and determines the hashed token filename.
- When a successful identity check reports a changed email for the same subject, the registry updates the displayed email without creating another account or replacing its credential.

# Rule 4 — Remove is the only replacement/re-authentication path in iteration one

## Examples
- Selecting Remove asks for confirmation naming the email address.
- Declining confirmation changes nothing.
- Confirming removes only that account's local credential and registry entry.
- To replace or re-authenticate an account, the user removes it and then adds it again.
- Removing locally does not promise to revoke access at Google in this iteration.

# Rule 5 — Calendar discovery spans connected accounts without personal policy

## Examples
- list-calendars queries every connected Calendar account and identifies each calendar's owning account email.
- Results are grouped by account; each result contains the account email, status, and either calendars or a safe error.
- A failure in one account is reported alongside successful results from other accounts rather than hiding all results.
- An authentication failure sets `reauthenticationRequired` for that account without exposing provider payloads, tokens, or credential paths.
- Personal meanings such as “family” or “work” live in external skills/instructions, not the extension.
- Other Calendar tools require an explicit account email and calendar ID; there is no default account.

# Storage Decision
- macOS: `~/Library/Application Support/pi-google-calendar/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/pi-google-calendar/`
- Windows: `%LOCALAPPDATA%/pi-google-calendar/`
- Override: `PI_GOOGLE_CALENDAR_DATA_DIR`
- Layout: `oauth-client.json`, `accounts.json`, and `tokens/<stable-subject-hash>.json`
- Directories use mode `0700`; files use mode `0600`; writes are atomic and locked.

# Deferred
- A project-operated shared Calendar OAuth client
- Gmail, Contacts, Docs, and Drive integrations
- Shared Google identity/account settings
- Configurable OAuth scopes
- Labels and default accounts
- Edit or re-authenticate-in-place
- Google-side token revocation
- Project-specific account settings
- Runtime confirmation dialogs for Calendar mutations





