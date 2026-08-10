import { describe, expect, it } from "vitest";

import { buildProviderChildEnvironment } from "../providerChildEnvironment";
import {
  makeLegacyCodexLaunchContext,
  makeManagedCodexLaunchContext,
} from "./codexProviderLaunchContext";
import { buildCodexAccountProcessEnv } from "./codexAccountProcessEnv";

const target = { provider: "codex" as const, profileId: "profile-1" };

describe("buildCodexAccountProcessEnv", () => {
  it("preserves the legacy account-control environment behavior", () => {
    const sourceHomePath = "/profiles/legacy-codex";
    const baseEnv = {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/inherited/codex-home",
      CODEX_SQLITE_HOME: "/inherited/sqlite-home",
      ANTHROPIC_API_KEY: "legacy-upstream-key",
      SYNARA_AUTH_TOKEN: "control-plane-secret",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      CUSTOM_PROVIDER_TOKEN: "legacy-custom-provider-token",
    };
    const launchContext = makeLegacyCodexLaunchContext({
      target,
      binaryPath: "/usr/bin/codex",
      settingsRevision: 3,
      registryRevision: 0,
      sourceHomePath,
    });

    const actual = buildCodexAccountProcessEnv({ launchContext, env: baseEnv });
    const expected = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: { ...baseEnv, CODEX_HOME: sourceHomePath },
    });

    expect(actual).toEqual(expected);
    expect(actual.CODEX_HOME).toBe(sourceHomePath);
    expect(actual.ANTHROPIC_API_KEY).toBe("legacy-upstream-key");
    expect(actual.CUSTOM_PROVIDER_TOKEN).toBe("legacy-custom-provider-token");
  });

  it("anchors a relative legacy home to the account-process cwd", () => {
    const baseEnv = { PATH: "/usr/bin", HOME: "/home/tester" };
    const launchContext = makeLegacyCodexLaunchContext({
      target,
      binaryPath: "/usr/bin/codex",
      settingsRevision: 3,
      registryRevision: 0,
      sourceHomePath: "relative-codex-home",
    });

    const actual = buildCodexAccountProcessEnv({
      launchContext,
      env: baseEnv,
      cwd: "/srv/synara-home",
    });

    expect(actual.CODEX_HOME).toBe("/srv/synara-home/relative-codex-home");
  });

  it("gives managed account control only operational environment values", () => {
    const codexHomePath = "/profiles/managed/home";
    const codexSqliteHomePath = "/profiles/managed/sqlite";
    const launchContext = makeManagedCodexLaunchContext({
      target,
      binaryPath: "/usr/bin/codex",
      settingsRevision: 3,
      registryRevision: 4,
      authenticationBoundAt: null,
      continuationNamespaceId: "managed-storage-key",
      codexHomePath,
      codexSqliteHomePath,
    });
    const inheritedEnvironment = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      TMPDIR: "/tmp/tester",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/host/codex-home",
      CODEX_SQLITE_HOME: "/host/codex-sqlite-home",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      CUSTOM_PROVIDER_TOKEN: "custom-provider-secret",
      DATABASE_URL: "postgres://secret@example.test/database",
      UNRELATED_FEATURE_FLAG: "enabled",
      SYNARA_AUTH_TOKEN: "control-plane-secret",
      NODE_OPTIONS: "--require=/tmp/inject.js",
    };

    const result = buildCodexAccountProcessEnv({
      launchContext,
      env: inheritedEnvironment,
    });

    expect(result).toMatchObject({
      PATH: inheritedEnvironment.PATH,
      TMPDIR: inheritedEnvironment.TMPDIR,
      LANG: inheritedEnvironment.LANG,
      HOME: "/profiles/managed",
      USERPROFILE: "/profiles/managed",
      CODEX_HOME: codexHomePath,
      CODEX_SQLITE_HOME: codexSqliteHomePath,
    });
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.CUSTOM_PROVIDER_TOKEN).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.UNRELATED_FEATURE_FLAG).toBeUndefined();
    expect(result.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(result.NODE_OPTIONS).toBeUndefined();
    expect(inheritedEnvironment.CODEX_HOME).toBe("/host/codex-home");
    expect(inheritedEnvironment.CODEX_SQLITE_HOME).toBe("/host/codex-sqlite-home");
  });

  it("normalizes Windows path variables without copying their ambient casing", () => {
    const launchContext = makeManagedCodexLaunchContext({
      target,
      binaryPath: "C:\\codex.exe",
      settingsRevision: 3,
      registryRevision: 4,
      authenticationBoundAt: null,
      continuationNamespaceId: "managed-storage-key",
      codexHomePath: "C:\\profiles\\managed\\home",
      codexSqliteHomePath: "C:\\profiles\\managed\\sqlite",
    });

    const result = buildCodexAccountProcessEnv({
      launchContext,
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32",
        PathExt: ".EXE;.CMD",
        SYSTEMROOT: "C:\\Windows",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
    });

    expect(result).toMatchObject({
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    });
    expect(result.Path).toBeUndefined();
    expect(result.PathExt).toBeUndefined();
    expect(result.SYSTEMROOT).toBeUndefined();
    expect(result.COMSPEC).toBeUndefined();
  });
});
