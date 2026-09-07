import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionRestore, sessionCookieParameters, type CookieSessionBackend } from "./browserSessionRestore";

const homes: string[] = [];
const store = { available: async () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() };
const cookie = { name: "fixture", value: "synthetic-session-secret", domain: "example.test", path: "/", secure: true, httpOnly: true, session: true, sameSite: "Strict" as const, priority: "High" as const, sourceScheme: "Secure" as const, sourcePort: 443 };

function backend(initial: unknown[] = [cookie]) {
  let cookies = initial;
  let change = () => {};
  const api = {
    read: vi.fn(async () => cookies),
    restore: vi.fn(async (_cookies: Record<string, unknown>[]) => {}),
    onChange: (listener: () => void) => { change = listener; },
    dispose: vi.fn(),
    change(next: unknown[]) { cookies = next; change(); },
  } satisfies CookieSessionBackend & { change(next: unknown[]): void };
  return api;
}

async function home() {
  const path = await mkdtemp(join(tmpdir(), "synara-session-restore-test-"));
  homes.push(path);
  return path;
}
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("imported browser session restoration", () => {
  it("restores encrypted session cookies after clean shutdown without fabricating expiry", async () => {
    const directory = await home();
    const first = new BrowserSessionRestore(directory, backend(), store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    expect((await readFile(join(directory, "sessions.enc"))).includes(Buffer.from(cookie.value))).toBe(false);
    expect((await stat(join(directory, "sessions.enc"))).mode & 0o777).toBe(0o600);
    await first.shutdown();
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await second.initialize();
    expect(next.restore).toHaveBeenCalledWith([expect.objectContaining({ name: cookie.name, value: cookie.value, url: "https://example.test/", secure: true, httpOnly: true, sameSite: "Strict" })]);
    expect(next.restore.mock.calls[0]![0][0]).not.toHaveProperty("expires");
    expect(next.restore.mock.calls[0]![0][0]).not.toHaveProperty("domain");
    await second.shutdown();
  });

  it("does not revive logged-out cookies on the next launch", async () => {
    const directory = await home();
    const source = backend();
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    source.change([]);
    await first.shutdown();
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await second.initialize();
    expect(next.restore).toHaveBeenCalledWith([]);
    await second.shutdown();
  });

  it("discards stale snapshots after an unclean run, including a logout before persistence", async () => {
    const directory = await home();
    const source = backend();
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    source.change([]);
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await second.initialize();
    expect(next.restore).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "sessions.enc"))).toBe(false);
    await second.shutdown();
  });

  it("stores only imported domains and leaves persistent-cookie expiry to Chromium", async () => {
    const directory = await home();
    const source = backend([cookie, { ...cookie, name: "persistent", session: false }, { ...cookie, domain: "unrelated.test" }]);
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    await first.shutdown();
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await second.initialize();
    expect(next.restore.mock.calls[0]![0]).toHaveLength(1);
    await second.shutdown();
  });

  it("captures current rotated values rather than the original import", async () => {
    const directory = await home();
    const source = backend();
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    source.change([{ ...cookie, value: "rotated-synthetic" }]);
    await first.shutdown();
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await second.initialize();
    expect(next.restore.mock.calls[0]![0][0]).toMatchObject({ value: "rotated-synthetic" });
    await second.shutdown();
  });

  it("preserves partition keys and domain-cookie scope", () => {
    const partitionKey = { topLevelSite: "https://parent.test", hasCrossSiteAncestor: true };
    expect(sessionCookieParameters({ ...cookie, domain: ".example.test", partitionKey })).toMatchObject({ domain: ".example.test", partitionKey });
    expect(sessionCookieParameters({ ...cookie, partitionKeyOpaque: true })).toBeNull();
  });

  it("refuses a clean checkpoint when cookies mutate during the final read", async () => {
    const directory = await home();
    const source = backend();
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    source.read.mockImplementationOnce(async () => { source.change([]); return [cookie]; });
    await expect(first.shutdown()).rejects.toThrow();
    expect(existsSync(join(directory, "active-run"))).toBe(true);
  });

  it("invalidates a clean checkpoint if a late cookie deletion arrives", async () => {
    const directory = await home();
    const source = backend();
    const first = new BrowserSessionRestore(directory, source, store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    await first.shutdown();
    source.change([]);
    expect(existsSync(join(directory, "active-run"))).toBe(true);
  });

  it("fails closed on tampered encrypted data", async () => {
    const directory = await home();
    const first = new BrowserSessionRestore(directory, backend(), store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    await first.shutdown();
    const path = join(directory, "sessions.enc");
    const data = await readFile(path);
    data[data.length - 1] ^= 1;
    await writeFile(path, data);
    const next = backend([]);
    const second = new BrowserSessionRestore(directory, next, store);
    await expect(second.initialize()).rejects.toThrow("restoration is unavailable");
    expect(next.restore).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "active-run"))).toBe(true);
  });

  it("does not claim persistence when secure OS key storage is unavailable", async () => {
    const first = new BrowserSessionRestore(await home(), backend(), { ...store, available: async () => false });
    await expect(first.initialize()).rejects.toThrow();
    await expect(first.rememberImport(["example.test"])).rejects.toThrow("Secure browser session storage is unavailable");
    await first.shutdown();
  });

  it("keeps the dirty marker when a replacement snapshot cannot be written", async () => {
    const directory = await home();
    const first = new BrowserSessionRestore(directory, backend(), store);
    await first.initialize();
    await first.rememberImport(["example.test"]);
    await unlink(join(directory, "sessions.enc"));
    await mkdir(join(directory, "sessions.enc"));
    await expect(first.shutdown()).rejects.toThrow("Secure browser session persistence failed.");
    expect(existsSync(join(directory, "active-run"))).toBe(true);
  });
});
