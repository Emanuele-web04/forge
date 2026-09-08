import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const moduleUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "helium-cookie-source.js"),
).href;
const cookieSyncUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "cookie-sync.js"),
).href;

let heliumSource: Record<string, any>;
let cookieSync: Record<string, any>;

beforeAll(async () => {
  [heliumSource, cookieSync] = await Promise.all([import(moduleUrl), import(cookieSyncUrl)]);
});

const SYNTHETIC_KEY_MATERIAL = "synthetic-key-material";
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function syntheticKeychainPassword(): string {
  return createHash("sha256").update(`helium-test:${SYNTHETIC_KEY_MATERIAL}`).digest("hex");
}

function encryptPlaintext(plaintext: string, version: number): Buffer {
  const key = pbkdf2Sync(syntheticKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  let input = Buffer.from(plaintext, "utf8");
  if (version >= 24) {
    // Recent Chromium versions place the host-key SHA-256 digest before the
    // plaintext inside the encrypted blob, so it is removed after decryption.
    const digest = createHash("sha256").update("example.test").digest();
    input = Buffer.concat([digest, input]);
  }
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

function v10Blob(plaintext: string, version = 0): Buffer {
  return Buffer.concat([Buffer.from("v10", "latin1"), encryptPlaintext(plaintext, version)]);
}

function v11Blob(plaintext: string, version = 0): Buffer {
  // v11 values carry a 35-byte prefix before the CBC ciphertext; for the test
  // fixture that prefix is arbitrary bytes followed by the encrypted body.
  return Buffer.concat([
    Buffer.from("v11", "latin1"),
    Buffer.alloc(32, 0xab),
    encryptPlaintext(plaintext, version),
  ]);
}

let home = "";
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "synara-helium-fixture-"));
  process.env.HOME = home;
  const profileDir = join(home, "Library", "Application Support", "net.imput.helium", "Default");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(profileDir, "Cookies"));
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT x'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = database.prepare(
    `INSERT INTO cookies (host_key, top_frame_site_key, has_cross_site_ancestor, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const futureUtc =
    BigInt(Math.floor(Date.now() / 1000) + 86_400 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  const pastUtc =
    BigInt(Math.floor(Date.now() / 1000) - 3_600 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  insert.run(
    "example.test",
    "",
    0,
    "session",
    "",
    v10Blob("synthetic-session-value"),
    "/",
    futureUtc,
    1,
    1,
    -1,
    2,
    443,
  );
  insert.run(
    "other.test",
    "",
    0,
    "plain",
    "plain-value",
    Buffer.alloc(0),
    "/",
    futureUtc,
    0,
    0,
    1,
    1,
    80,
  );
  insert.run(
    "broken.test",
    "",
    0,
    "broken",
    "",
    Buffer.concat([Buffer.from("v10", "latin1"), Buffer.alloc(32, 0xab)]),
    "/",
    futureUtc,
    1,
    0,
    -1,
    2,
    443,
  );
  insert.run(
    "example.test",
    "",
    0,
    "stale",
    "",
    v10Blob("stale-value"),
    "/",
    pastUtc,
    1,
    0,
    -1,
    2,
    443,
  );
  // Partitioned CHIPS cookie: same name scoped to a top-frame site.
  insert.run(
    "example.test",
    "https://partition.test",
    1,
    "partitioned",
    "",
    v10Blob("partitioned-session-value"),
    "/",
    futureUtc,
    1,
    1,
    -1,
    2,
    443,
  );
  database.close();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

function heliumOptions(overrides: { profile?: string; domains?: string[] } = {}) {
  return cookieSync.normalizeCookieSyncOptions({
    source: { browser: "helium", profile: overrides.profile ?? "Default" },
    ...(overrides.domains ? { domains: overrides.domains } : {}),
  });
}

function neverLoadNativeReader() {
  return async () => {
    throw new Error("native reader must not load for helium");
  };
}

async function createHeliumProfile(
  profileName: string,
  metaVersion: number,
  rows: Array<{
    host_key: string;
    top_frame_site_key?: string;
    has_cross_site_ancestor?: number;
    name: string;
    value?: string;
    encrypted_value?: Buffer;
    path: string;
    expires_utc: bigint;
    is_secure: number;
    is_httponly: number;
    samesite: number;
    source_scheme: number;
    source_port: number;
  }>,
  metaStorage: "text" | "integer" = "text",
): Promise<void> {
  const dir = join(home, "Library", "Application Support", "net.imput.helium", profileName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(dir, "Cookies"));
  // Real Chromium stores meta.value as INTEGER; readBigInts surfaces it as
  // bigint. The text form keeps coverage for legacy and synthetic databases.
  const metaValueType = metaStorage === "integer" ? "INTEGER" : "TEXT";
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value ${metaValueType} NOT NULL);
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL DEFAULT 0,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      encrypted_value BLOB NOT NULL DEFAULT x'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL DEFAULT 0,
      is_secure INTEGER NOT NULL DEFAULT 0,
      is_httponly INTEGER NOT NULL DEFAULT 0,
      has_expires INTEGER NOT NULL DEFAULT 1,
      samesite INTEGER NOT NULL DEFAULT -1,
      source_scheme INTEGER NOT NULL DEFAULT 2,
      source_port INTEGER NOT NULL DEFAULT 443,
      has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
    );
  `);
  database
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
    .run("version", metaStorage === "integer" ? metaVersion : String(metaVersion));
  const insert = database.prepare(
    `INSERT INTO cookies (host_key, top_frame_site_key, has_cross_site_ancestor, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.host_key,
      row.top_frame_site_key ?? "",
      row.has_cross_site_ancestor ?? 0,
      row.name,
      row.value ?? "",
      row.encrypted_value ?? Buffer.alloc(0),
      row.path,
      row.expires_utc,
      row.is_secure,
      row.is_httponly,
      row.samesite,
      row.source_scheme,
      row.source_port,
    );
  }
  if (metaVersion === 0) {
    // A version of 0 can mean either "no meta row" or "meta version 0".
    // Make sure the default fixture with a blank meta table still works.
    database.prepare("DELETE FROM meta WHERE key = ?").run("version");
  }
  database.close();
}

const futureUtc =
  BigInt(Math.floor(Date.now() / 1000) + 86_400 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;

describe.skipIf(process.platform !== "darwin")("helium cookie source", () => {
  it("lists only profiles that contain a cookie database", async () => {
    await expect(heliumSource.listHeliumProfiles()).resolves.toEqual([
      { id: "Default", name: "Default", isDefault: true },
    ]);
  });

  it("decrypts v10 rows and applies site scope through the shared pipeline", async () => {
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(2);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "synthetic-session-value",
      domain: "example.test",
      path: "/",
      secure: true,
      httpOnly: true,
    });
    expect(snapshot.cookies[1]).toMatchObject({
      name: "partitioned",
      value: "partitioned-session-value",
      domain: "example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      partitionKey: "https://partition.test",
      partitionCrossSiteAncestor: true,
    });
    expect(snapshot.skipped).toBe(2);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        { code: "decrypt_failed", count: 1 },
        { code: "domain_filtered", count: 1 },
        { code: "expired", count: 1 },
      ]),
    );
  });

  it("imports every site in profile scope and reports undecryptable rows", async () => {
    const snapshot = await cookieSync.extractCookieSync(heliumOptions(), neverLoadNativeReader(), {
      keychainPassword: async () => syntheticKeychainPassword(),
    });
    const names = snapshot.cookies.map((cookie: { name: string }) => cookie.name).sort();
    expect(names).toEqual(["partitioned", "plain", "session"]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([{ code: "decrypt_failed", count: 1 }]),
    );
  });

  it("decrypts Chromium v10 values that carry a v24 host-key digest", async () => {
    await createHeliumProfile("Chromium24", 24, [
      {
        host_key: "example.test",
        name: "session",
        encrypted_value: v10Blob("v24-session-value", 24),
        path: "/",
        expires_utc: futureUtc,
        is_secure: 1,
        is_httponly: 1,
        samesite: -1,
        source_scheme: 2,
        source_port: 443,
      },
    ]);
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ profile: "Chromium24", domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "v24-session-value",
      domain: "example.test",
    });
  });

  it("strips the v24 host-key digest when meta.version is stored as an integer", async () => {
    await createHeliumProfile(
      "Chromium24Integer",
      24,
      [
        {
          host_key: "example.test",
          name: "session",
          encrypted_value: v10Blob("v24-integer-meta-value", 24),
          path: "/",
          expires_utc: futureUtc,
          is_secure: 1,
          is_httponly: 1,
          samesite: -1,
          source_scheme: 2,
          source_port: 443,
        },
      ],
      "integer",
    );
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ profile: "Chromium24Integer", domains: ["example.test"] }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "v24-integer-meta-value",
      domain: "example.test",
    });
  });

  it("maps a corrupt cookie database to a bounded reader error", async () => {
    const dir = join(home, "Library", "Application Support", "net.imput.helium", "Corrupt");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "Cookies"), Buffer.from("not a sqlite database"));
    const error = await cookieSync
      .extractCookieSync(heliumOptions({ profile: "Corrupt" }), neverLoadNativeReader(), {
        keychainPassword: async () => syntheticKeychainPassword(),
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      cookieReaderCode: "source_extraction_failed",
      cookieReaderStage: "acquisition",
      cookiePermissionDenied: false,
    });
    expect(String(error)).not.toContain("not a sqlite");
  });

  it("decrypts Chromium v11 values", async () => {
    await createHeliumProfile("ChromiumV11", 0, [
      {
        host_key: "example.test",
        name: "session",
        encrypted_value: v11Blob("v11-session-value", 0),
        path: "/",
        expires_utc: futureUtc,
        is_secure: 1,
        is_httponly: 1,
        samesite: -1,
        source_scheme: 2,
        source_port: 443,
      },
      {
        host_key: "other.test",
        name: "plain",
        value: "plain-value",
        path: "/",
        expires_utc: futureUtc,
        is_secure: 0,
        is_httponly: 0,
        samesite: 1,
        source_scheme: 1,
        source_port: 80,
      },
    ]);
    const snapshot = await cookieSync.extractCookieSync(
      heliumOptions({ profile: "ChromiumV11" }),
      neverLoadNativeReader(),
      { keychainPassword: async () => syntheticKeychainPassword() },
    );
    const names = snapshot.cookies.map((cookie: { name: string }) => cookie.name).sort();
    expect(names).toEqual(["plain", "session"]);
    expect(snapshot.cookies.find((c: { name: string }) => c.name === "session")).toMatchObject({
      value: "v11-session-value",
      domain: "example.test",
    });
  });

  it("never loads the native reader and maps a missing profile to source_missing", async () => {
    const load = vi.fn(neverLoadNativeReader());
    const error = await cookieSync
      .extractCookieSync(heliumOptions({ profile: "Missing" }), load)
      .catch((value: unknown) => value);
    expect(load).not.toHaveBeenCalled();
    expect(error).toMatchObject({ cookieReaderCode: "no_selected_source" });
  });

  it.each([
    [
      "interaction denial",
      new Error("security: User interaction is not allowed."),
      { cookiePermissionDenied: true, cookieReaderStage: "decrypt" },
    ],
    [
      "timeout kill",
      Object.assign(new Error("spawn timed out"), { killed: true }),
      { cookieReaderCode: "timed_out", cookieReaderStage: "decrypt" },
    ],
    [
      "unknown helper failure",
      new Error("security: lookup command failed"),
      { cookieReaderCode: "source_extraction_failed", cookieReaderStage: "decrypt" },
    ],
  ])(
    "classifies Keychain helper failures without leaking the diagnostic",
    (_label, cause, expected) => {
      const error = heliumSource.keychainFailure(cause);
      expect(error).toMatchObject(expected);
      expect(String(error)).not.toContain("security:");
      expect(String(error)).not.toContain("interaction");
    },
  );

  it("propagates an injected Keychain failure unchanged", async () => {
    const cause = new Error("synthetic-injected-failure");
    const error = await heliumSource
      .readHeliumCookieSnapshot(heliumOptions(), {
        keychainPassword: async () => {
          throw cause;
        },
      })
      .catch((value: unknown) => value);
    expect(error).toBe(cause);
  });
});

describe("patched Betterwright listCookieSourceBrowsers", () => {
  it("does not treat a native-reader load failure as an empty source list", async () => {
    await rm(join(home, "Library", "Application Support", "net.imput.helium"), {
      recursive: true,
      force: true,
    });
    const load = vi.fn(async () => {
      throw new Error("synthetic native reader load failure");
    });
    await expect(cookieSync.listCookieSourceBrowsers(load)).rejects.toMatchObject({
      cookieReaderCode: "reader_unavailable",
    });
  });

  it("does not treat a native-reader supported-browsers failure as an empty source list", async () => {
    await rm(join(home, "Library", "Application Support", "net.imput.helium"), {
      recursive: true,
      force: true,
    });
    const load = vi.fn(async () => ({
      supportedBrowsers: async () => {
        throw Object.assign(new Error("synthetic supported failure"), {
          rookieCode: "discovery_failed",
        });
      },
    }));
    await expect(cookieSync.listCookieSourceBrowsers(load)).rejects.toMatchObject({
      cookieReaderCode: "discovery_failed",
    });
  });

  // Helium discovery itself is macOS-only; the two rejection tests above stay
  // platform-independent because they remove the Helium data directory first.
  it.skipIf(process.platform !== "darwin")(
    "returns Helium independently when the native reader fails",
    async () => {
      const load = vi.fn(async () => {
        throw new Error("synthetic native reader load failure");
      });
      const result = await cookieSync.listCookieSourceBrowsers(load);
      expect(result.some((entry: { id: string }) => entry.id === "helium")).toBe(true);
    },
  );
});
