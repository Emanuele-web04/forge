import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";

export interface VaultKeyStore {
  available(): Promise<boolean>;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const MasterEnvelope = Schema.Struct({
  salt: Schema.String,
  iv: Schema.String,
  tag: Schema.String,
  data: Schema.String,
});
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  os: Schema.NullOr(Schema.String),
  master: Schema.NullOr(MasterEnvelope),
});
type Envelope = typeof Envelope.Type;
const AAD = Buffer.from("synara-browser-vault-key-v1");

function decode(value: string, length: number): Buffer {
  const result = Buffer.from(value, "base64");
  if (result.length !== length || result.toString("base64") !== value)
    throw new Error("Invalid vault key envelope.");
  return result;
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (!password || Buffer.byteLength(password) > 1024) throw new Error("Invalid master password.");
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(new Error("Master password verification failed."));
        else resolve(key);
      },
    );
  });
}

async function readPrivate(path: string, max: number): Promise<Buffer | null> {
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > max) throw new Error("Invalid vault key file.");
      const buffer = Buffer.alloc(max + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > max) {
        buffer.fill(0);
        throw new Error("Invalid vault key file.");
      }
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

/** The same data key is wrapped by a master-derived key and, optionally, the OS key store. */
export class VaultKeyProtection {
  private envelope: Envelope | null = null;
  private key: Buffer | null = null;
  private readonly ready: Promise<void>;
  private authenticating = false;
  private retryAt = 0;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly store?: VaultKeyStore,
  ) {
    this.ready = this.load().finally(() => {
      if (this.disposed) {
        this.key?.fill(0);
        this.key = null;
      }
    });
    void this.ready.catch(() => {});
  }

  private async load(): Promise<void> {
    const stored = await readPrivate(join(this.directory, "key-protection.json"), 16_384);
    if (stored) {
      this.envelope = Schema.decodeUnknownSync(Envelope)(JSON.parse(stored.toString("utf8")));
      if (!this.envelope.master && !this.envelope.os)
        throw new Error("Vault key protection is missing.");
      if (this.envelope.os && this.store && (await this.store.available())) {
        try {
          this.key = decode(this.store.decrypt(Buffer.from(this.envelope.os, "base64")), 32);
        } catch {
          if (!this.envelope.master) throw new Error("OS vault key storage is unavailable.");
        }
        if (this.key) await this.removeLegacyKey();
      }
      return;
    }
    const legacy = await readPrivate(join(this.directory, "vault.key"), 32);
    if (legacy && legacy.length !== 32) throw new Error("Invalid legacy vault key.");
    if (!legacy && (await readPrivate(join(this.directory, "vault.enc"), 32 * 1024 * 1024))) {
      throw new Error("Vault key is missing; refusing to replace existing credentials.");
    }
    this.key = legacy ?? randomBytes(32);
    if (await this.store?.available()) {
      const os = this.wrapForOs(this.key);
      await this.persist({ version: 1, os, master: null });
      await this.removeLegacyKey();
    }
  }

  private wrapForOs(key: Buffer): string {
    if (!this.store) throw new Error("Secure OS storage is unavailable.");
    const wrapped = this.store.encrypt(key.toString("base64"));
    const verified = decode(this.store.decrypt(wrapped), 32);
    try {
      if (!timingSafeEqual(key, verified)) throw new Error("OS key storage verification failed.");
      return wrapped.toString("base64");
    } finally {
      verified.fill(0);
    }
  }

  private async persist(envelope: Envelope): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `key-${randomBytes(16).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(envelope), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
      await rename(temporary, join(this.directory, "key-protection.json"));
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.envelope = envelope;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async removeLegacyKey(): Promise<void> {
    const legacy = await readPrivate(join(this.directory, "vault.key"), 32);
    if (!legacy) return;
    try {
      if (!this.key || legacy.length !== 32 || !timingSafeEqual(legacy, this.key))
        throw new Error("Vault key migration could not be verified.");
      await unlink(join(this.directory, "vault.key"));
    } finally {
      legacy.fill(0);
    }
  }

  async status() {
    await this.ready;
    return {
      configured: this.envelope?.master != null,
      locked: !this.key || !this.envelope,
      osProtected: this.envelope?.os != null,
    };
  }

  async provide(): Promise<Buffer> {
    await this.ready;
    if (this.disposed || !this.key || !this.envelope)
      throw new Error("Unlock the browser vault first.");
    return Buffer.from(this.key);
  }

  async setup(password: string): Promise<void> {
    await this.ready;
    if (this.disposed || this.authenticating || this.envelope?.master || !this.key)
      throw new Error("Master password setup is unavailable.");
    if (password.length < 12 || Buffer.byteLength(password) > 1024)
      throw new Error("Use at least 12 characters for the master password.");
    this.authenticating = true;
    const salt = randomBytes(16);
    let derived: Buffer | undefined;
    try {
      derived = await derive(password, salt);
      if (this.disposed) throw new Error("Vault closed.");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", derived, iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(this.key), cipher.final()]);
      await this.persist({
        version: 1,
        os: this.envelope?.os ?? null,
        master: {
          salt: salt.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        },
      });
      await this.removeLegacyKey();
    } finally {
      derived?.fill(0);
      this.authenticating = false;
    }
  }

  async authenticate(password: string): Promise<void> {
    await this.ready;
    if (this.disposed || this.authenticating || Date.now() < this.retryAt || !this.envelope?.master)
      throw new Error("Master password verification is unavailable.");
    this.authenticating = true;
    let derived: Buffer | undefined;
    let key: Buffer | undefined;
    try {
      const master = this.envelope.master;
      derived = await derive(password, decode(master.salt, 16));
      const decipher = createDecipheriv("aes-256-gcm", derived, decode(master.iv, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(decode(master.tag, 16));
      key = Buffer.concat([decipher.update(decode(master.data, 32)), decipher.final()]);
      if (this.disposed || (this.key && !timingSafeEqual(this.key, key)))
        throw new Error("Vault key verification failed.");
      if (!this.key) this.key = Buffer.from(key);
      await this.removeLegacyKey();
    } catch {
      this.retryAt = Date.now() + 1000;
      throw new Error("Master password verification failed. Try again shortly.");
    } finally {
      key?.fill(0);
      derived?.fill(0);
      this.authenticating = false;
    }
  }

  async lock(): Promise<void> {
    await this.ready;
    if (this.authenticating) throw new Error("Wait for master password verification to finish.");
    if (!this.envelope?.master) throw new Error("Set a master password before locking.");
    this.key?.fill(0);
    this.key = null;
  }

  dispose(): void {
    this.disposed = true;
    this.key?.fill(0);
    this.key = null;
  }
}
