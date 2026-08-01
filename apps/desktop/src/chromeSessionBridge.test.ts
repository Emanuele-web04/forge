import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeSessionBridge } from "./chromeSessionBridge";

const tempDirectories: string[] = [];
const chromeEpochOffsetMicroseconds = 11_644_473_600_000_000n;

function createChromeRoot(localState: object): {
  readonly homeDir: string;
  readonly root: string;
} {
  const homeDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-chrome-import-"));
  tempDirectories.push(homeDir);
  const root = Path.join(homeDir, "Library", "Application Support", "Google", "Chrome");
  FS.mkdirSync(root, { recursive: true });
  FS.writeFileSync(Path.join(root, "Local State"), JSON.stringify(localState));
  return { homeDir, root };
}

function createCookieDatabase(root: string, profileId: string): DatabaseSync {
  const profilePath = Path.join(root, profileId);
  FS.mkdirSync(profilePath, { recursive: true });
  const database = new DatabaseSync(Path.join(profilePath, "Cookies"));
  database.exec(`
    CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta(key, value) VALUES ('version', '24');
    CREATE TABLE cookies(
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL,
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      has_expires INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL,
      last_update_utc INTEGER NOT NULL
    );
  `);
  return database;
}

function chromeTimestamp(unixMilliseconds: number): string {
  return (chromeEpochOffsetMicroseconds + BigInt(Math.floor(unixMilliseconds)) * 1_000n).toString();
}

function encryptCookie(password: string, hostKey: string, value: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([
    createHash("sha256").update(hostKey).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
}

function insertCookie(
  database: DatabaseSync,
  input: {
    readonly hostKey: string;
    readonly name: string;
    readonly value?: string;
    readonly encryptedValue?: Uint8Array;
    readonly path?: string;
    readonly expiresUtc?: string;
    readonly hasExpires?: boolean;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: number;
    readonly topFrameSiteKey?: string;
    readonly lastUpdateUtc?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO cookies(
        host_key, top_frame_site_key, name, value, encrypted_value, path,
        expires_utc, is_secure, is_httponly, has_expires, samesite,
        source_scheme, last_update_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.hostKey,
      input.topFrameSiteKey ?? "",
      input.name,
      input.value ?? "",
      input.encryptedValue ?? Buffer.alloc(0),
      input.path ?? "/",
      input.expiresUtc ?? "0",
      input.secure === false ? 0 : 1,
      input.httpOnly === false ? 0 : 1,
      input.hasExpires === true ? 1 : 0,
      input.sameSite ?? -1,
      input.secure === false ? 1 : 2,
      input.lastUpdateUtc ?? "1",
    );
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChromeSessionBridge", () => {
  it("reports the feature as unavailable outside macOS", () => {
    const bridge = new ChromeSessionBridge({ platform: "linux", homeDir: "/unused" });

    expect(bridge.getProfileState()).toEqual({
      supported: false,
      profiles: [],
      preferredProfileId: null,
      unavailableReason: "Chrome sign-in import is currently available on macOS only.",
    });
  });

  it("lists cookie-bearing Chrome profiles and prefers the active one", () => {
    const { homeDir, root } = createChromeRoot({
      profile: {
        last_active_profiles: ["Profile 2"],
        info_cache: {
          Default: { name: "Personal", active_time: 10 },
          "Profile 2": { gaia_name: "Work", active_time: 20 },
          "../escape": { name: "Unsafe", active_time: 30 },
        },
      },
    });
    createCookieDatabase(root, "Default").close();
    createCookieDatabase(root, "Profile 2").close();

    expect(new ChromeSessionBridge({ platform: "darwin", homeDir }).getProfileState()).toEqual({
      supported: true,
      profiles: [
        { id: "Profile 2", label: "Work" },
        { id: "Default", label: "Personal" },
      ],
      preferredProfileId: "Profile 2",
      unavailableReason: null,
    });
  });

  it("decrypts and returns only unpartitioned cookies applicable to the requested site", async () => {
    const password = "test-safe-storage-password";
    const now = Date.UTC(2026, 6, 31);
    const { homeDir, root } = createChromeRoot({
      profile: { info_cache: { Default: { name: "Personal" } } },
    });
    const database = createCookieDatabase(root, "Default");
    insertCookie(database, {
      hostKey: ".google.com",
      name: "SID",
      encryptedValue: encryptCookie(password, ".google.com", "secret-session"),
      expiresUtc: chromeTimestamp(now + 60_000),
      hasExpires: true,
      sameSite: 2,
      lastUpdateUtc: "9",
    });
    insertCookie(database, {
      hostKey: "accounts.google.com",
      name: "HOST_ONLY",
      value: "plain-session",
      secure: true,
      httpOnly: false,
      sameSite: 1,
      lastUpdateUtc: "8",
    });
    insertCookie(database, {
      hostKey: ".google.com",
      name: "PARTITIONED",
      encryptedValue: encryptCookie(password, ".google.com", "partitioned"),
      topFrameSiteKey: "https://example.com",
      lastUpdateUtc: "7",
    });
    insertCookie(database, {
      hostKey: ".google.com",
      name: "EXPIRED",
      encryptedValue: encryptCookie(password, ".google.com", "expired"),
      expiresUtc: chromeTimestamp(now - 60_000),
      hasExpires: true,
      lastUpdateUtc: "6",
    });
    insertCookie(database, {
      hostKey: ".youtube.com",
      name: "OTHER_SITE",
      encryptedValue: encryptCookie(password, ".youtube.com", "other"),
      lastUpdateUtc: "5",
    });
    database.close();
    const readSafeStoragePassword = vi.fn(async () => password);

    const result = await new ChromeSessionBridge({
      platform: "darwin",
      homeDir,
      now: () => now,
      readSafeStoragePassword,
    }).readSiteCookies("Default", "https://accounts.google.com/signin");

    expect(readSafeStoragePassword).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      site: "accounts.google.com",
      sourceProfileLabel: "Personal",
      skippedCookieCount: 2,
    });
    expect(result.cookies).toEqual([
      {
        url: "https://accounts.google.com/",
        name: "SID",
        value: "secret-session",
        domain: ".google.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: (now + 60_000) / 1_000,
        sameSite: "strict",
      },
      {
        url: "https://accounts.google.com/",
        name: "HOST_ONLY",
        value: "plain-session",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
      },
    ]);
  });

  it("fails closed when a v24 cookie domain hash does not match", async () => {
    const password = "test-safe-storage-password";
    const { homeDir, root } = createChromeRoot({
      profile: { info_cache: { Default: { name: "Personal" } } },
    });
    const database = createCookieDatabase(root, "Default");
    insertCookie(database, {
      hostKey: ".google.com",
      name: "SID",
      encryptedValue: encryptCookie(password, ".example.com", "wrong-domain"),
    });
    database.close();

    const result = await new ChromeSessionBridge({
      platform: "darwin",
      homeDir,
      readSafeStoragePassword: async () => password,
    }).readSiteCookies("Default", "https://accounts.google.com");

    expect(result.cookies).toEqual([]);
    expect(result.skippedCookieCount).toBe(1);
  });

  it("opens only web URLs in Chrome", async () => {
    const openChrome = vi.fn(async () => undefined);
    const bridge = new ChromeSessionBridge({ platform: "darwin", openChrome });

    await bridge.openSignIn("https://accounts.google.com/signin");
    expect(openChrome).toHaveBeenCalledWith("https://accounts.google.com/signin");
    await expect(bridge.openSignIn("file:///tmp/private")).rejects.toThrow(/http\(s\)/i);
  });
});
