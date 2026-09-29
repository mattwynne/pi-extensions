import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { authorizeInBrowser, browserCommandForPlatform, createGoogleCalendarExtension, GOOGLE_CALENDAR_SCOPES } from "../extensions/google-calendar/extension.ts";
import { DuplicateAccountError, googleSubjectHash } from "../extensions/google-calendar/storage.ts";

class FakeStore {
  constructor(accounts = []) {
    this.accounts = accounts.map(account => ({ subjectHash: googleSubjectHash(account.subject), email: account.email }));
    this.tokens = new Map(accounts.map(account => [googleSubjectHash(account.subject), {
      refresh_token: `${account.subject}-refresh`,
      identity: { subject: account.subject, email: account.currentEmail ?? account.email },
    }]));
    this.hasClient = true;
    this.imported = [];
    this.removed = [];
  }

  async hasOAuthClient() { return this.hasClient; }
  async importOAuthClient(path) { this.hasClient = true; this.imported.push(path); return "/private/oauth-client.json"; }
  async readOAuthClient() {
    if (!this.hasClient) throw new Error("OAuth client is not configured");
    return { client_id: "client-id", client_secret: "client-secret", redirect_uris: ["http://localhost"] };
  }
  async loadAccounts() { return this.accounts.map(account => ({ ...account })); }
  async findAccountByEmail(email) {
    const account = this.accounts.find(candidate => candidate.email.toLowerCase() === email.toLowerCase());
    if (!account) throw new Error(`Unknown Google Calendar account "${email}".`);
    return { ...account };
  }
  async readToken(subjectHash) {
    const token = this.tokens.get(subjectHash);
    if (!token) throw new Error("Saved Google Calendar credential is missing.");
    return { ...token };
  }
  async mergeToken(subjectHash, token, expectedRefreshToken) {
    const current = this.tokens.get(subjectHash);
    if (!current || (expectedRefreshToken && current.refresh_token !== expectedRefreshToken)) return false;
    this.tokens.set(subjectHash, { ...current, ...token });
    return true;
  }
  async updateAccountEmail(subjectHash, email) {
    const account = this.accounts.find(candidate => candidate.subjectHash === subjectHash);
    if (account) account.email = email;
  }
  async addAccount(identity, tokens) {
    const subjectHash = googleSubjectHash(identity.subject);
    if (this.accounts.some(account => account.subjectHash === subjectHash)) throw new DuplicateAccountError(identity.email);
    const account = { subjectHash, email: identity.email };
    this.accounts.push(account);
    this.tokens.set(subjectHash, { ...tokens, identity });
    return { ...account };
  }
  async removeAccount(email) {
    const index = this.accounts.findIndex(account => account.email.toLowerCase() === email.toLowerCase());
    if (index < 0) return false;
    const [account] = this.accounts.splice(index, 1);
    this.tokens.delete(account.subjectHash);
    this.removed.push(email);
    return true;
  }
}

function fakeGoogle(calendarBehavior = {}) {
  const calls = { calendarList: [], insert: [], patch: [], move: [], delete: [], listEvents: [], freebusy: [] };
  class OAuth2 {
    constructor() { this.listeners = new Map(); }
    setCredentials(credentials) { this.credentials = credentials; }
    on(event, handler) { this.listeners.set(event, handler); }
  }
  const api = {
    auth: { OAuth2 },
    oauth2: () => ({ userinfo: { get: async () => ({ data: {} }) } }),
    calendar: ({ auth }) => {
      const email = auth.credentials.identity?.email;
      const behavior = calendarBehavior[email] ?? {};
      return {
        calendarList: {
          list: async request => {
            calls.calendarList.push(request);
            if (behavior.listError) throw behavior.listError;
            const pageIndex = request.pageToken ? Number(request.pageToken.slice(5)) : 0;
            const pages = behavior.calendarPages ?? [behavior.calendars ?? []];
            return { data: { items: pages[pageIndex] ?? [], nextPageToken: pageIndex + 1 < pages.length ? `page-${pageIndex + 1}` : undefined } };
          },
        },
        events: {
          list: async request => {
            calls.listEvents.push(request);
            if (behavior.eventError?.[request.calendarId]) throw behavior.eventError[request.calendarId];
            if (behavior.onEventList) await behavior.onEventList(request);
            const pageIndex = request.pageToken ? Number(request.pageToken.slice(5)) : 0;
            const pages = behavior.eventsByCalendar?.[request.calendarId] ?? behavior.eventPages ?? [behavior.events ?? []];
            return { data: { items: pages[pageIndex] ?? [], nextPageToken: pageIndex + 1 < pages.length ? `page-${pageIndex + 1}` : undefined } };
          },
          get: async request => ({ data: { id: request.eventId, summary: "Example" } }),
          insert: async request => {
            calls.insert.push(request);
            return { data: { id: "created", summary: request.requestBody.summary, htmlLink: "https://calendar.example/created" } };
          },
          patch: async request => {
            calls.patch.push(request);
            return { data: { id: request.eventId, summary: request.requestBody.summary ?? "Updated" } };
          },
          move: async request => {
            calls.move.push(request);
            return { data: { id: request.eventId, summary: "Moved" } };
          },
          delete: async request => { calls.delete.push(request); return { data: {} }; },
        },
        freebusy: {
          query: async request => { calls.freebusy.push(request); return { data: { calendars: {} } }; },
        },
      };
    },
  };
  return { api, calls };
}

function setup({ accounts = [], calendarBehavior = {}, hasClient = true, authorize, identityForClient } = {}) {
  const store = new FakeStore(accounts);
  store.hasClient = hasClient;
  const { api, calls } = fakeGoogle(calendarBehavior);
  const tools = new Map();
  const commands = new Map();
  const extension = createGoogleCalendarExtension({
    googleApi: api,
    store,
    identityForClient: identityForClient ?? (async client => client.credentials.identity),
    authorize: authorize ?? (async () => ({
      identity: { subject: "new-subject", email: "new@example.com" },
      tokens: { refresh_token: "new-refresh", identity: { subject: "new-subject", email: "new@example.com" } },
    })),
  });
  extension({
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
  });
  return { store, tools, commands, calls };
}

function uiFixture({ selections = [], inputs = [], confirms = [] } = {}) {
  const notifications = [];
  return {
    ctx: {
      hasUI: true,
      ui: {
        select: async () => selections.shift(),
        input: async () => inputs.shift(),
        confirm: async () => confirms.shift(),
        notify: (message, level) => notifications.push({ message, level }),
      },
    },
    notifications,
  };
}

function oauthFixture() {
  const tokenRequests = [];
  class OAuth2 {
    generateAuthUrl(options) {
      const url = new URL("https://accounts.google.test/authorize");
      for (const [key, value] of Object.entries(options)) {
        if (Array.isArray(value)) url.searchParams.set(key, value.join(" "));
        else url.searchParams.set(key, String(value));
      }
      return url.toString();
    }
    async getToken(request) {
      tokenRequests.push(request);
      return { tokens: { refresh_token: "refresh", access_token: "access" } };
    }
    setCredentials(credentials) { this.credentials = credentials; }
  }
  return { googleApi: { auth: { OAuth2 } }, tokenRequests };
}

function oauthContext() {
  const notifications = [];
  return { ctx: { ui: { notify: (message, level) => notifications.push({ message, level }) } }, notifications };
}

test("the Pi entrypoint keeps reloadable implementation modules in TypeScript", async () => {
  const index = await readFile(new URL("../extensions/google-calendar/index.ts", import.meta.url), "utf8");
  const extension = await readFile(new URL("../extensions/google-calendar/extension.ts", import.meta.url), "utf8");
  assert.match(index, /from "\.\/extension\.ts"/);
  assert.match(extension, /from "\.\/storage\.ts"/);
  assert.doesNotMatch(index + extension, /\.mjs["']/);
});

test("browser OAuth validates state, PKCE, and the loopback callback", async () => {
  const { googleApi, tokenRequests } = oauthFixture();
  const { ctx } = oauthContext();
  let authorizationRequest;
  const result = await authorizeInBrowser({
    keys: { client_id: "id", client_secret: "secret" },
    ctx,
    googleApi,
    identityForClient: async () => ({ subject: "subject", email: "person@example.com" }),
    launchBrowser: async authUrl => {
      const authorization = new URL(authUrl);
      authorizationRequest = authorization;
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "authorization-code");
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    },
    timeoutMs: 1_000,
  });
  assert.equal(result.identity.email, "person@example.com");
  assert.match(tokenRequests[0].redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
  assert.ok(tokenRequests[0].codeVerifier);
  assert.equal(authorizationRequest.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizationRequest.searchParams.get("code_challenge"));
  assert.notEqual(authorizationRequest.searchParams.get("code_challenge"), tokenRequests[0].codeVerifier);
});

test("browser OAuth rejects a callback with the wrong state", async () => {
  const { googleApi } = oauthFixture();
  const { ctx } = oauthContext();
  await assert.rejects(authorizeInBrowser({
    keys: { client_id: "id", client_secret: "secret" },
    ctx,
    googleApi,
    identityForClient: async () => ({ subject: "subject", email: "person@example.com" }),
    launchBrowser: async authUrl => {
      const authorization = new URL(authUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", "wrong-state");
      callback.searchParams.set("code", "authorization-code");
      await fetch(callback);
    },
    timeoutMs: 1_000,
  }), /state did not match/);
});

test("browser OAuth times out and a browser-launch failure provides a manual handoff", async () => {
  const first = oauthFixture();
  const timeoutContext = oauthContext();
  await assert.rejects(authorizeInBrowser({
    keys: { client_id: "id", client_secret: "secret" },
    ctx: timeoutContext.ctx,
    googleApi: first.googleApi,
    identityForClient: async () => ({ subject: "subject", email: "person@example.com" }),
    launchBrowser: async () => {},
    timeoutMs: 20,
  }), /timed out/);

  const second = oauthFixture();
  const fallbackContext = oauthContext();
  const result = await authorizeInBrowser({
    keys: { client_id: "id", client_secret: "secret" },
    ctx: fallbackContext.ctx,
    googleApi: second.googleApi,
    identityForClient: async () => ({ subject: "subject", email: "person@example.com" }),
    launchBrowser: async authUrl => {
      const authorization = new URL(authUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set("code", "authorization-code");
      setTimeout(() => void fetch(callback), 0);
      throw new Error("no browser");
    },
    timeoutMs: 1_000,
  });
  assert.equal(result.identity.email, "person@example.com");
  assert.ok(fallbackContext.notifications.some(entry => entry.level === "warning" && /Open this URL manually/.test(entry.message)));
});

test("uses a shell-safe browser launcher on Windows", () => {
  const url = "https://accounts.google.test/auth?one=1&two=2";
  assert.deepEqual(browserCommandForPlatform("win32", url), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
});

test("requests only the agreed identity, calendar-list, event, and availability scopes", () => {
  assert.deepEqual(GOOGLE_CALENDAR_SCOPES, [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ]);
});

test("registers /google-calendar and requires explicit account and calendar inputs", () => {
  const { tools, commands } = setup();
  assert.deepEqual([...commands.keys()], ["google-calendar"]);
  assert.deepEqual(tools.get("gcal_list_calendars").parameters.required ?? [], []);
  assert.deepEqual(tools.get("gcal_list_events").parameters.required, ["account", "calendarId"]);
  assert.ok(tools.get("gcal_get_event").parameters.required.includes("account"));
  assert.ok(tools.get("gcal_create_event").parameters.required.includes("account"));
  assert.ok(tools.get("gcal_update_event").parameters.required.includes("calendarId"));
  assert.ok(tools.get("gcal_delete_event").parameters.required.includes("calendarId"));
  assert.ok(tools.get("gcal_free_busy").parameters.required.includes("calendarIds"));
});

test("list-calendars preserves successful accounts and reports safe per-account failures", async () => {
  const accounts = [
    { subject: "good-subject", email: "good@example.com" },
    { subject: "bad-subject", email: "bad@example.com" },
  ];
  const { tools } = setup({
    accounts,
    calendarBehavior: {
      "good@example.com": { calendars: [{ id: "primary", summary: "Good calendar", primary: true }] },
      "bad@example.com": { listError: new Error("invalid_grant token provider payload") },
    },
  });
  const result = await tools.get("gcal_list_calendars").execute("call", {});
  assert.equal(result.details.accounts.length, 2);
  assert.equal(result.details.accounts[0].status, "ok");
  assert.equal(result.details.accounts[0].calendars[0].id, "primary");
  assert.equal(result.details.accounts[1].status, "error");
  assert.equal(result.details.accounts[1].reauthenticationRequired, true);
  assert.deepEqual(result.details.accounts[1].error, {
    code: "reauthentication_required",
    message: "Re-authentication required.",
  });
  assert.ok(!("calendars" in result.details.accounts[1]));
  assert.doesNotMatch(JSON.stringify(result), /provider payload/);
});

test("list-calendars follows every provider page", async () => {
  const { tools, calls } = setup({
    accounts: [{ subject: "paged", email: "paged@example.com" }],
    calendarBehavior: {
      "paged@example.com": { calendarPages: [[{ id: "one" }], [{ id: "two" }]] },
    },
  });
  const result = await tools.get("gcal_list_calendars").execute("call", {});
  assert.deepEqual(result.details.accounts[0].calendars.map(calendar => calendar.id), ["one", "two"]);
  assert.equal(calls.calendarList.length, 2);
  assert.equal(calls.calendarList[1].pageToken, "page-1");
});

test("transient health-check failures do not tell users to replace working credentials", async () => {
  const { tools } = setup({
    accounts: [{ subject: "offline", email: "offline@example.com" }],
    identityForClient: async () => { throw new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"); },
  });
  const result = await tools.get("gcal_auth_status").execute("call", {});
  assert.equal(result.details.accounts[0].status, "Connected");
  assert.equal(result.details.accounts[0].reauthenticationRequired, false);
});

test("refreshes a changed email for the same stable Google subject", async () => {
  const { tools, store } = setup({
    accounts: [{ subject: "stable-subject", email: "old@example.com", currentEmail: "new@example.com" }],
    calendarBehavior: { "new@example.com": { calendars: [] } },
  });
  const result = await tools.get("gcal_list_calendars").execute("call", {});
  assert.equal(result.details.accounts[0].accountEmail, "new@example.com");
  assert.equal(store.accounts[0].email, "new@example.com");
});

test("first-time settings import a Desktop client and add an account", async () => {
  const { store, commands } = setup({ hasClient: false });
  const { ctx, notifications } = uiFixture({
    selections: ["Add account", "Close"],
    inputs: ["~/Downloads/client.json"],
  });
  await commands.get("google-calendar").handler("", ctx);
  assert.deepEqual(store.imported, ["~/Downloads/client.json"]);
  assert.equal(store.accounts[0].email, "new@example.com");
  assert.ok(notifications.some(entry => entry.message === "Connected new@example.com." && entry.level === "success"));
});

test("cancelled OAuth leaves the account registry unchanged", async () => {
  const { store, commands } = setup({ authorize: async () => { throw new Error("Google authorization was cancelled or rejected."); } });
  const { ctx, notifications } = uiFixture({ selections: ["Add account", "Close"] });
  await commands.get("google-calendar").handler("", ctx);
  assert.deepEqual(store.accounts, []);
  assert.ok(notifications.some(entry => /cancelled or rejected/.test(entry.message) && entry.level === "error"));
});

test("adding an existing Google subject does not replace its credential", async () => {
  const existing = { subject: "same-subject", email: "person@example.com" };
  const { store, commands } = setup({
    accounts: [existing],
    authorize: async () => ({
      identity: { subject: "same-subject", email: "renamed@example.com" },
      tokens: { refresh_token: "replacement", identity: { subject: "same-subject", email: "renamed@example.com" } },
    }),
  });
  const originalToken = { ...store.tokens.get(googleSubjectHash("same-subject")) };
  const { ctx, notifications } = uiFixture({ selections: ["Add account", "Close"] });
  await commands.get("google-calendar").handler("", ctx);
  assert.deepEqual(store.tokens.get(googleSubjectHash("same-subject")), originalToken);
  assert.equal(store.accounts[0].email, "person@example.com");
  assert.ok(notifications.some(entry => /already connected/.test(entry.message) && entry.level === "warning"));
});

test("remove asks for confirmation and deletes only the selected local account", async () => {
  const accounts = [
    { subject: "one", email: "one@example.com" },
    { subject: "two", email: "two@example.com" },
  ];
  const { store, commands } = setup({ accounts });
  const { ctx } = uiFixture({
    selections: ["one@example.com — Connected", "Remove account", "Close"],
    confirms: [true],
  });
  await commands.get("google-calendar").handler("", ctx);
  assert.deepEqual(store.removed, ["one@example.com"]);
  assert.deepEqual(store.accounts.map(account => account.email), ["two@example.com"]);
});

test("declining remove changes nothing", async () => {
  const { store, commands } = setup({ accounts: [{ subject: "one", email: "one@example.com" }] });
  const { ctx } = uiFixture({
    selections: ["one@example.com — Connected", "Remove account", "Close"],
    confirms: [false],
  });
  await commands.get("google-calendar").handler("", ctx);
  assert.deepEqual(store.accounts.map(account => account.email), ["one@example.com"]);
});

test("mutation tools add no runtime confirmation and default notifications to none", async () => {
  const accounts = [{ subject: "writer", email: "writer@example.com" }];
  const { tools, calls } = setup({ accounts });

  await tools.get("gcal_create_event").execute("call", {
    account: "writer@example.com",
    calendarId: "primary",
    summary: "One day",
    start: "2026-10-01",
    allDay: true,
  });
  assert.equal(calls.insert[0].sendUpdates, "none");
  assert.deepEqual(calls.insert[0].requestBody.end, { date: "2026-10-02" });

  await tools.get("gcal_update_event").execute("call", {
    account: "writer@example.com",
    calendarId: "primary",
    eventId: "event-1",
    summary: "Changed",
  });
  assert.equal(calls.patch[0].sendUpdates, "none");

  await tools.get("gcal_delete_event").execute("call", {
    account: "writer@example.com",
    calendarId: "primary",
    eventId: "event-1",
  });
  assert.equal(calls.delete[0].sendUpdates, "none");
});

test("move plus edit applies the edits after moving and sends notifications at most once", async () => {
  const { tools, calls } = setup({ accounts: [{ subject: "writer", email: "writer@example.com" }] });
  await tools.get("gcal_update_event").execute("call", {
    account: "writer@example.com",
    calendarId: "source",
    eventId: "event-1",
    moveToCalendarId: "destination",
    summary: "Moved and renamed",
    sendUpdates: "all",
  });
  assert.equal(calls.move[0].sendUpdates, "none");
  assert.equal(calls.patch[0].calendarId, "destination");
  assert.equal(calls.patch[0].requestBody.summary, "Moved and renamed");
  assert.equal(calls.patch[0].sendUpdates, "all");
});

test("event listing follows pages up to the requested result limit", async () => {
  const { tools, calls } = setup({
    accounts: [{ subject: "reader", email: "reader@example.com" }],
    calendarBehavior: {
      "reader@example.com": { eventPages: [[{ id: "one" }, { id: "two" }], [{ id: "three" }]] },
    },
  });
  const result = await tools.get("gcal_list_events").execute("call", {
    account: "reader@example.com",
    calendarId: "primary",
    timeMin: "2026-01-01T00:00:00Z",
    timeMax: "2026-02-01T00:00:00Z",
    maxResults: 3,
  });
  assert.deepEqual(result.details.events.map(event => event.id), ["one", "two", "three"]);
  assert.equal(calls.listEvents.length, 2);
  assert.equal(calls.listEvents[1].maxResults, 1);
});

test("non-expanded recurring event queries omit startTime ordering", async () => {
  const { tools, calls } = setup({ accounts: [{ subject: "reader", email: "reader@example.com" }] });
  await tools.get("gcal_list_events").execute("call", {
    account: "reader@example.com",
    calendarId: "primary",
    timeMin: "2026-01-01T00:00:00Z",
    timeMax: "2026-02-01T00:00:00Z",
    singleEvents: false,
  });
  assert.equal(calls.listEvents[0].singleEvents, false);
  assert.ok(!("orderBy" in calls.listEvents[0]));
});

test("settings fail closed when no interactive or RPC UI is available", async () => {
  const { commands } = setup();
  await assert.rejects(
    commands.get("google-calendar").handler("", { hasUI: false, ui: {} }),
    /require an interactive Pi or an RPC client/,
  );
});

const window = { timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-02-01T00:00:00Z" };
const account = email => ({ subject: email, email });
const event = (id, start, extra = {}) => ({ id, summary: id, start: { dateTime: start }, ...extra });

test("aggregate search is model-visible and its schema requires both bounds and constrains selection/targets", () => {
  const { tools } = setup();
  const tool = tools.get("gcal_search_events");
  assert.match(tool.promptSnippet, /across connected calendars/i);
  assert.ok(tool.promptGuidelines.some(guideline => /instead of multiple gcal_list_events calls/i.test(guideline)));
  const schema = tool.parameters;
  assert.deepEqual(schema.required, ["timeMin", "timeMax"]);
  assert.deepEqual(schema.properties.calendarSelection.anyOf.map(option => option.const), ["selected", "primary", "all"]);
  assert.equal(schema.properties.accounts.minItems, 1);
  assert.equal(schema.properties.targets.minItems, 1);
  assert.deepEqual(schema.properties.targets.items.required, ["account", "calendarId"]);
});

test("aggregate search defaults to selected plus primary, supports primary/all and account filtering", async () => {
  const { tools, calls } = setup({ accounts: [account("a@test"), account("b@test")], calendarBehavior: {
    "a@test": { calendars: [{ id: "main", primary: true, summary: "Main" }, { id: "checked", selected: true }, { id: "hidden" }] },
    "b@test": { calendars: [{ id: "other", primary: true }] },
  } });
  const search = params => tools.get("gcal_search_events").execute("call", { ...window, ...params });
  const selected = await search({});
  assert.deepEqual(selected.details.searched.calendars.map(c => c.calendarId), ["main", "checked", "other"]);
  assert.deepEqual(calls.listEvents.map(c => c.calendarId), ["main", "checked", "other"]);
  calls.listEvents.length = 0;
  assert.deepEqual((await search({ accounts: ["a@test"], calendarSelection: "primary" })).details.searched.calendars.map(c => c.calendarId), ["main"]);
  assert.deepEqual(calls.listEvents.map(c => c.calendarId), ["main"]);
  calls.listEvents.length = 0;
  assert.deepEqual((await search({ accounts: ["a@test"], calendarSelection: "all" })).details.searched.calendars.map(c => c.calendarId), ["main", "checked", "hidden"]);
});

test("explicit targets bypass selection, retain summaries where possible, and deduplicate shared calendars", async () => {
  const { tools, calls } = setup({ accounts: [account("a@test"), account("b@test")], calendarBehavior: {
    "a@test": { calendars: [{ id: "shared", summary: "Shared" }] },
    "b@test": { calendars: [{ id: "shared", summary: "Other name" }] },
  } });
  const result = await tools.get("gcal_search_events").execute("call", { ...window, targets: [
    { account: "a@test", calendarId: "shared" }, { account: "b@test", calendarId: "shared" },
    { account: "b@test", calendarId: "unknown" },
  ] });
  assert.deepEqual(calls.listEvents.map(c => c.calendarId), ["shared", "unknown"]);
  assert.deepEqual(result.details.searched.calendars[0].accounts, ["a@test", "b@test"]);
  assert.equal(result.details.searched.calendars[0].summary, "Shared");
  assert.equal(result.details.searched.calendars[1].summary, "unknown");
});

test("aggregate search paginates, sorts, merges occurrence provenance, truncates after dedupe and renders sources", async () => {
  const shared = { iCalUID: "same@uid", location: "Hall" };
  const { tools, calls } = setup({ accounts: [account("a@test")], calendarBehavior: { "a@test": {
    calendars: [{ id: "one", selected: true, summary: "Work" }, { id: "two", selected: true, summary: "Home" }],
    eventsByCalendar: {
      one: [[event("late", "2026-01-04T10:00:00Z"), event("copy1", "2026-01-02T10:00:00Z", shared)], [event("early", "2026-01-01T10:00:00Z")]],
      two: [[event("copy2", "2026-01-02T10:00:00Z", shared), event("other-occurrence", "2026-01-03T10:00:00Z", shared)]],
    },
  } } });
  const result = await tools.get("gcal_search_events").execute("call", { ...window, maxResults: 2, q: "Hall", timeZone: "Europe/London" });
  assert.deepEqual(result.details.events.map(e => e.id), ["early", "copy1"]);
  assert.deepEqual(result.details.events[1].sources.map(s => s.calendarId), ["one", "two"]);
  assert.equal(result.details.truncated, true);
  assert.ok(calls.listEvents.some(c => c.pageToken === "page-1"));
  assert.ok(calls.listEvents.every(c => c.q === "Hall" && c.timeZone === "Europe/London" && c.singleEvents === true));
  assert.match(result.content[0].text, /2026-01-02.*copy1.*Work.*a@test.*Hall/);
});

test("aggregate search keeps partial successes with safe failures from discovery and event queries", async () => {
  const { tools } = setup({ accounts: [account("good@test"), account("bad@test")], calendarBehavior: {
    "good@test": { calendars: [{ id: "ok", primary: true }, { id: "fail", selected: true }], eventsByCalendar: { ok: [[event("found", "2026-01-02T00:00:00Z")]] }, eventError: { fail: new Error("secret /private/file") } },
    "bad@test": { listError: new Error("invalid_grant secret token /private/file") },
  } });
  const result = await tools.get("gcal_search_events").execute("call", window);
  assert.deepEqual(result.details.events.map(e => e.id), ["found"]);
  assert.equal(result.details.failures.length, 2);
  assert.deepEqual(result.details.failures.map(f => f.code), ["reauthentication_required", "event_list_failed"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|\/private\/file/);
});

test("aggregate event queries use bounded internal concurrency", async () => {
  let active = 0, peak = 0;
  const { tools } = setup({ accounts: [account("a@test")], calendarBehavior: { "a@test": {
    calendars: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, selected: true })),
    onEventList: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; },
  } } });
  await tools.get("gcal_search_events").execute("call", window);
  assert.ok(peak > 1 && peak <= 4, `peak concurrency: ${peak}`);
});

test("explicit targets still query when calendar-list metadata fails and use ID as summary", async () => {
  const { tools, calls } = setup({ accounts: [account("a@test")], calendarBehavior: {
    "a@test": { listError: new Error("internal /private/path"), events: [event("found", "2026-01-01T10:00:00Z")] },
  } });
  const result = await tools.get("gcal_search_events").execute("call", { ...window, targets: [{ account: "a@test", calendarId: "exact" }] });
  assert.deepEqual(calls.listEvents.map(c => c.calendarId), ["exact"]);
  assert.equal(result.details.events[0].sources[0].calendarSummary, "exact");
  assert.equal(result.details.failures.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /internal|\/private\/path/);
});

test("event copies with equivalent timestamp offsets merge; missing UID stays source-specific", async () => {
  const { tools } = setup({ accounts: [account("a@test")], calendarBehavior: { "a@test": {
    calendars: [{ id: "one", selected: true }, { id: "two", selected: true }],
    eventsByCalendar: {
      one: [[event("local", "2026-01-02T10:00:00+02:00", { iCalUID: "uid" }), event("same-id", "2026-01-02T07:00:00Z")]],
      two: [[event("remote", "2026-01-02T08:00:00Z", { iCalUID: "uid" }), event("same-id", "2026-01-02T07:00:00Z")]],
    },
  } } });
  const result = await tools.get("gcal_search_events").execute("call", window);
  assert.equal(result.details.events.length, 3);
  assert.deepEqual(result.details.events.find(e => e.iCalUID === "uid").sources.map(s => s.eventId), ["local", "remote"]);
  assert.deepEqual(result.details.events.map(e => e.id), ["same-id", "same-id", "local"]);
});

test("shared calendar retries another connected account when the first cannot read events", async () => {
  const { tools, calls } = setup({ accounts: [account("a@test"), account("b@test")], calendarBehavior: {
    "a@test": { calendars: [{ id: "shared", primary: true }], eventError: { shared: new Error("not permitted") } },
    "b@test": { calendars: [{ id: "shared", selected: true }], events: [event("found", "2026-01-01T10:00:00Z")] },
  } });
  const result = await tools.get("gcal_search_events").execute("call", window);
  assert.equal(calls.listEvents.length, 2);
  assert.deepEqual(result.details.events[0].sources.map(s => s.account), ["a@test", "b@test"]);
  assert.deepEqual(result.details.failures, []);
});
