import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTH_TOKEN_FILE_ENV,
  AuthTokenFileError,
  parseAuthTokenFile,
  readAuthTokenFile,
  resolveAuthToken,
} from "./authTokenFile";
import { buildProviderChildEnvironment } from "./providerChildEnvironment";
import { remoteAccessPolicyError, requiresSessionAuthentication } from "./remoteAccessPolicy";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "synara-auth-token-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("parseAuthTokenFile", () => {
  it("strips the trailing newline the bootstrapper writes", () => {
    expect(parseAuthTokenFile("s3cret-token\n", "/tmp/t")).toBe("s3cret-token");
    expect(parseAuthTokenFile("  s3cret-token  \n", "/tmp/t")).toBe("s3cret-token");
  });

  // The critical predicate: an empty file must not read as "no token
  // configured", or a truncated write silently downgrades a remote-reachable
  // server to unauthenticated.
  it.each(["", "   ", "\n", "\t\n "])("refuses an empty credential file %j", (contents) => {
    expect(() => parseAuthTokenFile(contents, "/tmp/t")).toThrow(AuthTokenFileError);
    expect(() => parseAuthTokenFile(contents, "/tmp/t")).toThrow(/is empty/);
  });

  it("refuses a multi-line file rather than guessing which line is the token", () => {
    expect(() => parseAuthTokenFile("token-a\ntoken-b\n", "/tmp/t")).toThrow(/single-line/);
  });
});

describe("readAuthTokenFile", () => {
  it("reads a credential written the way the bootstrapper writes it", async () => {
    const path = join(workspace, "auth-token");
    await writeFile(path, "provisioned-token\n");
    expect(readAuthTokenFile(path)).toBe("provisioned-token");
  });

  // Failing closed matters more than a tidy message: a missing credential file
  // on a remote-reachable box must stop startup, not fall through to unauth.
  it("throws rather than returning undefined when the file is missing", () => {
    expect(() => readAuthTokenFile(join(workspace, "absent"))).toThrow(AuthTokenFileError);
  });
});

describe("resolveAuthToken", () => {
  it("returns the environment token when no file is configured", () => {
    expect(resolveAuthToken({ authToken: "env-token", authTokenFile: undefined })).toBe(
      "env-token",
    );
  });

  // Precedence guard: a stale SYNARA_AUTH_TOKEN in an operator's shell must not
  // beat the credential the broker provisioned and will actually present.
  it("prefers the file over the environment token", () => {
    expect(
      resolveAuthToken({
        authToken: "stale-env-token",
        authTokenFile: "/tmp/auth-token",
        read: () => "provisioned-token",
      }),
    ).toBe("provisioned-token");
  });

  it("propagates a file error instead of falling back to the environment token", () => {
    expect(() =>
      resolveAuthToken({
        authToken: "stale-env-token",
        authTokenFile: "/tmp/auth-token",
        read: () => {
          throw new AuthTokenFileError("empty");
        },
      }),
    ).toThrow(AuthTokenFileError);
  });

  it("ignores a blank file path", () => {
    expect(resolveAuthToken({ authToken: "env-token", authTokenFile: "   " })).toBe("env-token");
  });
});

// The end-to-end property the bootstrap depends on: a server configured ONLY
// with the credential file must enforce authentication. Before this existed the
// unit exported SYNARA_AUTH_TOKEN_FILE, nothing read it, and the loopback bind
// made the policy classify the server local-only — so it started with auth off.
describe("a server booted with only the credential file", () => {
  const loopbackConfig = {
    host: "127.0.0.1",
    publicUrl: undefined,
    allowInsecureRemote: false,
    devUrl: undefined,
  } as const;

  it("enforces authentication once the file is resolved", async () => {
    const path = join(workspace, "auth-token");
    await writeFile(path, "provisioned-token\n");
    const authToken = resolveAuthToken({ authToken: undefined, authTokenFile: path });

    expect(authToken).toBe("provisioned-token");
    expect(requiresSessionAuthentication({ ...loopbackConfig, authToken })).toBe(true);
    expect(remoteAccessPolicyError({ ...loopbackConfig, authToken })).toBeNull();
  });

  // This is the regression itself: without the file being read, authToken is
  // undefined and the loopback bind means NOTHING requires authentication.
  it("would run unauthenticated if the file were ignored", () => {
    expect(requiresSessionAuthentication({ ...loopbackConfig, authToken: undefined })).toBe(false);
  });

  it("refuses to start when the credential file is present but empty", async () => {
    const path = join(workspace, "auth-token");
    await writeFile(path, "");
    expect(() => resolveAuthToken({ authToken: undefined, authTokenFile: path })).toThrow(
      AuthTokenFileError,
    );
  });

  // The whole point of a file over an env var: neither the token nor a pointer
  // to it may reach a provider child process.
  it("never leaks the credential path to a provider child", () => {
    const childEnv = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        [AUTH_TOKEN_FILE_ENV]: "/home/deploy/.synara/remote/state/auth-token",
        SYNARA_AUTH_TOKEN: "provisioned-token",
        PATH: "/usr/bin",
      },
    });
    expect(childEnv[AUTH_TOKEN_FILE_ENV]).toBeUndefined();
    expect(childEnv.SYNARA_AUTH_TOKEN).toBeUndefined();
    expect(childEnv.PATH).toBe("/usr/bin");
  });
});
