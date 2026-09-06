import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  accountJsonPath,
  accountSecretPath,
  activePointerPath,
} from "@synara/shared/providerAccounts/accountPaths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AccountLaunchError,
  buildChildEnvironment,
  resolveLaunchEnvironment,
} from "./accountResolution.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-launcher-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeAccount(ordinal: number, agent: object): void {
  const filePath = accountJsonPath(root, "codex", ordinal);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ schemaVersion: 1, provider: "codex", ordinal, agent }),
  );
}

function writeActivePointer(ordinal: number): void {
  const filePath = activePointerPath(root, "codex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(ordinal));
}

describe("resolveLaunchEnvironment", () => {
  it("resolves account zero natively with no overrides when no pointer exists", () => {
    const launch = resolveLaunchEnvironment({ root, provider: "codex", env: {} });
    expect(launch).toEqual({ ordinal: 0, overrides: {} });
  });

  it("resolves the active pointer to a managed Codex OAuth environment", () => {
    writeActivePointer(3);
    writeAccount(3, { state: "connected", authMethod: "oauth", generation: 1 });
    const launch = resolveLaunchEnvironment({ root, provider: "codex", env: {} });
    expect(launch.ordinal).toBe(3);
    expect(launch.overrides.CODEX_HOME).toBe(
      path.join(root, "accounts", "codex", "3", "agent", "home"),
    );
    expect(launch.overrides.OPENAI_API_KEY).toBe("");
  });

  it("prefers SYNARA_ACCOUNT_OVERRIDE over the active pointer, ignoring other providers", () => {
    writeActivePointer(3);
    writeAccount(2, { state: "connected", authMethod: "oauth", generation: 1 });
    writeAccount(3, { state: "connected", authMethod: "oauth", generation: 1 });
    const launch = resolveLaunchEnvironment({
      root,
      provider: "codex",
      env: { SYNARA_ACCOUNT_OVERRIDE: "codex:2" },
    });
    expect(launch.ordinal).toBe(2);

    const ignored = resolveLaunchEnvironment({
      root,
      provider: "codex",
      env: { SYNARA_ACCOUNT_OVERRIDE: "grok:9" },
    });
    expect(ignored.ordinal).toBe(3);
  });

  it("injects the stored API key for apiKey accounts and fails closed when missing", () => {
    writeAccount(4, { state: "connected", authMethod: "apiKey", generation: 1 });
    expect(() =>
      resolveLaunchEnvironment({ root, provider: "codex", explicitOrdinal: 4, env: {} }),
    ).toThrow(AccountLaunchError);

    const secretPath = accountSecretPath(root, "codex", 4, "agent");
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, "sk-test");
    const launch = resolveLaunchEnvironment({
      root,
      provider: "codex",
      explicitOrdinal: 4,
      env: {},
    });
    expect(launch.overrides.OPENAI_API_KEY).toBe("sk-test");
  });

  it("fails closed for missing accounts, disconnected bindings, and malformed overrides", () => {
    expect(() =>
      resolveLaunchEnvironment({ root, provider: "codex", explicitOrdinal: 5, env: {} }),
    ).toThrow("does not exist");

    writeAccount(6, { state: "needs-auth", authMethod: "oauth", generation: 1 });
    expect(() =>
      resolveLaunchEnvironment({ root, provider: "codex", explicitOrdinal: 6, env: {} }),
    ).toThrow("not connected");

    expect(() =>
      resolveLaunchEnvironment({
        root,
        provider: "codex",
        env: { SYNARA_ACCOUNT_OVERRIDE: "bogus" },
      }),
    ).toThrow("Invalid SYNARA_ACCOUNT_OVERRIDE");
  });

  it("resolves managed accounts for every supported provider", () => {
    const filePath = accountJsonPath(root, "grok", 1);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        provider: "grok",
        ordinal: 1,
        agent: { state: "connected", authMethod: "oauth", generation: 1 },
      }),
    );
    const launch = resolveLaunchEnvironment({
      root,
      provider: "grok",
      explicitOrdinal: 1,
      env: {},
    });
    expect(launch.ordinal).toBe(1);
    expect(launch.overrides.GROK_HOME).toContain(path.join("accounts", "grok", "1"));
  });

  it("produces disjoint homes and keys for two accounts of the same provider", () => {
    for (const ordinal of [1, 2]) {
      writeAccount(ordinal, { state: "connected", authMethod: "apiKey", generation: 1 });
      const secretPath = accountSecretPath(root, "codex", ordinal, "agent");
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, `sk-acct-${ordinal}`);
    }
    const one = resolveLaunchEnvironment({ root, provider: "codex", explicitOrdinal: 1, env: {} });
    const two = resolveLaunchEnvironment({ root, provider: "codex", explicitOrdinal: 2, env: {} });
    expect(one.overrides.CODEX_HOME).not.toBe(two.overrides.CODEX_HOME);
    expect(one.overrides.OPENAI_API_KEY).toBe("sk-acct-1");
    expect(two.overrides.OPENAI_API_KEY).toBe("sk-acct-2");

    const childEnv = buildChildEnvironment(
      {
        OPENAI_API_KEY: "native-key",
        OPENAI_BASE_URL: "https://native.example.com",
        CODEX_HOME: "/native/home",
        SYNARA_ACCOUNT_OVERRIDE: "codex:1",
        SYNARA_LAUNCHER_SHIM: "codex",
        UNRELATED: "kept",
      },
      two.overrides,
    );
    expect(childEnv.OPENAI_API_KEY).toBe("sk-acct-2");
    expect(childEnv.CODEX_HOME).toBe(two.overrides.CODEX_HOME);
    expect(childEnv.OPENAI_BASE_URL).toBeUndefined();
    expect(childEnv.SYNARA_ACCOUNT_OVERRIDE).toBeUndefined();
    expect(childEnv.SYNARA_LAUNCHER_SHIM).toBeUndefined();
    expect(childEnv.UNRELATED).toBe("kept");
  });

  it("fails closed on a corrupted active pointer", () => {
    const pointer = activePointerPath(root, "codex");
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, "garbage");
    expect(() => resolveLaunchEnvironment({ root, provider: "codex", env: {} })).toThrow(
      "corrupted",
    );
  });
});

describe("buildChildEnvironment", () => {
  it("strips launcher control variables and applies overrides with unset markers", () => {
    const env = buildChildEnvironment(
      {
        SYNARA_LAUNCHER_BYPASS: "1",
        SYNARA_ACCOUNT_OVERRIDE: "codex:2",
        OPENAI_API_KEY: "parent-key",
        HOME: "/home/user",
      },
      { OPENAI_API_KEY: "", CODEX_HOME: "/accounts/codex/2/agent/home" },
    );
    expect(env).toEqual({ HOME: "/home/user", CODEX_HOME: "/accounts/codex/2/agent/home" });
  });
});
