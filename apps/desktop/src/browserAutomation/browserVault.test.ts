import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserVault } from "./browserVault";

const homes: string[] = [];
const master = "synthetic-master-password-only";
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "synara-vault-"));
  homes.push(home);
  const vault = new BrowserVault(home);
  await vault.setupMaster(master);
  return { home, vault };
}
const origin = "https://login.example.test";
const page = (url = origin) => ({ getURL: () => url, isDestroyed: () => false });

describe("browser vault", () => {
  it("does not enable saving or agent access after a failed settings write", async () => {
    const { home, vault } = await fixture();
    await vault.configure({ agentUse: false, offerSave: false, autosave: false });
    await rm(join(home, "preferences.json"));
    await mkdir(join(home, "preferences.json"));
    await expect(vault.configure({ agentUse: true, offerSave: true, autosave: true })).rejects.toThrow();
    expect((await vault.snapshot()).settings).toEqual({ agentUse: false, offerSave: false, autosave: false });
    vault.dispose();
  });
  it("persists user and agent logins without exposing secrets in metadata", async () => {
    const { home, vault } = await fixture();
    await vault.configure({ agentUse: true, offerSave: true, autosave: false });
    await vault.saveCaptured(origin, { username: "human", password: "synthetic-human-secret" }, "user");
    const adapter = vault.agentAdapter(page(), new AbortController().signal);
    await adapter.handleRequest("save", { username: "agent", password: "synthetic-agent-secret", matchMode: "base-domain" }, origin);
    const restored = new BrowserVault(home);
    expect((await restored.snapshot()).protection.locked).toBe(true);
    await restored.unlock(master);
    const snapshot = await restored.snapshot();
    expect(snapshot.logins).toHaveLength(2);
    expect(snapshot.logins.map(({ source }) => source).sort()).toEqual(["agent", "user"]);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-");
    expect(await readFile(join(home, "preferences.json"), "utf8")).not.toContain("synthetic-");
    expect(vault.redact({ text: "synthetic-human-secret synthetic-agent-secret" })).not.toEqual({ text: "synthetic-human-secret synthetic-agent-secret" });
    vault.dispose();
    restored.dispose();
  });

  it("requires the master password to reveal user, agent and pending generated passwords", async () => {
    const { home, vault } = await fixture();
    await vault.configure({ agentUse: true, offerSave: true, autosave: false });
    await vault.saveCaptured(origin, { username: "human", password: "synthetic-human" }, "user");
    const adapter = vault.agentAdapter(page(), new AbortController().signal);
    await adapter.handleRequest("save", { username: "agent", password: "synthetic-agent" }, origin);
    await adapter.handleRequest("generate", { username: "signup" }, origin);
    const snapshot = await vault.snapshot();
    expect(snapshot.logins).toHaveLength(3);
    expect(snapshot.logins.find((login) => login.username === "signup")).toMatchObject({ status: "pending", source: "agent" });
    for (const login of snapshot.logins) {
      const result = await vault.reveal({ id: login.id, password: master });
      expect(result.password.length).toBeGreaterThan(10);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(JSON.stringify(await vault.snapshot())).not.toContain(result.password);
    }
    await expect(vault.reveal({ id: snapshot.logins[0]!.id, password: "incorrect-master" })).rejects.toThrow();
    await expect(readFile(join(home, "vault", "vault.key"))).rejects.toThrow();
    expect(await readFile(join(home, "vault", "key-protection.json"), "utf8")).not.toContain(master);
    await vault.lock();
    await expect(adapter.handleRequest("list", {}, origin)).rejects.toThrow();
    expect((await vault.snapshot()).logins).toEqual([]);
    vault.dispose();
  });

  it("uses opaque IDs only at their exact origin and honors disabling and cancellation", async () => {
    const { vault } = await fixture();
    const controller = new AbortController();
    const adapter = vault.agentAdapter(page(), controller.signal);
    await adapter.handleRequest("save", { username: "account", password: "synthetic-secret" }, origin);
    const login = (await vault.snapshot()).logins[0]!;
    const other = vault.agentAdapter(page("https://sub.login.example.test"), controller.signal);
    await expect(other.handleRequest("fill", { id: login.id }, "https://sub.login.example.test")).rejects.toThrow();
    await expect(adapter.handleRequest("fill", { id: login.id }, "https://unrelated.test")).rejects.toThrow();
    await expect(adapter.handleRequest("ownerReveal", { id: login.id }, origin)).rejects.toThrow();
    await vault.configure({ agentUse: false, offerSave: false, autosave: false });
    await expect(adapter.handleRequest("list", {}, origin)).rejects.toThrow();
    await vault.configure({ agentUse: true, offerSave: false, autosave: false });
    controller.abort();
    await expect(adapter.handleRequest("fill", { id: login.id }, origin)).rejects.toThrow();
    vault.dispose();
  });

  it("requires saving consent and supports update, dismissal and deletion", async () => {
    const { vault } = await fixture();
    await vault.saveCaptured(origin, { username: "human", password: "not-consented" }, "user");
    expect((await vault.snapshot()).logins).toEqual([]);
    await vault.configure({ agentUse: true, offerSave: true, autosave: false });
    const prompt = vault.askSave({ origin, username: "human", mode: "save" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = (await vault.snapshot()).pending[0]!;
    vault.respond({ id: pending.id, save: true });
    expect(await prompt).toBe("save");
    await vault.saveCaptured(origin, { username: "human", password: "original" }, "user");
    expect(await vault.shouldOfferSave({ origin, username: "human", password: "original" })).toBe(false);
    expect(await vault.shouldOfferSave({ origin, username: "human", password: "changed" })).toBe(true);
    expect(await vault.shouldOfferSave({ origin: "https://other.test", username: "human", password: "original" })).toBe(true);
    const id = (await vault.snapshot()).logins[0]!.id;
    await vault.saveCaptured(origin, { username: "human", password: "updated" }, "user");
    expect((await vault.snapshot()).logins.map((login) => login.id)).toEqual([id]);
    const dismissed = vault.askSave({ origin, username: "human", mode: "update" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vault.configure({ agentUse: true, offerSave: false, autosave: false });
    expect(await dismissed).toBe("dismiss");
    await vault.remove(id);
    expect((await vault.snapshot()).logins).toEqual([]);
    vault.dispose();
  });
});
