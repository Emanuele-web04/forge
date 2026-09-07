import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserVaultSettings, type BrowserVaultSavePrompt, type BrowserVaultSnapshot } from "@synara/contracts";
import { createLocalCredentialVault, type CredentialVault, type LocalCredentialVault } from "betterwright";
import { Schema } from "effect";
import { VaultKeyProtection, type VaultKeyStore } from "./vaultKeyProtection";

const Source = Schema.Literals(["user", "agent"]);
const Preferences = Schema.Struct({
  settings: BrowserVaultSettings,
  sources: Schema.Array(Schema.Struct({ id: Schema.String, source: Source })),
});
type Source = typeof Source.Type;
type Payload = Parameters<LocalCredentialVault["handleRequest"]>[1];
type Action = Parameters<LocalCredentialVault["handleRequest"]>[0];
interface PageOrigin { getURL(): string; isDestroyed(): boolean }

const ACTIONS: readonly Action[] = ["list", "list-pending", "save", "update", "remove", "fill", "generate", "commit", "discard"];

/** Owner metadata stays in desktop IPC; only the scoped adapter reaches a worker. */
export class BrowserVault {
  private readonly vault: LocalCredentialVault;
  private readonly ready: Promise<void>;
  private readonly keys: VaultKeyProtection;
  private settings: BrowserVaultSettings = { agentUse: true, offerSave: false, autosave: false };
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, { prompt: BrowserVaultSavePrompt; resolve(choice: "save" | "dismiss"): void }>();
  private writing = Promise.resolve();
  private captureError: string | null = null;

  constructor(private readonly home: string, keyStore?: VaultKeyStore) {
    this.keys = new VaultKeyProtection(join(home, "vault"), keyStore);
    this.vault = createLocalCredentialVault({ home, keyProvider: () => this.keys.provide() });
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let text: string;
    try { text = await readFile(join(this.home, "preferences.json"), "utf8"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw new Error("Browser vault settings could not be read.");
    }
    const preferences = Schema.decodeUnknownSync(Preferences)(JSON.parse(text));
    this.settings = preferences.settings;
    for (const entry of preferences.sources) this.sources.set(entry.id, entry.source);
  }

  private persist(settings?: BrowserVaultSettings): Promise<void> {
    const write = async () => {
      const text = JSON.stringify({ settings: settings ?? this.settings, sources: [...this.sources].map(([id, source]) => ({ id, source })) });
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const temporary = join(this.home, `preferences-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx", flush: true });
        await rename(temporary, join(this.home, "preferences.json"));
        if (settings) this.settings = settings;
      } finally { await unlink(temporary).catch(() => {}); }
    };
    const operation = this.writing.then(write);
    this.writing = operation.catch(() => {});
    return operation;
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A closed renderer cannot block vault writes. */ }
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async snapshot(): Promise<BrowserVaultSnapshot> {
    await this.ready;
    const protection = await this.keys.status();
    const { credentials, pendingCredentials } = protection.locked
      ? { credentials: [], pendingCredentials: [] }
      : await this.vault.ownerList({ category: "login" });
    return this.vault.redact({
      protection,
      settings: this.settings,
      logins: [
        ...credentials.map(({ id, origin, username, label, updatedAt }) => ({ id, origin, username, label, updatedAt, status: "saved" as const, source: this.sources.get(id) ?? "unknown" })),
        ...pendingCredentials.map(({ pendingId, origin, username, label, createdAt, expired }) => ({ id: pendingId, origin, username, label, updatedAt: createdAt, status: expired ? "expired" as const : "pending" as const, source: this.sources.get(pendingId) ?? "unknown" })),
      ],
      pending: [...this.pending.values()].map(({ prompt }) => prompt),
      error: this.captureError,
    } satisfies BrowserVaultSnapshot);
  }

  async setupMaster(password: string): Promise<void> {
    await this.ready;
    await this.keys.setup(password);
    this.changed();
  }

  async unlock(password: string): Promise<void> {
    await this.keys.authenticate(password);
    this.changed();
  }

  async lock(): Promise<void> {
    await this.keys.lock();
    this.dismissPrompts();
    this.changed();
  }

  async reveal(input: { id: string; password: string }): Promise<{ password: string; expiresAt: number }> {
    await this.ready;
    await this.keys.authenticate(input.password);
    const record = await this.vault.ownerReveal(input.id);
    if (record.category !== "login" || record.secret == null) throw new Error("No saved password exists for this login.");
    this.vault.trackRedactionSecret(record.secret);
    return { password: record.secret, expiresAt: Date.now() + 20_000 };
  }

  async configure(input: BrowserVaultSettings): Promise<BrowserVaultSnapshot> {
    await this.ready;
    const settings = Schema.decodeUnknownSync(BrowserVaultSettings)(input);
    if (settings.autosave && !settings.offerSave) throw new Error("Enable password saving before autosave.");
    await this.persist(settings);
    if (!settings.offerSave) this.dismissPrompts();
    this.changed();
    return this.snapshot();
  }

  async remove(id: string): Promise<BrowserVaultSnapshot> {
    await this.ready;
    await this.vault.ownerRemove(id);
    this.sources.delete(id);
    await this.persist();
    this.changed();
    return this.snapshot();
  }

  private async request(action: Action, payload: Payload, origin: string, source: Source) {
    const result = await this.vault.handleRequest(action, { ...payload, matchMode: "exact-origin" }, origin);
    if (["save", "update", "commit"].includes(action) && result && typeof result === "object" && "id" in result && typeof result.id === "string") {
      this.sources.set(result.id, source);
      await this.persist();
    }
    if (action === "generate" && result && typeof result === "object" && "pendingId" in result && typeof result.pendingId === "string") {
      this.sources.set(result.pendingId, source);
      await this.persist();
    }
    if (!["list", "list-pending", "fill"].includes(action)) this.changed();
    return result;
  }

  agentAdapter(page: PageOrigin, signal: AbortSignal): CredentialVault {
    const assertOrigin = (origin: string) => {
      signal.throwIfAborted();
      if (!this.settings.agentUse || page.isDestroyed()) throw new Error("Saved login use is unavailable.");
      const current = new URL(page.getURL());
      if (!["https:", "http:"].includes(current.protocol) || current.origin !== origin) throw new Error("Saved login does not match this page origin.");
    };
    return {
      handleRequest: async (action, payload, origin) => {
        await this.ready;
        assertOrigin(origin);
        const supported = ACTIONS.find((candidate) => candidate === action);
        if (!supported) throw new Error("Unsupported saved login operation.");
        const result = await this.request(supported, payload, origin, "agent");
        assertOrigin(origin);
        return result;
      },
      redact: (value) => this.vault.redact(value),
      // Deliberately no resetRedactionSecrets: the user-owned page outlives workers.
    };
  }

  redact<T>(value: T): T { return this.vault.redact(value); }

  trackSecret(secret: string): void { this.vault.trackRedactionSecret(secret); }

  async shouldOfferSave(input: { origin: string; username: string; password: string }): Promise<boolean> {
    await this.ready;
    if (!this.settings.offerSave || (await this.keys.status()).locked) return false;
    const { credentials } = await this.vault.ownerList({ category: "login" });
    const existing = credentials.find((entry) => entry.origin === input.origin && entry.username === input.username);
    if (!existing) return true;
    const filled = await this.vault.handleRequest("fill", { id: existing.id }, input.origin);
    return !(filled && typeof filled === "object" && "secret" in filled && filled.secret === input.password);
  }

  reportCaptureFailure(): void {
    if (this.captureError) return;
    this.captureError = "Password saving is unavailable. Reopen the browser and try again.";
    this.changed();
  }

  reportCaptureReady(): void {
    if (!this.captureError) return;
    this.captureError = null;
    this.changed();
  }

  async saveCaptured(origin: string, payload: Payload, source: Source): Promise<void> {
    await this.ready;
    if (!this.settings.offerSave) return;
    await this.request("save", payload, origin, source);
  }

  async askSave(input: Omit<BrowserVaultSavePrompt, "id">): Promise<"save" | "dismiss"> {
    await this.ready;
    if (!this.settings.offerSave) return "dismiss";
    if (this.settings.autosave) return "save";
    if (this.pending.size >= 8) return "dismiss";
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respond({ id, save: false }), 120_000);
      this.pending.set(id, {
        prompt: { ...input, id },
        resolve: (choice) => { clearTimeout(timer); resolve(choice); },
      });
      this.changed();
    });
  }

  respond(input: { id: string; save: boolean }): void {
    const pending = this.pending.get(input.id);
    if (!pending) return;
    this.pending.delete(input.id);
    pending.resolve(input.save && this.settings.offerSave ? "save" : "dismiss");
    this.changed();
  }

  private dismissPrompts(): void {
    for (const id of this.pending.keys()) this.respond({ id, save: false });
  }

  dispose(): void {
    this.keys.dispose();
    this.dismissPrompts();
    this.listeners.clear();
  }
}
