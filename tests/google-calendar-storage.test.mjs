import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CalendarStore,
  DuplicateAccountError,
  googleSubjectHash,
  resolveCalendarDataDir,
  validateDesktopOAuthClient,
} from "../extensions/google-calendar/storage.ts";

const desktopClient = {
  installed: {
    client_id: "desktop-client-id",
    client_secret: "desktop-client-secret",
    redirect_uris: ["http://localhost"],
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-google-calendar-test-"));
  const dataDir = join(root, "data");
  const source = join(root, "downloaded-client.json");
  await writeFile(source, JSON.stringify(desktopClient), "utf8");
  return { root, dataDir, source, store: new CalendarStore({ dataDir, home: root }) };
}

test("uses OS application-data locations and honors the override", () => {
  assert.equal(resolveCalendarDataDir({ platform: "darwin", home: "/Users/example", env: {} }), "/Users/example/Library/Application Support/pi-google-calendar");
  assert.equal(resolveCalendarDataDir({ platform: "linux", home: "/home/example", env: {} }), "/home/example/.local/share/pi-google-calendar");
  assert.equal(resolveCalendarDataDir({ platform: "linux", home: "/home/example", env: { XDG_DATA_HOME: "/data" } }), "/data/pi-google-calendar");
  assert.equal(resolveCalendarDataDir({ platform: "win32", home: "C:\\Users\\example", env: { LOCALAPPDATA: "C:\\Local" } }), "C:\\Local/pi-google-calendar");
  assert.equal(resolveCalendarDataDir({ platform: "linux", home: "/home/example", env: { PI_GOOGLE_CALENDAR_DATA_DIR: "/private/calendar" } }), "/private/calendar");
});

test("accepts only an installed Desktop OAuth client", () => {
  assert.equal(validateDesktopOAuthClient(desktopClient).client_id, "desktop-client-id");
  assert.throws(() => validateDesktopOAuthClient({ web: desktopClient.installed }), /Web OAuth client/);
  assert.throws(() => validateDesktopOAuthClient({ installed: { client_id: "id", client_secret: "secret", redirect_uris: ["https://example.com/callback"] } }), /loopback localhost/);
  assert.throws(() => validateDesktopOAuthClient({ installed: { client_id: "id" } }), /client_secret/);
});

test("imports OAuth configuration and creates private storage", async () => {
  const { dataDir, source, store } = await fixture();
  await store.importOAuthClient(source);
  const saved = JSON.parse(await readFile(join(dataDir, "oauth-client.json"), "utf8"));
  assert.equal(saved.installed.client_secret, "desktop-client-secret");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, "oauth-client.json"))).mode & 0o777, 0o600);
  assert.equal((await store.readOAuthClient()).client_id, "desktop-client-id");
});

test("rejects missing, malformed, and web client imports without replacing configuration", async () => {
  const { root, source, store } = await fixture();
  await store.importOAuthClient(source);
  const original = await readFile(store.oauthClientPath, "utf8");

  await assert.rejects(store.importOAuthClient(join(root, "missing.json")), /not found/);
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{", "utf8");
  await assert.rejects(store.importOAuthClient(malformed), /not valid JSON/);
  const web = join(root, "web.json");
  await writeFile(web, JSON.stringify({ web: desktopClient.installed }), "utf8");
  await assert.rejects(store.importOAuthClient(web), /Web OAuth client/);

  assert.equal(await readFile(store.oauthClientPath, "utf8"), original);
});

test("stores accounts by stable subject hash and rejects duplicate identities", async () => {
  const { store } = await fixture();
  const account = await store.addAccount({ subject: "google-subject-1", email: "person@example.com" }, { refresh_token: "token-one" });
  assert.equal(account.subjectHash, googleSubjectHash("google-subject-1"));
  assert.deepEqual(await store.loadAccounts(), [{ subjectHash: account.subjectHash, email: "person@example.com" }]);
  assert.equal((await store.readToken(account.subjectHash)).refresh_token, "token-one");
  assert.equal((await stat(store.tokenPath(account.subjectHash))).mode & 0o777, 0o600);

  await assert.rejects(
    store.addAccount({ subject: "google-subject-1", email: "renamed@example.com" }, { refresh_token: "replacement" }),
    DuplicateAccountError,
  );
  assert.equal((await store.readToken(account.subjectHash)).refresh_token, "token-one");
});

test("a late refresh cannot recreate a removed token or overwrite a re-added credential", async () => {
  const { store } = await fixture();
  const first = await store.addAccount({ subject: "stable", email: "person@example.com" }, { refresh_token: "old-refresh", access_token: "old-access" });
  await store.removeAccount("person@example.com");
  assert.equal(await store.mergeToken(first.subjectHash, { access_token: "late-access" }, "old-refresh"), false);
  await assert.rejects(store.readToken(first.subjectHash), /credential is missing/);

  const second = await store.addAccount({ subject: "stable", email: "person@example.com" }, { refresh_token: "new-refresh", access_token: "new-access" });
  assert.equal(await store.mergeToken(second.subjectHash, { access_token: "late-access" }, "old-refresh"), false);
  assert.deepEqual(await store.readToken(second.subjectHash), { refresh_token: "new-refresh", access_token: "new-access" });
});

test("updates display email for the same identity and removes only the selected account", async () => {
  const { store } = await fixture();
  const first = await store.addAccount({ subject: "subject-1", email: "old@example.com" }, { refresh_token: "one" });
  const second = await store.addAccount({ subject: "subject-2", email: "other@example.com" }, { refresh_token: "two" });

  await store.updateAccountEmail(first.subjectHash, "new@example.com");
  assert.equal((await store.findAccountByEmail("new@example.com")).subjectHash, first.subjectHash);
  assert.equal(await store.removeAccount("new@example.com"), true);
  assert.deepEqual(await store.loadAccounts(), [{ subjectHash: second.subjectHash, email: "other@example.com" }]);
  assert.equal((await store.readToken(second.subjectHash)).refresh_token, "two");
  await assert.rejects(store.readToken(first.subjectHash), /credential is missing/);
});
