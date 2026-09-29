import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { google } from "googleapis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveStore, DuplicateAccountError, googleSubjectHash } from "./storage.ts";

export const GOOGLE_DRIVE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
];

const OAUTH_TIMEOUT_MS = 5 * 60 * 1_000;
const accountSchema = Type.String({ description: "Connected Google account email. Required; there is no default account." });

function safeAuthenticationError(error) {
  const status = error?.response?.status ?? error?.code;
  const reason = error?.response?.data?.error ?? error?.response?.data?.error_description;
  const message = String(error?.message ?? error ?? "");
  return status === 401
    || reason === "invalid_grant"
    || /credential|authenticated|authentication|invalid_grant|token|oauth client/i.test(message);
}

async function identityForClient(client, googleApi) {
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
  identityForClient: resolveIdentity = identityForClient,
  launchBrowser = defaultBrowserLauncher,
  scopes = GOOGLE_DRIVE_SCOPES,
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
        const identity = await resolveIdentity(client, googleApi, tokenResponse.tokens);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Google Drive authorization succeeded. You can return to Pi.");
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve({ identity, tokens: tokenResponse.tokens });
      } catch (error) {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("Google Drive authorization failed. You can return to Pi.");
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
          scope: scopes,
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
  if (!ctx.hasUI) throw new Error("Google Drive settings require an interactive Pi or an RPC client that supports extension dialogs. No changes were made.");
}

// ---------- Doc / Sheet / Slide / Drive id + URL helpers ----------

function docIdFrom(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}
function docUrl(id) {
  return `https://docs.google.com/document/d/${id}/edit`;
}
function spreadsheetIdFrom(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}
function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
function presentationIdFrom(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}
function slideObjectIdFrom(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/[#&]slide=id\.([a-zA-Z0-9_:\-]+)/);
  return match?.[1] ?? trimmed;
}
function presentationUrl(id) {
  return `https://docs.google.com/presentation/d/${id}/edit`;
}
function slideUrl(presentationId, slideId) {
  return `${presentationUrl(presentationId)}${slideId ? `#slide=id.${slideId}` : ""}`;
}
function driveFileIdFrom(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/(?:document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    ?? trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}
function driveFolderUrl(id) {
  return `https://drive.google.com/drive/folders/${id}`;
}
function escapeDriveQueryString(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function quoteSheetName(name) {
  return `'${name.replace(/'/g, "''")}'`;
}
function objectId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

// ---------- Docs text/structure helpers ----------

function extractText(doc) {
  const chunks = [];
  for (const element of doc.body?.content ?? []) {
    for (const child of element.paragraph?.elements ?? []) {
      const text = child.textRun?.content;
      if (text) chunks.push(text);
    }
  }
  return chunks.join("");
}

async function endIndex(docsApi, documentId) {
  const res = await docsApi.documents.get({ documentId, fields: "body/content/endIndex" });
  const content = res.data.body?.content ?? [];
  return content.at(-1)?.endIndex ?? 1;
}

function namedStyleFor(type) {
  switch (type.toLowerCase()) {
    case "title": return "TITLE";
    case "subtitle": return "SUBTITLE";
    case "heading1": case "heading_1": case "h1": return "HEADING_1";
    case "heading2": case "heading_2": case "h2": return "HEADING_2";
    case "heading3": case "heading_3": case "h3": return "HEADING_3";
    case "heading4": case "heading_4": case "h4": return "HEADING_4";
    case "heading5": case "heading_5": case "h5": return "HEADING_5";
    case "heading6": case "heading_6": case "h6": return "HEADING_6";
    case "paragraph": case "normal": return "NORMAL_TEXT";
    default: return undefined;
  }
}

function buildStyledRequests(blocks, insertIndex) {
  let text = "";
  let cursor = insertIndex;
  const styleRequests = [];
  for (const block of blocks) {
    const type = block.type.toLowerCase();
    if (type === "bullets" || type === "bullet_list" || type === "numbered" || type === "numbered_list") {
      const items = block.items ?? [];
      if (!items.length) continue;
      const blockText = items.map(item => item.trim()).filter(Boolean).map(item => `${item}\n`).join("");
      if (!blockText) continue;
      const startIndex = cursor;
      const endIndex = cursor + blockText.length;
      text += blockText;
      cursor = endIndex;
      styleRequests.push({
        createParagraphBullets: {
          range: { startIndex, endIndex },
          bulletPreset: type.startsWith("numbered") ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
        },
      });
      continue;
    }
    const blockText = `${block.text ?? ""}\n`;
    if (blockText === "\n" && type !== "spacer") continue;
    const startIndex = cursor;
    const endIndex = cursor + blockText.length;
    text += blockText;
    cursor = endIndex;
    const namedStyleType = namedStyleFor(type);
    if (namedStyleType) {
      styleRequests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex },
          paragraphStyle: { namedStyleType },
          fields: "namedStyleType",
        },
      });
    }
  }
  return { text, requests: text ? [{ insertText: { location: { index: insertIndex }, text } }, ...styleRequests] : [] };
}

function paragraphText(paragraph) {
  return (paragraph?.elements ?? []).map(element => element.textRun?.content ?? "").join("");
}

function paragraphsFrom(doc) {
  return (doc.body?.content ?? [])
    .filter(element => element.paragraph)
    .map(element => ({
      startIndex: element.startIndex ?? 1,
      endIndex: element.endIndex ?? 1,
      text: paragraphText(element.paragraph),
      namedStyleType: element.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT",
    }));
}

function findParagraph(doc, text, matchCase = false) {
  const needle = matchCase ? text : text.toLowerCase();
  return paragraphsFrom(doc).find(paragraph => {
    const haystack = matchCase ? paragraph.text : paragraph.text.toLowerCase();
    return haystack.includes(needle);
  });
}

function findHeading(doc, headingText, matchCase = false) {
  const needle = (matchCase ? headingText : headingText.toLowerCase()).trim();
  return paragraphsFrom(doc).find(paragraph => {
    if (!String(paragraph.namedStyleType).startsWith("HEADING_") && paragraph.namedStyleType !== "TITLE" && paragraph.namedStyleType !== "SUBTITLE") return false;
    return (matchCase ? paragraph.text : paragraph.text.toLowerCase()).trim().includes(needle);
  });
}

function tablesFrom(doc) {
  return (doc.body?.content ?? [])
    .filter(element => element.table)
    .map(element => ({ startIndex: element.startIndex ?? 1, endIndex: element.endIndex ?? 1, table: element.table }));
}

function tableCellInsertIndex(cell) {
  const firstContent = cell.content?.[0];
  if (!firstContent) return undefined;
  return (firstContent.startIndex ?? cell.startIndex ?? 1) + 1;
}

async function insertTableAt(docsApi, documentId, insertIndex, rows, headerRow = true) {
  const rowCount = rows.length;
  const columnCount = Math.max(...rows.map(row => row.length));
  if (rowCount <= 0 || columnCount <= 0) throw new Error("Table must have at least one row and one column");
  await docsApi.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertTable: { rows: rowCount, columns: columnCount, location: { index: insertIndex } } }] },
  });
  const res = await docsApi.documents.get({ documentId });
  const table = tablesFrom(res.data).filter(c => c.startIndex >= insertIndex).sort((a, b) => a.startIndex - b.startIndex)[0] ?? tablesFrom(res.data).at(-1);
  if (!table) throw new Error("Inserted table could not be found");
  const requests = [];
  for (let r = 0; r < rowCount; r++) {
    const tableRow = table.table.tableRows?.[r];
    for (let c = 0; c < columnCount; c++) {
      const cell = tableRow?.tableCells?.[c];
      const text = rows[r]?.[c] ?? "";
      const index = cell ? tableCellInsertIndex(cell) : undefined;
      if (index === undefined || !text) continue;
      requests.push({ insertText: { location: { index }, text } });
      if (headerRow && r === 0) {
        requests.push({ updateTextStyle: { range: { startIndex: index, endIndex: index + text.length }, textStyle: { bold: true }, fields: "bold" } });
      }
    }
  }
  requests.sort((a, b) => (a.insertText?.location?.index ?? a.updateTextStyle?.range?.startIndex ?? 0) - (b.insertText?.location?.index ?? b.updateTextStyle?.range?.startIndex ?? 0));
  if (requests.length) await docsApi.documents.batchUpdate({ documentId, requestBody: { requests } });
  return { startIndex: table.startIndex, endIndex: table.endIndex, rowCount, columnCount };
}

// ---------- Slides helpers ----------

const PAGE_WIDTH_PT = 720;
const PAGE_HEIGHT_PT = 405;

function textFromTextElements(textElements) {
  return (textElements ?? []).map(element => element.textRun?.content ?? "").join("");
}

function textFromPageElement(element) {
  if (element.shape?.text) return textFromTextElements(element.shape.text.textElements);
  if (element.table?.tableRows) {
    const rows = element.table.tableRows.map(row => {
      const cells = row.tableCells ?? [];
      return cells.map(cell => textFromTextElements(cell.text?.textElements).trim()).join("\t");
    });
    return rows.join("\n");
  }
  return "";
}

function slideLines(presentation) {
  return (presentation.slides ?? []).map((slide, index) => {
    const texts = (slide.pageElements ?? []).map(element => textFromPageElement(element).trim()).filter(Boolean);
    return [`Slide ${index + 1} (${slide.objectId})`, texts.length ? texts.join("\n") : "(no text)"].join("\n");
  });
}

async function truncateForTool(text, prefix) {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncation.truncated) return truncation.content;
  await mkdir(tmpdir(), { recursive: true });
  const tempPath = join(tmpdir(), `pi-google-drive-${Date.now()}.txt`);
  await writeFile(tempPath, text, "utf8");
  return `${truncation.content}\n\n[${prefix} truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempPath}]`;
}

function asBulletText(slide) {
  const parts = [];
  if (slide.body?.trim()) parts.push(slide.body.trim());
  if (slide.bullets?.length) parts.push(slide.bullets.map(item => `• ${item.trim()}`).filter(line => line !== "•").join("\n"));
  return parts.filter(Boolean).join("\n\n");
}

function createTextBoxRequests(pageObjectId, text, options) {
  const elementId = options.objectId ?? objectId("gslides_text");
  const requests = [{
    createShape: {
      objectId: elementId,
      shapeType: "TEXT_BOX",
      elementProperties: {
        pageObjectId,
        size: {
          width: { magnitude: options.width, unit: "PT" },
          height: { magnitude: options.height, unit: "PT" },
        },
        transform: { scaleX: 1, scaleY: 1, translateX: options.x, translateY: options.y, unit: "PT" },
      },
    },
  }];
  if (text) {
    requests.push({ insertText: { objectId: elementId, insertionIndex: 0, text } });
    if (options.fontSize || options.bold) {
      requests.push({
        updateTextStyle: {
          objectId: elementId,
          textRange: { type: "ALL" },
          style: { fontSize: options.fontSize ? { magnitude: options.fontSize, unit: "PT" } : undefined, bold: options.bold },
          fields: [options.fontSize ? "fontSize" : undefined, options.bold !== undefined ? "bold" : undefined].filter(Boolean).join(","),
        },
      });
    }
  }
  return { elementId, requests };
}

function buildSlideContentRequests(pageObjectId, slide) {
  const layout = (slide.layout ?? "title_body").toLowerCase();
  const requests = [];
  if (slide.title?.trim()) {
    requests.push(...createTextBoxRequests(pageObjectId, slide.title.trim(), {
      x: 36, y: layout === "title_only" ? 126 : 28, width: PAGE_WIDTH_PT - 72,
      height: layout === "title_only" ? 100 : 56, fontSize: layout === "title_only" ? 36 : 30, bold: true,
    }).requests);
  }
  if (slide.subtitle?.trim()) {
    requests.push(...createTextBoxRequests(pageObjectId, slide.subtitle.trim(), {
      x: 54, y: slide.title?.trim() ? 88 : 150, width: PAGE_WIDTH_PT - 108, height: 42, fontSize: 18,
    }).requests);
  }
  const body = asBulletText(slide);
  if (body && layout !== "title_only") {
    requests.push(...createTextBoxRequests(pageObjectId, body, {
      x: 54, y: slide.subtitle?.trim() ? 140 : 108, width: PAGE_WIDTH_PT - 108,
      height: PAGE_HEIGHT_PT - (slide.subtitle?.trim() ? 172 : 140), fontSize: 18,
    }).requests);
  }
  return requests;
}

async function resolveSlideId(slidesApi, presentationId, input) {
  const normalized = slideObjectIdFrom(input);
  if (/^\d+$/.test(normalized)) {
    const res = await slidesApi.presentations.get({ presentationId, fields: "slides/objectId" });
    const slide = (res.data.slides ?? [])[Number(normalized) - 1];
    if (!slide?.objectId) throw new Error(`No slide ${normalized} in ${presentationUrl(presentationId)}`);
    return slide.objectId;
  }
  return normalized;
}

// ---------- Schemas ----------

const StyledBlockSchema = Type.Object({
  type: Type.String({ description: "title, subtitle, heading1, heading2, heading3, heading4, heading5, heading6, paragraph, bullets, numbered, or spacer" }),
  text: Type.Optional(Type.String({ description: "Text for headings and paragraphs" })),
  items: Type.Optional(Type.Array(Type.String(), { description: "List items for bullets or numbered blocks" })),
});
const TableRowsSchema = Type.Array(Type.Array(Type.String()), { description: "Table rows, where each row is an array of cell strings" });
const ValuesSchema = Type.Array(Type.Array(Type.Any()), { description: "Rows of cell values. Values may be strings, numbers, booleans, or nulls." });
const SlideContentSchema = Type.Object({
  layout: Type.Optional(Type.String({ description: "title_body, title_only, or blank. Defaults to title_body." })),
  title: Type.Optional(Type.String({ description: "Slide title" })),
  subtitle: Type.Optional(Type.String({ description: "Optional subtitle" })),
  body: Type.Optional(Type.String({ description: "Body text. Use newlines for separate paragraphs." })),
  bullets: Type.Optional(Type.Array(Type.String(), { description: "Bullet items. Rendered as bullet-prefixed lines." })),
});

function normalizeValues(values) {
  return values.map(row => row.map(value => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
  }));
}

// ---------- Extension factory ----------

export function createGoogleDriveExtension({
  googleApi = google,
  store = new DriveStore(),
  resolveIdentity = identityForClient,
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
          console.error(`Could not persist refreshed Google Drive credential for ${savedAccount.email}: ${error?.message ?? error}`);
        });
    });
    const identity = await resolveIdentity(client, googleApi, token);
    if (googleSubjectHash(identity.subject) !== savedAccount.subjectHash) {
      throw new Error("Saved Google credential belongs to a different identity. Remove and re-add this account.");
    }
    if (identity.email !== savedAccount.email) await store.updateAccountEmail(savedAccount.subjectHash, identity.email);
    return { client, account: { subjectHash: savedAccount.subjectHash, email: identity.email } };
  }

  async function accountStatuses() {
    const accounts = await store.loadAccounts();
    return Promise.all(accounts.map(async account => {
      try {
        const connected = await connectAccount(account.email);
        return { email: connected.account.email, status: "Connected", reauthenticationRequired: false };
      } catch (error) {
        return safeAuthenticationError(error)
          ? { email: account.email, status: "Re-authentication required", reauthenticationRequired: true }
          : { email: account.email, status: "Connected", reauthenticationRequired: false };
      }
    }));
  }

  async function importOAuthClient(ctx) {
    requireUI(ctx);
    const sourcePath = await ctx.ui.input("Import Google Desktop OAuth client", "Path to the downloaded JSON file");
    if (!sourcePath?.trim()) return false;
    const destination = await store.importOAuthClient(sourcePath);
    ctx.ui.notify(`Google Drive OAuth client saved in ${destination}.`, "success");
    return true;
  }

  async function addAccount(ctx) {
    requireUI(ctx);
    if (!(await store.hasOAuthClient())) {
      ctx.ui.notify("Import a Google Desktop OAuth client before adding an account.", "info");
      if (!(await importOAuthClient(ctx))) return false;
    }
    const keys = await store.readOAuthClient();
    const result = await authorize({ keys, ctx, googleApi, resolveIdentity, launchBrowser });
    const account = await store.addAccount(result.identity, result.tokens);
    ctx.ui.notify(`Connected ${account.email}.`, "success");
    return true;
  }

  async function removeAccount(ctx, email) {
    const confirmed = await ctx.ui.confirm(`Remove ${email}?`, "This deletes only the local Drive credential. It does not revoke access at Google.");
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
      const title = rows.length ? "Google Drive accounts" : "Google Drive accounts — none connected";
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

  return function googleDriveExtension(pi) {
    pi.registerTool({
      name: "gdrive_auth_status",
      label: "Google Drive Auth Status",
      description: "Report which Google Drive accounts are connected and which require re-authentication.",
      parameters: Type.Object({}),
      async execute() {
        const accounts = await accountStatuses();
        const text = accounts.length
          ? accounts.map(account => `${account.email}: ${account.status}`).join("\n")
          : "No Google Drive accounts connected. Run /google-drive to add one.";
        return { content: [{ type: "text", text }], details: { accounts } };
      },
    });

    // ---------------- Drive ----------------

    pi.registerTool({
      name: "gdrive_find_folders",
      label: "Google Drive Find Folders",
      description: "Find Google Drive folders by exact or partial name in one explicitly selected account. Requires broad Google Drive scope.",
      promptSnippet: "Find Google Drive folders by name",
      promptGuidelines: ["Use gdrive_find_folders to locate a destination folder ID before moving files in Google Drive."],
      parameters: Type.Object({
        account: accountSchema,
        name: Type.String({ description: "Folder name or substring to search for" }),
        exact: Type.Optional(Type.Boolean({ description: "Whether to match the folder name exactly. Defaults to false." })),
        pageSize: Type.Optional(Type.Number({ description: "Maximum folders to return. Defaults to 10, maximum 100." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const escaped = escapeDriveQueryString(params.name);
        const nameClause = params.exact ? `name = '${escaped}'` : `name contains '${escaped}'`;
        const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 10));
        const res = await drive.files.list({
          q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and ${nameClause}`,
          fields: "files(id,name,parents,webViewLink)",
          pageSize,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        const folders = res.data.files ?? [];
        const text = folders.length
          ? folders.map(folder => `${folder.name} — ${folder.id} — ${folder.webViewLink ?? driveFolderUrl(folder.id!)}`).join("\n")
          : "No matching folders found.";
        return { content: [{ type: "text", text }], details: { account: account.email, folders } };
      },
    });

    pi.registerTool({
      name: "gdrive_create_folder",
      label: "Google Drive Create Folder",
      description: "Create a new Google Drive folder in one explicitly selected account, optionally inside a parent folder. Requires broad Google Drive scope.",
      promptSnippet: "Create Google Drive folders",
      promptGuidelines: [
        "Use gdrive_create_folder when the user explicitly asks to create a new Google Drive folder.",
        "If the user asks to create a folder inside another folder, use the provided parent folder URL/ID or use gdrive_find_folders first to identify the parent.",
      ],
      parameters: Type.Object({
        account: accountSchema,
        name: Type.String({ description: "Name for the new Google Drive folder" }),
        parent: Type.Optional(Type.String({ description: "Optional parent folder URL or folder ID. If omitted, creates the folder in My Drive/root." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const parentId = params.parent ? driveFileIdFrom(params.parent) : undefined;
        const created = await drive.files.create({
          requestBody: { name: params.name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined },
          fields: "id,name,parents,webViewLink",
          supportsAllDrives: true,
        });
        const folder = created.data;
        const url = folder.webViewLink ?? driveFolderUrl(folder.id!);
        const parentText = parentId ? ` inside ${driveFolderUrl(parentId)}` : " in My Drive/root";
        return { content: [{ type: "text", text: `Created Google Drive folder ${folder.name ?? params.name}${parentText}: ${url}` }], details: { account: account.email, folder, url } };
      },
    });

    pi.registerTool({
      name: "gdrive_list_parents",
      label: "Google Drive List Parents",
      description: "List the current parent folders for a Google Drive file or Google Doc in one explicitly selected account. Requires broad Google Drive scope.",
      promptSnippet: "List Google Drive file parent folders",
      promptGuidelines: ["Use gdrive_list_parents when you need to inspect where a Google Doc or Drive file currently lives."],
      parameters: Type.Object({
        account: accountSchema,
        file: Type.String({ description: "Google Drive file URL, Google Doc URL, or file ID" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const fileId = driveFileIdFrom(params.file);
        const file = await drive.files.get({ fileId, fields: "id,name,mimeType,parents,webViewLink", supportsAllDrives: true });
        const parentIds = file.data.parents ?? [];
        const parentFolders = await Promise.all(parentIds.map(async parentId => {
          const parent = await drive.files.get({ fileId: parentId, fields: "id,name,webViewLink", supportsAllDrives: true });
          return parent.data;
        }));
        const text = parentFolders.length
          ? parentFolders.map(parent => `${parent.name} — ${parent.id} — ${parent.webViewLink ?? driveFolderUrl(parent.id!)}`).join("\n")
          : `${file.data.name ?? fileId} has no visible parent folders.`;
        return { content: [{ type: "text", text }], details: { account: account.email, file: file.data, parentFolders } };
      },
    });

    pi.registerTool({
      name: "gdrive_move_file",
      label: "Google Drive Move File",
      description: "Move a Google Drive file or Google Doc into a target folder in one explicitly selected account. Requires broad Google Drive scope.",
      promptSnippet: "Move Google Drive files or Google Docs into folders",
      promptGuidelines: ["Before gdrive_move_file, use gdrive_find_folders or a provided folder URL/ID to identify the destination folder."],
      parameters: Type.Object({
        account: accountSchema,
        file: Type.String({ description: "Google Drive file URL, Google Doc URL, or file ID to move" }),
        folder: Type.String({ description: "Destination Google Drive folder URL or folder ID" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const fileId = driveFileIdFrom(params.file);
        const folderId = driveFileIdFrom(params.folder);
        const current = await drive.files.get({ fileId, fields: "id,name,parents,webViewLink", supportsAllDrives: true });
        const previousParents = current.data.parents ?? [];
        const updated = await drive.files.update({
          fileId,
          addParents: folderId,
          removeParents: previousParents.join(",") || undefined,
          fields: "id,name,parents,webViewLink",
          supportsAllDrives: true,
        });
        const text = `Moved ${updated.data.name ?? fileId} to ${driveFolderUrl(folderId)}.`;
        return { content: [{ type: "text", text }], details: { account: account.email, file: updated.data, previousParents, folderId, folderUrl: driveFolderUrl(folderId) } };
      },
    });

    // ---------------- Docs ----------------

    pi.registerTool({
      name: "gdocs_create",
      label: "Google Docs Create",
      description: "Create a Google Doc in one explicitly selected account, optionally with initial plain text content, and return its URL.",
      promptSnippet: "Create Google Docs documents",
      promptGuidelines: ["Use gdocs_create when the user asks you to create or draft a Google Doc. Google Docs tools accept plain text content; do not use markdown unless the user explicitly wants markdown text in the document."],
      parameters: Type.Object({
        account: accountSchema,
        title: Type.String({ description: "Document title" }),
        content: Type.Optional(Type.String({ description: "Initial plain text body" })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const created = await docs.documents.create({ requestBody: { title: params.title } });
        const documentId = created.data.documentId!;
        if (params.content) {
          await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: params.content } }] } });
        }
        return { content: [{ type: "text", text: `Created Google Doc: ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_create_styled",
      label: "Google Docs Create Styled",
      description: "Create a Google Doc in one explicitly selected account using native Google Docs paragraph styles and lists.",
      promptSnippet: "Create styled Google Docs documents with native headings, paragraphs, bullets, and numbered lists",
      promptGuidelines: ["Use gdocs_create_styled when the user asks for a Google Doc with structure, headings, lists, or native Google Docs styles."],
      parameters: Type.Object({
        account: accountSchema,
        title: Type.String({ description: "Document title" }),
        blocks: Type.Array(StyledBlockSchema, { description: "Structured content blocks" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const created = await docs.documents.create({ requestBody: { title: params.title } });
        const documentId = created.data.documentId!;
        const { requests } = buildStyledRequests(params.blocks, 1);
        if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Created styled Google Doc: ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_append_styled",
      label: "Google Docs Append Styled",
      description: "Append content to a Google Doc in one explicitly selected account using native Google Docs paragraph styles and lists.",
      promptSnippet: "Append styled content to Google Docs documents",
      promptGuidelines: ["Use gdocs_append_styled when the user asks you to add structured headings, paragraphs, or lists to an existing Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        blocks: Type.Array(StyledBlockSchema, { description: "Structured content blocks" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const index = Math.max(1, (await endIndex(docs, documentId)) - 1);
        const { requests } = buildStyledRequests(params.blocks, index);
        if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Appended styled content to Google Doc: ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_append_table",
      label: "Google Docs Append Table",
      description: "Append a native Google Docs table to the end of a document in one explicitly selected account and fill its cells.",
      promptSnippet: "Append native tables to Google Docs documents",
      promptGuidelines: ["Use gdocs_append_table when the user asks to add a table to the end of an existing Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        rows: TableRowsSchema,
        headerRow: Type.Optional(Type.Boolean({ description: "Bold the first row as a header. Defaults to true." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const index = Math.max(1, (await endIndex(docs, documentId)) - 1);
        const table = await insertTableAt(docs, documentId, index, params.rows, params.headerRow ?? true);
        return { content: [{ type: "text", text: `Appended ${table.rowCount}x${table.columnCount} table to ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId), table } };
      },
    });

    pi.registerTool({
      name: "gdocs_insert_table_after",
      label: "Google Docs Insert Table After",
      description: "Insert a native Google Docs table after the first paragraph or heading containing matching text in one explicitly selected account.",
      promptSnippet: "Insert native tables after matching text in Google Docs documents",
      promptGuidelines: ["Use gdocs_insert_table_after when the user asks to add a table after a heading or paragraph in a Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        afterText: Type.String({ description: "Text to find in an existing paragraph/heading" }),
        rows: TableRowsSchema,
        headerRow: Type.Optional(Type.Boolean({ description: "Bold the first row as a header. Defaults to true." })),
        matchCase: Type.Optional(Type.Boolean({ description: "Whether matching is case-sensitive. Defaults to false." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.get({ documentId });
        const paragraph = findParagraph(res.data, params.afterText, params.matchCase ?? false);
        if (!paragraph) throw new Error(`Could not find paragraph containing: ${params.afterText}`);
        const docEnd = (res.data.body?.content ?? []).at(-1)?.endIndex ?? paragraph.endIndex;
        const insertIndex = Math.min(paragraph.endIndex, Math.max(1, docEnd - 1));
        const table = await insertTableAt(docs, documentId, insertIndex, params.rows, params.headerRow ?? true);
        return { content: [{ type: "text", text: `Inserted ${table.rowCount}x${table.columnCount} table after '${params.afterText}' in ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId), table } };
      },
    });

    pi.registerTool({
      name: "gdocs_outline",
      label: "Google Docs Outline",
      description: "Read a Google Doc in one explicitly selected account as a structured outline of native headings and paragraph text with document indexes for editing.",
      promptSnippet: "Inspect Google Docs structure before editing",
      promptGuidelines: ["Use gdocs_outline before making targeted edits to an existing Google Doc."],
      parameters: Type.Object({ account: accountSchema, document: Type.String({ description: "Google Doc URL or document ID" }) }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.get({ documentId });
        const lines = paragraphsFrom(res.data)
          .map(p => { const text = p.text.replace(/\n$/, ""); return text.trim() ? `${p.namedStyleType} [${p.startIndex}-${p.endIndex}]: ${text}` : undefined; })
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text", text: lines || "(empty document)" }], details: { account: account.email, documentId, url: docUrl(documentId), title: res.data.title } };
      },
    });

    pi.registerTool({
      name: "gdocs_find_replace",
      label: "Google Docs Find Replace",
      description: "Replace exact text in a Google Doc in one explicitly selected account using Google Docs native replaceAllText.",
      promptSnippet: "Find and replace text in Google Docs documents",
      promptGuidelines: ["Use gdocs_find_replace for straightforward exact text replacements in Google Docs."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        find: Type.String({ description: "Exact text to find" }),
        replace: Type.String({ description: "Replacement text" }),
        matchCase: Type.Optional(Type.Boolean({ description: "Whether matching is case-sensitive. Defaults to true." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ replaceAllText: { containsText: { text: params.find, matchCase: params.matchCase ?? true }, replaceText: params.replace } }] },
        });
        const occurrencesChanged = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return { content: [{ type: "text", text: `Replaced ${occurrencesChanged} occurrence(s) in ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId), occurrencesChanged } };
      },
    });

    pi.registerTool({
      name: "gdocs_insert_after",
      label: "Google Docs Insert After",
      description: "Insert styled blocks after the first paragraph or heading containing exact text in one explicitly selected account.",
      promptSnippet: "Insert styled content after a matching paragraph in Google Docs",
      promptGuidelines: ["Use gdocs_insert_after to add new sections or paragraphs after an existing heading or text in a Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        afterText: Type.String({ description: "Text to find in an existing paragraph/heading" }),
        blocks: Type.Array(StyledBlockSchema, { description: "Structured content blocks to insert" }),
        matchCase: Type.Optional(Type.Boolean({ description: "Whether matching is case-sensitive. Defaults to false." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.get({ documentId });
        const paragraph = findParagraph(res.data, params.afterText, params.matchCase ?? false);
        if (!paragraph) throw new Error(`Could not find paragraph containing: ${params.afterText}`);
        const docEnd = (res.data.body?.content ?? []).at(-1)?.endIndex ?? paragraph.endIndex;
        const insertIndex = Math.min(paragraph.endIndex, Math.max(1, docEnd - 1));
        const { requests } = buildStyledRequests(params.blocks, insertIndex);
        if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Inserted styled content after '${params.afterText}' in ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId), insertIndex } };
      },
    });

    pi.registerTool({
      name: "gdocs_replace_section",
      label: "Google Docs Replace Section",
      description: "Replace the content under a heading in one explicitly selected account, optionally stopping before another heading, using native styled blocks.",
      promptSnippet: "Replace a section in a Google Doc by heading",
      promptGuidelines: ["Use gdocs_replace_section for substantial edits to a section of a Google Doc. Prefer gdocs_outline first to verify headings."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        heading: Type.String({ description: "Heading whose section content should be replaced" }),
        blocks: Type.Array(StyledBlockSchema, { description: "Replacement structured content blocks. Usually omit the heading itself unless you want a subheading." }),
        beforeHeading: Type.Optional(Type.String({ description: "Optional next heading where replacement should stop. If omitted, stops at the next heading of any level or document end." })),
        matchCase: Type.Optional(Type.Boolean({ description: "Whether heading matching is case-sensitive. Defaults to false." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.get({ documentId });
        const paragraphs = paragraphsFrom(res.data);
        const heading = findHeading(res.data, params.heading, params.matchCase ?? false);
        if (!heading) throw new Error(`Could not find heading: ${params.heading}`);
        let endParagraph;
        if (params.beforeHeading) endParagraph = findHeading(res.data, params.beforeHeading, params.matchCase ?? false);
        else endParagraph = paragraphs.find(p => p.startIndex >= heading.endIndex && String(p.namedStyleType).startsWith("HEADING_"));
        const docEnd = (res.data.body?.content ?? []).at(-1)?.endIndex ?? heading.endIndex;
        const startIndex = heading.endIndex;
        const endIndex = Math.min(endParagraph?.startIndex ?? Math.max(1, docEnd - 1), Math.max(1, docEnd - 1));
        const requests = [];
        if (endIndex > startIndex) requests.push({ deleteContentRange: { range: { startIndex, endIndex } } });
        requests.push(...buildStyledRequests(params.blocks, startIndex).requests);
        if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Replaced section '${params.heading}' in ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId), startIndex, endIndex } };
      },
    });

    pi.registerTool({
      name: "gdocs_read",
      label: "Google Docs Read",
      description: "Read plain text content from a Google Doc in one explicitly selected account by URL or document ID.",
      promptSnippet: "Read Google Docs documents",
      promptGuidelines: ["Use gdocs_read when the user asks you to inspect an existing Google Doc."],
      parameters: Type.Object({ account: accountSchema, document: Type.String({ description: "Google Doc URL or document ID" }) }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const res = await docs.documents.get({ documentId });
        const text = extractText(res.data);
        return { content: [{ type: "text", text: text || "(empty document)" }], details: { account: account.email, title: res.data.title, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_append",
      label: "Google Docs Append",
      description: "Append plain text to the end of a Google Doc in one explicitly selected account by URL or document ID.",
      promptSnippet: "Append text to Google Docs documents",
      promptGuidelines: ["Use gdocs_append when the user asks you to add text to an existing Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        text: Type.String({ description: "Plain text to append" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const index = Math.max(1, (await endIndex(docs, documentId)) - 1);
        await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { location: { index }, text: params.text } }] } });
        return { content: [{ type: "text", text: `Appended text to Google Doc: ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_replace",
      label: "Google Docs Replace",
      description: "Replace the entire body of a Google Doc in one explicitly selected account with plain text by URL or document ID.",
      promptSnippet: "Replace Google Docs document contents",
      promptGuidelines: ["Use gdocs_replace when the user asks you to overwrite an existing Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        text: Type.String({ description: "Replacement plain text body" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const docs = googleApi.docs({ version: "v1", auth: client });
        const documentId = docIdFrom(params.document);
        const index = await endIndex(docs, documentId);
        const requests = [];
        if (index > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: index - 1 } } });
        if (params.text) requests.push({ insertText: { location: { index: 1 }, text: params.text } });
        await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Replaced Google Doc contents: ${docUrl(documentId)}` }], details: { account: account.email, documentId, url: docUrl(documentId) } };
      },
    });

    pi.registerTool({
      name: "gdocs_share",
      label: "Google Docs Share",
      description: "Share a Google Doc in one explicitly selected account with an email address.",
      promptSnippet: "Share Google Docs documents",
      promptGuidelines: ["Use gdocs_share only when the user explicitly asks you to share a Google Doc."],
      parameters: Type.Object({
        account: accountSchema,
        document: Type.String({ description: "Google Doc URL or document ID" }),
        email: Type.String({ description: "Email address to share with" }),
        role: Type.Optional(Type.String({ description: "reader, commenter, or writer. Defaults to writer." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const documentId = docIdFrom(params.document);
        const role = ["reader", "commenter", "writer"].includes(params.role ?? "") ? params.role : "writer";
        await drive.permissions.create({ fileId: documentId, sendNotificationEmail: true, requestBody: { type: "user", role, emailAddress: params.email } });
        return { content: [{ type: "text", text: `Shared ${docUrl(documentId)} with ${params.email} as ${role}.` }], details: { account: account.email, documentId, url: docUrl(documentId), email: params.email, role } };
      },
    });

    // ---------------- Sheets ----------------

    pi.registerTool({
      name: "gsheets_create",
      label: "Google Sheets Create",
      description: "Create a Google Sheet in one explicitly selected account, optionally with sheet tabs and initial values, and return its URL.",
      promptSnippet: "Create Google Sheets spreadsheets",
      promptGuidelines: ["Use gsheets_create when the user asks you to create or draft a Google Sheet or spreadsheet. For Google Sheets tools, values are arrays of rows; each row is an array of cell values."],
      parameters: Type.Object({
        account: accountSchema,
        title: Type.String({ description: "Spreadsheet title" }),
        sheets: Type.Optional(Type.Array(Type.String(), { description: "Optional sheet/tab names. Defaults to a single default sheet." })),
        values: Type.Optional(ValuesSchema),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const created = await sheetsApi.spreadsheets.create({
          requestBody: { properties: { title: params.title }, sheets: params.sheets?.length ? params.sheets.map(title => ({ properties: { title } })) : undefined },
        });
        const spreadsheetId = created.data.spreadsheetId!;
        const firstSheetTitle = created.data.sheets?.[0]?.properties?.title ?? params.sheets?.[0] ?? "Sheet1";
        if (params.values?.length) {
          await sheetsApi.spreadsheets.values.update({ spreadsheetId, range: `${quoteSheetName(firstSheetTitle)}!A1`, valueInputOption: "USER_ENTERED", requestBody: { values: normalizeValues(params.values) } });
        }
        return { content: [{ type: "text", text: `Created Google Sheet: ${spreadsheetUrl(spreadsheetId)}` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId) } };
      },
    });

    pi.registerTool({
      name: "gsheets_info",
      label: "Google Sheets Info",
      description: "Read spreadsheet metadata (sheet/tab names, IDs, and grid sizes) for a spreadsheet in one explicitly selected account.",
      promptSnippet: "Inspect Google Sheets spreadsheet metadata",
      promptGuidelines: ["Use gsheets_info before targeted edits when you need sheet/tab names or IDs."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const res = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: "properties/title,sheets/properties" });
        const sheetLines = (res.data.sheets ?? []).map(sheet => {
          const p = sheet.properties!;
          return `${p.title} (id ${p.sheetId}, ${p.gridProperties?.rowCount ?? "?"} rows x ${p.gridProperties?.columnCount ?? "?"} cols)`;
        });
        return { content: [{ type: "text", text: [`Title: ${res.data.properties?.title ?? "(untitled)"}`, ...sheetLines].join("\n") }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), title: res.data.properties?.title, sheets: res.data.sheets?.map(s => s.properties) } };
      },
    });

    pi.registerTool({
      name: "gsheets_read",
      label: "Google Sheets Read",
      description: "Read cell values from a Google Sheet range in one explicitly selected account. If no range is specified, it reads the first sheet's used range.",
      promptSnippet: "Read Google Sheets cell values",
      promptGuidelines: ["Use gsheets_read when the user asks you to inspect an existing Google Sheet. If no range is specified, it reads the first sheet's used range."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        range: Type.Optional(Type.String({ description: "A1 notation range, e.g. Sheet1!A1:D20. Defaults to the first sheet." })),
        valueRenderOption: Type.Optional(Type.String({ description: "FORMATTED_VALUE, UNFORMATTED_VALUE, or FORMULA. Defaults to FORMATTED_VALUE." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        let range = params.range;
        if (!range) {
          const meta = await sheetsApi.spreadsheets.get({ spreadsheetId, fields: "sheets/properties/title" });
          const title = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
          range = quoteSheetName(title);
        }
        const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: params.valueRenderOption ?? "FORMATTED_VALUE" });
        const values = res.data.values ?? [];
        const text = values.length ? values.map(row => row.map(cell => String(cell ?? "")).join("\t")).join("\n") : "(empty range)";
        return { content: [{ type: "text", text }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), range: res.data.range, values } };
      },
    });

    pi.registerTool({
      name: "gsheets_update",
      label: "Google Sheets Update",
      description: "Write values to a Google Sheet range in one explicitly selected account, replacing cells in that range.",
      promptSnippet: "Update Google Sheets cell ranges",
      promptGuidelines: ["Use gsheets_update when the user asks to set or replace values in a specific Google Sheet range."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        range: Type.String({ description: "A1 notation range to write, e.g. Sheet1!A1:C3" }),
        values: ValuesSchema,
        valueInputOption: Type.Optional(Type.String({ description: "RAW or USER_ENTERED. Defaults to USER_ENTERED." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const res = await sheetsApi.spreadsheets.values.update({ spreadsheetId, range: params.range, valueInputOption: params.valueInputOption ?? "USER_ENTERED", requestBody: { values: normalizeValues(params.values) } });
        return { content: [{ type: "text", text: `Updated ${res.data.updatedCells ?? 0} cell(s) in ${spreadsheetUrl(spreadsheetId)}` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), updatedRange: res.data.updatedRange, updatedCells: res.data.updatedCells } };
      },
    });

    pi.registerTool({
      name: "gsheets_append",
      label: "Google Sheets Append",
      description: "Append rows of values to a Google Sheet table/range in one explicitly selected account.",
      promptSnippet: "Append rows to Google Sheets",
      promptGuidelines: ["Use gsheets_append when the user asks to add rows to an existing Google Sheet."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        range: Type.String({ description: "A1 notation table/range to append to, e.g. Sheet1!A:D" }),
        values: ValuesSchema,
        valueInputOption: Type.Optional(Type.String({ description: "RAW or USER_ENTERED. Defaults to USER_ENTERED." })),
        insertDataOption: Type.Optional(Type.String({ description: "INSERT_ROWS or OVERWRITE. Defaults to INSERT_ROWS." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const res = await sheetsApi.spreadsheets.values.append({ spreadsheetId, range: params.range, valueInputOption: params.valueInputOption ?? "USER_ENTERED", insertDataOption: params.insertDataOption ?? "INSERT_ROWS", requestBody: { values: normalizeValues(params.values) } });
        return { content: [{ type: "text", text: `Appended ${res.data.updates?.updatedRows ?? 0} row(s) to ${spreadsheetUrl(spreadsheetId)}` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), updates: res.data.updates } };
      },
    });

    pi.registerTool({
      name: "gsheets_clear",
      label: "Google Sheets Clear",
      description: "Clear values from a Google Sheet range in one explicitly selected account.",
      promptSnippet: "Clear Google Sheets ranges",
      promptGuidelines: ["Use gsheets_clear only when the user explicitly asks to clear values from a Google Sheet range."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        range: Type.String({ description: "A1 notation range to clear" }),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const res = await sheetsApi.spreadsheets.values.clear({ spreadsheetId, range: params.range, requestBody: {} });
        return { content: [{ type: "text", text: `Cleared ${res.data.clearedRange ?? params.range} in ${spreadsheetUrl(spreadsheetId)}` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), clearedRange: res.data.clearedRange } };
      },
    });

    pi.registerTool({
      name: "gsheets_add_sheet",
      label: "Google Sheets Add Sheet",
      description: "Add a new sheet/tab to an existing Google spreadsheet in one explicitly selected account.",
      promptSnippet: "Add tabs to Google Sheets spreadsheets",
      promptGuidelines: ["Use gsheets_add_sheet when the user asks to add a tab/sheet to an existing Google spreadsheet."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        title: Type.String({ description: "New sheet/tab title" }),
        rows: Type.Optional(Type.Number({ description: "Optional row count" })),
        columns: Type.Optional(Type.Number({ description: "Optional column count" })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const sheetsApi = googleApi.sheets({ version: "v4", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const res = await sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: params.title, gridProperties: { rowCount: params.rows, columnCount: params.columns } } } }] },
        });
        const properties = res.data.replies?.[0]?.addSheet?.properties;
        return { content: [{ type: "text", text: `Added sheet '${params.title}' to ${spreadsheetUrl(spreadsheetId)}` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), sheet: properties } };
      },
    });

    pi.registerTool({
      name: "gsheets_share",
      label: "Google Sheets Share",
      description: "Share a Google Sheet in one explicitly selected account with an email address.",
      promptSnippet: "Share Google Sheets spreadsheets",
      promptGuidelines: ["Use gsheets_share only when the user explicitly asks you to share a Google Sheet."],
      parameters: Type.Object({
        account: accountSchema,
        spreadsheet: Type.String({ description: "Google Sheet URL or spreadsheet ID" }),
        email: Type.String({ description: "Email address to share with" }),
        role: Type.Optional(Type.String({ description: "reader, commenter, or writer. Defaults to writer." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const spreadsheetId = spreadsheetIdFrom(params.spreadsheet);
        const role = ["reader", "commenter", "writer"].includes(params.role ?? "") ? params.role : "writer";
        await drive.permissions.create({ fileId: spreadsheetId, sendNotificationEmail: true, requestBody: { type: "user", role, emailAddress: params.email } });
        return { content: [{ type: "text", text: `Shared ${spreadsheetUrl(spreadsheetId)} with ${params.email} as ${role}.` }], details: { account: account.email, spreadsheetId, url: spreadsheetUrl(spreadsheetId), email: params.email, role } };
      },
    });

    // ---------------- Slides ----------------

    pi.registerTool({
      name: "gslides_create",
      label: "Google Slides Create",
      description: "Create a Google Slides presentation in one explicitly selected account, optionally with initial slides, and return its URL.",
      promptSnippet: "Create Google Slides presentations",
      promptGuidelines: ["Use gslides_create when the user asks to create or draft a Google Slides presentation. Pass slides as native slide blocks with title, subtitle, body, and bullets; do not use markdown."],
      parameters: Type.Object({
        account: accountSchema,
        title: Type.String({ description: "Presentation title" }),
        slides: Type.Optional(Type.Array(SlideContentSchema, { description: "Optional initial slides" })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const created = await slidesApi.presentations.create({ requestBody: { title: params.title } });
        const presentationId = created.data.presentationId!;
        if (params.slides?.length) {
          const fetched = await slidesApi.presentations.get({ presentationId, fields: "slides(objectId,pageElements/objectId)" });
          const existingFirstSlide = fetched.data.slides?.[0];
          const requests = [];
          for (const [index, slide] of params.slides.entries()) {
            const pageObjectId = index === 0 && existingFirstSlide?.objectId ? existingFirstSlide.objectId : objectId("gslides_slide");
            if (index === 0 && existingFirstSlide?.pageElements?.length) {
              requests.push(...existingFirstSlide.pageElements.map(element => ({ deleteObject: { objectId: element.objectId } })));
            }
            if (!(index === 0 && existingFirstSlide?.objectId)) {
              requests.push({ createSlide: { objectId: pageObjectId, insertionIndex: index, slideLayoutReference: { predefinedLayout: "BLANK" } } });
            }
            requests.push(...buildSlideContentRequests(pageObjectId, slide));
          }
          if (requests.length) await slidesApi.presentations.batchUpdate({ presentationId, requestBody: { requests } });
        }
        return { content: [{ type: "text", text: `Created Google Slides presentation: ${presentationUrl(presentationId)}` }], details: { account: account.email, presentationId, url: presentationUrl(presentationId) } };
      },
    });

    pi.registerTool({
      name: "gslides_read",
      label: "Google Slides Read",
      description: "Read text content from a Google Slides presentation in one explicitly selected account by URL or presentation ID.",
      promptSnippet: "Read Google Slides presentations",
      promptGuidelines: ["Use gslides_read when the user asks you to inspect or summarize an existing Google Slides presentation."],
      parameters: Type.Object({ account: accountSchema, presentation: Type.String({ description: "Google Slides URL or presentation ID" }) }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const res = await slidesApi.presentations.get({ presentationId });
        const text = [`Title: ${res.data.title ?? "(untitled)"}`, "", ...slideLines(res.data)].join("\n");
        return { content: [{ type: "text", text: await truncateForTool(text || "(empty presentation)", "Google Slides read output") }], details: { account: account.email, presentationId, url: presentationUrl(presentationId), title: res.data.title, slideCount: res.data.slides?.length ?? 0 } };
      },
    });

    pi.registerTool({
      name: "gslides_info",
      label: "Google Slides Info",
      description: "Inspect Google Slides presentation metadata, slide IDs, and page element text snippets for targeted edits in one explicitly selected account.",
      promptSnippet: "Inspect Google Slides structure before editing",
      promptGuidelines: ["Use gslides_info before targeted Google Slides edits when you need slide object IDs or element IDs."],
      parameters: Type.Object({ account: accountSchema, presentation: Type.String({ description: "Google Slides URL or presentation ID" }) }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const res = await slidesApi.presentations.get({ presentationId, fields: "title,slides(objectId,pageElements(objectId,shape/text/table))" });
        const lines = [`Title: ${res.data.title ?? "(untitled)"}`, `URL: ${presentationUrl(presentationId)}`];
        for (const [index, slide] of (res.data.slides ?? []).entries()) {
          lines.push(`Slide ${index + 1}: ${slide.objectId} — ${slideUrl(presentationId, slide.objectId)}`);
          for (const element of slide.pageElements ?? []) {
            const snippet = textFromPageElement(element).replace(/\s+/g, " ").trim().slice(0, 120);
            lines.push(`  ${element.objectId}: ${snippet || "(no text)"}`);
          }
        }
        return { content: [{ type: "text", text: await truncateForTool(lines.join("\n"), "Google Slides info output") }], details: { account: account.email, presentationId, url: presentationUrl(presentationId), title: res.data.title, slideCount: res.data.slides?.length ?? 0 } };
      },
    });

    pi.registerTool({
      name: "gslides_append_slide",
      label: "Google Slides Append Slide",
      description: "Append a slide with title, subtitle, body text, and/or bullets to an existing Google Slides presentation in one explicitly selected account.",
      promptSnippet: "Append slides to Google Slides presentations",
      promptGuidelines: ["Use gslides_append_slide when the user asks to add a new slide to an existing presentation."],
      parameters: Type.Object({
        account: accountSchema,
        presentation: Type.String({ description: "Google Slides URL or presentation ID" }),
        slide: SlideContentSchema,
        insertionIndex: Type.Optional(Type.Number({ description: "Optional zero-based insertion index. Defaults to the end." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const pageObjectId = objectId("gslides_slide");
        const requests = [
          { createSlide: { objectId: pageObjectId, insertionIndex: params.insertionIndex, slideLayoutReference: { predefinedLayout: "BLANK" } } },
          ...buildSlideContentRequests(pageObjectId, params.slide),
        ];
        await slidesApi.presentations.batchUpdate({ presentationId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Appended slide to ${slideUrl(presentationId, pageObjectId)}` }], details: { account: account.email, presentationId, slideId: pageObjectId, url: slideUrl(presentationId, pageObjectId) } };
      },
    });

    pi.registerTool({
      name: "gslides_find_replace",
      label: "Google Slides Find Replace",
      description: "Replace exact text across a Google Slides presentation in one explicitly selected account, optionally limited to specific slide IDs.",
      promptSnippet: "Find and replace text in Google Slides presentations",
      promptGuidelines: ["Use gslides_find_replace for straightforward exact text replacements in Google Slides."],
      parameters: Type.Object({
        account: accountSchema,
        presentation: Type.String({ description: "Google Slides URL or presentation ID" }),
        find: Type.String({ description: "Exact text to find" }),
        replace: Type.String({ description: "Replacement text" }),
        matchCase: Type.Optional(Type.Boolean({ description: "Whether matching is case-sensitive. Defaults to true." })),
        slides: Type.Optional(Type.Array(Type.String(), { description: "Optional slide object IDs or slide URLs to limit replacement to." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const pageObjectIds = params.slides?.map(slideObjectIdFrom);
        const res = await slidesApi.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: [{ replaceAllText: { containsText: { text: params.find, matchCase: params.matchCase ?? true }, replaceText: params.replace, pageObjectIds } }] },
        });
        const occurrencesChanged = res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        return { content: [{ type: "text", text: `Replaced ${occurrencesChanged} occurrence(s) in ${presentationUrl(presentationId)}` }], details: { account: account.email, presentationId, url: presentationUrl(presentationId), occurrencesChanged } };
      },
    });

    pi.registerTool({
      name: "gslides_replace_slide",
      label: "Google Slides Replace Slide",
      description: "Replace all page elements on a slide with new title, subtitle, body text, and/or bullets in one explicitly selected account.",
      promptSnippet: "Replace a Google Slides slide's content",
      promptGuidelines: ["Use gslides_replace_slide for substantial edits to one slide. Prefer gslides_info first to verify the slide ID or number."],
      parameters: Type.Object({
        account: accountSchema,
        presentation: Type.String({ description: "Google Slides URL or presentation ID" }),
        slide: Type.String({ description: "Slide object ID, slide URL, or 1-based slide number" }),
        content: SlideContentSchema,
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const pageObjectId = await resolveSlideId(slidesApi, presentationId, params.slide);
        const res = await slidesApi.presentations.get({ presentationId, fields: "slides(objectId,pageElements/objectId)" });
        const target = (res.data.slides ?? []).find(slide => slide.objectId === pageObjectId);
        if (!target) throw new Error(`Could not find slide ${params.slide}`);
        const requests = [
          ...(target.pageElements ?? []).map(element => ({ deleteObject: { objectId: element.objectId } })),
          ...buildSlideContentRequests(pageObjectId, params.content),
        ];
        if (requests.length) await slidesApi.presentations.batchUpdate({ presentationId, requestBody: { requests } });
        return { content: [{ type: "text", text: `Replaced slide content: ${slideUrl(presentationId, pageObjectId)}` }], details: { account: account.email, presentationId, slideId: pageObjectId, url: slideUrl(presentationId, pageObjectId) } };
      },
    });

    pi.registerTool({
      name: "gslides_create_text_box",
      label: "Google Slides Create Text Box",
      description: "Create a positioned text box on an existing slide in one explicitly selected account. Coordinates and sizes are in points.",
      promptSnippet: "Add positioned text boxes to Google Slides slides",
      promptGuidelines: ["Use gslides_create_text_box when the user asks to add a specific text box to an existing slide."],
      parameters: Type.Object({
        account: accountSchema,
        presentation: Type.String({ description: "Google Slides URL or presentation ID" }),
        slide: Type.String({ description: "Slide object ID, slide URL, or 1-based slide number" }),
        text: Type.String({ description: "Text box content" }),
        x: Type.Optional(Type.Number({ description: "Left position in points. Defaults to 54." })),
        y: Type.Optional(Type.Number({ description: "Top position in points. Defaults to 108." })),
        width: Type.Optional(Type.Number({ description: "Width in points. Defaults to 612." })),
        height: Type.Optional(Type.Number({ description: "Height in points. Defaults to 180." })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points. Defaults to 18." })),
        bold: Type.Optional(Type.Boolean({ description: "Whether text should be bold. Defaults to false." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const slidesApi = googleApi.slides({ version: "v1", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const pageObjectId = await resolveSlideId(slidesApi, presentationId, params.slide);
        const built = createTextBoxRequests(pageObjectId, params.text, {
          x: params.x ?? 54, y: params.y ?? 108, width: params.width ?? 612, height: params.height ?? 180, fontSize: params.fontSize ?? 18, bold: params.bold ?? false,
        });
        await slidesApi.presentations.batchUpdate({ presentationId, requestBody: { requests: built.requests } });
        return { content: [{ type: "text", text: `Created text box on ${slideUrl(presentationId, pageObjectId)}` }], details: { account: account.email, presentationId, slideId: pageObjectId, elementId: built.elementId, url: slideUrl(presentationId, pageObjectId) } };
      },
    });

    pi.registerTool({
      name: "gslides_share",
      label: "Google Slides Share",
      description: "Share a Google Slides presentation in one explicitly selected account with an email address.",
      promptSnippet: "Share Google Slides presentations",
      promptGuidelines: ["Use gslides_share only when the user explicitly asks you to share a Google Slides presentation."],
      parameters: Type.Object({
        account: accountSchema,
        presentation: Type.String({ description: "Google Slides URL or presentation ID" }),
        email: Type.String({ description: "Email address to share with" }),
        role: Type.Optional(Type.String({ description: "reader, commenter, or writer. Defaults to writer." })),
      }),
      async execute(_id, params) {
        const { client, account } = await connectAccount(params.account);
        const drive = googleApi.drive({ version: "v3", auth: client });
        const presentationId = presentationIdFrom(params.presentation);
        const role = ["reader", "commenter", "writer"].includes(params.role ?? "") ? params.role : "writer";
        await drive.permissions.create({ fileId: presentationId, sendNotificationEmail: true, requestBody: { type: "user", role, emailAddress: params.email } });
        return { content: [{ type: "text", text: `Shared ${presentationUrl(presentationId)} with ${params.email} as ${role}.` }], details: { account: account.email, presentationId, url: presentationUrl(presentationId), email: params.email, role } };
      },
    });

    pi.registerCommand("google-drive", {
      description: "Open Google Drive account and OAuth settings.",
      handler: async (_args, ctx) => openSettings(ctx),
    });
  };
}

export default createGoogleDriveExtension();