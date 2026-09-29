# Google Drive

A Pi extension for connecting multiple Google accounts and working with their
Drive files, Docs, Sheets, and Slides. It follows the same account + OAuth model
as the sibling `google-calendar` extension.

## Install

Link this directory into Pi's global extension directory and install its
dependency:

```sh
ln -s ~/git/mattwynne/pi-extensions/extensions/google-drive \
  ~/.pi/agent/extensions/google-drive
cd ~/git/mattwynne/pi-extensions/extensions/google-drive
npm install
```

Run `/reload` after installing or changing the extension.

## Set up Google OAuth

Each user supplies their own Google Desktop OAuth client. No shared OAuth client
or credentials are included in this repository.

1. Create or select a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the Drive, Docs, Sheets, and Slides APIs.
3. Configure the Google Auth Platform consent screen and audience.
4. Under **Clients**, create an OAuth client with application type **Desktop app**.
5. Download its JSON file.
6. In interactive Pi, run `/google-drive`, choose **Import OAuth client**, and enter the downloaded file's path.
7. Choose **Add account** and complete Google's browser authorization flow.

The extension requests only:

- OpenID identity and email
- Full Drive access
- Docs, Sheets, and Slides access

Adding an already-connected Google identity is rejected. To replace or re-authenticate an account, remove it locally and add it again.

## Settings

Run:

```text
/google-drive
```

The settings dialog lists each account as either `Connected` or `Re-authentication required`. From there you can add or remove accounts. Removing an account deletes only its local token; it does not revoke the app grant at Google.

## Private storage

Credentials are stored outside both the repository and `~/.pi`:

- macOS: `~/Library/Application Support/pi-google-drive/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/pi-google-drive/`
- Windows: `%LOCALAPPDATA%/pi-google-drive/`
- Override: `PI_GOOGLE_DRIVE_DATA_DIR`

Layout:

```text
oauth-client.json
accounts.json
tokens/<stable-subject-hash>.json
```

Directories and files use restrictive modes and atomic, locked writes.

## Tools

One OAuth token per account covers Drive, Docs, Sheets, and Slides. Except
`gdrive_auth_status`, every tool requires an explicit `account` email. There is
no default account and no personal routing policy.

- `gdrive_auth_status` — account connection status
- `gdrive_find_folders` / `gdrive_create_folder` / `gdrive_list_parents` / `gdrive_move_file`
- `gdocs_create`, `gdocs_create_styled`, `gdocs_read`, `gdocs_append`, `gdocs_append_styled`, `gdocs_append_table`, `gdocs_insert_after`, `gdocs_insert_table_after`, `gdocs_outline`, `gdocs_find_replace`, `gdocs_replace`, `gdocs_replace_section`, `gdocs_share`
- `gsheets_create`, `gsheets_info`, `gsheets_read`, `gsheets_update`, `gsheets_append`, `gsheets_clear`, `gsheets_add_sheet`, `gsheets_share`
- `gslides_create`, `gslides_read`, `gslides_info`, `gslides_append_slide`, `gslides_find_replace`, `gslides_replace_slide`, `gslides_create_text_box`, `gslides_share`

## Mutation safety in the first iteration

The write tools do not display an enforced runtime confirmation dialog in the
first iteration. Their Pi prompt guidance says to use them only following
explicit user intent; that guidance is not an access-control boundary.