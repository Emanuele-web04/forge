import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, existsSync, mkdirSync, openSync, closeSync, fsyncSync, unlinkSync, writeFileSync } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { VaultKeyProtection, type VaultKeyStore } from "./vaultKeyProtection";

const Text = Schema.String.check(Schema.isMaxLength(16_384));
const PartitionKey = Schema.Struct({ topLevelSite: Text, hasCrossSiteAncestor: Schema.Boolean });
const Cookie = Schema.Struct({
  name: Text, value: Text, domain: Text, path: Text,
  secure: Schema.Boolean, httpOnly: Schema.Boolean, session: Schema.Boolean,
  sameSite: Schema.optional(Schema.Literals(["Strict", "Lax", "None"])),
  priority: Schema.Literals(["Low", "Medium", "High"]),
  sourceScheme: Schema.Literals(["Unset", "NonSecure", "Secure"]),
  sourcePort: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 65535 })),
  partitionKey: Schema.optional(PartitionKey),
  partitionKeyOpaque: Schema.optional(Schema.Boolean),
});
type Cookie = typeof Cookie.Type;
const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  domains: Schema.Array(Text).check(Schema.isMaxLength(20_000)),
  cookies: Schema.Array(Cookie).check(Schema.isMaxLength(20_000)),
});
const AAD = Buffer.from("synara-imported-session-restore-v1");
const MAX_BYTES = 16 * 1024 * 1024;

export interface CookieSessionBackend {
  read(): Promise<unknown[]>;
  restore(cookies: Record<string, unknown>[]): Promise<void>;
  onChange(listener: () => void): void;
  dispose(): void;
}

function domainName(domain: string): string { return domain.replace(/^\./, ""); }

export function sessionCookieParameters(cookie: Cookie): Record<string, unknown> | null {
  if (!cookie.session || cookie.partitionKeyOpaque || !cookie.path.startsWith("/")) return null;
  const host = domainName(cookie.domain);
  const url = new URL(`${cookie.secure || cookie.sourceScheme === "Secure" ? "https" : "http"}://${host}/`);
  if (url.hostname !== host || url.username || url.password || url.port) return null;
  if (cookie.partitionKey) {
    const top = new URL(cookie.partitionKey.topLevelSite);
    if (!["http:", "https:"].includes(top.protocol) || top.origin !== cookie.partitionKey.topLevelSite) return null;
  }
  // URL-only preserves host-only cookies; domain cookies retain their leading dot.
  return {
    name: cookie.name, value: cookie.value, url: url.href,
    ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
    path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    priority: cookie.priority, sourceScheme: cookie.sourceScheme, sourcePort: cookie.sourcePort,
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** No snapshot from an unclean run is replayed, including an interrupted logout. */
export class BrowserSessionRestore {
  private readonly keys: VaultKeyProtection;
  private readonly dirtyPath: string;
  private readonly snapshotPath: string;
  private domains = new Set<string>();
  private revision = 0;
  private clean = false;
  private available = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, private readonly backend: CookieSessionBackend, store: VaultKeyStore) {
    this.keys = new VaultKeyProtection(directory, store);
    this.dirtyPath = join(directory, "active-run");
    this.snapshotPath = join(directory, "sessions.enc");
  }

  private syncDirectory(): void {
    if (process.platform === "win32") return;
    const fd = openSync(this.directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private invalidate(): void {
    writeFileSync(this.dirtyPath, "1", { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), flush: true });
    this.syncDirectory();
    this.clean = false;
  }

  async initialize(): Promise<void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const interrupted = existsSync(this.dirtyPath);
    this.invalidate();
    this.backend.onChange(() => {
      this.revision++;
      if (this.clean) this.invalidate();
    });
    const key = await this.keys.provide();
    key.fill(0);
    this.available = true;
    if (interrupted) {
      await unlink(this.snapshotPath).catch(() => {});
      return;
    }
    let file;
    try { file = await open(this.snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new Error("Browser session restoration is unavailable.");
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 28) throw new Error("Invalid session snapshot.");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error("Invalid session snapshot.");
      const encrypted = buffer.subarray(0, bytesRead);
      const dataKey = await this.keys.provide();
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", dataKey, encrypted.subarray(0, 12));
        decipher.setAAD(AAD);
        decipher.setAuthTag(encrypted.subarray(12, 28));
        plaintext = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
        const snapshot = Schema.decodeUnknownSync(Snapshot)(JSON.parse(plaintext.toString("utf8")));
        this.domains = new Set(snapshot.domains);
        const cookies = snapshot.cookies.map(sessionCookieParameters);
        if (cookies.some((cookie) => cookie === null)) throw new Error("Unsupported session snapshot.");
        await this.backend.restore(cookies as Record<string, unknown>[]);
      } finally { dataKey.fill(0); plaintext?.fill(0); }
    } catch {
      this.domains.clear();
      await unlink(this.snapshotPath).catch(() => {});
      throw new Error("Browser session restoration is unavailable.");
    } finally { await file.close(); }
  }

  async rememberImport(domains: readonly string[]): Promise<void> {
    if (!this.available) throw new Error("Secure browser session storage is unavailable.");
    let raw: unknown[];
    try { raw = await this.backend.read(); }
    catch { throw new Error("Browser session metadata could not be read."); }
    let cookies: readonly Cookie[];
    try { cookies = Schema.decodeUnknownSync(Schema.Array(Cookie))(raw); }
    catch { throw new Error("Browser session metadata is unsupported."); }
    const imported = new Set(domains.map(domainName));
    for (const cookie of cookies) if (imported.has(domainName(cookie.domain))) this.domains.add(cookie.domain);
    await this.save();
  }

  private save(): Promise<void> {
    const operation = this.writing.then(async () => {
      const cookies = Schema.decodeUnknownSync(Schema.Array(Cookie))(await this.backend.read())
        .filter((cookie) => cookie.session && this.domains.has(cookie.domain));
      // Refuse to claim continuity if isolation metadata cannot be replayed.
      if (cookies.some((cookie) => sessionCookieParameters(cookie) === null)) throw new Error("Unsupported session cookie metadata.");
      const plaintext = Buffer.from(JSON.stringify({ version: 1, domains: [...this.domains], cookies }));
      if (plaintext.length > MAX_BYTES - 28) throw new Error("Session snapshot is too large.");
      const key = await this.keys.provide();
      const temporary = join(this.directory, `sessions-${randomBytes(16).toString("hex")}.tmp`);
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(AAD);
        const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600, flag: "wx", flush: true });
        await rename(temporary, this.snapshotPath);
        this.syncDirectory();
      } finally { key.fill(0); plaintext.fill(0); await unlink(temporary).catch(() => {}); }
    });
    const safeOperation = operation.catch(() => { throw new Error("Secure browser session persistence failed."); });
    this.writing = safeOperation.catch(() => {});
    return safeOperation;
  }

  async shutdown(): Promise<void> {
    try {
      if (!this.available) return;
      const revision = this.revision;
      await this.save();
      if (this.revision !== revision) throw new Error("Browser cookies changed during shutdown.");
      this.clean = true;
      unlinkSync(this.dirtyPath);
      this.syncDirectory();
    } finally { this.keys.dispose(); this.backend.dispose(); }
  }
}
