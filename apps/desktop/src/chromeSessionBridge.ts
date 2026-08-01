// FILE: chromeSessionBridge.ts
// Purpose: Imports one site's Chrome cookies into a user-selected Synara browser profile.
// Layer: Desktop browser identity infrastructure (macOS only)

import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFile } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import type { BrowserChromeProfile, BrowserChromeProfileState } from "@synara/contracts";

const CHROME_BUNDLE_ID = "com.google.Chrome";
const CHROME_SAFE_STORAGE_ACCOUNT = "Chrome";
const CHROME_SAFE_STORAGE_SERVICE = "Chrome Safe Storage";
const CHROME_COOKIE_PREFIX = "v10";
const CHROME_COOKIE_SCHEMA_HASH_VERSION = 24;
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;
const MAX_SITE_COOKIE_ROWS = 2_000;
const execFileAsync = promisify(execFile);

interface ChromeLocalStateProfile {
  readonly name?: unknown;
  readonly gaia_name?: unknown;
  readonly active_time?: unknown;
}

interface ChromeLocalState {
  readonly profile?: {
    readonly last_used?: unknown;
    readonly last_active_profiles?: unknown;
    readonly info_cache?: unknown;
  };
}

interface ChromeCookieRow {
  readonly host_key: string;
  readonly name: string;
  readonly value: string;
  readonly encrypted_value: Uint8Array;
  readonly path: string;
  readonly expires_utc: string;
  readonly is_secure: number;
  readonly is_httponly: number;
  readonly has_expires: number;
  readonly samesite: number;
  readonly source_scheme: number;
  readonly top_frame_site_key: string;
}

export interface ChromeCookieImport {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface ChromeSiteCookieReadResult {
  readonly cookies: readonly ChromeCookieImport[];
  readonly skippedCookieCount: number;
  readonly site: string;
  readonly sourceProfileLabel: string;
}

export interface ChromeSessionBridgeOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly now?: () => number;
  readonly readSafeStoragePassword?: () => Promise<string>;
  readonly openChrome?: (url: string) => Promise<void>;
}

function requireWebUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Chrome sign-in requires an http(s) page.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname.length === 0) {
    throw new Error("Chrome sign-in requires an http(s) page.");
  }
  return url;
}

function profileDisplayName(directory: string, value: ChromeLocalStateProfile): string {
  for (const candidate of [value.gaia_name, value.name]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.replace(/\s+/gu, " ").trim().slice(0, 80);
    }
  }
  return directory === "Default" ? "Chrome" : directory;
}

function isSafeChromeProfileDirectory(value: string): boolean {
  return (
    value === "Default" ||
    value === "Guest Profile" ||
    value === "System Profile" ||
    /^Profile \d{1,4}$/u.test(value)
  );
}

function parseChromeProfiles(localState: ChromeLocalState): {
  readonly profiles: BrowserChromeProfile[];
  readonly preferredProfileId: string | null;
} {
  const infoCache = localState.profile?.info_cache;
  if (!infoCache || typeof infoCache !== "object" || Array.isArray(infoCache)) {
    return { profiles: [], preferredProfileId: null };
  }

  const records = Object.entries(infoCache)
    .filter(([directory, value]) => isSafeChromeProfileDirectory(directory) && !!value)
    .map(([directory, value]) => {
      const profile = value as ChromeLocalStateProfile;
      const activeTime =
        typeof profile.active_time === "number" && Number.isFinite(profile.active_time)
          ? profile.active_time
          : 0;
      return {
        profile: { id: directory, label: profileDisplayName(directory, profile) },
        activeTime,
      };
    })
    .sort(
      (left, right) =>
        right.activeTime - left.activeTime || left.profile.id.localeCompare(right.profile.id),
    );

  const ids = new Set(records.map((record) => record.profile.id));
  const rawLastUsed = localState.profile?.last_used;
  const activeProfiles = localState.profile?.last_active_profiles;
  const preferredCandidates = [
    typeof rawLastUsed === "string" ? rawLastUsed : null,
    Array.isArray(activeProfiles) && typeof activeProfiles[0] === "string"
      ? activeProfiles[0]
      : null,
    records[0]?.profile.id ?? null,
  ];
  const preferredProfileId = preferredCandidates.find(
    (candidate): candidate is string => candidate !== null && ids.has(candidate),
  );
  return {
    profiles: records.map((record) => record.profile),
    preferredProfileId: preferredProfileId ?? null,
  };
}

function cookieDomainMatchesHostname(hostKey: string, hostname: string): boolean {
  const normalizedHostKey = hostKey.toLocaleLowerCase("en-US");
  if (normalizedHostKey.startsWith(".")) {
    const domain = normalizedHostKey.slice(1);
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
  return normalizedHostKey === hostname;
}

function candidateCookieHostKeys(hostname: string): string[] {
  const labels = hostname.split(".").filter(Boolean);
  const candidates = new Set<string>([hostname]);
  if (labels.length === 1) return [...candidates];
  // Never include the final label alone (for example `.com`). Chrome itself
  // rejects public-suffix cookies, and excluding it keeps the query narrowly
  // scoped even if a profile database has been tampered with.
  for (let index = 0; index < labels.length - 1; index += 1) {
    const suffix = labels.slice(index).join(".");
    candidates.add(suffix);
    candidates.add(`.${suffix}`);
  }
  return [...candidates];
}

function sameSiteFromChrome(value: number): ChromeCookieImport["sameSite"] {
  switch (value) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

function chromeTimeToUnixSeconds(value: string): number | null {
  try {
    const microseconds = BigInt(value) - CHROME_EPOCH_OFFSET_MICROSECONDS;
    if (microseconds <= 0n) return null;
    const seconds = Number(microseconds) / 1_000_000;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

function decryptChromeCookie(
  encryptedValue: Uint8Array,
  key: Buffer,
  hostKey: string,
  schemaVersion: number,
): string | null {
  const encrypted = Buffer.from(encryptedValue);
  if (encrypted.length <= CHROME_COOKIE_PREFIX.length) return null;
  if (
    encrypted.subarray(0, CHROME_COOKIE_PREFIX.length).toString("ascii") !== CHROME_COOKIE_PREFIX
  ) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(CHROME_COOKIE_PREFIX.length)),
      decipher.final(),
    ]);
    if (schemaVersion < CHROME_COOKIE_SCHEMA_HASH_VERSION) return plaintext.toString("utf8");
    if (plaintext.length < 32) return null;
    const expectedDomainHash = createHash("sha256").update(hostKey).digest();
    if (!plaintext.subarray(0, expectedDomainHash.length).equals(expectedDomainHash)) return null;
    return plaintext.subarray(expectedDomainHash.length).toString("utf8");
  } catch {
    return null;
  }
}

async function readChromeSafeStoragePassword(): Promise<string> {
  try {
    const result = await execFileAsync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-a",
        CHROME_SAFE_STORAGE_ACCOUNT,
        "-s",
        CHROME_SAFE_STORAGE_SERVICE,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const password = String(result.stdout).trim();
    if (password.length > 0) return password;
  } catch {
    // Some existing Chrome installations omit the account attribute. Retry by
    // service name before surfacing a user-facing Keychain error.
  }
  try {
    const result = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", CHROME_SAFE_STORAGE_SERVICE],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const password = String(result.stdout).trim();
    if (password.length > 0) return password;
  } catch {
    // Fall through to the stable error below without exposing command output.
  }
  throw new Error("Chrome cookies could not be unlocked in macOS Keychain.");
}

async function openUrlInChrome(url: string): Promise<void> {
  try {
    await execFileAsync("/usr/bin/open", ["-b", CHROME_BUNDLE_ID, url], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
  } catch {
    throw new Error("Google Chrome is not installed or could not be opened.");
  }
}

export class ChromeSessionBridge {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly now: () => number;
  private readonly passwordReader: () => Promise<string>;
  private readonly chromeOpener: (url: string) => Promise<void>;

  constructor(options: ChromeSessionBridgeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? OS.homedir();
    this.now = options.now ?? Date.now;
    this.passwordReader = options.readSafeStoragePassword ?? readChromeSafeStoragePassword;
    this.chromeOpener = options.openChrome ?? openUrlInChrome;
  }

  getProfileState(): BrowserChromeProfileState {
    if (this.platform !== "darwin") {
      return {
        supported: false,
        profiles: [],
        preferredProfileId: null,
        unavailableReason: "Chrome sign-in import is currently available on macOS only.",
      };
    }
    const localStatePath = Path.join(this.chromeRoot(), "Local State");
    let localState: ChromeLocalState;
    try {
      localState = JSON.parse(FS.readFileSync(localStatePath, "utf8")) as ChromeLocalState;
    } catch {
      return {
        supported: false,
        profiles: [],
        preferredProfileId: null,
        unavailableReason: "Google Chrome profiles were not found on this Mac.",
      };
    }
    const parsed = parseChromeProfiles(localState);
    const profiles = parsed.profiles.filter((profile) => this.resolveCookieDatabase(profile.id));
    const profileIds = new Set(profiles.map((profile) => profile.id));
    const preferredProfileId =
      parsed.preferredProfileId && profileIds.has(parsed.preferredProfileId)
        ? parsed.preferredProfileId
        : (profiles[0]?.id ?? null);
    return {
      supported: profiles.length > 0,
      profiles,
      preferredProfileId,
      unavailableReason:
        profiles.length > 0 ? null : "Google Chrome does not have an importable profile yet.",
    };
  }

  async openSignIn(rawUrl: string): Promise<void> {
    const url = requireWebUrl(rawUrl);
    await this.chromeOpener(url.toString());
  }

  async readSiteCookies(
    chromeProfileId: string,
    rawUrl: string,
  ): Promise<ChromeSiteCookieReadResult> {
    if (this.platform !== "darwin") {
      throw new Error("Chrome sign-in import is currently available on macOS only.");
    }
    const url = requireWebUrl(rawUrl);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    const profileState = this.getProfileState();
    const sourceProfile = profileState.profiles.find((profile) => profile.id === chromeProfileId);
    if (!sourceProfile) throw new Error("The selected Chrome profile is no longer available.");
    const databasePath = this.resolveCookieDatabase(sourceProfile.id);
    if (!databasePath) throw new Error("The selected Chrome profile has no cookie store.");

    const database = new DatabaseSync(databasePath, { readOnly: true });
    let key: Buffer | null = null;
    try {
      const versionRow = database
        .prepare("SELECT value FROM meta WHERE key = 'version' LIMIT 1")
        .get() as { readonly value?: unknown } | undefined;
      const schemaVersion = Number(versionRow?.value ?? 0);
      const candidateHosts = candidateCookieHostKeys(hostname);
      const placeholders = candidateHosts.map(() => "?").join(", ");
      const rows = database
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path,
                  CAST(expires_utc AS TEXT) AS expires_utc,
                  is_secure, is_httponly, has_expires, samesite, source_scheme,
                  top_frame_site_key
             FROM cookies
            WHERE host_key IN (${placeholders})
            ORDER BY last_update_utc DESC
            LIMIT ${MAX_SITE_COOKIE_ROWS}`,
        )
        .all(...candidateHosts) as unknown as ChromeCookieRow[];

      const hasEncryptedRows = rows.some((row) => row.encrypted_value.byteLength > 0);
      if (hasEncryptedRows) {
        const password = await this.passwordReader();
        key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
      }

      const cookies: ChromeCookieImport[] = [];
      const seenCookieKeys = new Set<string>();
      let skippedCookieCount = 0;
      for (const row of rows) {
        if (
          !cookieDomainMatchesHostname(row.host_key, hostname) ||
          row.top_frame_site_key.length > 0
        ) {
          skippedCookieCount += 1;
          continue;
        }
        const cookieKey = `${row.host_key}\0${row.name}\0${row.path}`;
        if (seenCookieKeys.has(cookieKey)) {
          skippedCookieCount += 1;
          continue;
        }
        seenCookieKeys.add(cookieKey);

        const expirationDate = row.has_expires
          ? chromeTimeToUnixSeconds(row.expires_utc)
          : undefined;
        if (row.has_expires && (!expirationDate || expirationDate <= this.now() / 1_000)) {
          skippedCookieCount += 1;
          continue;
        }
        const value =
          row.encrypted_value.byteLength > 0
            ? key
              ? decryptChromeCookie(row.encrypted_value, key, row.host_key, schemaVersion)
              : null
            : row.value;
        if (value === null) {
          skippedCookieCount += 1;
          continue;
        }

        const secure = row.is_secure === 1 || row.source_scheme === 2;
        const cookieUrl = new URL(url.toString());
        cookieUrl.protocol = secure ? "https:" : url.protocol;
        cookieUrl.pathname = row.path.startsWith("/") ? row.path : "/";
        cookieUrl.search = "";
        cookieUrl.hash = "";
        cookies.push({
          url: cookieUrl.toString(),
          name: row.name,
          value,
          ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
          path: cookieUrl.pathname,
          secure,
          httpOnly: row.is_httponly === 1,
          ...(typeof expirationDate === "number" ? { expirationDate } : {}),
          sameSite: sameSiteFromChrome(row.samesite),
        });
      }
      return {
        cookies,
        skippedCookieCount,
        site: hostname,
        sourceProfileLabel: sourceProfile.label,
      };
    } finally {
      key?.fill(0);
      database.close();
    }
  }

  private chromeRoot(): string {
    return Path.join(this.homeDir, "Library", "Application Support", "Google", "Chrome");
  }

  private resolveCookieDatabase(profileId: string): string | null {
    if (!isSafeChromeProfileDirectory(profileId)) return null;
    const profilePath = Path.join(this.chromeRoot(), profileId);
    for (const relativePath of [Path.join("Network", "Cookies"), "Cookies"]) {
      const candidate = Path.join(profilePath, relativePath);
      if (FS.existsSync(candidate)) return candidate;
    }
    return null;
  }
}
