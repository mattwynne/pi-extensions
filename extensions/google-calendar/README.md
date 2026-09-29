# Google Calendar

A Pi extension for connecting multiple Google accounts and working with their calendars.

## Install

Link this directory into Pi’s global extension directory and install its dependency:

```sh
ln -s /path/to/pi-extensions/extensions/google-calendar \
  ~/.pi/agent/extensions/google-calendar
cd /path/to/pi-extensions/extensions/google-calendar
npm install
```

Run `/reload` after installing or changing the extension.

## Set up Google OAuth

Each user supplies their own Google Desktop OAuth client. No shared OAuth client or credentials are included in this repository.

1. Create or select a project you control in the [Google Cloud Console](https://console.cloud.google.com/). The project name is your choice and is not used by the extension.
2. Enable the **Google Calendar API** for that project.
3. In **Google Auth Platform**, configure the app information and audience. Choose **Internal** only when every account that will connect belongs to the same Google Workspace organization; otherwise choose **External**.
4. Under **Data Access**, add the scopes listed below. Google may classify the Calendar scopes as sensitive and request additional information before a broadly distributed app can be verified.
5. Choose the publishing status that fits the installation:
   - **Testing** is convenient for local setup. Add every account that will connect as a test user. External apps in Testing are limited to their test-user allowlist, and refresh tokens for these Calendar scopes can expire after seven days, requiring re-authentication.
   - **In production** removes the Testing allowlist and seven-day refresh-token limit. External apps using sensitive scopes may need Google verification; until then, Google may show an unverified-app warning or limit access.
6. Under **Clients**, create an OAuth client with application type **Desktop app**.
7. Download the client JSON. Treat it as a credential and do not commit it to this repository.
8. In interactive Pi, run `/google-calendar`, choose **Import OAuth client**, and enter the downloaded file’s path.
9. Choose **Add account** and complete Google’s browser authorization flow.

The extension requests these exact scopes:

- `openid` — identify the Google account
- `email` — read the account email address
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly` — read the account's calendar list
- `https://www.googleapis.com/auth/calendar.events` — read and write calendar events
- `https://www.googleapis.com/auth/calendar.freebusy` — read calendar availability

The imported client configuration is copied to the private storage location
described below; the extension does not read it from the checkout after import.

Adding an already-connected Google identity is rejected. To replace or re-authenticate an account, remove it locally and add it again.

## Settings

Run:

```text
/google-calendar
```

The settings dialog lists each account as either `Connected` or `Re-authentication required`. From there you can add an account or remove a selected account. Removing an account deletes only its local token; it does not revoke the app grant at Google.

Interactive Pi provides the dialogs directly. RPC clients can relay the standard Pi dialogs. JSON and print modes cannot change settings; use interactive Pi for setup and account management.

## Private storage

Credentials are stored outside both the repository and `~/.pi`:

- macOS: `~/Library/Application Support/pi-google-calendar/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/pi-google-calendar/`
- Windows: `%LOCALAPPDATA%/pi-google-calendar/`
- Override: `PI_GOOGLE_CALENDAR_DATA_DIR`

Layout:

```text
oauth-client.json
accounts.json
tokens/<stable-subject-hash>.json
```

Directories use mode `0700` and files use mode `0600` where the operating system supports POSIX permissions. Writes are locked and atomic.

### Migrating an older installation

Older versions stored Calendar credentials under `~/.pi/google-calendar` and
do not migrate them automatically. Keep the old directory until the new setup
works, then use `/google-calendar` to import your Desktop OAuth client again and
add each account. After every account reports `Connected`, delete the old
directory with your usual secure file-removal process. Do not copy old token or
account files into the new application-data directory.

## Tools

- `gcal_auth_status` — report account connection status
- `gcal_list_calendars` — list calendars across every connected account, preserving partial successes
- `gcal_search_events` — read-only aggregate event search across connected calendars in one call
- `gcal_list_events` / `gcal_get_event` — read events from one explicit account/calendar
- `gcal_create_event` / `gcal_update_event` / `gcal_delete_event` — write events
- `gcal_free_busy` — query busy periods

`gcal_search_events` requires `timeMin` and `timeMax` (RFC3339). By default it searches selected calendars **and every primary calendar** across all connected accounts. Set `calendarSelection` to `primary` or `all`, optionally restrict with a non-empty `accounts` list, or pass non-empty `targets: [{ account, calendarId }]` to search exactly those pairs (overriding account discovery and selection). Optional `q` and `timeZone` are passed to Google. `maxResults` defaults to 100, clamped to 1–2500 **across the combined result**. Results are sorted, repeated occurrences merged with all source accounts/calendars, and `truncated` indicates when more unique results were found. Discovery and search failures are reported separately without discarding successful events. This reads every page per calendar, so broad searches can take longer; event queries run with bounded internal concurrency.

For example:

```json
{"timeMin":"2026-01-01T12:00:00Z","timeMax":"2026-01-01T18:00:00Z"}
```

Except for `gcal_list_calendars` and `gcal_search_events`, tools require an explicit account email and calendar ID or IDs. There is no default account and no personal routing policy.

## Mutation safety in the first iteration

The mutation tools do not display an enforced runtime confirmation dialog in the first iteration. Their Pi prompt guidance says to use them only following explicit user intent; that guidance is not an access-control boundary.

Attendee notifications remain opt-in: create, update, move, and delete operations default `sendUpdates` to `none`. Runtime confirmation dialogs are planned for a later iteration.
