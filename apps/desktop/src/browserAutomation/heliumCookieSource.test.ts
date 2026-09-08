import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const moduleUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "helium-cookie-source.js"),
).href;
const heliumSource = await import(moduleUrl);
const cookieSyncUrl = pathToFileURL(
  path.join(path.dirname(require.resolve("betterwright")), "cookie-sync.js"),
).href;
const cookieSync = await import(cookieSyncUrl);

const SYNTHETIC_KEY_MATERIAL = "synthetic-key-material";
const CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function syntheticKeychainPassword(): string {
  return createHash("sha256").update(`helium-test:${SYNTHETIC_KEY_MATERIAL}`).digest("hex");
}

function v10Blob(plaintext: string): Buffer {
  const key = pbkdf2Sync(syntheticKeychainPassword(), "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10", "latin1"),
    cipher.update(plaintext, "utf8"),
    cipher.final(),
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
      source_port INTEGER NOT NULL DEFAULT 443
    );
  `);
  const insert = database.prepare(
    `INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const futureUtc =
    BigInt(Math.floor(Date.now() / 1000) + 86_400 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  const pastUtc =
    BigInt(Math.floor(Date.now() / 1000) - 3_600 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000n;
  insert.run(
    "example.test",
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
  insert.run("other.test", "plain", "plain-value", Buffer.alloc(0), "/", futureUtc, 0, 0, 1, 1, 80);
  insert.run(
    "broken.test",
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
  insert.run("example.test", "stale", "", v10Blob("stale-value"), "/", pastUtc, 1, 0, -1, 2, 443);
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
    expect(snapshot.cookies).toHaveLength(1);
    expect(snapshot.cookies[0]).toMatchObject({
      name: "session",
      value: "synthetic-session-value",
      domain: "example.test",
      path: "/",
      secure: true,
      httpOnly: true,
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
    expect(names).toEqual(["plain", "session"]);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([{ code: "decrypt_failed", count: 1 }]),
    );
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
