import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { google } from "googleapis";
import { CalendarStore, DuplicateAccountError, googleSubjectHash } from "./storage.ts";

export const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

const OAUTH_TIMEOUT_MS = 5 * 60 * 1_000;
const accountSchema = Type.String({ description: "Connected Google account email. Required; there is no default account." });
const sendUpdatesSchema = Type.Optional(Type.Union([
  Type.Literal("none"),
  Type.Literal("all"),
  Type.Literal("externalOnly"),
], { description: "Send notifications: none (default), all, or externalOnly." }));

function isoRfc3339(date) {
  return date.toISOString();
}

function eventWindow(start, end) {
  const startValue = start?.dateTime ?? start?.date ?? "(undated)";
  const endValue = end?.dateTime ?? end?.date ?? "";
  return endValue ? `${startValue} → ${endValue}` : startValue;
}

function summarizeEvent(event) {
  const parts = [event.id ?? "(no id)", eventWindow(event.start, event.end), event.summary ?? "(no title)"];
  if (event.location) parts.push(`@${event.location}`);
  if (event.status) parts.push(`[${event.status}]`);
  if (event.start?.timeZone) parts.push(`tz=${event.start.timeZone}`);
  return parts.join(" | ");
}

function nextDate(dateOnly) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) throw new Error("All-day event dates must use YYYY-MM-DD.");
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("All-day event date is invalid.");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function safeAuthenticationError(error) {
  const status = error?.response?.status ?? error?.code;
  const reason = error?.response?.data?.error ?? error?.response?.data?.error_description;
  const message = String(error?.message ?? error ?? "");
  return status === 401
    || reason === "invalid_grant"
    || /credential|authenticated|authentication|invalid_grant|token|oauth client/i.test(message);
}

function safeAccountFailure(error) {
  const reauthenticationRequired = safeAuthenticationError(error);
  return {
    code: reauthenticationRequired ? "reauthentication_required" : "calendar_list_failed",
    message: reauthenticationRequired ? "Re-authentication required." : "Unable to list calendars for this account.",
    reauthenticationRequired,
  };
}

// Shared read paths: both the low-level tools and aggregate search use the same
// pagination and safe failure classification.
async function listCalendarPages(api) {
  const calendars = [];
  let pageToken;
  do {
    const response = await api.calendarList.list({ maxResults: 250, ...(pageToken ? { pageToken } : {}) });
    calendars.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return calendars;
}

async function listEventPages(api, request, limit = Infinity) {
  const events = [];
  let pageToken;
  do {
    const remaining = limit - events.length;
    if (remaining <= 0) break;
    const response = await api.events.list({ ...request, maxResults: Math.min(request.maxResults, remaining), ...(pageToken ? { pageToken } : {}) });
    events.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

function eventFailure(error) {
  const reauthenticationRequired = safeAuthenticationError(error);
  return {
    code: reauthenticationRequired ? "reauthentication_required" : "event_list_failed",
    message: reauthenticationRequired ? "Re-authentication required." : "Unable to list events for this calendar.",
    reauthenticationRequired,
  };
}

function addCalendarSource(sources, calendar, accountEmail, api) {
  if (!sources.has(calendar.id)) sources.set(calendar.id, {
    calendarId: calendar.id, summary: calendar.summary ?? calendar.id, accounts: [], connections: [],
  });
  const source = sources.get(calendar.id);
  if (source.summary === source.calendarId && calendar.summary) source.summary = calendar.summary;
  if (!source.accounts.includes(accountEmail)) {
    source.accounts.push(accountEmail);
    source.connections.push({ account: accountEmail, api });
  }
}

function mergeEvent(eventsByKey, event, source) {
  const occurrence = event.start?.dateTime ? new Date(event.start.dateTime).toISOString() : event.start?.date ?? "(undated)";
  const key = event.iCalUID
    ? JSON.stringify([event.iCalUID, occurrence])
    : JSON.stringify([source.calendarId, event.id ?? event.recurringEventId ?? event, occurrence]);
  if (!eventsByKey.has(key)) eventsByKey.set(key, { ...event, sources: [] });
  const entry = eventsByKey.get(key);
  for (const account of source.accounts) {
    if (!entry.sources.some(s => s.account === account && s.calendarId === source.calendarId)) {
      entry.sources.push({ account, calendarId: source.calendarId, calendarSummary: source.summary, eventId: event.id });
    }
  }
}

function startTimestamp(event) {
  const start = event.start?.dateTime ?? event.start?.date;
  return start ? Date.parse(start) || 0 : 0;
}

// Workers claim one index at a time; failures on one calendar never cancel others.
async function mapBounded(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

async function defaultIdentityForClient(client, googleApi) {
  const oauth2 = googleApi.oauth2({ version: "v2", auth: client });
  const response = await oauth2.userinfo.get();
  const subject = response.data.id;
  const email = response.data.email;
  if (!subject || !email || response.data.verified_email === false) {
    throw new Error("Google authorization did not return a verified email and stable subject identifier.");
  }
  return { subject, email };
}

function stateMatches(actual, expected) {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function browserCommandForPlatform(platform, url) {
  if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

function defaultBrowserLauncher(url) {
  const opener = browserCommandForPlatform(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function authorizeInBrowser({
  keys,
  ctx,
  googleApi = google,
  identityForClient = defaultIdentityForClient,
  launchBrowser = defaultBrowserLauncher,
  timeoutMs = OAUTH_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let client;
    let timer;
    let settled = false;
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const server = http.createServer(async (request, response) => {
      if (settled) {
        response.statusCode = 409;
        response.end("Authorization has already completed.");
        return;
      }
      try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (requestUrl.pathname !== "/oauth2callback") {
          response.statusCode = 404;
          response.end("Not found.");
          return;
        }
        if (!stateMatches(requestUrl.searchParams.get("state"), state)) {
          response.statusCode = 400;
          response.end("Authorization state did not match. You can return to Pi.");
          throw new Error("Google OAuth callback state did not match.");
        }
        if (requestUrl.searchParams.has("error")) {
          response.statusCode = 400;
          response.end("Authorization was not completed. You can return to Pi.");
          throw new Error("Google authorization was cancelled or rejected.");
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.statusCode = 400;
          response.end("No authorization code was provided. You can return to Pi.");
          throw new Error("Google OAuth callback did not include an authorization code.");
        }
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const tokenResponse = await client.getToken({ code, redirect_uri: redirectUri, codeVerifier });
        if (!tokenResponse.tokens.refresh_token) throw new Error("Google did not return a refresh token. Remove the app grant at Google and try again.");
        client.setCredentials(tokenResponse.tokens);
        const identity = await identityForClient(client, googleApi, tokenResponse.tokens);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Google Calendar authorization succeeded. You can return to Pi.");
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve({ identity, tokens: tokenResponse.tokens });
      } catch (error) {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("Google Calendar authorization failed. You can return to Pi.");
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(error);
        }
      }
    });

    server.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    server.listen(0, "127.0.0.1", async () => {
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        client = new googleApi.auth.OAuth2(keys.client_id, keys.client_secret, redirectUri);
        const authUrl = client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: GOOGLE_CALENDAR_SCOPES,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        try {
          await launchBrowser(authUrl);
          ctx.ui.notify("Opened Google authorization in your browser.", "info");
        } catch (error) {
          ctx.ui.notify(`Could not open a browser automatically (${error?.message ?? error}). Open this URL manually: ${authUrl}`, "warning");
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          server.close();
          reject(error);
        }
      }
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error("Google authorization timed out. No account was added."));
    }, timeoutMs);
  });
}

function requireUI(ctx) {
  if (!ctx.hasUI) throw new Error("Google Calendar settings require an interactive Pi or an RPC client that supports extension dialogs. No changes were made.");
}

export function createGoogleCalendarExtension({
  googleApi = google,
  store = new CalendarStore(),
  identityForClient = defaultIdentityForClient,
  authorize = authorizeInBrowser,
  launchBrowser = defaultBrowserLauncher,
} = {}) {
  async function connectAccount(accountInput) {
    const keys = await store.readOAuthClient();
    const savedAccount = await store.findAccountByEmail(accountInput);
    const token = await store.readToken(savedAccount.subjectHash);
    const client = new googleApi.auth.OAuth2(keys.client_id, keys.client_secret, keys.redirect_uris?.[0]);
    client.setCredentials(token);
    let expectedRefreshToken = token.refresh_token;
    client.on("tokens", tokens => {
      void store.mergeToken(savedAccount.subjectHash, tokens, expectedRefreshToken)
        .then(merged => {
          if (merged && tokens.refresh_token) expectedRefreshToken = tokens.refresh_token;
        })
        .catch(error => {
          console.error(`Could not persist refreshed Google Calendar credential for ${savedAccount.email}: ${error?.message ?? error}`);
        });
    });
    const identity = await identityForClient(client, googleApi, token);
    if (googleSubjectHash(identity.subject) !== savedAccount.subjectHash) {
      throw new Error("Saved Google credential belongs to a different identity. Remove and re-add this account.");
    }
    if (identity.email !== savedAccount.email) await store.updateAccountEmail(savedAccount.subjectHash, identity.email);
    return { client, account: { subjectHash: savedAccount.subjectHash, email: identity.email } };
  }

  async function discoverCalendars(emails, { retainConnectionOnListError = false } = {}) {
    return Promise.all(emails.map(async email => {
      let connection;
      try {
        connection = await connectAccount(email);
        const api = googleApi.calendar({ version: "v3", auth: connection.client });
        const calendars = await listCalendarPages(api);
        return { accountEmail: connection.account.email, requestedEmail: email, status: "ok", calendars, reauthenticationRequired: false, api };
      } catch (error) {
        const failure = safeAccountFailure(error);
        return {
          accountEmail: connection?.account.email ?? email,
          requestedEmail: email,
          status: "error",
          error: { code: failure.code, message: failure.message },
          reauthenticationRequired: failure.reauthenticationRequired,
          ...(retainConnectionOnListError && connection ? { api: googleApi.calendar({ version: "v3", auth: connection.client }), calendars: [] } : {}),
        };
      }
    }));
  }

  async function accountStatuses() {
    const accounts = await store.loadAccounts();
    return Promise.all(accounts.map(async account => {
      try {
        const connected = await connectAccount(account.email);
        return { email: connected.account.email, status: "Connected", reauthenticationRequired: false };
      } catch (error) {
        if (safeAuthenticationError(error)) {
          return { email: account.email, status: "Re-authentication required", reauthenticationRequired: true };
        }
        return { email: account.email, status: "Connected", reauthenticationRequired: false };
      }
    }));
  }

  async function importOAuthClient(ctx) {
    requireUI(ctx);
    const sourcePath = await ctx.ui.input("Import Google Desktop OAuth client", "Path to the downloaded JSON file");
    if (!sourcePath?.trim()) return false;
    const destination = await store.importOAuthClient(sourcePath);
    ctx.ui.notify(`Google Calendar OAuth client saved in ${destination}.`, "success");
    return true;
  }

  async function addAccount(ctx) {
    requireUI(ctx);
    if (!(await store.hasOAuthClient())) {
      ctx.ui.notify("Import a Google Desktop OAuth client before adding an account.", "info");
      if (!(await importOAuthClient(ctx))) return false;
    }
    const keys = await store.readOAuthClient();
    const result = await authorize({ keys, ctx, googleApi, identityForClient, launchBrowser });
    const account = await store.addAccount(result.identity, result.tokens);
    ctx.ui.notify(`Connected ${account.email}.`, "success");
    return true;
  }

  async function removeAccount(ctx, email) {
    const confirmed = await ctx.ui.confirm(`Remove ${email}?`, "This deletes only the local Calendar credential. It does not revoke access at Google.");
    if (!confirmed) return false;
    await store.removeAccount(email);
    ctx.ui.notify(`Removed ${email}.`, "success");
    return true;
  }

  async function openSettings(ctx) {
    requireUI(ctx);
    while (true) {
      const statuses = await accountStatuses();
      const accounts = await store.loadAccounts();
      const hasClient = await store.hasOAuthClient();
      const rows = statuses.map(status => `${status.email} — ${status.status}`);
      const actions = ["Add account"];
      if (!hasClient) actions.push("Import OAuth client");
      else if (accounts.length === 0) actions.push("Replace OAuth client");
      actions.push("Close");
      const title = rows.length ? "Google Calendar accounts" : "Google Calendar accounts — none connected";
      const choice = await ctx.ui.select(title, [...rows, ...actions]);
      if (!choice || choice === "Close") return;
      const rowIndex = rows.indexOf(choice);
      if (rowIndex >= 0) {
        const email = statuses[rowIndex].email;
        const accountAction = await ctx.ui.select(`${email} — ${statuses[rowIndex].status}`, ["Remove account", "Back"]);
        if (accountAction === "Remove account") await removeAccount(ctx, email);
        continue;
      }
      try {
        if (choice === "Add account") await addAccount(ctx);
        else if (choice === "Import OAuth client" || choice === "Replace OAuth client") await importOAuthClient(ctx);
      } catch (error) {
        const level = error instanceof DuplicateAccountError ? "warning" : "error";
        ctx.ui.notify(error?.message ?? String(error), level);
      }
    }
  }

  return function googleCalendarExtension(pi) {
    pi.registerTool({
      name: "gcal_auth_status",
      label: "Google Calendar Auth Status",
      description: "Report which Google Calendar accounts are connected and which require re-authentication.",
      parameters: Type.Object({}),
      async execute() {
        const accounts = await accountStatuses();
        const text = accounts.length
          ? accounts.map(account => `${account.email}: ${account.status}`).join("\n")
          : "No Google Calendar accounts connected. Run /google-calendar to add one.";
        return { content: [{ type: "text", text }], details: { accounts } };
      },
    });

    pi.registerTool({
      name: "gcal_list_calendars",
      label: "Google Calendar List Calendars",
      description: "List calendars across every connected Google account, preserving successful results when another account fails.",
      promptSnippet: "List Google Calendar calendars across connected accounts",
      parameters: Type.Object({}),
      async execute() {
        const accounts = (await discoverCalendars((await store.loadAccounts()).map(account => account.email)))
          .map(({ api, requestedEmail, ...result }) => result);
        const lines = [];
        for (const result of accounts) {
          lines.push(`${result.accountEmail}: ${result.status === "ok" ? `${result.calendars.length} calendar(s)` : result.error.message}`);
          for (const calendar of result.calendars ?? []) {
            const flags = [];
            if (calendar.primary) flags.push("primary");
            if (calendar.selected) flags.push("selected");
            lines.push(`  ${calendar.summary ?? "(unnamed)"} | id=${calendar.id} | role=${calendar.accessRole ?? "?"} | tz=${calendar.timeZone ?? "?"}${flags.length ? ` | ${flags.join(",")}` : ""}`);
          }
        }
        if (!lines.length) lines.push("No Google Calendar accounts connected. Run /google-calendar to add one.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { accounts } };
      },
    });

    pi.registerTool({
      name: "gcal_list_events",
      label: "Google Calendar List Events",
      description: "List events in one explicitly selected account and calendar. Defaults to the next 30 days.",
      promptSnippet: "List Google Calendar events for an account",
      parameters: Type.Object({
        account: accountSchema,
        calendarId: Type.String({ description: "Calendar ID from gcal_list_calendars." }),
        timeMin: Type.Optional(Type.String({ description: "RFC3339 start (default: now)." })),
        timeMax: Type.Optional(Type.String({ description: "RFC3339 end (default: now + 30 days)." })),
        maxResults: Type.Optional(Type.Number({ description: "Max events. Defaults to 100, maximum 2500." })),
        q: Type.Optional(Type.String({ description: "Free-text search across event fields." })),
        timeZone: Type.Optional(Type.String({ description: "Optional timezone for interpreting timeMin/timeMax." })),
        singleEvents: Type.Optional(Type.Boolean({ description: "Expand recurring events into single instances. Defaults to true." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const calendarApi = googleApi.calendar({ version: "v3", auth: client });
        const now = new Date();
        const timeMin = params.timeMin ?? isoRfc3339(now);
        const timeMax = params.timeMax ?? isoRfc3339(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
        const singleEvents = params.singleEvents ?? true;
        const request = {
          calendarId: params.calendarId,
          timeMin,
          timeMax,
          maxResults: Math.max(1, Math.min(2500, params.maxResults ?? 100)),
          singleEvents,
        };
        if (singleEvents) request.orderBy = "startTime";
        if (params.q) request.q = params.q;
        if (params.timeZone) request.timeZone = params.timeZone;
        const events = await listEventPages(calendarApi, request, params.maxResults ?? 100);
        const text = events.length ? events.map(summarizeEvent).join("\n") : `No events in ${params.calendarId} between ${timeMin} and ${timeMax}.`;
        return { content: [{ type: "text", text }], details: { account: account.email, calendarId: params.calendarId, timeMin, timeMax, count: events.length, events } };
      },
    });

    pi.registerTool({
      name: "gcal_search_events",
      label: "Google Calendar Search Events",
      description: "Search a time range across connected calendars, preserving partial successes and source calendars.",
      promptSnippet: "Search Google Calendar events across connected calendars in one call",
      promptGuidelines: [
        "Use gcal_search_events instead of multiple gcal_list_events calls when the user asks for an agenda or events across accounts/calendars.",
      ],
      parameters: Type.Object({
        timeMin: Type.String({ description: "Required RFC3339 start." }),
        timeMax: Type.String({ description: "Required RFC3339 end." }),
        calendarSelection: Type.Optional(Type.Union([Type.Literal("selected"), Type.Literal("primary"), Type.Literal("all")])),
        accounts: Type.Optional(Type.Array(accountSchema, { minItems: 1 })),
        targets: Type.Optional(Type.Array(Type.Object({ account: accountSchema, calendarId: Type.String() }), { minItems: 1 })),
        q: Type.Optional(Type.String()),
        timeZone: Type.Optional(Type.String()),
        maxResults: Type.Optional(Type.Number({ description: "Aggregate maximum; defaults to 100, clamped to 1..2500." })),
      }),
      async execute(_id, params) {
        const saved = await store.loadAccounts();
        const wanted = params.targets ? [...new Set(params.targets.map(target => target.account))] : params.accounts ?? saved.map(a => a.email);
        const discovered = await discoverCalendars(wanted, { retainConnectionOnListError: Boolean(params.targets) });
        const failures = discovered.filter(result => result.status === "error").map(result => ({
          account: result.accountEmail, ...result.error, reauthenticationRequired: result.reauthenticationRequired,
        }));
        const sources = new Map();
        for (const result of discovered.filter(result => result.api)) {
          const requested = params.targets?.filter(t => t.account.toLowerCase() === result.requestedEmail.toLowerCase());
          const calendars = requested
            ? requested.map(t => result.calendars.find(c => c.id === t.calendarId) ?? { id: t.calendarId })
            : result.calendars.filter(c => params.calendarSelection === "all" || (params.calendarSelection === "primary" ? c.primary : c.primary || c.selected));
          for (const calendar of calendars) {
            addCalendarSource(sources, calendar, result.accountEmail, result.api);
          }
        }
        const calendars = [...sources.values()];
        const results = await mapBounded(calendars, 4, async source => {
          let failure;
          for (const connection of source.connections) {
            try {
              return { events: await listEventPages(connection.api, {
                calendarId: source.calendarId, timeMin: params.timeMin, timeMax: params.timeMax,
                maxResults: 2500, singleEvents: true, orderBy: "startTime",
                ...(params.q ? { q: params.q } : {}),
                ...(params.timeZone ? { timeZone: params.timeZone } : {}),
              }) };
            } catch (error) {
              failure = { account: connection.account, calendarId: source.calendarId, ...eventFailure(error) };
            }
          }
          return { failure };
        });
        const byKey = new Map();
        for (const [index, source] of calendars.entries()) {
          if (results[index].failure) failures.push(results[index].failure);
          for (const event of results[index].events ?? []) mergeEvent(byKey, event, source);
        }
        const sorted = [...byKey.values()].sort((a, b) => startTimestamp(a) - startTimestamp(b));
        const limit = Math.max(1, Math.min(2500, Math.trunc(params.maxResults ?? 100) || 1));
        const events = sorted.slice(0, limit);
        const lines = events.map(event => `${eventWindow(event.start, event.end)} | ${event.summary ?? "(no title)"} | ${event.sources.map(s => `${s.calendarSummary} (${s.account})`).join(", ")}${event.location ? ` | ${event.location}` : ""}`);
        if (!lines.length) lines.push("No events found in the requested time range.");
        for (const failure of failures) lines.push(`${failure.account}${failure.calendarId ? ` / ${failure.calendarId}` : ""}: ${failure.message}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { events, failures, searched: { accounts: wanted, calendars: calendars.map(({ connections, ...source }) => source) }, truncated: sorted.length > limit } };
      },
    });

    pi.registerTool({
      name: "gcal_get_event",
      label: "Google Calendar Get Event",
      description: "Read a single event by ID from an explicitly selected account and calendar.",
      promptSnippet: "Read a Google Calendar event",
      parameters: Type.Object({
        account: accountSchema,
        calendarId: Type.String({ description: "Calendar ID." }),
        eventId: Type.String({ description: "Event ID." }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const response = await googleApi.calendar({ version: "v3", auth: client }).events.get({ calendarId: params.calendarId, eventId: params.eventId });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }], details: { account: account.email, event: response.data } };
      },
    });

    pi.registerTool({
      name: "gcal_create_event",
      label: "Google Calendar Create Event",
      description: "Create an event in an explicitly selected account and calendar. This first iteration does not enforce a runtime confirmation dialog.",
      promptSnippet: "Create Google Calendar events",
      promptGuidelines: [
        "Use gcal_create_event only when the user explicitly asks to create a calendar event.",
        "For timed events pass ISO start/end plus timeZone. For all-day events set allDay=true and use YYYY-MM-DD.",
        "By default invites are NOT sent (sendUpdates=none). Set sendUpdates=all only when attendees should be emailed an invite.",
      ],
      parameters: Type.Object({
        account: accountSchema,
        calendarId: Type.String({ description: "Calendar ID from gcal_list_calendars." }),
        summary: Type.String({ description: "Event title." }),
        start: Type.String({ description: "Start datetime (ISO) or date (YYYY-MM-DD when allDay)." }),
        end: Type.Optional(Type.String({ description: "End datetime (ISO) or exclusive end date. Required for timed events; a one-day all-day event defaults to the next date." })),
        description: Type.Optional(Type.String({ description: "Event description/notes." })),
        location: Type.Optional(Type.String({ description: "Location." })),
        timeZone: Type.Optional(Type.String({ description: "Event timezone, e.g. America/Vancouver. Ignored for all-day." })),
        allDay: Type.Optional(Type.Boolean({ description: "Create an all-day event. Defaults to false." })),
        attendees: Type.Optional(Type.Array(Type.String(), { description: "Attendee email addresses (only emailed if sendUpdates is set)." })),
        sendUpdates: sendUpdatesSchema,
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const calendarApi = googleApi.calendar({ version: "v3", auth: client });
        const allDay = params.allDay ?? false;
        const start = allDay ? { date: params.start } : { dateTime: params.start, timeZone: params.timeZone };
        const end = params.end
          ? allDay ? { date: params.end } : { dateTime: params.end, timeZone: params.timeZone }
          : allDay ? { date: nextDate(params.start) } : undefined;
        if (!allDay && !end) throw new Error("An end datetime is required for non-all-day events.");
        const event = { summary: params.summary, start, end };
        if (params.description) event.description = params.description;
        if (params.location) event.location = params.location;
        if (params.attendees?.length) event.attendees = params.attendees.map(email => ({ email }));
        const response = await calendarApi.events.insert({ calendarId: params.calendarId, requestBody: event, sendUpdates: params.sendUpdates ?? "none" });
        const created = response.data;
        return {
          content: [{ type: "text", text: `Created "${created.summary}" (${created.id}) in ${params.calendarId}. ${created.htmlLink ?? ""}` }],
          details: { account: account.email, calendarId: params.calendarId, eventId: created.id, htmlLink: created.htmlLink, event: created },
        };
      },
    });

    pi.registerTool({
      name: "gcal_update_event",
      label: "Google Calendar Update Event",
      description: "Update or move an event in an explicitly selected account and calendar. This first iteration does not enforce a runtime confirmation dialog.",
      promptSnippet: "Update Google Calendar events",
      promptGuidelines: [
        "Use gcal_update_event only when the user explicitly asks to change a calendar event.",
        "When rescheduling a timed event, pass BOTH start and end. For an all-day event use date-only strings.",
        "By default attendee notifications are NOT sent (sendUpdates=none).",
      ],
      parameters: Type.Object({
        account: accountSchema,
        calendarId: Type.String({ description: "Current calendar ID." }),
        eventId: Type.String({ description: "Event ID." }),
        summary: Type.Optional(Type.String({ description: "New title." })),
        description: Type.Optional(Type.String({ description: "New description." })),
        location: Type.Optional(Type.String({ description: "New location." })),
        start: Type.Optional(Type.String({ description: "New start (ISO datetime, or YYYY-MM-DD for all-day)." })),
        end: Type.Optional(Type.String({ description: "New end (ISO datetime, or exclusive YYYY-MM-DD for all-day)." })),
        timeZone: Type.Optional(Type.String({ description: "Timezone to apply to moved start/end." })),
        moveToCalendarId: Type.Optional(Type.String({ description: "Move the event to this calendar ID instead of patching." })),
        sendUpdates: sendUpdatesSchema,
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const calendarApi = googleApi.calendar({ version: "v3", auth: client });
        const updates = {};
        if (params.summary !== undefined) updates.summary = params.summary;
        if (params.description !== undefined) updates.description = params.description;
        if (params.location !== undefined) updates.location = params.location;
        if (params.start !== undefined || params.end !== undefined) {
          if (!params.start || !params.end) throw new Error("Rescheduling requires both start and end.");
          const isDate = /^\d{4}-\d{2}-\d{2}$/.test(params.start) && /^\d{4}-\d{2}-\d{2}$/.test(params.end);
          updates.start = isDate ? { date: params.start } : { dateTime: params.start, timeZone: params.timeZone };
          updates.end = isDate ? { date: params.end } : { dateTime: params.end, timeZone: params.timeZone };
        }
        const sendUpdates = params.sendUpdates ?? "none";
        let response;
        if (params.moveToCalendarId) {
          const hasUpdates = Object.keys(updates).length > 0;
          response = await calendarApi.events.move({
            calendarId: params.calendarId,
            eventId: params.eventId,
            destination: params.moveToCalendarId,
            sendUpdates: hasUpdates ? "none" : sendUpdates,
          });
          if (hasUpdates) {
            response = await calendarApi.events.patch({
              calendarId: params.moveToCalendarId,
              eventId: response.data.id ?? params.eventId,
              requestBody: updates,
              sendUpdates,
            });
          }
        } else {
          response = await calendarApi.events.patch({ calendarId: params.calendarId, eventId: params.eventId, requestBody: updates, sendUpdates });
        }
        const updated = response.data;
        return {
          content: [{ type: "text", text: `Updated "${updated.summary}" (${updated.id}). ${updated.htmlLink ?? ""}` }],
          details: { account: account.email, eventId: updated.id, htmlLink: updated.htmlLink, event: updated },
        };
      },
    });

    pi.registerTool({
      name: "gcal_delete_event",
      label: "Google Calendar Delete Event",
      description: "Delete an event from an explicitly selected account and calendar. This first iteration does not enforce a runtime confirmation dialog.",
      promptSnippet: "Delete Google Calendar events",
      promptGuidelines: [
        "Use gcal_delete_event only when the user explicitly asks to delete a calendar event.",
        "By default attendee notifications are NOT sent (sendUpdates=none).",
      ],
      parameters: Type.Object({
        account: accountSchema,
        calendarId: Type.String({ description: "Calendar ID." }),
        eventId: Type.String({ description: "Event ID." }),
        sendUpdates: sendUpdatesSchema,
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        await googleApi.calendar({ version: "v3", auth: client }).events.delete({
          calendarId: params.calendarId,
          eventId: params.eventId,
          sendUpdates: params.sendUpdates ?? "none",
        });
        return { content: [{ type: "text", text: `Deleted event ${params.eventId} from ${params.calendarId}.` }], details: { account: account.email, calendarId: params.calendarId, eventId: params.eventId } };
      },
    });

    pi.registerTool({
      name: "gcal_free_busy",
      label: "Google Calendar Free Busy",
      description: "Query busy periods for explicitly selected calendars in one connected account.",
      promptSnippet: "Query Google Calendar free/busy",
      parameters: Type.Object({
        account: accountSchema,
        timeMin: Type.String({ description: "RFC3339 start of the window to check." }),
        timeMax: Type.String({ description: "RFC3339 end of the window to check." }),
        calendarIds: Type.Array(Type.String(), { minItems: 1, description: "Calendar IDs to check; at least one is required." }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const response = await googleApi.calendar({ version: "v3", auth: client }).freebusy.query({
          requestBody: { timeMin: params.timeMin, timeMax: params.timeMax, items: params.calendarIds.map(id => ({ id })) },
        });
        const calendars = response.data.calendars ?? {};
        const lines = [];
        for (const id of params.calendarIds) {
          const entry = calendars[id];
          if (!entry) {
            lines.push(`${id}: no data`);
            continue;
          }
          if (entry.errors?.length) {
            lines.push(`${id}: errors ${entry.errors.map(error => error.reason ?? String(error)).join(", ")}`);
            continue;
          }
          const busy = entry.busy ?? [];
          lines.push(`${id}: ${busy.length} busy block(s)`);
          for (const block of busy) lines.push(`   ${block.start} → ${block.end}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { account: account.email, timeMin: params.timeMin, timeMax: params.timeMax, calendars } };
      },
    });

    pi.registerCommand("google-calendar", {
      description: "Open Google Calendar account and OAuth settings.",
      handler: async (_args, ctx) => openSettings(ctx),
    });
  };
}

export default createGoogleCalendarExtension();
