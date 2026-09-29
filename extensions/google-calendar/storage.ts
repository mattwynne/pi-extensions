import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const REGISTRY_VERSION = 1;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
let temporaryFileCounter = 0;

const sleep = (milliseconds) => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

export class DuplicateAccountError extends Error {
  constructor(email) {
    super(`Google Calendar account "${email}" is already connected. Remove it before adding it again.`);
    this.name = "DuplicateAccountError";
  }
}

export function googleSubjectHash(subject) {
  if (typeof subject !== "string" || !subject.trim()) throw new Error("Google identity did not include a stable subject identifier.");
  return createHash("sha256").update(subject).digest("hex");
}

export function resolveCalendarDataDir({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  if (env.PI_GOOGLE_CALENDAR_DATA_DIR?.trim()) return resolve(expandHome(env.PI_GOOGLE_CALENDAR_DATA_DIR.trim(), home));
  if (platform === "darwin") return join(home, "Library", "Application Support", "pi-google-calendar");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error("LOCALAPPDATA is required to locate Google Calendar data on Windows.");
    return join(localAppData, "pi-google-calendar");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(xdgDataHome ? expandHome(xdgDataHome, home) : join(home, ".local", "share"), "pi-google-calendar");
}

export function expandHome(input, home = homedir()) {
  const value = input.trim().replace(/^['"]|['"]$/g, "");
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(value);
}

export function validateDesktopOAuthClient(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("OAuth client file must contain a JSON object.");
  if (raw.web && !raw.installed) throw new Error("This is a Web OAuth client. Create and download a Desktop app OAuth client instead.");
  const installed = raw.installed;
  if (!installed || typeof installed !== "object" || Array.isArray(installed)) {
    throw new Error("OAuth client file does not contain an installed/Desktop client.");
  }
  if (typeof installed.client_id !== "string" || !installed.client_id.trim()) throw new Error("Desktop OAuth client is missing client_id.");
  if (typeof installed.client_secret !== "string" || !installed.client_secret.trim()) throw new Error("Desktop OAuth client is missing client_secret.");
  if (!Array.isArray(installed.redirect_uris) || !installed.redirect_uris.some(uri => typeof uri === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(?:\/.*)?$/i.test(uri))) {
    throw new Error("Desktop OAuth client must allow a loopback localhost redirect URI.");
  }
  return {
    client_id: installed.client_id,
    client_secret: installed.client_secret,
    redirect_uris: [...installed.redirect_uris],
    ...(typeof installed.project_id === "string" ? { project_id: installed.project_id } : {}),
    ...(typeof installed.auth_uri === "string" ? { auth_uri: installed.auth_uri } : {}),
    ...(typeof installed.token_uri === "string" ? { token_uri: installed.token_uri } : {}),
  };
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function makePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  try {
    await chmod(path, DIRECTORY_MODE);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function atomicWrite(path, contents) {
  await makePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${process.pid}-${++temporaryFileCounter}`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    try {
      await chmod(temporaryPath, FILE_MODE);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    await rename(temporaryPath, path);
    try {
      await chmod(path, FILE_MODE);
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function withFileLock(path, operation) {
  await makePrivateDirectory(dirname(path));
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for private data lock ${lockPath}.`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

function validateRegistry(raw) {
  if (!raw || raw.version !== REGISTRY_VERSION || !Array.isArray(raw.accounts)) throw new Error("Invalid Google Calendar account registry.");
  const seen = new Set();
  const accounts = raw.accounts.map(account => {
    if (!account || typeof account.subjectHash !== "string" || !/^[a-f0-9]{64}$/.test(account.subjectHash)) {
      throw new Error("Google Calendar account registry contains an invalid subject hash.");
    }
    if (typeof account.email !== "string" || !account.email.includes("@")) throw new Error("Google Calendar account registry contains an invalid email.");
    if (seen.has(account.subjectHash)) throw new Error("Google Calendar account registry contains a duplicate identity.");
    seen.add(account.subjectHash);
    return { subjectHash: account.subjectHash, email: account.email };
  });
  return { version: REGISTRY_VERSION, accounts };
}

export class CalendarStore {
  constructor({ dataDir = resolveCalendarDataDir(), home = homedir() } = {}) {
    this.dataDir = dataDir;
    this.home = home;
    this.oauthClientPath = join(dataDir, "oauth-client.json");
    this.accountsPath = join(dataDir, "accounts.json");
    this.tokensDir = join(dataDir, "tokens");
  }

  async initialize() {
    await makePrivateDirectory(this.dataDir);
    await makePrivateDirectory(this.tokensDir);
  }

  tokenPath(subjectHash) {
    if (!/^[a-f0-9]{64}$/.test(subjectHash)) throw new Error("Invalid Google subject hash.");
    return join(this.tokensDir, `${subjectHash}.json`);
  }

  async hasOAuthClient() {
    return pathExists(this.oauthClientPath);
  }

  async importOAuthClient(sourcePath) {
    if (!sourcePath?.trim()) throw new Error("Choose the downloaded Desktop OAuth JSON file.");
    const resolvedSource = expandHome(sourcePath, this.home);
    let raw;
    try {
      raw = JSON.parse(await readFile(resolvedSource, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`OAuth client file not found: ${resolvedSource}`);
      if (error instanceof SyntaxError) throw new Error("OAuth client file is not valid JSON.");
      throw error;
    }
    const installed = validateDesktopOAuthClient(raw);
    await this.initialize();
    await withFileLock(this.oauthClientPath, () => atomicWrite(this.oauthClientPath, `${JSON.stringify({ installed }, null, 2)}\n`));
    return this.oauthClientPath;
  }

  async readOAuthClient() {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.oauthClientPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Google Calendar OAuth client is not configured. Run /google-calendar to import a Desktop OAuth client.");
      if (error instanceof SyntaxError) throw new Error("Saved Google Calendar OAuth client is invalid JSON. Re-import it with /google-calendar.");
      throw error;
    }
    return validateDesktopOAuthClient(raw);
  }

  async loadAccounts() {
    try {
      return validateRegistry(JSON.parse(await readFile(this.accountsPath, "utf8"))).accounts;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new Error("Saved Google Calendar account registry is invalid JSON.");
      throw error;
    }
  }

  async findAccountByEmail(email) {
    if (!email?.trim()) throw new Error("A connected Google Calendar account email is required.");
    const normalized = email.trim().toLowerCase();
    const account = (await this.loadAccounts()).find(candidate => candidate.email.toLowerCase() === normalized);
    if (!account) {
      const known = (await this.loadAccounts()).map(candidate => candidate.email).join(", ");
      throw new Error(`Unknown Google Calendar account "${email}".${known ? ` Connected accounts: ${known}.` : " Run /google-calendar to add one."}`);
    }
    return account;
  }

  async addAccount(identity, tokens) {
    if (!identity?.email || !identity?.subject) throw new Error("Google authorization did not return a verified email and subject.");
    const subjectHash = googleSubjectHash(identity.subject);
    await this.initialize();
    return withFileLock(this.accountsPath, async () => {
      const accounts = await this.loadAccounts();
      if (accounts.some(account => account.subjectHash === subjectHash)) throw new DuplicateAccountError(identity.email);
      const tokenPath = this.tokenPath(subjectHash);
      await withFileLock(tokenPath, () => atomicWrite(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`));
      const updated = [...accounts, { subjectHash, email: identity.email }];
      try {
        await atomicWrite(this.accountsPath, `${JSON.stringify({ version: REGISTRY_VERSION, accounts: updated }, null, 2)}\n`);
      } catch (error) {
        await rm(tokenPath, { force: true }).catch(() => {});
        throw error;
      }
      return { subjectHash, email: identity.email };
    });
  }

  async updateAccountEmail(subjectHash, email) {
    await withFileLock(this.accountsPath, async () => {
      const accounts = await this.loadAccounts();
      const index = accounts.findIndex(account => account.subjectHash === subjectHash);
      if (index < 0 || accounts[index].email === email) return;
      accounts[index] = { ...accounts[index], email };
      await atomicWrite(this.accountsPath, `${JSON.stringify({ version: REGISTRY_VERSION, accounts }, null, 2)}\n`);
    });
  }

  async readToken(subjectHash) {
    try {
      return JSON.parse(await readFile(this.tokenPath(subjectHash), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Saved Google Calendar credential is missing. Remove and re-add this account with /google-calendar.");
      if (error instanceof SyntaxError) throw new Error("Saved Google Calendar credential is invalid. Remove and re-add this account with /google-calendar.");
      throw error;
    }
  }

  async mergeToken(subjectHash, tokens, expectedRefreshToken) {
    const tokenPath = this.tokenPath(subjectHash);
    return withFileLock(tokenPath, async () => {
      let current;
      try {
        current = JSON.parse(await readFile(tokenPath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      if (expectedRefreshToken && current.refresh_token !== expectedRefreshToken) return false;
      await atomicWrite(tokenPath, `${JSON.stringify({ ...current, ...tokens }, null, 2)}\n`);
      return true;
    });
  }

  async removeAccount(email) {
    return withFileLock(this.accountsPath, async () => {
      const accounts = await this.loadAccounts();
      const normalized = email.trim().toLowerCase();
      const account = accounts.find(candidate => candidate.email.toLowerCase() === normalized);
      if (!account) return false;
      const remaining = accounts.filter(candidate => candidate.subjectHash !== account.subjectHash);
      await atomicWrite(this.accountsPath, `${JSON.stringify({ version: REGISTRY_VERSION, accounts: remaining }, null, 2)}\n`);
      const tokenPath = this.tokenPath(account.subjectHash);
      await withFileLock(tokenPath, () => unlink(tokenPath).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      }));
      return true;
    });
  }
}
